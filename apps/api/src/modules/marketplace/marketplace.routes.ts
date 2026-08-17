/* eslint-disable @typescript-eslint/no-explicit-any */
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { recordAudit } from '../../core/audit.js'
import { withTenant } from '../../db/pool.js'
import {
  listApps,
  getAppBySlug,
  createApp,
  updateApp,
  deleteApp,
  listInstalls,
  installApp,
  uninstallApp,
  toggleInstall,
  updateInstallConfig,
} from './marketplace.js'

const CreateAppBody = z.object({
  name: z.string().min(1).max(120),
  slug: z.string().min(1).max(80).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug must be lowercase alphanumeric with hyphens'),
  description: z.string().max(2000).optional().default(''),
  developer: z.string().max(200).optional().default(''),
  version: z.string().max(40).optional().default('1.0.0'),
  icon_url: z.string().url().max(500).nullable().optional(),
  capabilities: z.array(z.string().max(100)).max(50).optional().default([]),
})

const UpdateAppBody = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  developer: z.string().max(200).optional(),
  version: z.string().max(40).optional(),
  icon_url: z.string().url().max(500).nullable().optional(),
  capabilities: z.array(z.string().max(100)).max(50).optional(),
})

const InstallBody = z.object({
  config: z.record(z.unknown()).optional().default({}),
})

const ToggleBody = z.object({
  enabled: z.boolean(),
})

const ConfigBody = z.object({
  config: z.record(z.unknown()),
})

export async function marketplaceRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('marketplace.read')]
  const manage = [authenticate, requireTenant, requirePermission('marketplace.manage')]

  // ── App Registry (platform-wide, marketplace.manage) ──

  app.get('/marketplace/apps', { preHandler: read }, async (_req, reply) => {
    const apps = await listApps(app.db)
    return reply.send(apps)
  })

  app.get('/marketplace/apps/:slug', { preHandler: read }, async (req, reply) => {
    const { slug } = req.params as { slug: string }
    const app_ = await getAppBySlug(app.db, slug)
    if (!app_) return reply.code(404).send({ error: { code: 'not_found', message: 'App not found' } })
    return reply.send(app_)
  })

  app.post('/marketplace/apps', { preHandler: manage }, async (req, reply) => {
    const body = CreateAppBody.parse(req.body)
    const user = (req as any).user
    const tenantId = (req as any).tenantCtx?.tenantId as string
    const created = await createApp(app.db, { ...body, created_by: user?.id ?? null })
    try {
      await withTenant(app.db, tenantId, async (client) => {
        await recordAudit(client, tenantId, { actorId: user?.id, action: 'marketplace.app_created', objectType: 'app_registry', objectId: created.id, payload: { slug: created.slug, name: created.name } })
      })
    } catch { /* audit best-effort */ }
    return reply.code(201).send(created)
  })

  app.patch('/marketplace/apps/:slug', { preHandler: manage }, async (req, reply) => {
    const { slug } = req.params as { slug: string }
    const body = UpdateAppBody.parse(req.body)
    const tenantId = (req as any).tenantCtx?.tenantId as string
    const existing = await getAppBySlug(app.db, slug)
    if (!existing) return reply.code(404).send({ error: { code: 'not_found', message: 'App not found' } })
    const updated = await updateApp(app.db, existing.id, body)
    try {
      await withTenant(app.db, tenantId, async (client) => {
        await recordAudit(client, tenantId, { actorId: (req as any).user?.id, action: 'marketplace.app_updated', objectType: 'app_registry', objectId: updated.id, payload: { slug } })
      })
    } catch { /* audit best-effort */ }
    return reply.send(updated)
  })

  app.delete('/marketplace/apps/:slug', { preHandler: manage }, async (req, reply) => {
    const { slug } = req.params as { slug: string }
    const tenantId = (req as any).tenantCtx?.tenantId as string
    const existing = await getAppBySlug(app.db, slug)
    if (!existing) return reply.code(404).send({ error: { code: 'not_found', message: 'App not found' } })
    await deleteApp(app.db, existing.id)
    try {
      await withTenant(app.db, tenantId, async (client) => {
        await recordAudit(client, tenantId, { actorId: (req as any).user?.id, action: 'marketplace.app_deleted', objectType: 'app_registry', objectId: existing.id, payload: { slug } })
      })
    } catch { /* audit best-effort */ }
    return reply.code(204).send()
  })

  // ── Tenant installs (RLS-scoped) ──

  app.get('/marketplace/installs', { preHandler: read }, async (req, reply) => {
    const tenantId = (req as any).tenantCtx?.tenantId as string
    const installs = await withTenant(app.db, tenantId, (client) => listInstalls(client, tenantId))
    return reply.send(installs)
  })

  app.post('/marketplace/installs/:appId', { preHandler: manage }, async (req, reply) => {
    const { appId } = req.params as { appId: string }
    const tenantId = (req as any).tenantCtx?.tenantId as string
    const userId = (req as any).user?.id as string
    const body = InstallBody.parse(req.body)
    const install = await installApp(app.db, tenantId, userId, appId, body.config)
    return reply.code(201).send(install)
  })

  app.delete('/marketplace/installs/:appId', { preHandler: manage }, async (req, reply) => {
    const { appId } = req.params as { appId: string }
    const tenantId = (req as any).tenantCtx?.tenantId as string
    await uninstallApp(app.db, tenantId, appId)
    return reply.code(204).send()
  })

  app.patch('/marketplace/installs/:appId/toggle', { preHandler: manage }, async (req, reply) => {
    const { appId } = req.params as { appId: string }
    const tenantId = (req as any).tenantCtx?.tenantId as string
    const body = ToggleBody.parse(req.body)
    const install = await toggleInstall(app.db, tenantId, appId, body.enabled)
    return reply.send(install)
  })

  app.patch('/marketplace/installs/:appId/config', { preHandler: manage }, async (req, reply) => {
    const { appId } = req.params as { appId: string }
    const tenantId = (req as any).tenantCtx?.tenantId as string
    const body = ConfigBody.parse(req.body)
    const install = await updateInstallConfig(app.db, tenantId, appId, body.config)
    return reply.send(install)
  })
}
