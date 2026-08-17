import { randomBytes } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { withTenant, type DbClient } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { canManageSessions } from './remote.routes.js'
import '../../types.js'

async function addRecordingEvent(
  client: DbClient,
  tenantId: string,
  sessionId: string,
  event: string,
  actorId: string,
  payload: Record<string, unknown> = {},
): Promise<void> {
  await client.query(
    `INSERT INTO session_events (tenant_id, session_id, actor_type, actor_id, event, payload)
     VALUES ($1, $2, 'user', $3, $4, $5::jsonb)`,
    [tenantId, sessionId, actorId, event, JSON.stringify(payload)],
  )
}

/** Delete rows whose retention window has elapsed, removing files best-effort. */
async function purgeExpired(client: DbClient, dir: string, sessionId: string): Promise<void> {
  const { rows } = await client.query(
    `SELECT id, storage_key FROM session_recordings
      WHERE session_id = $1 AND expires_at IS NOT NULL AND expires_at <= now()`,
    [sessionId],
  )
  if (rows.length === 0) return
  for (const row of rows) {
    try {
      await unlink(path.join(dir, row.storage_key))
    } catch {
      /* the file may already be gone */
    }
  }
  await client.query('DELETE FROM session_recordings WHERE id = ANY($1::uuid[])', [rows.map((row) => row.id)])
}

export async function recordingRoutes(app: FastifyInstance): Promise<void> {
  const guards = [authenticate, requireTenant]

  app.post('/sessions/:id/recordings', { preHandler: guards }, async (request, reply) => {
    const ctx = request.tenantCtx!
    if (!canManageSessions(ctx.orgRole)) throw AppError.forbidden('Remote session access denied', 'missing_permission')
    const { id: sessionId } = request.params as { id: string }

    const session = await withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        'SELECT id, recording_mode, recording_retention_days FROM remote_sessions WHERE id = $1',
        [sessionId],
      )
      return rows[0]
    })
    if (!session) throw AppError.notFound('Session not found')
    if (session.recording_mode !== 'video') {
      throw new AppError(403, 'recording_not_enabled', 'This session does not permit video recording')
    }

    const part = await request.file({ limits: { fileSize: app.config.maxRecordingBytes } })
    if (!part) throw AppError.badRequest('No recording provided', 'missing_file')

    const storageKey = `recordings/${ctx.tenantId}/${randomBytes(16).toString('hex')}.webm`
    const fullPath = path.join(app.config.recordingDir, storageKey)
    await mkdir(path.dirname(fullPath), { recursive: true })

    let size = 0
    const counting = async function* () {
      for await (const chunk of part.file) {
        size += chunk.length
        if (size > app.config.maxRecordingBytes) throw AppError.badRequest('Recording exceeds the size limit', 'file_too_large')
        yield chunk
      }
    }
    await pipeline(counting(), createWriteStream(fullPath))

    const durationSec = Math.max(0, Math.round(Number((request.query as { durationSec?: string }).durationSec ?? 0)))
    const recording = await withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `INSERT INTO session_recordings
           (tenant_id, session_id, recorded_by, storage_key, mime, size_bytes, duration_sec, started_at, ended_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::int, now() - make_interval(secs => $7::int), now(), now() + make_interval(days => $8::int))
         RETURNING id, session_id, mime, size_bytes, duration_sec, created_at, expires_at`,
        [ctx.tenantId, sessionId, request.user!.id, storageKey, part.mimetype || 'video/webm', size, durationSec, session.recording_retention_days],
      )
      const row = res.rows[0]
      await addRecordingEvent(client, ctx.tenantId, sessionId, 'session.recording.uploaded', request.user!.id, {
        sizeBytes: size,
        durationSec,
      })
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'session.recording.uploaded',
        objectType: 'remote_session',
        objectId: sessionId,
        ip: request.ip,
        payload: { recordingId: row.id, sizeBytes: size, durationSec },
      })
      return { ...row, size_bytes: Number(row.size_bytes) }
    })

    return reply.code(201).send({ recording })
  })

  app.get('/sessions/:id/recordings', { preHandler: guards }, async (request) => {
    const ctx = request.tenantCtx!
    if (!canManageSessions(ctx.orgRole)) throw AppError.forbidden('Remote session access denied', 'missing_permission')
    const { id: sessionId } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      await purgeExpired(client, app.config.recordingDir, sessionId)
      const { rows } = await client.query(
        `SELECT id, session_id, mime, size_bytes, duration_sec, created_at, expires_at
           FROM session_recordings WHERE session_id = $1 ORDER BY created_at ASC`,
        [sessionId],
      )
      return { recordings: rows.map((row) => ({ ...row, size_bytes: Number(row.size_bytes) })) }
    })
  })

  app.get('/sessions/:id/recordings/:recordingId', { preHandler: guards }, async (request, reply) => {
    const ctx = request.tenantCtx!
    if (!canManageSessions(ctx.orgRole)) throw AppError.forbidden('Remote session access denied', 'missing_permission')
    const { id: sessionId, recordingId } = request.params as { id: string; recordingId: string }

    const recording = await withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT storage_key, mime, expires_at FROM session_recordings WHERE id = $1 AND session_id = $2`,
        [recordingId, sessionId],
      )
      return rows[0]
    })
    if (!recording) throw AppError.notFound('Recording not found')
    if (recording.expires_at && new Date(recording.expires_at).getTime() <= Date.now()) {
      throw AppError.notFound('Recording has expired')
    }

    const fullPath = path.join(app.config.recordingDir, recording.storage_key)
    try {
      await stat(fullPath)
    } catch {
      throw AppError.notFound('Recording file missing from storage')
    }
    return reply
      .header('content-type', recording.mime || 'video/webm')
      .header('content-disposition', `attachment; filename="deskos-session-${sessionId}.webm"`)
      .send(createReadStream(fullPath))
  })
}
