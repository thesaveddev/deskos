import { randomBytes } from 'node:crypto'
import { AppError } from '../../core/errors.js'
import { permissionsForRole, type OrgRole } from '../../core/permissions.js'
import type { AppConfig } from '../../config.js'
import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'
import { generateClientSecret, hashSecret, isScopeSubset, scopesToPermissions, VALID_SCOPES, verifyPkce } from './scopes.js'
import { signOAuthToken } from './token.js'

export interface ClientInput {
  name: string
  redirectUris?: string[]
  scopes?: string[]
  grantTypes?: ('client_credentials' | 'authorization_code')[]
  enabled?: boolean
}

export interface OAuthClientRow {
  id: string
  tenant_id: string
  name: string
  client_secret_hash: string
  redirect_uris: string[]
  scopes: string[]
  grant_types: string[]
  enabled: boolean
}

interface AuthCodeRow {
  id: string
  tenant_id: string
  client_id: string
  user_id: string
  scopes: string[]
  code_challenge: string
  redirect_uri: string
}

function maskClient(row: Record<string, unknown>): Record<string, unknown> {
  return {
    id: row.id,
    name: row.name,
    redirectUris: row.redirect_uris,
    scopes: row.scopes,
    grantTypes: row.grant_types,
    enabled: row.enabled,
    createdAt: row.created_at,
  }
}

function assertScopes(scopes: string[]): void {
  if (!scopes.length) throw AppError.badRequest('At least one scope is required', 'invalid_scope')
  if (!isScopeSubset(scopes, VALID_SCOPES)) throw AppError.badRequest('Unknown scope', 'invalid_scope')
}

export async function createClient(
  pool: DbPool,
  tenantId: string,
  input: ClientInput,
  actorId: string,
): Promise<{ client: Record<string, unknown>; clientSecret: string }> {
  const scopes = input.scopes ?? ['tickets:read']
  const grantTypes = input.grantTypes ?? ['client_credentials']
  assertScopes(scopes)
  const secret = generateClientSecret()
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO oauth_clients (tenant_id, name, client_secret_hash, redirect_uris, scopes, grant_types, enabled, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [tenantId, input.name, hashSecret(secret), input.redirectUris ?? [], scopes, grantTypes, input.enabled ?? true, actorId],
    )
    return { client: maskClient(rows[0]), clientSecret: secret }
  })
}

export async function listClients(pool: DbPool, tenantId: string): Promise<Record<string, unknown>[]> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query('SELECT * FROM oauth_clients ORDER BY created_at')
    return rows.map((r: Record<string, unknown>) => maskClient(r))
  })
}

export async function deleteClient(pool: DbPool, tenantId: string, id: string): Promise<void> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query('DELETE FROM oauth_clients WHERE id = $1 RETURNING id', [id])
    if (!rows[0]) throw AppError.notFound('OAuth client not found')
  })
}

/** Public (pre-tenant) client lookup by id + secret hash, via the RLS lookup policy. */
async function findClientBySecret(pool: DbPool, clientId: string, secret: string): Promise<OAuthClientRow | undefined> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.oauth_client_lookup', 'on', true)")
    const { rows } = await client.query(
      'SELECT * FROM oauth_clients WHERE id = $1 AND client_secret_hash = $2 AND enabled = true',
      [clientId, hashSecret(secret)],
    )
    await client.query('COMMIT')
    return rows[0] as OAuthClientRow | undefined
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* connection broken */
    }
    throw err
  } finally {
    client.release()
  }
}

