import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../core/errors.js'
import { isOrgRole } from '../core/permissions.js'
import '../types.js'

/**
 * Resolve the active tenant for the request.
 * Tenant is selected via the X-DeskOS-Tenant header (uuid or slug); when the
 * user belongs to exactly one tenant the header may be omitted. Membership is
 * verified here — being logged in never implies tenant access.
 */
export async function requireTenant(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  if (!request.user) throw AppError.unauthorized()

  const header = request.headers['x-deskos-tenant']
  const selector = Array.isArray(header) ? header[0] : header

  const { rows } = await request.server.db.query(
    `SELECT m.id AS membership_id, m.org_role, m.status,
            t.id AS tenant_id, t.slug, t.name
       FROM memberships m
       JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1`,
    [request.user.id],
  )
  const active = rows.filter((r) => r.status === 'active')

  if (active.length === 0) {
    throw AppError.forbidden('No active membership', 'no_membership')
  }

  let chosen
  if (selector) {
    chosen = active.find((r) => r.tenant_id === selector || r.slug === selector)
    if (!chosen) {
      throw AppError.forbidden('Not a member of this tenant', 'tenant_not_member')
    }
  } else if (active.length === 1) {
    chosen = active[0]
  } else {
    throw AppError.badRequest(
      'X-DeskOS-Tenant header is required when you belong to multiple tenants',
      'tenant_ambiguous',
    )
  }

  if (!isOrgRole(chosen.org_role)) {
    throw AppError.forbidden('Membership has an unknown role', 'unknown_role')
  }

  request.tenantCtx = {
    tenantId: chosen.tenant_id,
    userId: request.user.id,
    slug: chosen.slug,
    name: chosen.name,
    orgRole: chosen.org_role,
    membershipId: chosen.membership_id,
  }
}
