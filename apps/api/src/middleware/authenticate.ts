import type { FastifyReply, FastifyRequest } from 'fastify'
import { verifyAccessToken } from '../core/auth/jwt.js'
import { AppError } from '../core/errors.js'
import '../types.js'

export async function authenticate(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const header = request.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    throw AppError.unauthorized('Missing bearer token')
  }
  const token = header.slice('Bearer '.length).trim()

  let payload
  try {
    payload = await verifyAccessToken(request.server.config, token)
  } catch {
    throw AppError.unauthorized('Invalid or expired token')
  }

  const { rows } = await request.server.db.query(
    'SELECT id, email, name, status FROM users WHERE id = $1',
    [payload.sub],
  )
  const user = rows[0]
  if (!user || user.status !== 'active') {
    throw AppError.unauthorized('Account is not active')
  }
  request.user = { id: user.id, email: user.email, name: user.name }
}
