import { randomBytes } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { recordAudit } from '../../core/audit.js'
import { AppError } from '../../core/errors.js'
import { notify } from '../../core/notify.js'
import { roleHasPermission } from '../../core/permissions.js'
import { withTenant, type DbPool } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { generateEnrolCode, hashToken } from '../devices/device-auth.js'
import { assertSessionPermission, sessionPermissions } from './remote.routes.js'
import '../../types.js'

const _DEFAULT_CODE_TTL_MS = 30 * 60_000

const createSchema = z.object({
  permissions: z.array(z.enum(sessionPermissions)).min(1).max(10).default(['view_screen']),
  reason: z.string().trim().max(500).optional(),
  expiresInMin: z.number().int().min(1).max(1440).default(30),
})

const claimSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  hostname: z.string().min(1).max(255).optional(),
  os: z.string().max(40).optional(),
  osVersion: z.string().max(80).optional(),
  arch: z.string().max(40).optional(),
})

interface AdhocRow {
  id: string
  tenant_id: string
  state: string
  permissions: string[]
  reason: string
  requested_by: string
  device_id: string | null
  remote_session_id: string | null
  expires_at: Date
}

/** Pre-tenant lookup by code hash, mirroring the device-token read path. */
async function findAdhocByCode(pool: DbPool, code: string): Promise<AdhocRow | undefined> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const codeHash = hashToken(code)
    await client.query("SELECT set_config('app.adhoc_code_hash', $1, true)", [codeHash])
    const { rows } = await client.query(
      `SELECT id, tenant_id, state, permissions, reason, requested_by,
              device_id, remote_session_id, expires_at
         FROM adhoc_sessions
        WHERE code_hash = $1
        LIMIT 1`,
      [codeHash],
    )
    await client.query('COMMIT')
    return rows[0] as AdhocRow | undefined
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* connection already broken */
    }
    throw err
  } finally {
    client.release()
  }
}

function publicAdhoc(
  row: AdhocRow,
  helperAvailable: boolean,
): { state: string; reason: string; permissions: string[]; helperAvailable: boolean } {
  return { state: row.state, reason: row.reason, permissions: row.permissions, helperAvailable }
}

/** Technician-facing route (registered under /api/v1). */
export async function adhocSessionRoutes(app: FastifyInstance): Promise<void> {
  app.post('/adhoc-sessions', { preHandler: [authenticate, requireTenant] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = createSchema.parse(request.body)
    assertSessionPermission(ctx.orgRole, 'attended', body.permissions, body.reason)

    const code = generateEnrolCode()
    const expiresAt = new Date(Date.now() + (body.expiresInMin ?? 30) * 60_000)
    const created = await withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `INSERT INTO adhoc_sessions (tenant_id, code_hash, permissions, reason, requested_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, tenant_id, permissions, reason, state, expires_at`,
        [ctx.tenantId, hashToken(code), body.permissions, body.reason ?? '', request.user!.id, expiresAt],
      )
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'session.adhoc.created',
        objectType: 'adhoc_session',
        objectId: res.rows[0].id,
        ip: request.ip,
        payload: { permissions: body.permissions },
      })
      return res.rows[0]
    })

    return reply.code(201).send({
      id: created.id,
      code,
      connectUrl: `${app.config.publicUrl}/connect/${code}`,
      expiresAt: created.expires_at,
    })
  })

  app.get('/adhoc-sessions', { preHandler: [authenticate, requireTenant] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    if (!roleHasPermission(ctx.orgRole, 'remote.attended')) {
      throw AppError.forbidden('Missing permission: remote.attended', 'missing_permission')
    }
    const result = await withTenant(app.db, ctx.tenantId, (client) =>
      client.query(
        `SELECT a.id, a.state, a.permissions, a.reason, a.expires_at, a.claimed_at, a.created_at,
                d.name AS device_name, a.remote_session_id, rs.state AS remote_session_state
           FROM adhoc_sessions a
           LEFT JOIN devices d ON d.id = a.device_id
           LEFT JOIN remote_sessions rs ON rs.id = a.remote_session_id
          ORDER BY a.created_at DESC
          LIMIT 100`,
      ),
    )
    return reply.send({ sessions: result.rows })
  })

  app.post('/adhoc-sessions/:id/revoke', { preHandler: [authenticate, requireTenant] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    if (!roleHasPermission(ctx.orgRole, 'remote.attended')) {
      throw AppError.forbidden('Missing permission: remote.attended', 'missing_permission')
    }
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params)
    const revoked = await withTenant(app.db, ctx.tenantId, async (client) => {
      const res = await client.query(
        `UPDATE adhoc_sessions
            SET state = 'expired', updated_at = now()
          WHERE id = $1 AND state = 'open'
          RETURNING id, state`,
        [id],
      )
      if (!res.rowCount) return null
      await recordAudit(client, ctx.tenantId, {
        actorType: 'user',
        actorId: request.user!.id,
        action: 'session.adhoc.revoked',
        objectType: 'adhoc_session',
        objectId: id,
        ip: request.ip,
      })
      return res.rows[0]
    })
    if (!revoked) throw AppError.conflict('This support code is not open and cannot be revoked.', 'not_open')
    return reply.send({ id: revoked.id, state: revoked.state })
  })
}

