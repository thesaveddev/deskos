import { readFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../src/app.js'
import { loadConfig } from '../src/config.js'
import { hashPassword } from '../src/core/auth/password.js'
import { signAccessToken } from '../src/core/auth/jwt.js'
import type { OrgRole } from '../src/core/permissions.js'
import { withTenant } from '../src/db/pool.js'
import { DB_URL_FILE } from './global-setup.js'

export function getDatabaseUrl(): string {
  const raw = readFileSync(DB_URL_FILE, 'utf8')
  return (JSON.parse(raw) as { databaseUrl: string }).databaseUrl
}

export async function createTestApp(
  env: NodeJS.ProcessEnv = {},
  decorate?: (app: FastifyInstance) => void,
): Promise<FastifyInstance> {
  const config = loadConfig({
    NODE_ENV: 'test',
    DATABASE_URL: getDatabaseUrl(),
    REYDESK_JWT_SECRET: 'unit-test-secret-0123456789abcdef0123456789abcdef',
    REYDESK_EMAIL_KEY: 'unit-test-email-key-0123456789abcdef0123456789abcdef',
    ...env,
  } as NodeJS.ProcessEnv)
  const app = await buildApp(config)
  decorate?.(app)
  await app.ready()
  return app
}

export function uniqueEmail(prefix: string): string {
  return `${prefix}-${randomBytes(6).toString('hex')}@example.com`
}

export interface Session {
  accessToken: string
  refreshToken: string
  userId: string
  tenantId?: string
  tenantSlug?: string
}

export async function signupOwner(
  app: FastifyInstance,
  opts?: { email?: string; tenantName?: string; password?: string; name?: string },
): Promise<Session & { email: string }> {
  const email = opts?.email ?? uniqueEmail('owner')
  const password = opts?.password ?? 'correct-horse-battery-9'
  const name = opts?.name ?? 'Test Owner'
  const tenantName = opts?.tenantName ?? `Org ${randomBytes(3).toString('hex')}`

  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/signup',
    payload: { email, password, name, tenantName },
  })
  if (res.statusCode !== 201) {
    throw new Error(`signup failed (${res.statusCode}): ${res.body}`)
  }
  const body = res.json()
  return {
    email,
    accessToken: body.accessToken,
    refreshToken: body.refreshToken,
    userId: body.user.id,
    tenantId: body.tenant.id,
    tenantSlug: body.tenant.slug,
  }
}

export function authHeaders(session: Session, tenant?: string): Record<string, string> {
  const headers: Record<string, string> = { authorization: `Bearer ${session.accessToken}` }
  if (tenant) headers['x-reydesk-tenant'] = tenant
  return headers
}

/**
 * Create an active user with the given role inside an existing tenant and issue
 * an access token directly (no login round-trip, no rate-limit interaction).
 */
export async function seedActiveMember(
  app: FastifyInstance,
  tenantId: string,
  role: OrgRole,
): Promise<Session & { email: string }> {
  const email = uniqueEmail(role)
  const password = 'member-password-12345'
  const hash = await hashPassword(password, 4)
  const userRes = await app.db.query(
    `INSERT INTO users (email, password_hash, name, status) VALUES ($1, $2, $3, 'active') RETURNING id`,
    [email, hash, `${role} user`],
  )
  const userId = userRes.rows[0].id as string
  await app.db.query(
    `INSERT INTO memberships (tenant_id, user_id, org_role, status) VALUES ($1, $2, $3, 'active')`,
    [tenantId, userId, role],
  )
  const accessToken = await signAccessToken(app.config, userId, randomBytes(16).toString('hex'))
  return { email, userId, accessToken, refreshToken: 'unused', tenantId }
}

/** Seed a notification for a user within a tenant (writes through RLS). */
export async function seedNotification(
  app: FastifyInstance,
  tenantId: string,
  userId: string,
  body: string,
): Promise<string> {
  return withTenant(app.db, tenantId, async (client) => {
    const res = await client.query(
      `INSERT INTO notifications (tenant_id, user_id, kind, body) VALUES ($1, $2, 'test', $3) RETURNING id`,
      [tenantId, userId, body],
    )
    return res.rows[0].id as string
  })
}
