import type { DbClient, DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'
import { notify } from '../../core/notify.js'

export interface DayWindow {
  start: string
  end: string
}

export type BusinessHoursSchedule = Record<string, DayWindow>

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const

function parseMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + (m || 0)
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

/**
 * Add working minutes to a start instant. An empty schedule means 24/7.
 * Schedule windows are interpreted in UTC (tenant-timezone-aware calendars are
 * a documented follow-up). Holidays are ISO dates skipped entirely.
 */
export function addBusinessMinutes(
  startMs: number,
  minutes: number,
  schedule: BusinessHoursSchedule = {},
  holidays: string[] = [],
): Date {
  if (minutes <= 0) return new Date(startMs)
  const windows = Object.keys(schedule).filter((k) => DAY_KEYS.includes(k as (typeof DAY_KEYS)[number]))
  if (windows.length === 0) return new Date(startMs + minutes * 60_000)

  const holidaySet = new Set(holidays)
  let cursor = new Date(startMs)
  let remaining = minutes

  for (let guard = 0; guard < 400 && remaining > 0; guard++) {
    const dayKey = DAY_KEYS[cursor.getUTCDay()]
    const window = schedule[dayKey]
    if (!window || holidaySet.has(isoDay(cursor))) {
      cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1))
      continue
    }

    const windowStartMin = parseMinutes(window.start)
    const windowEndMin = parseMinutes(window.end)
    const dayStart = Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate())
    const windowStartMs = dayStart + windowStartMin * 60_000
    const windowEndMs = dayStart + windowEndMin * 60_000

    if (cursor.getTime() >= windowEndMs) {
      cursor = new Date(dayStart + 86_400_000)
      continue
    }
    if (cursor.getTime() < windowStartMs) cursor = new Date(windowStartMs)

    const available = (windowEndMs - cursor.getTime()) / 60_000
    if (remaining <= available) {
      return new Date(cursor.getTime() + remaining * 60_000)
    }
    remaining -= available
    cursor = new Date(dayStart + 86_400_000)
  }
  return cursor
}

export interface DeadlineInput {
  priority: string
  matrix: Record<string, { response_mins: number; resolution_mins: number }>
  schedule?: BusinessHoursSchedule
  holidays?: string[]
  fromMs?: number
}

export function computeDeadlines(input: DeadlineInput): { dueResponseAt: Date; dueResolutionAt: Date } {
  const entry = input.matrix[input.priority] ?? input.matrix.p3
  const from = input.fromMs ?? Date.now()
  return {
    dueResponseAt: addBusinessMinutes(from, entry.response_mins, input.schedule, input.holidays),
    dueResolutionAt: addBusinessMinutes(from, entry.resolution_mins, input.schedule, input.holidays),
  }
}

export interface BreachResult {
  responseBreaches: Array<{ id: string; number: number }>
  resolutionBreaches: Array<{ id: string; number: number }>
}

/** Pick the member to alert for a breached ticket: assignee → team lead → first active owner. */
async function breachNotifiee(client: DbClient, tenantId: string, ticketId: string): Promise<string | null> {
  const { rows } = await client.query(
    `SELECT COALESCE(t.assignee_id, tm.lead_id, NULL) AS user_id
       FROM tickets t
       LEFT JOIN teams tm ON tm.id = t.team_id
      WHERE t.id = $1`,
    [ticketId],
  )
  if (rows[0]?.user_id) return rows[0].user_id as string

  const owners = await client.query(
    `SELECT m.user_id
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1 AND m.org_role = 'owner' AND m.status = 'active' AND u.status = 'active'
      ORDER BY m.created_at ASC
      LIMIT 1`,
    [tenantId],
  )
  return (owners.rows[0]?.user_id as string | undefined) ?? null
}

async function recordBreachEvents(client: DbClient, tenantId: string, breaches: Array<{ id: string; number: number }>, kind: 'response' | 'resolution'): Promise<void> {
  for (const ticket of breaches) {
    await client.query(
      `INSERT INTO ticket_threads (tenant_id, ticket_id, kind, visibility, body, meta)
       VALUES ($1, $2, 'system_event', 'internal', $3, $4::jsonb)`,
      [tenantId, ticket.id, `SLA ${kind} breached`, JSON.stringify({ event: `sla_${kind}_breached` })],
    )
    const notifiee = await breachNotifiee(client, tenantId, ticket.id)
    if (notifiee) {
      await notify(client, tenantId, {
        userId: notifiee,
        kind: 'sla.breached',
        subjectType: 'ticket',
        subjectId: ticket.id,
        body: `SLA ${kind} breached on ticket #${ticket.number}`,
      })
    }
  }
}

/** Evaluate SLA breaches for a single tenant inside its RLS context. */
export async function checkBreachesForTenant(pool: DbPool, tenantId: string): Promise<BreachResult> {
  return withTenant(pool, tenantId, async (client) => {
    const response = await client.query(
      `UPDATE tickets
          SET sla_response_breached = true, updated_at = now()
        WHERE tenant_id = $1
          AND sla_response_breached = false
          AND due_response_at IS NOT NULL
          AND due_response_at < now()
          AND first_response_at IS NULL
          AND status NOT IN ('resolved', 'closed')
        RETURNING id, number`,
      [tenantId],
    )
    const resolution = await client.query(
      `UPDATE tickets
          SET sla_resolution_breached = true, updated_at = now()
        WHERE tenant_id = $1
          AND sla_resolution_breached = false
          AND due_resolution_at IS NOT NULL
          AND due_resolution_at < now()
          AND resolved_at IS NULL
          AND status NOT IN ('resolved', 'closed')
          AND id NOT IN (
            SELECT ticket_id FROM ai_worker_runs
            WHERE tenant_id = $1 AND status = 'resolved' AND ticket_id IS NOT NULL
          )
        RETURNING id, number`,
      [tenantId],
    )
    await recordBreachEvents(client, tenantId, response.rows, 'response')
    await recordBreachEvents(client, tenantId, resolution.rows, 'resolution')
    return { responseBreaches: response.rows, resolutionBreaches: resolution.rows }
  })
}

/** Sweep every tenant. Tenant discovery uses the global tenants table (no RLS). */
export async function checkAllBreaches(pool: DbPool): Promise<number> {
  const { rows } = await pool.query('SELECT id FROM tenants')
  let total = 0
  for (const tenant of rows) {
    try {
      const result = await checkBreachesForTenant(pool, tenant.id)
      total += result.responseBreaches.length + result.resolutionBreaches.length
    } catch {
      /* keep sweeping other tenants */
    }
  }
  return total
}

export function startSlaScheduler(pool: DbPool, intervalMs = 60_000): NodeJS.Timeout {
  const timer = setInterval(() => {
    void checkAllBreaches(pool).catch(() => undefined)
  }, intervalMs)
  timer.unref()
  return timer
}
