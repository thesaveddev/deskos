import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { adClient, type AdAction, type AdClient } from './ldap.js'
import {
  createConnection,
  deleteConnection,
  getConnection,
  listActions,
  listConnections,
  listSyncRuns,
  runAccountAction,
  syncDirectory,
  testConnection,
  updateConnection,
} from './ad.js'
import '../../types.js'

declare module 'fastify' {
  interface FastifyInstance {
    /** Injectable LDAP client for tests; falls back to the real ldapjs client. */
    adClient?: AdClient
  }
}

const connectionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  host: z.string().trim().min(1).max(200),
  port: z.number().int().min(1).max(65535).optional(),
  useSsl: z.boolean().optional(),
  baseDn: z.string().trim().min(1).max(500),
  bindDn: z.string().trim().min(1).max(500),
  bindPassword: z.string().min(1).max(2000),
  enabled: z.boolean().optional(),
})

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  host: z.string().trim().min(1).max(200).optional(),
  port: z.number().int().min(1).max(65535).optional(),
  useSsl: z.boolean().optional(),
  baseDn: z.string().trim().min(1).max(500).optional(),
  bindDn: z.string().trim().min(1).max(500).optional(),
  bindPassword: z.string().min(1).max(2000).optional(),
  enabled: z.boolean().optional(),
})

const actionSchema = z.object({
  action: z.enum(['resetPassword', 'unlockAccount', 'enableAccount', 'disableAccount']),
  upn: z.string().trim().min(1).max(320),
  newPassword: z.string().min(8).max(200).optional(),
})

export async function adRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('ad.read')]
  const manage = [authenticate, requireTenant, requirePermission('ad.manage')]
  const emailKey = () => app.config.emailKey
  const clientFor = () => app.adClient ?? adClient

  app.get('/ad/connections', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    return { connections: await listConnections(app.db, ctx.tenantId) }
  })

  app.post('/ad/connections', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = connectionSchema.parse(request.body)
    const id = await createConnection(app.db, ctx.tenantId, body, emailKey(), request.user!.id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'ad.connection_created',
        objectType: 'ad_connection',
        objectId: id,
        ip: request.ip,
        payload: { name: body.name },
      })
    })
    return reply.code(201).send({ id })
  })

  app.patch('/ad/connections/:id', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = updateSchema.parse(request.body)
    await updateConnection(app.db, ctx.tenantId, id, body, emailKey())
    return { ok: true }
  })

  app.delete('/ad/connections/:id', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    await deleteConnection(app.db, ctx.tenantId, id)
    return { ok: true }
  })

  app.post('/ad/connections/:id/test', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const row = await getConnection(app.db, ctx.tenantId, id)
    const result = await testConnection(clientFor(), row, emailKey())
    if (!result.ok) throw new AppError(502, 'ad_connection_failed', result.error ?? 'Connection failed')
    return result
  })

  app.post('/ad/connections/:id/sync', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const result = await syncDirectory(app.db, ctx.tenantId, id, emailKey(), clientFor())
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'ad.directory_synced',
        objectType: 'ad_connection',
        objectId: id,
        ip: request.ip,
        payload: { ...result },
      })
    })
    return reply.code(200).send(result)
  })

  app.get('/ad/sync-runs', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    return { runs: await listSyncRuns(app.db, ctx.tenantId) }
  })

  app.post('/ad/connections/:id/actions', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = actionSchema.parse(request.body)
    const result = await runAccountAction(
      app.db,
      ctx.tenantId,
      id,
      emailKey(),
      request.user!.id,
      body.action as AdAction,
      body.upn,
      body.newPassword,
      clientFor(),
    )
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'ad.account_action',
        objectType: 'ad_connection',
        objectId: id,
        ip: request.ip,
        payload: { action: body.action, upn: body.upn, status: result.status },
      })
    })
    return reply.code(201).send(result)
  })

  app.get('/ad/actions', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    return { actions: await listActions(app.db, ctx.tenantId) }
  })

  app.get('/ad/contacts', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query('SELECT id, name, email, department, account_status FROM contacts ORDER BY name LIMIT 500')
      return { contacts: rows }
    })
  })
}
