import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { AppError } from '../../core/errors.js'
import { recordAudit } from '../../core/audit.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { authenticateOAuth, requireOAuthScope } from './oauth-middleware.js'
import { authorize, createClient, deleteClient, issueToken, listClients, type ClientInput } from './oauth.js'
import { addApiAllowlistEntry, getApiSecurity, getApiUsage, recordApiUsage, removeApiAllowlistEntry, updateApiSecurity } from './security.js'
import '../../types.js'

const clientSchema = z.object({
  name: z.string().trim().min(1).max(120),
  redirectUris: z.array(z.string().trim().url().max(1000)).max(20).optional(),
  scopes: z.array(z.string().trim().min(1).max(60)).min(1).max(50).optional(),
  grantTypes: z.array(z.enum(['client_credentials', 'authorization_code'])).min(1).max(2).optional(),
  enabled: z.boolean().optional(),
})

const authorizeSchema = z.object({
  clientId: z.string().uuid(),
  redirectUri: z.string().trim().min(1).max(1000),
  codeChallenge: z.string().trim().min(43).max(128),
  scopes: z.array(z.string().trim().min(1).max(60)).min(1).max(50),
})

const allowlistEntrySchema = z.object({
  cidr: z.string().trim().min(1).max(100),
  label: z.string().trim().max(120).optional(),
})

const securitySettingsSchema = z.object({ enabled: z.boolean() })

const tokenSchema = z.object({
  grant_type: z.string().trim().min(1).max(60),
  client_id: z.string().uuid(),
  client_secret: z.string().trim().min(1).max(2000).optional(),
  code: z.string().trim().min(1).max(2000).optional(),
  code_verifier: z.string().trim().min(43).max(128).optional(),
})

export async function oauthRoutes(app: FastifyInstance): Promise<void> {
  const manage = [authenticate, requireTenant, requirePermission('integration.manage')]

  app.addHook('onResponse', async (request, reply) => {
    const oauth = request.oauthCtx
    if (!oauth) return
    void recordApiUsage(app.db, {
      tenantId: oauth.tenantId,
      clientId: oauth.clientId,
      method: request.method,
      path: request.url.split('?')[0],
      statusCode: reply.statusCode,
      sourceIp: request.ip,
    })
  })

  app.get('/oauth/clients', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    return { clients: await listClients(app.db, ctx.tenantId) }
  })

  app.post('/oauth/clients', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = clientSchema.parse(request.body)
    const result = await createClient(app.db, ctx.tenantId, body as ClientInput, request.user!.id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'oauth.client_created',
        objectType: 'oauth_client',
        objectId: result.client.id as string,
        ip: request.ip,
        payload: { name: body.name, grantTypes: body.grantTypes ?? ['client_credentials'] },
      })
    })
    return reply.code(201).send(result)
  })

  app.get('/oauth/security', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    return getApiSecurity(app.db, ctx.tenantId)
  })

  app.patch('/oauth/security', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const body = securitySettingsSchema.parse(request.body)
    return updateApiSecurity(app.db, ctx.tenantId, request.user!.id, body.enabled)
  })

  app.post('/oauth/security/allowlist', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = allowlistEntrySchema.parse(request.body)
    try {
      const entry = await addApiAllowlistEntry(app.db, ctx.tenantId, request.user!.id, body.cidr, body.label ?? '')
      return reply.code(201).send({ entry })
    } catch (error) {
      throw AppError.badRequest(error instanceof Error ? error.message : 'Could not add network')
    }
  })

  app.delete('/oauth/security/allowlist/:id', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const removed = await removeApiAllowlistEntry(app.db, ctx.tenantId, id)
    if (!removed) throw AppError.notFound('Allowlist entry not found')
    return { ok: true }
  })

  app.get('/oauth/security/usage', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const days = Number((request.query as { days?: string }).days ?? 30)
    return getApiUsage(app.db, ctx.tenantId, days)
  })

  app.delete('/oauth/clients/:id', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    await deleteClient(app.db, ctx.tenantId, id)
    return { ok: true }
  })

  // Authorization-code endpoint (authenticated user approves scopes for a client).
  app.post('/oauth/authorize', { preHandler: [authenticate, requireTenant] }, async (request) => {
    const ctx = request.tenantCtx!
    const body = authorizeSchema.parse(request.body)
    return authorize(app.db, ctx.tenantId, ctx.orgRole, request.user!.id, body)
  })

  // Public token endpoint.
  app.post('/oauth/token', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request) => {
    const body = tokenSchema.parse(request.body)
    return issueToken(app.db, app.config, body)
  })

  // Demonstrative protected resource: the public API surface for OAuth clients.
  app.get('/public/tickets', { preHandler: [authenticateOAuth, requireOAuthScope('ticket.read')] }, async (request) => {
    const oauth = request.oauthCtx!
    const result = await withTenant(app.db, oauth.tenantId, async (client) => {
      const { rows } = await client.query(
        'SELECT id, number, subject, status, priority, created_at FROM tickets ORDER BY created_at DESC LIMIT 100',
      )
      return { tickets: rows }
    })
    return result
  })
}
