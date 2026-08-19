import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'
import { ensureTenantDefaults, getDefaultSlaPolicy } from '../tenants/defaults.js'
import { computeDeadlines } from '../tickets/sla.js'
import { extractTicketNumber, parseRawEmail } from './email.parser.js'
import { dispatchTicketTriage } from '../ai/triage.js'

export interface ProcessResult {
  action: 'created' | 'replied' | 'duplicate' | 'skipped'
  ticketNumber?: number
  ticketId?: string
  reason?: string
}

export interface ProcessEmailOptions {
  /** Pin the tenant. The worker auto-resolves (first tenant) when omitted. */
  tenantId?: string
}

/**
 * Process a single raw RFC822 email: parse it, resolve the tenant + requester,
 * create a new ticket or append to an existing thread, and record the message
 * for deduplication. Returns a summary of what happened.
 */
export async function processRawEmail(pool: DbPool, rawEmail: string, opts?: ProcessEmailOptions): Promise<ProcessResult> {
  const email = await parseRawEmail(rawEmail)

  if (!email.messageId) return { action: 'skipped', reason: 'no message-id' }
  if (!email.fromAddress) return { action: 'skipped', reason: 'no from address' }

  // Resolve tenant: prefer explicit routing, else first tenant (no RLS on tenants).
  // In production this would route by the To address → tenant email channel.
  let tenantId = opts?.tenantId
  if (!tenantId) {
    const { rows: tenants } = await pool.query('SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1')
    if (tenants.length === 0) return { action: 'skipped', reason: 'no tenants' }
    tenantId = tenants[0].id as string
  }

  // Dedupil: check if this message was already processed
  const existing = await withTenant(pool, tenantId, (client) =>
    client.query('SELECT id FROM processed_emails WHERE message_id = $1', [email.messageId]),
  )
  if (existing.rowCount) return { action: 'duplicate', reason: 'message-id already processed' }

  // Get or create the requester user
  const requesterId = await getOrCreateUserByEmail(pool, tenantId, email.fromAddress, email.fromName)

  // Try to match an existing ticket by subject number
  const ticketNumber = extractTicketNumber(email.subject)

  if (ticketNumber) {
    const matched = await withTenant(pool, tenantId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, status FROM tickets WHERE number = $1 AND tenant_id = $2`,
        [ticketNumber, tenantId],
      )
      return rows[0]
    })

    if (matched) {
      await withTenant(pool, tenantId, async (client) => {
        await client.query(
          `INSERT INTO ticket_threads (tenant_id, ticket_id, author_id, kind, visibility, body, meta)
           VALUES ($1, $2, $3, 'message', 'public', $4, $5::jsonb)`,
          [tenantId, matched.id, requesterId, email.body || email.subject, JSON.stringify({ source: 'email', messageId: email.messageId })],
        )
        // Reopen if resolved/closed
        if (matched.status === 'resolved' || matched.status === 'closed') {
          await client.query(
            `UPDATE tickets SET status = 'open', resolved_at = NULL, closed_at = NULL, updated_at = now() WHERE id = $1`,
            [matched.id],
          )
          await client.query(
            `INSERT INTO ticket_threads (tenant_id, ticket_id, kind, visibility, body, meta)
             VALUES ($1, $2, 'system_event', 'internal', 'Reopened by email reply', $3::jsonb)`,
            [tenantId, matched.id, JSON.stringify({ event: 'ticket.reopened', source: 'email' })],
          )
        } else {
          await client.query(`UPDATE tickets SET updated_at = now() WHERE id = $1`, [matched.id])
        }
        await client.query(
          `INSERT INTO processed_emails (tenant_id, message_id, ticket_id, from_address, subject)
           VALUES ($1, $2, $3, $4, $5)`,
          [tenantId, email.messageId, matched.id, email.fromAddress, email.subject],
        )
      })
      void dispatchTicketTriage(tenantId, matched.id as string, 'requester_reply').catch(() => undefined)
      return { action: 'replied', ticketNumber, ticketId: matched.id as string }
    }
  }

  // No match — create a new ticket
  const defaults = await ensureTenantDefaults(pool, tenantId)
  const policy = await getDefaultSlaPolicy(pool, tenantId)
  const { dueResponseAt, dueResolutionAt } = computeDeadlines({
    priority: 'p3',
    matrix: policy.matrix,
    schedule: policy.businessHoursSchedule,
  })

  const newNumber = await withTenant(pool, tenantId, async (client) => {
    const counter = await client.query(
      'UPDATE tenants SET ticket_counter = ticket_counter + 1 WHERE id = $1 RETURNING ticket_counter',
      [tenantId],
    )
    return counter.rows[0].ticket_counter as number
  })

  const created = await withTenant(pool, tenantId, async (client) => {
    const res = await client.query(
      `INSERT INTO tickets
         (tenant_id, number, type, status, priority, subject, requester_id,
          team_id, category_id, sla_policy_id, source, due_response_at, due_resolution_at)
       VALUES ($1, $2, 'incident', 'new', 'p3', $3, $4, $5, $6, $7, 'email', $8, $9)
       RETURNING id`,
      [tenantId, newNumber, email.subject, requesterId, defaults.teamId, defaults.categoryId, policy.id, dueResponseAt, dueResolutionAt],
    )
    const ticketId = res.rows[0].id

    await client.query(
      `INSERT INTO ticket_threads (tenant_id, ticket_id, author_id, kind, visibility, body, meta)
       VALUES ($1, $2, $3, 'message', 'public', $4, $5::jsonb)`,
      [tenantId, ticketId, requesterId, email.body || email.subject, JSON.stringify({ source: 'email', messageId: email.messageId })],
    )
    await client.query(
      `INSERT INTO processed_emails (tenant_id, message_id, ticket_id, from_address, subject)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, email.messageId, ticketId, email.fromAddress, email.subject],
    )
    return { ticketId: ticketId as string }
  })

  void dispatchTicketTriage(tenantId, created.ticketId, 'created').catch(() => undefined)
  return { action: 'created', ticketNumber: newNumber, ticketId: created.ticketId }
}

async function getOrCreateUserByEmail(pool: DbPool, tenantId: string, email: string, name: string): Promise<string> {
  // Check if user exists (users is global, no RLS)
  const { rows: users } = await pool.query('SELECT id FROM users WHERE email = $1', [email])
  if (users.length > 0) {
    const userId = users[0].id as string
    // Ensure membership
    const { rows: memberships } = await pool.query(
      'SELECT id FROM memberships WHERE tenant_id = $1 AND user_id = $2',
      [tenantId, userId],
    )
    if (memberships.length === 0) {
      await pool.query(
        `INSERT INTO memberships (tenant_id, user_id, org_role, status) VALUES ($1, $2, 'end_user', 'invited')`,
        [tenantId, userId],
      )
    }
    return userId
  }

  // Create new user + membership
  const res = await pool.query(
    `INSERT INTO users (email, name, status) VALUES ($1, $2, 'invited') RETURNING id`,
    [email, name],
  )
  const userId = res.rows[0].id as string
  await pool.query(
    `INSERT INTO memberships (tenant_id, user_id, org_role, status) VALUES ($1, $2, 'end_user', 'invited')`,
    [tenantId, userId],
  )
  return userId
}