import type { DbClient } from '../../db/pool.js'
import { notify } from '../../core/notify.js'
import { assertTeamAcceptsTickets } from '../teams/team-policy.js'

export type AutomationTrigger = 'ticket.created' | 'ticket.updated' | 'device.offline' | 'device.low_disk'

export type ConditionOp = 'eq' | 'neq' | 'contains' | 'in'

export interface AutomationCondition {
  field: string
  op: ConditionOp
  value: unknown
}

export interface AutomationConditions {
  all?: AutomationCondition[]
  any?: AutomationCondition[]
}

export type AutomationAction =
  | { type: 'set_priority'; priority: string }
  | { type: 'add_tags'; tags: string[] }
  | { type: 'assign_team'; team_id: string }
  | { type: 'assign_user'; user_id: string }
  | { type: 'notify'; role?: string; user_id?: string; body?: string }
  | { type: 'add_note'; body: string }
  | { type: 'webhook'; url: string }

export interface AutomationRule {
  id: string
  tenant_id: string
  name: string
  trigger: AutomationTrigger
  conditions: AutomationConditions
  actions: AutomationAction[]
  enabled: boolean
  last_run_at: string | null
  run_count: number
  created_at: string
  updated_at: string
}

export interface AutomationSubject {
  objectType: 'ticket' | 'device'
  objectId: string
  fields: Record<string, unknown>
}

/** Resolve a subject field value (undefined when absent). */
function fieldValue(subject: AutomationSubject, field: string): unknown {
  return subject.fields[field]
}

function eq(a: unknown, b: unknown): boolean {
  return String(a) === String(b)
}

function conditionMatches(cond: AutomationCondition, subject: AutomationSubject): boolean {
  const actual = fieldValue(subject, cond.field)
  switch (cond.op) {
    case 'eq':
      return eq(actual, cond.value)
    case 'neq':
      return !eq(actual, cond.value)
    case 'contains': {
      if (Array.isArray(actual)) return actual.some((e) => eq(e, cond.value))
      if (typeof actual === 'string') return actual.toLowerCase().includes(String(cond.value).toLowerCase())
      return false
    }
    case 'in': {
      if (!Array.isArray(cond.value)) return false
      return cond.value.some((v) => eq(actual, v))
    }
    default:
      return false
  }
}

/** Evaluate a conditions object (all must match AND at least one any must match). */
export function evaluateConditions(conditions: AutomationConditions | null | undefined, subject: AutomationSubject): boolean {
  if (!conditions) return true
  const all = conditions.all ?? []
  const any = conditions.any ?? []
  if (all.some((c) => !conditionMatches(c, subject))) return false
  if (any.length > 0 && !any.some((c) => conditionMatches(c, subject))) return false
  return true
}

/** Replace {{field}} placeholders with subject field values. */
export function renderTemplate(text: string, subject: AutomationSubject): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_m, key: string) => {
    const v = fieldValue(subject, key)
    return v === undefined || v === null ? '' : String(v)
  })
}

interface ActionResult {
  applied: boolean
  note?: string
}

