import type { FastifyInstance } from 'fastify'
import { AppError } from '../../core/errors.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { withTenant } from '../../db/pool.js'
import {
  listNotes, createNote, updateNote, deleteNote,
  listCategories, createCategory, deleteCategory,
} from './notes.service.js'

const COLORS = new Set(['yellow', 'green', 'blue', 'pink', 'purple', 'orange', 'gray'])
const IMAGE_MAX = 2_000_000

export async function notesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireTenant)

  app.get('/notes', async (req, reply) => {
    const ctx = req.tenantCtx!
    const userId = req.user!.id
    return reply.send({ notes: await withTenant(app.db, ctx.tenantId, (client) => listNotes(client, ctx.tenantId, userId)) })
  })

  app.get('/notes/categories', async (req, reply) => {
    const ctx = req.tenantCtx!
    const userId = req.user!.id
    return reply.send({ categories: await withTenant(app.db, ctx.tenantId, (client) => listCategories(client, ctx.tenantId, userId)) })
  })

  app.post('/notes/categories', async (req, reply) => {
    const ctx = req.tenantCtx!
    const userId = req.user!.id
    const body = (req.body || {}) as Record<string, unknown>
    const name = typeof body.name === 'string' ? body.name.trim() : ''
    if (!name || name.length > 60) throw AppError.badRequest('Category name is required and must be 60 characters or fewer')
    const color = typeof body.color === 'string' && COLORS.has(body.color) ? body.color : 'gray'
    try {
      return reply.code(201).send({ category: await withTenant(app.db, ctx.tenantId, (client) => createCategory(client, ctx.tenantId, userId, name, color)) })
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw AppError.conflict('That category already exists')
      throw error
    }
  })

  app.delete('/notes/categories/:id', async (req, reply) => {
    const ctx = req.tenantCtx!
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const deleted = await withTenant(app.db, ctx.tenantId, (client) => deleteCategory(client, ctx.tenantId, userId, id))
    if (!deleted) return reply.code(404).send({ error: 'Category not found' })
    return reply.send({ ok: true })
  })

  app.post('/notes', async (req, reply) => {
    const ctx = req.tenantCtx!
    const userId = req.user!.id
    const body = (req.body || {}) as Record<string, unknown>
    const imageData = typeof body.image_data === 'string' ? body.image_data : null
    if (imageData && (!imageData.startsWith('data:image/') || imageData.length > IMAGE_MAX)) throw AppError.badRequest('Image must be a valid image smaller than 1.5 MB')
    const note = await withTenant(app.db, ctx.tenantId, (client) => createNote(client, ctx.tenantId, userId, {
      title: body.title as string, body: body.body as string, color: body.color as string,
      category_id: body.category_id as string, image_data: imageData ?? undefined,
      position_x: body.position_x as number, position_y: body.position_y as number,
      width: body.width as number, height: body.height as number,
    }))
    return reply.send({ note })
  })

  app.patch('/notes/:id', async (req, reply) => {
    const ctx = req.tenantCtx!
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const body = (req.body || {}) as Record<string, unknown>
    const imageData = body.image_data === null ? null : typeof body.image_data === 'string' ? body.image_data : undefined
    if (imageData && (!imageData.startsWith('data:image/') || imageData.length > IMAGE_MAX)) throw AppError.badRequest('Image must be a valid image smaller than 1.5 MB')
    const note = await withTenant(app.db, ctx.tenantId, (client) => updateNote(client, ctx.tenantId, userId, Number(id), {
      title: body.title as string, body: body.body as string, color: body.color as string,
      category_id: body.category_id as string, image_data: imageData,
      position_x: body.position_x as number, position_y: body.position_y as number,
      width: body.width as number, height: body.height as number, is_pinned: body.is_pinned as boolean,
    }))
    if (!note) return reply.code(404).send({ error: 'Note not found' })
    return reply.send({ note })
  })

  app.delete('/notes/:id', async (req, reply) => {
    const ctx = req.tenantCtx!
    const userId = req.user!.id
    const { id } = req.params as { id: string }
    const deleted = await withTenant(app.db, ctx.tenantId, (client) => deleteNote(client, ctx.tenantId, userId, Number(id)))
    if (!deleted) return reply.code(404).send({ error: 'Note not found' })
    return reply.send({ ok: true })
  })
}
