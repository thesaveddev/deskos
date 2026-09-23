import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../core/errors.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { findCredentialByToken } from './identity-credentials.js'
import '../../types.js'

/** Authenticate either a normal staff JWT or a scoped AI worker credential. */
export async function authenticateExternalAi(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const apiKey = request.headers['x-reydesk-api-key']
  const authorization = request.headers.authorization
  const rawToken = typeof apiKey === 'string' ? apiKey : authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : ''
  if (!rawToken) throw AppError.unauthorized('Missing external AI credential')

  if (!rawToken.startsWith('reydesk_ai_')) {
    await authenticate(request, reply)
    await requireTenant(request, reply)
    return
  }

  const tenantHeader = request.headers['x-reydesk-tenant']
  const tenantSelector = Array.isArray(tenantHeader) ? tenantHeader[0] : tenantHeader
  if (!tenantSelector) throw AppError.badRequest('X-ReyDesk-Tenant is required for an AI worker credential', 'tenant_required')
  const tenant = (await request.server.db.query(
    'SELECT id, slug, name FROM tenants WHERE id = $1 OR slug = $1',
    [tenantSelector],
  )).rows[0]
  if (!tenant) throw AppError.unauthorized('Unknown tenant')

  const credential = await findCredentialByToken(request.server.db, tenant.id, rawToken)
  if (!credential) throw AppError.unauthorized('Invalid, expired, or revoked AI worker credential')
  const playbook = await withTenant(request.server.db, tenant.id, async (client) => {
    const result = await client.query(
      'SELECT enabled, identity_status, allowed_tools FROM ai_playbooks WHERE id = $1 AND tenant_id = $2',
      [credential.playbook_id, tenant.id],
    )
    return result.rows[0]
  })
  if (!playbook || !playbook.enabled || playbook.identity_status !== 'active') {
    throw AppError.forbidden('The AI worker identity is not enabled', 'ai_worker_identity_disabled')
  }

  request.user = {
    id: credential.created_by ?? credential.id,
    email: `ai-worker:${credential.token_prefix}`,
    name: credential.name,
  }
  request.tenantCtx = {
    tenantId: tenant.id,
    userId: request.user.id,
    slug: tenant.slug,
    name: tenant.name,
    orgRole: 'owner',
    membershipId: credential.id,
  }
  request.aiCredential = {
    id: credential.id,
    playbookId: credential.playbook_id,
    allowedTools: Array.isArray(playbook.allowed_tools) ? playbook.allowed_tools : [],
  }
}