async function executeAction(
  client: DbClient,
  tenantId: string,
  subject: AutomationSubject,
  action: AutomationAction,
): Promise<ActionResult> {
  const ticket = subject.objectType === 'ticket' ? subject.objectId : null

  switch (action.type) {
    case 'set_priority':
      if (!ticket) return { applied: false, note: 'not a ticket subject' }
      await client.query('UPDATE tickets SET priority = $2, updated_at = now() WHERE id = $1', [ticket, action.priority])
      return { applied: true }
    case 'add_tags':
      if (!ticket) return { applied: false, note: 'not a ticket subject' }
      await client.query(
        `UPDATE tickets
            SET tags = COALESCE(tags, '{}'::text[]) || $2::text[], updated_at = now()
          WHERE id = $1`,
        [ticket, action.tags],
      )
      return { applied: true }
    case 'assign_team':
      if (!ticket) return { applied: false, note: 'not a ticket subject' }
      await assertTeamAcceptsTickets(client, tenantId, action.team_id)
      await client.query('UPDATE tickets SET team_id = $2, updated_at = now() WHERE id = $1', [ticket, action.team_id])
      return { applied: true }
    case 'assign_user':
      if (!ticket) return { applied: false, note: 'not a ticket subject' }
      await client.query('UPDATE tickets SET assignee_id = $2, updated_at = now() WHERE id = $1', [ticket, action.user_id])
      return { applied: true }
    case 'add_note':
      if (!ticket) return { applied: false, note: 'not a ticket subject' }
      await client.query(
        `INSERT INTO ticket_threads (tenant_id, ticket_id, kind, visibility, body, meta)
         VALUES ($1, $2, 'system_event', 'internal', $3, $4::jsonb)`,
        [tenantId, ticket, renderTemplate(action.body, subject), JSON.stringify({ event: 'automation.note' })],
      )
      return { applied: true }
    case 'notify': {
      const body = renderTemplate(action.body ?? 'Automation notification', subject)
      const userIds: string[] = []
      if (action.user_id) {
        userIds.push(action.user_id)
      }
      if (action.role) {
        const { rows } = await client.query(
          `SELECT m.user_id
             FROM memberships m
             JOIN users u ON u.id = m.user_id
            WHERE m.tenant_id = $1 AND m.org_role = $2 AND m.status = 'active' AND u.status = 'active'`,
          [tenantId, action.role],
        )
        userIds.push(...rows.map((r) => r.user_id as string))
      }
      for (const userId of new Set(userIds)) {
        await notify(client, tenantId, {
          userId,
          kind: 'automation',
          subjectType: subject.objectType,
          subjectId: subject.objectId,
          body,
        })
      }
      return { applied: userIds.length > 0 }
    }
    case 'webhook':
      // Delivery infrastructure (webhook_endpoints) is a separate, later module.
      return { applied: false, note: 'webhook delivery deferred' }
    default:
      return { applied: false, note: 'unknown action' }
  }
}

export interface AutomationRunSummary {
  automationId: string
  status: 'ok' | 'skipped' | 'error' | 'deferred'
  actions: string[]
}

/**
 * Evaluate and execute every enabled rule matching a trigger, inside an
 * already-open tenant-scoped transaction. Records a run per rule and updates
 * rule counters. Never throws: individual failures are captured in the run log.
 */
export async function runAutomationsForTrigger(
  client: DbClient,
  tenantId: string,
  trigger: AutomationTrigger,
  subject: AutomationSubject,
): Promise<AutomationRunSummary[]> {
  const { rows } = await client.query(
    `SELECT id, name, trigger, conditions, actions
       FROM automations
      WHERE tenant_id = $1 AND trigger = $2 AND enabled = true
      ORDER BY created_at ASC`,
    [tenantId, trigger],
  )

  const summaries: AutomationRunSummary[] = []
  for (const rule of rows) {
    const conditions = (rule.conditions ?? {}) as AutomationConditions
    const actions = (rule.actions ?? []) as AutomationAction[]
    if (!evaluateConditions(conditions, subject)) {
      await recordRun(client, tenantId, rule.id, trigger, subject, 'skipped', { reason: 'conditions not met' })
      summaries.push({ automationId: rule.id, status: 'skipped', actions: [] })
      continue
    }

    const appliedActions: string[] = []
    let status: AutomationRunSummary['status'] = 'ok'
    let error: string | undefined

    for (const action of actions) {
      try {
        const result = await executeAction(client, tenantId, subject, action)
        if (result.applied) appliedActions.push(action.type)
        if (action.type === 'webhook') status = 'deferred'
      } catch (err) {
        status = 'error'
        error = (err as Error).message
        break
      }
    }

    await recordRun(client, tenantId, rule.id, trigger, subject, status, { actions: appliedActions, error })
    await client.query(
      'UPDATE automations SET last_run_at = now(), run_count = run_count + 1 WHERE id = $1',
      [rule.id],
    )
    summaries.push({ automationId: rule.id, status, actions: appliedActions })
  }
  return summaries
}

async function recordRun(
  client: DbClient,
  tenantId: string,
  automationId: string,
  trigger: AutomationTrigger,
  subject: AutomationSubject,
  status: AutomationRunSummary['status'],
  log: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO automation_runs (tenant_id, automation_id, trigger, subject_type, subject_id, status, log)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tenantId, automationId, trigger, subject.objectType, subject.objectId, status, JSON.stringify(log)],
  )
}