export async function authorize(
  pool: DbPool,
  tenantId: string,
  userRole: OrgRole,
  userId: string,
  input: { clientId: string; redirectUri: string; codeChallenge: string; scopes: string[] },
): Promise<{ code: string; redirectUri: string }> {
  assertScopes(input.scopes)
  const userPermissions = permissionsForRole(userRole)
  const grantedPermissions = scopesToPermissions(input.scopes)
  if (!grantedPermissions.every((p) => userPermissions.includes(p as (typeof userPermissions)[number]))) {
    throw AppError.forbidden('Requested scope exceeds your permissions')
  }

  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query('SELECT * FROM oauth_clients WHERE id = $1 AND enabled = true', [input.clientId])
    const oauthClient = rows[0] as OAuthClientRow | undefined
    if (!oauthClient) throw AppError.notFound('OAuth client not found')
    if (!oauthClient.grant_types.includes('authorization_code')) {
      throw AppError.badRequest('Client does not allow the authorization code grant', 'unsupported_grant')
    }
    if (!oauthClient.redirect_uris.includes(input.redirectUri)) {
      throw AppError.badRequest('Redirect URI not registered for this client', 'invalid_redirect_uri')
    }
    if (!isScopeSubset(input.scopes, oauthClient.scopes)) {
      throw AppError.badRequest('Requested scope exceeds the client scope', 'invalid_scope')
    }

    const code = randomBytes(32).toString('base64url')
    await client.query(
      `INSERT INTO oauth_auth_codes (tenant_id, client_id, user_id, code_hash, redirect_uri, scopes, code_challenge, code_challenge_method, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'S256', now() + interval '10 minutes')`,
      [tenantId, input.clientId, userId, hashSecret(code), input.redirectUri, input.scopes, input.codeChallenge],
    )
    return { code, redirectUri: input.redirectUri }
  })
}

interface TokenResult {
  access_token: string
  token_type: 'Bearer'
  expires_in: number
  scope: string
}

export async function issueToken(
  pool: DbPool,
  config: AppConfig,
  body: {
    grant_type: string
    client_id: string
    client_secret?: string
    code?: string
    code_verifier?: string
  },
): Promise<TokenResult> {
  if (body.grant_type === 'client_credentials') {
    if (!body.client_secret) throw AppError.badRequest('client_secret is required', 'invalid_request')
    const oauthClient = await findClientBySecret(pool, body.client_id, body.client_secret)
    if (!oauthClient) throw AppError.unauthorized('Invalid client credentials', 'invalid_client')
    if (!oauthClient.grant_types.includes('client_credentials')) {
      throw AppError.badRequest('Client does not allow the client credentials grant', 'unsupported_grant')
    }
    const token = await signOAuthToken(config, { clientId: oauthClient.id, tenantId: oauthClient.tenant_id, scopes: oauthClient.scopes }, randomBytes(16).toString('hex'))
    return { access_token: token, token_type: 'Bearer', expires_in: config.accessTokenTtlSec, scope: oauthClient.scopes.join(' ') }
  }

  if (body.grant_type === 'authorization_code') {
    if (!body.code || !body.code_verifier) throw AppError.badRequest('code and code_verifier are required', 'invalid_request')
    const client = await pool.connect()
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.oauth_code_lookup', 'on', true)")
      const { rows } = await client.query(
        'SELECT * FROM oauth_auth_codes WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()',
        [hashSecret(body.code)],
      )
      const code = rows[0] as AuthCodeRow | undefined
      if (!code) throw AppError.badRequest('Invalid or expired authorization code', 'invalid_grant')
      if (code.client_id !== body.client_id) throw AppError.badRequest('Authorization code was issued to a different client', 'invalid_grant')
      if (!verifyPkce(body.code_verifier, code.code_challenge)) throw AppError.badRequest('PKCE verification failed', 'invalid_grant')
      await client.query('UPDATE oauth_auth_codes SET used_at = now() WHERE id = $1', [code.id])
      await client.query('COMMIT')

      const token = await signOAuthToken(config, { clientId: code.client_id, tenantId: code.tenant_id, scopes: code.scopes, sub: code.user_id }, randomBytes(16).toString('hex'))
      return { access_token: token, token_type: 'Bearer', expires_in: config.accessTokenTtlSec, scope: code.scopes.join(' ') }
    } catch (err) {
      try {
        await client.query('ROLLBACK')
      } catch {
        /* connection broken */
      }
      throw err
    } finally {
      client.release()
    }
  }

  throw AppError.badRequest('Unsupported grant type', 'unsupported_grant_type')
}
