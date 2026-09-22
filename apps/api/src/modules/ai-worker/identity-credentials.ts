import { createHash, randomBytes } from 'node:crypto'
import { AppError } from '../../core/errors.js'
import type { DbPool } from '../../db/pool.js'
import { notify } from '../../core/notify.js'
import { withTenant } from '../../db/pool.js'

export interface IdentityCredential {
  id: string
  tenant_id: string
  playbook_id: string
  name: string
  token_prefix: string
  status: 'active' | 'revoked' | 'expired'
  expires_at: string
  last_used_at: string | null
  usage_count: number
  created_by: string | null
  revoked_at: string | null
  revoked_by: string | null
  created_at: string
}

export interface IssuedIdentityCredential {
  credential: IdentityCredential
  token: string
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function newToken(): string {
  return `reydesk_ai_${randomBytes(32).toString('base64url')}`
}

async function ensurePlaybook(pool: DbPool, tenantId: string, playbookId: string): Promise<void> {
  await withTenant(pool, tenantId, async (client) => {
    const result = await client.query('SELECT id FROM ai_playbooks WHERE id = $1 AND tenant_id = $2', [playbookId, tenantId])
    if (!result.rows[0]) throw AppError.notFound('Playbook not found')
  })
}

/** Expire credentials lazily so stale active credentials cannot be used or displayed as active. */
async function expireCredentials(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }> }, tenantId: string, playbookId?: string): Promise<void> {
  const params: unknown[] = [tenantId]
  const scope = playbookId ? ' AND playbook_id = $2' : ''
  if (playbookId) params.push(playbookId)
  await client.query(
    `UPDATE ai_worker_identity_credentials
        SET status = 'expired'
      WHERE tenant_id = $1 AND status = 'active' AND expires_at <= now()${scope}`,
    params,
  )
}

export async function issueIdentityCredential(
  pool: DbPool,
  tenantId: string,
  playbookId: string,
  actorId: string,
  input: { name: string; expiresInDays: number },
): Promise<IssuedIdentityCredential> {
  await ensurePlaybook(pool, tenantId, playbookId)
  const token = newToken()
  const tokenPrefix = token.slice(0, 20)
  return withTenant(pool, tenantId, async (client) => {
    await expireCredentials(client, tenantId, playbookId)
    const { rows } = await client.query(
      `INSERT INTO ai_worker_identity_credentials
        (tenant_id, playbook_id, name, token_prefix, token_hash, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' days')::interval, $7)
       RETURNING id, tenant_id, playbook_id, name, token_prefix, status, expires_at,
                 last_used_at, usage_count, created_by, revoked_at, revoked_by, created_at`,
      [tenantId, playbookId, input.name, tokenPrefix, hashToken(token), input.expiresInDays, actorId],
    )
    return { credential: rows[0] as IdentityCredential, token }
  })
}

export async function listIdentityCredentials(
  pool: DbPool,
  tenantId: string,
  playbookId: string,
): Promise<IdentityCredential[]> {
  await ensurePlaybook(pool, tenantId, playbookId)
  return withTenant(pool, tenantId, async (client) => {
    await expireCredentials(client, tenantId, playbookId)
    const { rows } = await client.query(
      `SELECT id, tenant_id, playbook_id, name, token_prefix, status, expires_at,
              last_used_at, usage_count, created_by, revoked_at, revoked_by, created_at
         FROM ai_worker_identity_credentials
        WHERE tenant_id = $1 AND playbook_id = $2
        ORDER BY created_at DESC`,
      [tenantId, playbookId],
    )
    return rows as IdentityCredential[]
  })
}

