import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { AppError } from '../../core/errors.js'
import '../../types.js'
import type { EmailWorker } from './email.worker.js'
import {
  createChannel,
  deleteChannel,
  getChannel,
  listChannels,
  pollChannel,
  testChannelConnection,
  testConnectionConfig,
  updateChannel,
} from './email.channels.js'

const channelSchema = z.object({
  name: z.string().trim().min(1).max(120),
  address: z.string().trim().min(1).max(320),
  imapHost: z.string().trim().min(1).max(255),
  imapPort: z.number().int().min(1).max(65535).default(993),
  imapUser: z.string().trim().min(1).max(320),
  imapPass: z.string().min(1).max(1024),
  imapTls: z.boolean().default(true),
  enabled: z.boolean().optional(),
})

const channelPatchSchema = channelSchema.partial()

/** Credentials-only schema for the test-before-add endpoint. */
const connectionTestSchema = z.object({
  imapHost: z.string().trim().min(1).max(255),
  imapPort: z.number().int().min(1).max(65535).default(993),
  imapUser: z.string().trim().min(1).max(320),
  imapPass: z.string().min(1).max(1024),
  imapTls: z.boolean().default(true),
})

export function createEmailRoutes(worker: EmailWorker | null) {
  return async function emailRoutes(app: FastifyInstance): Promise<void> {
    const emailKey = () => app.config.emailKey

    app.get(
      '/email/status',
      { preHandler: [authenticate, requireTenant, requirePermission('settings.manage')] },
      async () => {
        if (!worker) {
          return { enabled: false, reason: 'IMAP not configured' }
        }
        return worker.getStatus()
      },
    )

    app.post(
      '/email/poll',
      { preHandler: [authenticate, requireTenant, requirePermission('settings.manage')] },
      async (_request) => {
        if (!worker) {
          return { processed: 0, message: 'IMAP not configured' }
        }
        return worker.pollOnce()
      },
    )

    app.get(
      '/email/channels',
      { preHandler: [authenticate, requireTenant, requirePermission('settings.manage')] },
      async (request) => {
        const channels = await listChannels(app.db, request.tenantCtx!.tenantId)
        return { channels }
      },
    )

    app.post(
      '/email/channels',
      { preHandler: [authenticate, requireTenant, requirePermission('settings.manage')] },
      async (request, reply) => {
        const body = channelSchema.parse(request.body)
        const channel = await createChannel(app.db, request.tenantCtx!.tenantId, body, emailKey())
        return reply.code(201).send({ id: channel.id })
      },
    )

    // Test credentials before saving (no channel id required).
    app.post(
      '/email/channels/test',
      { preHandler: [authenticate, requireTenant, requirePermission('settings.manage')] },
      async (request) => {
        const body = connectionTestSchema.parse(request.body)
        const test = await testConnectionConfig({
          host: body.imapHost,
          port: body.imapPort,
          user: body.imapUser,
          pass: body.imapPass,
          tls: body.imapTls,
        })
        return test
      },
    )

    app.patch(
      '/email/channels/:channelId',
      { preHandler: [authenticate, requireTenant, requirePermission('settings.manage')] },
      async (request) => {
        const { channelId } = request.params as { channelId: string }
        const body = channelPatchSchema.parse(request.body)
        await updateChannel(app.db, request.tenantCtx!.tenantId, channelId, body, emailKey())
        return { ok: true }
      },
    )

    app.delete(
      '/email/channels/:channelId',
      { preHandler: [authenticate, requireTenant, requirePermission('settings.manage')] },
      async (request) => {
        const { channelId } = request.params as { channelId: string }
        await deleteChannel(app.db, request.tenantCtx!.tenantId, channelId)
        return { ok: true }
      },
    )

    app.post(
      '/email/channels/:channelId/test',
      { preHandler: [authenticate, requireTenant, requirePermission('settings.manage')] },
      async (request) => {
        const { channelId } = request.params as { channelId: string }
        const channel = await getChannel(app.db, request.tenantCtx!.tenantId, channelId)
        const test = await testChannelConnection(channel, emailKey())
        if (!test.ok) {
          throw new AppError(502, 'imap_connection_failed', test.error ?? 'Connection failed')
        }
        return { ok: true, unseen: test.unseen }
      },
    )

    app.post(
      '/email/channels/:channelId/poll',
      { preHandler: [authenticate, requireTenant, requirePermission('settings.manage')] },
      async (request) => {
        const { channelId } = request.params as { channelId: string }
        const channel = await getChannel(app.db, request.tenantCtx!.tenantId, channelId)
        const result = await pollChannel(app.db, channel, emailKey())
        return result
      },
    )
  }
}