/** Public routes (registered at the root, no tenant auth). */
export async function connectRoutes(app: FastifyInstance): Promise<void> {
  app.get('/connect/:code', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request, reply) => {
    const { code } = request.params as { code: string }
    const row = await findAdhocByCode(app.db, code)
    if (!row) return reply.code(404).send({ error: { code: 'not_found', message: 'This support link is invalid or expired.' } })
    if (row.state !== 'open' || new Date(row.expires_at).getTime() <= Date.now()) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'This support link is invalid or expired.' } })
    }
    const helperAvailable = Boolean(app.config.helperBinaryPath && existsSync(app.config.helperBinaryPath))
    return reply.send(publicAdhoc(row, helperAvailable))
  })

  app.get(
    '/connect/:code/download',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { code } = request.params as { code: string }
      const row = await findAdhocByCode(app.db, code)
      if (!row || row.state !== 'open' || new Date(row.expires_at).getTime() <= Date.now()) {
        return reply
          .code(404)
          .send({ error: { code: 'not_found', message: 'This support link is invalid or expired.' } })
      }
      const binaryPath = app.config.helperBinaryPath
      if (!binaryPath || !existsSync(binaryPath)) {
        return reply.code(404).send({
          error: { code: 'helper_unavailable', message: 'The portable helper is not available yet.' },
        })
      }
      reply.header('Content-Type', 'application/octet-stream')
      reply.header('Content-Disposition', 'attachment; filename="deskos-helper.exe"')
      return reply.send(createReadStream(binaryPath))
    },
  )

  app.post(
    '/connect/:code/claim',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { code } = request.params as { code: string }
      const body = claimSchema.parse(request.body)
      const row = await findAdhocByCode(app.db, code)
      if (!row) throw AppError.notFound('This support link is invalid or expired.')
      if (new Date(row.expires_at).getTime() <= Date.now()) {
        throw AppError.notFound('This support link is invalid or expired.')
      }

      const deviceToken = `deskos_dev_${randomBytes(24).toString('base64url')}`
      const claimed = await withTenant(app.db, row.tenant_id, async (client) => {
        const consumed = await client.query(
          `UPDATE adhoc_sessions
              SET state = 'claimed', claimed_at = now(), updated_at = now()
            WHERE id = $1 AND state = 'open' AND expires_at > now()
           RETURNING id`,
          [row.id],
        )
        if (!consumed.rowCount) throw AppError.conflict('This support link is no longer available.', 'code_unavailable')

        const name = body.name ?? body.hostname ?? 'Ad-hoc support device'
        const device = (
          await client.query(
            `INSERT INTO devices
               (tenant_id, name, hostname, os, os_version, arch, ip_address, agent_version, agent_token_hash, last_seen_at)
             VALUES ($1, $2, $3, $4, $5, $6, '', '', $7, now())
             RETURNING id, name`,
            [row.tenant_id, name, body.hostname ?? '', body.os ?? '', body.osVersion ?? '', body.arch ?? '', hashToken(deviceToken)],
          )
        ).rows[0]

        const session = (
          await client.query(
            `INSERT INTO remote_sessions
               (tenant_id, device_id, type, state, permissions, reason, requested_by, recording_mode, recording_retention_days)
             VALUES ($1, $2, 'attended', 'consent_pending', $3, $4, $5, 'metadata', 30)
             RETURNING id, state`,
            [row.tenant_id, device.id, row.permissions, row.reason, row.requested_by],
          )
        ).rows[0]

        await client.query('UPDATE adhoc_sessions SET device_id = $2, remote_session_id = $3, updated_at = now() WHERE id = $1', [
          row.id,
          device.id,
          session.id,
        ])

        // Parity with the managed session-create path: the technician who
        // issued the code owns the resulting session, so the console's
        // participant list, invite, and transfer features work unchanged.
        await client.query(
          `INSERT INTO session_participants (tenant_id, session_id, user_id, role)
           VALUES ($1, $2, $3, 'owner')
           ON CONFLICT (session_id, user_id) DO UPDATE SET role = 'owner'`,
          [row.tenant_id, session.id, row.requested_by],
        )
        await client.query(
          `INSERT INTO session_events (tenant_id, session_id, actor_type, actor_id, event, payload)
           VALUES ($1, $2, 'agent', $3, 'session.created', $4)`,
          [row.tenant_id, session.id, device.id, JSON.stringify({ type: 'attended', adhoc: true, codeSessionId: row.id })],
        )

        await recordAudit(client, row.tenant_id, {
          actorType: 'agent',
          action: 'device.enrolled',
          objectType: 'device',
          objectId: device.id,
          ip: request.ip,
          payload: { name, adhoc: true, codeSessionId: row.id },
        })
        await notify(client, row.tenant_id, {
          userId: row.requested_by,
          kind: 'session.adhoc.claimed',
          subjectType: 'remote_session',
          subjectId: session.id,
          body: `Your support code was claimed by ${name}. Open the live session to connect.`,
        })
        return { device, session }
      })

      return reply.code(201).send({
        device: claimed.device,
        deviceToken,
        session: claimed.session,
        relayUrl: app.config.relayUrl,
      })
    },
  )
}