export async function revokeIdentityCredential(
  pool: DbPool,
  tenantId: string,
  playbookId: string,
  credentialId: string,
  actorId: string,
): Promise<IdentityCredential> {
  await ensurePlaybook(pool, tenantId, playbookId)
  return withTenant(pool, tenantId, async (client) => {
    await expireCredentials(client, tenantId, playbookId)
    const { rows } = await client.query(
      `UPDATE ai_worker_identity_credentials
          SET status = 'revoked', revoked_at = now(), revoked_by = $4
        WHERE id = $1 AND tenant_id = $2 AND playbook_id = $3 AND status = 'active'
        RETURNING id, tenant_id, playbook_id, name, token_prefix, status, expires_at,
                  last_used_at, usage_count, created_by, revoked_at, revoked_by, created_at`,
      [credentialId, tenantId, playbookId, actorId],
    )
    if (!rows[0]) throw AppError.notFound('Active credential not found')
    return rows[0] as IdentityCredential
  })
}

/** Notify tenant administrators once per day when worker credentials near expiry. */
export async function checkIdentityCredentialExpiry(pool: DbPool, windowDays = 7): Promise<number> {
  const tenants = await pool.query<{ id: string }>('SELECT id FROM tenants')
  let notified = 0
  for (const tenant of tenants.rows) {
    notified += await withTenant(pool, tenant.id, async (client) => {
      const expiring = await client.query<{ id: string; playbook_id: string; name: string; expires_at: string }>(
        `SELECT c.id, c.playbook_id, c.name, c.expires_at
           FROM ai_worker_identity_credentials c
          WHERE c.tenant_id = $1 AND c.status = 'active'
            AND c.expires_at > now()
            AND c.expires_at <= now() + ($2 || ' days')::interval
            AND (c.expiry_notified_at IS NULL OR c.expiry_notified_at < now() - interval '1 day')
          ORDER BY c.expires_at ASC`,
        [tenant.id, windowDays],
      )
      if (expiring.rows.length === 0) return 0
      const recipients = await client.query<{ user_id: string }>(
        `SELECT user_id FROM memberships
          WHERE tenant_id = $1 AND status = 'active'
            AND org_role IN ('owner', 'it_manager', 'service_desk_manager')`,
        [tenant.id],
      )
      for (const credential of expiring.rows) {
        const days = Math.max(0, Math.ceil((new Date(credential.expires_at).getTime() - Date.now()) / 86_400_000))
        for (const recipient of recipients.rows) {
          await notify(client, tenant.id, {
            userId: recipient.user_id,
            kind: 'ai_worker.credential_expiry',
            subjectType: 'ai_playbook',
            subjectId: credential.playbook_id,
            body: `AI worker credential “${credential.name}” expires in ${days} day${days === 1 ? '' : 's'}. Rotate or revoke it from AI Playbooks.`,
          })
        }
        await client.query('UPDATE ai_worker_identity_credentials SET expiry_notified_at = now() WHERE id = $1', [credential.id])
        notified++
      }
      return 0
    })
  }
  return notified
}

/** Constant-time hash lookup hook for future external-client authentication. */
export async function findCredentialByToken(
  pool: DbPool,
  tenantId: string,
  token: string,
): Promise<IdentityCredential | null> {
  return withTenant(pool, tenantId, async (client) => {
    const { rows } = await client.query(
      `UPDATE ai_worker_identity_credentials
          SET status = 'expired'
        WHERE tenant_id = $1 AND status = 'active' AND expires_at <= now()
          AND token_hash = $2
      RETURNING id, tenant_id, playbook_id, name, token_prefix, status, expires_at,
                last_used_at, usage_count, created_by, revoked_at, revoked_by, created_at`,
      [tenantId, hashToken(token)],
    )
    if (rows[0]) return null
    const result = await client.query(
      `SELECT id, tenant_id, playbook_id, name, token_prefix, status, expires_at,
              last_used_at, usage_count, created_by, revoked_at, revoked_by, created_at
         FROM ai_worker_identity_credentials
        WHERE tenant_id = $1 AND token_hash = $2 AND status = 'active' AND expires_at > now()`,
      [tenantId, hashToken(token)],
    )
    if (!result.rows[0]) return null
    await client.query(
      `UPDATE ai_worker_identity_credentials
          SET last_used_at = now(), usage_count = usage_count + 1
        WHERE id = $1`,
      [result.rows[0].id],
    )
    return result.rows[0] as IdentityCredential
  })
}
