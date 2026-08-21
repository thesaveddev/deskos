import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { graphClient, type EntraGraphClient } from './graph.js'
import {
  createConnection,
  deleteConnection,
  getConnection,
  listActions,
  listConnections,
  listContacts,
  listSyncRuns,
  runAccountAction,
  syncDevices,
  syncDirectory,
  testConnection,
  updateConnection,
} from './entra.js'
import '../../types.js'

declare module 'fastify' {
  interface FastifyInstance {
    /** Injectable Graph client for tests; falls back to the real client. */
    entraGraph: EntraGraphClient
  }
}

const connectionSchema = z.object({
  name: z.string().trim().min(1).max(120),
  azureTenantId: z.string().trim().min(1).max(200),
  clientId: z.string().trim().min(1).max(200),
  clientSecret: z.string().min(1).max(2000),
  enabled: z.boolean().default(true),
})

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  azureTenantId: z.string().trim().min(1).max(200).optional(),
  clientId: z.string().trim().min(1).max(200).optional(),
  clientSecret: z.string().min(1).max(2000).optional(),
  enabled: z.boolean().optional(),
})

const actionSchema = z.object({
  action: z.enum(['resetPassword', 'requireMfa']),
  upn: z.string().email().max(320),
  newPassword: z.string().min(8).max(200).optional(),
})

export async function entraRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('entra.read')]
  const manage = [authenticate, requireTenant, requirePermission('entra.manage')]
  const emailKey = () => app.config.emailKey

  app.get('/entra/connections', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    return { connections: await listConnections(app.db, ctx.tenantId) }
  })

  app.post('/entra/connections', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = connectionSchema.parse(request.body)
    const id = await createConnection(app.db, ctx.tenantId, body, emailKey(), request.user!.id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'entra.connection_created',
        objectType: 'entra_connection',
        objectId: id,
        ip: request.ip,
        payload: { name: body.name },
      })
    })
    return reply.code(201).send({ id })
  })

  app.patch('/entra/connections/:id', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = updateSchema.parse(request.body)
    await updateConnection(app.db, ctx.tenantId, id, body, emailKey())
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'entra.connection_updated',
        objectType: 'entra_connection',
        objectId: id,
        ip: request.ip,
      })
    })
    return { ok: true }
  })

  app.delete('/entra/connections/:id', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    await deleteConnection(app.db, ctx.tenantId, id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'entra.connection_deleted',
        objectType: 'entra_connection',
        objectId: id,
        ip: request.ip,
      })
    })
    return reply.code(200).send({ ok: true })
  })

  app.post('/entra/connections/:id/test', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const row = await getConnection(app.db, ctx.tenantId, id)
    const result = await testConnection(app.entraGraph ?? graphClient, row, emailKey())
    if (!result.ok) throw new AppError(502, 'entra_connection_failed', result.error ?? 'Connection failed')
    return result
  })

  app.post('/entra/connections/:id/sync', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const result = await syncDirectory(app.db, ctx.tenantId, id, emailKey(), app.entraGraph ?? graphClient)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'entra.directory_synced',
        objectType: 'entra_connection',
        objectId: id,
        ip: request.ip,
        payload: { ...result },
      })
    })
    return reply.code(200).send(result)
  })

  app.get('/entra/sync-runs', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    return { runs: await listSyncRuns(app.db, ctx.tenantId) }
  })

  app.post('/entra/connections/:id/sync-devices', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const result = await syncDevices(app.db, ctx.tenantId, id, emailKey(), app.entraGraph ?? graphClient)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'entra.devices_synced',
        objectType: 'entra_connection',
        objectId: id,
        ip: request.ip,
        payload: { ...result },
      })
    })
    return reply.code(200).send(result)
  })

  app.post('/entra/connections/:id/actions', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = actionSchema.parse(request.body)
    const result = await runAccountAction(
      app.db,
      ctx.tenantId,
      id,
      emailKey(),
      request.user!.id,
      body.action,
      body.upn,
      body.newPassword,
      app.entraGraph ?? graphClient,
    )
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'entra.account_action',
        objectType: 'entra_connection',
        objectId: id,
        ip: request.ip,
        payload: { action: body.action, upn: body.upn, status: result.status },
      })
    })
    return reply.code(201).send(result)
  })

  app.get('/entra/actions', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    return { actions: await listActions(app.db, ctx.tenantId) }
  })

  app.get('/entra/contacts', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    return { contacts: await listContacts(app.db, ctx.tenantId) }
  })
}
