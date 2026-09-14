import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { listPlaybooks, getPlaybook, createPlaybook, updatePlaybook, deletePlaybook, seedBuiltInPlaybooks } from './playbooks.js'
import '../../types.js'

const createSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(2000).default(''),
  category: z.enum(['general', 'password_reset', 'software_install', 'printer', 'network', 'account_unlock', 'email', 'hardware', 'security', 'custom']),
  trigger_keywords: z.array(z.string().max(100)).max(20).default([]),
  system_prompt: z.string().min(1).max(10000),
  max_steps: z.number().int().min(1).max(12).default(6),
  auto_approve_low_risk: z.boolean().default(true),
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
