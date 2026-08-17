import type { FastifyInstance } from 'fastify'
import { requireAuth } from '../../middleware/requireAuth.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { listNotes, createNote, updateNote, deleteNote } from './notes.service.js'

export async function notesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)
  app.addHook('preHandler', requireTenant)

  // List my notes
  app.get('/notes', async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const notes = await listNotes(app.db, ctx.tenantId, ctx.userId)
    return reply.send({ notes })
  })

  // Create note
  app.post('/notes', async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const body = (req.body || {}) as Record<string, unknown>
    const note = await createNote(app.db, ctx.tenantId, ctx.userId, {
      title: body.title as string,
      body: body.body as string,
      color: body.color as string,
      position_x: body.position_x as number,
      position_y: body.position_y as number,
      width: body.width as number,
      height: body.height as number,
    })
    return reply.send({ note })
  })

  // Update note
  app.patch('/notes/:id', async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const body = (req.body || {}) as Record<string, unknown>
    const note = await updateNote(app.db, ctx.tenantId, ctx.userId, Number(id), {
      title: body.title as string,
      body: body.body as string,
      color: body.color as string,
      position_x: body.position_x as number,
      position_y: body.position_y as number,
      width: body.width as number,
      height: body.height as number,
      is_pinned: body.is_pinned as boolean,
    })
    if (!note) return reply.code(404).send({ error: 'Note not found' })
    return reply.send({ note })
  })

  // Delete note
  app.delete('/notes/:id', async (req, reply) => {
    const ctx = (req as any).tenantCtx
    const { id } = req.params as { id: string }
    const deleted = await deleteNote(app.db, ctx.tenantId, ctx.userId, Number(id))
    if (!deleted) return reply.code(404).send({ error: 'Note not found' })
    return reply.send({ ok: true })
  })
}
