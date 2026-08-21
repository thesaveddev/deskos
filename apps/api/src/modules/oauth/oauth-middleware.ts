import type { FastifyReply, FastifyRequest } from 'fastify'
import { AppError } from '../../core/errors.js'
import { scopesToPermissions } from './scopes.js'
import { verifyOAuthToken } from './token.js'

/** Authenticate an OAuth2 bearer access token and populate request.oauthCtx. */
export async function authenticateOAuth(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization
  if (!header || !header.startsWith('Bearer ')) throw AppError.unauthorized('Missing OAuth bearer token')
  const token = header.slice('Bearer '.length).trim()
  try {
    const payload = await verifyOAuthToken(request.server.config, token)
    request.oauthCtx = {
      clientId: payload.clientId,
      tenantId: payload.tenantId,
      scopes: payload.scopes,
      userId: payload.sub,
    }
  } catch {
    throw AppError.unauthorized('Invalid or expired OAuth token', 'invalid_token')
  }
}

/** Require the token to grant a ReyDesk permission (via scope mapping). */
export function requireOAuthScope(permission: string) {
  return async (request: FastifyRequest): Promise<void> => {
    const ctx = request.oauthCtx
    if (!ctx) throw AppError.unauthorized('Missing OAuth context')
    if (!scopesToPermissions(ctx.scopes).includes(permission)) {
      throw AppError.forbidden(`Token does not grant ${permission}`, 'insufficient_scope')
    }
  }
}
