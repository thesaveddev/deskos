import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { listPlaybooks, getPlaybook, createPlaybook, updatePlaybook, deletePlaybook, seedBuiltInPlaybooks, reviewPlaybookAccess, rotatePlaybookIdentity, revokePlaybookIdentity } from './playbooks.js'
import { issueIdentityCredential, listIdentityCredentials, revokeIdentityCredential } from './identity-credentials.js'
import '../../types.js'

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  category: z.enum(['general', 'password_reset', 'software_install', 'printer', 'network', 'account_unlock', 'email', 'hardware', 'security', 'custom']),
  trigger_keywords: z.array(z.string().max(100)).max(20).default([]),
  system_prompt: z.string().min(1).max(10000),
  max_steps: z.number().int().min(1).max(12).default(6),
  auto_approve_low_risk: z.boolean().default(true),
  machine_identity: z.string().min(1).max(120).default('reydesk-worker'),
  allowed_tools: z.array(z.string().max(120)).max(50).default([]),
})

const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).optional(),
  category: z.enum(['general', 'password_reset', 'software_install', 'printer', 'network', 'account_unlock', 'email', 'hardware', 'security', 'custom']).optional(),
  trigger_keywords: z.array(z.string().max(100)).max(20).optional(),
  system_prompt: z.string().min(1).max(10000).optional(),
  max_steps: z.number().int().min(1).max(12).optional(),
  auto_approve_low_risk: z.boolean().optional(),
  enabled: z.boolean().optional(),
  machine_identity: z.string().min(1).max(120).optional(),
  allowed_tools: z.array(z.string().max(120)).max(50).optional(),
})

export async function playbookRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('ai_agent.read')]
  const manage = [authenticate, requireTenant, requirePermission('ai_agent.manage')]

  app.get('/ai-playbooks', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const query = (request.query ?? {}) as { category?: string; enabled?: string; search?: string }
    const playbooks = await listPlaybooks(app.db, ctx.tenantId, {
      category: query.category,
      enabled: query.enabled === 'true' ? true : query.enabled === 'false' ? false : undefined,
      search: query.search,
    })
    return { playbooks }
  })

  app.get('/ai-playbooks/:id', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const playbook = await getPlaybook(app.db, ctx.tenantId, id)
    return { playbook }
  })

  app.post('/ai-playbooks', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = createSchema.parse(request.body)
    const playbook = await createPlaybook(app.db, ctx.tenantId, body)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user', actorId: request.user!.id,
        action: 'ai_playbook.created', objectType: 'ai_playbook', objectId: playbook.id,
        ip: request.ip, payload: { name: playbook.name, category: playbook.category },
      })
    })
    return reply.code(201).send({ playbook })
  })

  app.patch('/ai-playbooks/:id', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = updateSchema.parse(request.body)
    const playbook = await updatePlaybook(app.db, ctx.tenantId, id, body)
    return { playbook }
  })

  app.post('/ai-playbooks/:id/access-review', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const playbook = await reviewPlaybookAccess(app.db, ctx.tenantId, id, request.user!.id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user', actorId: request.user!.id,
        action: 'ai_playbook.access_reviewed', objectType: 'ai_playbook', objectId: id,
        ip: request.ip, payload: { machineIdentity: playbook.machine_identity, allowedTools: playbook.allowed_tools },
      })
    })
    return { playbook }
  })

  app.post('/ai-playbooks/:id/identity/rotate', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const playbook = await rotatePlaybookIdentity(app.db, ctx.tenantId, id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user', actorId: request.user!.id,
        action: 'ai_playbook.identity_rotated', objectType: 'ai_playbook', objectId: id,
        ip: request.ip, payload: { identityVersion: playbook.identity_version },
      })
    })
    return { playbook }
  })

  app.get('/ai-playbooks/:id/identity/credentials', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return { credentials: await listIdentityCredentials(app.db, ctx.tenantId, id) }
  })

  app.post('/ai-playbooks/:id/identity/credentials', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = z.object({ name: z.string().trim().min(1).max(120), expiresInDays: z.number().int().min(1).max(365).default(90) }).parse(request.body)
    const issued = await issueIdentityCredential(app.db, ctx.tenantId, id, request.user!.id, body)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user', actorId: request.user!.id,
        action: 'ai_playbook.identity_credential_issued', objectType: 'ai_playbook', objectId: id,
        ip: request.ip, payload: { credentialId: issued.credential.id, name: body.name, expiresAt: issued.credential.expires_at },
      })
    })
    return reply.code(201).send(issued)
  })

  app.delete('/ai-playbooks/:id/identity/credentials/:credentialId', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id, credentialId } = request.params as { id: string; credentialId: string }
    const credential = await revokeIdentityCredential(app.db, ctx.tenantId, id, credentialId, request.user!.id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user', actorId: request.user!.id,
        action: 'ai_playbook.identity_credential_revoked', objectType: 'ai_playbook', objectId: id,
        ip: request.ip, payload: { credentialId },
      })
    })
    return reply.send({ credential })
  })

  app.post('/ai-playbooks/:id/identity/revoke', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = z.object({ reason: z.string().min(1).max(500) }).parse(request.body)
    const playbook = await revokePlaybookIdentity(app.db, ctx.tenantId, id, body.reason)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user', actorId: request.user!.id,
        action: 'ai_playbook.identity_revoked', objectType: 'ai_playbook', objectId: id,
        ip: request.ip, payload: { reason: body.reason },
      })
    })
    return { playbook }
  })

  app.delete('/ai-playbooks/:id', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    await deletePlaybook(app.db, ctx.tenantId, id)
    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user', actorId: request.user!.id,
        action: 'ai_playbook.deleted', objectType: 'ai_playbook', objectId: id,
        ip: request.ip,
      })
    })
    return reply.code(204).send()
  })

  app.post('/ai-playbooks/seed', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const seeded = await seedBuiltInPlaybooks(app.db, ctx.tenantId)
    return { seeded, message: `Seeded ${seeded} built-in playbooks.` }
  })
}
