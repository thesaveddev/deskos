import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../core/errors.js'
import { roleHasAll, type Permission } from '../core/permissions.js'
import '../types.js'

/**
 * Route-level RBAC gate. Requires an authenticated request with a resolved
 * tenant context (register after authenticate + requireTenant). Denials carry
 * a machine-readable denied_reason so the UI can explain the disabled state.
 */
export function requirePermission(...permissions: Permission[]) {
  return async function check(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    if (!request.user) throw AppError.unauthorized()
    if (!request.tenantCtx) {
      throw AppError.badRequest('Tenant context required', 'tenant_context_missing')
    }
    if (!roleHasAll(request.tenantCtx.orgRole, permissions)) {
      throw AppError.forbidden(
        `Missing permission: ${permissions.join(', ')}`,
        'missing_permission',
      )
    }
  }
}
