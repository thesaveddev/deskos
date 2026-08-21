import { createHash, randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { recordAudit } from '../../core/audit.js'
import { notifyInTxn } from '../../core/notify.js'
import { AppError } from '../../core/errors.js'
import { isOrgRole, ORG_ROLES, type OrgRole } from '../../core/permissions.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import '../../types.js'

const inviteSchema = z.object({
  email: z.string().email().max(320),
  name: z.string().min(1).max(200).optional(),
  orgRole: z.string().refine(isOrgRole, { message: 'invalid role' }),
})

const updateSchema = z.object({
  orgRole: z.string().refine(isOrgRole, { message: 'invalid role' }).optional(),
  status: z.enum(['active', 'invited', 'disabled']).optional(),
})

async function countOwners(app: FastifyInstance, tenantId: string): Promise<number> {
  const { rows } = await app.db.query(
    `SELECT count(*)::int AS n FROM memberships
      WHERE tenant_id = $1 AND org_role = 'owner' AND status = 'active'`,
    [tenantId],
  )
  return rows[0].n
}

function hashInvitationToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function memberRoutes(app: FastifyInstance): Promise<void> {
  const guards = [authenticate, requireTenant] as const

  app.get('/members', { preHandler: [...guards, requirePermission('member.read')] }, async (request) => {
    const ctx = request.tenantCtx!
    const query = request.query as { q?: string; mfa?: 'enabled' | 'disabled'; status?: string }
    const values: unknown[] = [ctx.tenantId]
    const clauses = ['m.tenant_id = $1']
    if (query.q?.trim()) {
      values.push(`%${query.q.trim()}%`)
      clauses.push(`(u.name ILIKE $${values.length} OR u.email ILIKE $${values.length})`)
    }
    if (query.mfa === 'enabled' || query.mfa === 'disabled') {
      values.push(query.mfa === 'enabled')
      clauses.push(`u.mfa_enabled = $${values.length}`)
    }
    if (query.status && ['active', 'invited', 'disabled'].includes(query.status)) {
      values.push(query.status)
      clauses.push(`m.status = $${values.length}`)
    }
    const { rows } = await app.db.query(
      `SELECT m.id AS membership_id, m.org_role, m.status, m.created_at,
              u.id AS user_id, u.email, u.name, u.status AS user_status,
              u.mfa_enabled, u.webauthn_enabled,
              (SELECT count(*)::int FROM device_assignments da WHERE da.user_id = u.id AND da.ended_at IS NULL) AS assigned_device_count
         FROM memberships m
         JOIN users u ON u.id = m.user_id
        WHERE ${clauses.join(' AND ')}
        ORDER BY m.created_at`,
      values,
    )
    return { members: rows }
  })

  app.post('/members/invite', { preHandler: [...guards, requirePermission('member.manage')] }, async (request) => {
    const ctx = request.tenantCtx!
    const body = inviteSchema.parse(request.body)
    const role = body.orgRole as OrgRole
    if (role === 'owner') throw AppError.badRequest('Cannot invite an owner; promote an existing member instead', 'owner_invite')

    const existingUser = (await app.db.query('SELECT id, status FROM users WHERE email = $1', [body.email])).rows[0]
    const existingMembership = existingUser
      ? (await app.db.query('SELECT id FROM memberships WHERE tenant_id = $1 AND user_id = $2', [ctx.tenantId, existingUser.id])).rows[0]
      : undefined
    if (existingMembership) throw AppError.conflict('User is already a member', 'already_member')

    let userId: string
    let membershipStatus: 'active' | 'invited'
    if (existingUser) {
      userId = existingUser.id
      membershipStatus = existingUser.status === 'active' ? 'active' : 'invited'
    } else {
      const created = await app.db.query(
        `INSERT INTO users (email, name, status) VALUES ($1, $2, 'invited') RETURNING id`,
        [body.email, body.name ?? body.email.split('@')[0]],
      )
      userId = created.rows[0].id
      membershipStatus = 'invited'
    }

    const membership = await app.db.query(
      `INSERT INTO memberships (tenant_id, user_id, org_role, status, invited_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [ctx.tenantId, userId, role, membershipStatus, request.user!.id],
    )

    await withTenant(app.db, ctx.tenantId, async (client) => {
      await recordAudit(client, ctx.tenantId, {
        actorId: request.user!.id,
        action: 'member.invited',
        objectType: 'membership',
        objectId: membership.rows[0].id,
        ip: request.ip,
        userAgent: request.headers['user-agent'],
        payload: { email: body.email, orgRole: role },
      })
    })
    const invitationToken = randomBytes(32).toString('hex')
    await app.db.query(
      `INSERT INTO organisation_invitations (tenant_id, membership_id, user_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4, now() + interval '7 days')`,
      [ctx.tenantId, membership.rows[0].id, userId, hashInvitationToken(invitationToken)],
    )

    await notifyInTxn(app.db, ctx.tenantId, {
      userId,
      kind: 'membership.invited',
      subjectType: 'tenant',
      subjectId: ctx.tenantId,
      body: `You were invited to ${ctx.name} as ${role}`,
    })

    const inviteUrl = `${app.config.publicUrl}/accept-invitation?token=${encodeURIComponent(invitationToken)}`
    const jobId = await app.emailQueue.addAndSend(app.mailer.buildInvitationMail({
      to: body.email,
      tenantName: ctx.name,
      role,
      inviteUrl,
      expiresInDays: 7,
    }))
    app.log.info({ membershipId: membership.rows[0].id, jobId, mailConfigured: app.mailer.enabled }, 'Organisation invitation email queued')

    return { membershipId: membership.rows[0].id, userId, status: membershipStatus, orgRole: role }
  })

  app.patch('/members/:membershipId', { preHandler: [...guards, requirePermission('member.manage')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { membershipId } = request.params as { membershipId: string }
    const body = updateSchema.parse(request.body)

    const current = (
      await app.db.query('SELECT id, org_role, status, user_id FROM memberships WHERE id = $1 AND tenant_id = $2', [membershipId, ctx.tenantId])
    ).rows[0]
    if (!current) throw AppError.notFound('Membership not found')

    if (current.org_role === 'owner' && (body.orgRole !== undefined && body.orgRole !== 'owner' || body.status === 'disabled')) {
      const owners = await countOwners(app, ctx.tenantId)
      if (owners <= 1) throw AppError.conflict('Cannot demote or disable the last owner', 'last_owner')
    }

    const sets: string[] = []
    const values: unknown[] = []
    if (body.orgRole !== undefined) {
      values.push(body.orgRole)
      sets.push(`org_role = $${values.length}`)
    }
    if (body.status !== undefined) {
      values.push(body.status)
      sets.push(`status = $${values.length}`)
    }
    if (sets.length === 0) throw AppError.badRequest('Nothing to update')
    values.push(membershipId)
    await app.db.query(`UPDATE memberships SET ${sets.join(', ')} WHERE id = $${values.length}`, values)

    await withTenant(app.db, ctx.tenantId, (client) =>
      recordAudit(client, ctx.tenantId, {
        actorId: request.user!.id,
        action: 'member.updated',
        objectType: 'membership',
        objectId: membershipId,
        ip: request.ip,
        payload: { changes: body },
      }),
    )
    return { ok: true }
  })

  // ── Admin: Reset user MFA ──
  app.post('/members/:membershipId/reset-mfa', { preHandler: [...guards, requirePermission('member.manage')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { membershipId } = request.params as { membershipId: string }
    const current = (
      await app.db.query('SELECT id, user_id FROM memberships WHERE id = $1 AND tenant_id = $2', [membershipId, ctx.tenantId])
    ).rows[0]
    if (!current) throw AppError.notFound('Membership not found')

    await app.db.query(
      `UPDATE users SET mfa_enabled = false, mfa_secret = NULL WHERE id = $1`,
      [current.user_id],
    )
    await app.db.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [current.user_id])
    await app.db.query('UPDATE mfa_setup_tokens SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [current.user_id])
    await app.db.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [current.user_id])

    await withTenant(app.db, ctx.tenantId, (client) =>
      recordAudit(client, ctx.tenantId, {
        actorId: request.user!.id,
        action: 'member.mfa_reset',
        objectType: 'user',
        objectId: current.user_id,
        ip: request.ip,
      }),
    )
    return { ok: true }
  })

  // ── Admin: Reset user passkeys ──
  app.post('/members/:membershipId/reset-passkeys', { preHandler: [...guards, requirePermission('member.manage')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { membershipId } = request.params as { membershipId: string }
    const current = (
      await app.db.query('SELECT id, user_id FROM memberships WHERE id = $1 AND tenant_id = $2', [membershipId, ctx.tenantId])
    ).rows[0]
    if (!current) throw AppError.notFound('Membership not found')

    await app.db.query('DELETE FROM webauthn_credentials WHERE user_id = $1', [current.user_id])
    await app.db.query('UPDATE users SET webauthn_enabled = false WHERE id = $1', [current.user_id])

    await withTenant(app.db, ctx.tenantId, (client) =>
      recordAudit(client, ctx.tenantId, {
        actorId: request.user!.id,
        action: 'member.passkeys_reset',
        objectType: 'user',
        objectId: current.user_id,
        ip: request.ip,
      }),
    )
    return { ok: true }
  })

  // ── Admin: Remove one passkey from one org member ──
  app.delete('/members/:membershipId/passkeys/:credentialId', { preHandler: [...guards, requirePermission('member.manage')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { membershipId, credentialId } = request.params as { membershipId: string; credentialId: string }
    const current = (await app.db.query(
      'SELECT user_id FROM memberships WHERE id = $1 AND tenant_id = $2',
      [membershipId, ctx.tenantId],
    )).rows[0]
    if (!current) throw AppError.notFound('Membership not found')

    const removed = (await app.db.query(
      'DELETE FROM webauthn_credentials WHERE id = $1 AND user_id = $2 RETURNING id',
      [credentialId, current.user_id],
    )).rows[0]
    if (!removed) throw AppError.notFound('Passkey not found')

    const remaining = await app.db.query('SELECT 1 FROM webauthn_credentials WHERE user_id = $1 LIMIT 1', [current.user_id])
    if (remaining.rowCount === 0) await app.db.query('UPDATE users SET webauthn_enabled = false WHERE id = $1', [current.user_id])
    await withTenant(app.db, ctx.tenantId, (client) =>
      recordAudit(client, ctx.tenantId, {
        actorId: request.user!.id,
        action: 'member.passkey_removed',
        objectType: 'webauthn_credential',
        objectId: credentialId,
        ip: request.ip,
        payload: { userId: current.user_id },
      }),
    )
    return { ok: true }
  })

  // ── Admin: List all passkeys across org users ──
  app.get('/members/all-passkeys', { preHandler: [...guards, requirePermission('member.manage')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { rows } = await app.db.query(
      `SELECT wc.id AS credential_id, m.id AS membership_id, wc.device_name, wc.created_at, wc.last_used_at,
              u.id AS user_id, u.name AS user_name, u.email AS user_email
         FROM webauthn_credentials wc
         JOIN users u ON u.id = wc.user_id
         JOIN memberships m ON m.user_id = u.id AND m.tenant_id = $1
        ORDER BY wc.created_at DESC`,
      [ctx.tenantId],
    )
    return { passkeys: rows }
  })

  app.delete('/members/:membershipId', { preHandler: [...guards, requirePermission('member.manage')] }, async (request) => {
    const ctx = request.tenantCtx!
    const { membershipId } = request.params as { membershipId: string }
    const current = (
      await app.db.query('SELECT id, org_role FROM memberships WHERE id = $1 AND tenant_id = $2', [membershipId, ctx.tenantId])
    ).rows[0]
    if (!current) throw AppError.notFound('Membership not found')

    if (current.org_role === 'owner') {
      const owners = await countOwners(app, ctx.tenantId)
      if (owners <= 1) throw AppError.conflict('Cannot remove the last owner', 'last_owner')
    }

    await app.db.query('DELETE FROM memberships WHERE id = $1', [membershipId])
    await withTenant(app.db, ctx.tenantId, (client) =>
      recordAudit(client, ctx.tenantId, {
        actorId: request.user!.id,
        action: 'member.removed',
        objectType: 'membership',
        objectId: membershipId,
        ip: request.ip,
      }),
    )
    return { ok: true }
  })
}

export const AVAILABLE_ROLES = ORG_ROLES
