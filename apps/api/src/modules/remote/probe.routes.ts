import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { AppError } from '../../core/errors.js'
import { roleHasPermission } from '../../core/permissions.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { buildIceServers, mintTurnCredential } from '../../core/ice.js'
import { createRelayTicket } from './relay-ticket.js'
import '../../types.js'

export async function probeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/probe/turn-config', { preHandler: [authenticate, requireTenant] }, async (request) => {
    const ctx = request.tenantCtx!
    if (!roleHasPermission(ctx.orgRole, 'remote.attended')) throw AppError.forbidden('Remote probe access denied', 'missing_permission')
    const configured = app.config.ice.turnUrls.length > 0 && app.config.ice.turnSharedSecret.length > 0
    const credential = configured ? mintTurnCredential(app.config.ice) : null
    return {
      ok: configured,
      configured,
      turnUrls: app.config.ice.turnUrls,
      iceServers: buildIceServers(app.config.ice),
      credentialExpiresAt: credential ? new Date(Number(credential.username.split(':')[0]) * 1000).toISOString() : null,
      note: configured ? 'TURN credentials were minted. The browser probe will now verify relay allocation.' : 'TURN is not configured on this deployment.',
    }
  })

  app.post('/probe/attended-session', { preHandler: [authenticate, requireTenant] }, async (request, reply) => {
    const ctx = request.tenantCtx!
    if (!roleHasPermission(ctx.orgRole, 'remote.attended') || !roleHasPermission(ctx.orgRole, 'remote.control')) {
      throw AppError.forbidden('Missing permission: remote.attended + remote.control', 'missing_permission')
    }
    const started = process.hrtime.bigint()
    const client = await app.db.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [ctx.tenantId])
      const deviceId = randomUUID()
      const sessionId = randomUUID()
      await client.query(`INSERT INTO devices (tenant_id, id, name, hostname, os, last_seen_at) VALUES ($1, $2, '[synthetic probe]', '[synthetic probe]', 'windows', now())`, [ctx.tenantId, deviceId])
      await client.query(`INSERT INTO remote_sessions (tenant_id, id, device_id, type, state, permissions, reason, requested_by) VALUES ($1, $2, $3, 'attended', 'consent_pending', $4, '[synthetic probe]', $5)`, [ctx.tenantId, sessionId, deviceId, ['view_screen', 'control_input'], request.user!.id])
      await client.query(`INSERT INTO session_participants (tenant_id, session_id, user_id, role) VALUES ($1, $2, $3, 'owner')`, [ctx.tenantId, sessionId, request.user!.id])
      const ticket = createRelayTicket(app.config.relaySecret, sessionId, 'technician')
      await client.query(`INSERT INTO session_join_tokens (tenant_id, session_id, audience, token_hash, expires_at) VALUES ($1, $2, 'technician', $3, $4)`, [ctx.tenantId, sessionId, ticket.hash, ticket.expiresAt])
      const durationMs = Math.round(Number(process.hrtime.bigint() - started) / 1e6)
      app.metrics.observeSyntheticProbe('attended_session', true)
      await client.query('ROLLBACK')
      return reply.send({ ok: true, check: 'attended_session', joinTokenIssued: true, durationMs })
    } catch (error) {
      try { await client.query('ROLLBACK') } catch { /* connection already broken */ }
      app.metrics.observeSyntheticProbe('attended_session', false)
      throw error
    } finally { client.release() }
  })
}
