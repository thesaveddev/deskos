import { AppError } from '../../core/errors.js'
import type { DbPool } from '../../db/pool.js'
import { withTenant } from '../../db/pool.js'
import type { AiProvider } from '../ai/gateway.js'

export const REMEDIATION_TOOLS = ['restart_device', 'collect_inventory', 'run_script', 'add_ticket_note', 'set_ticket_priority'] as const
export type RemediationTool = (typeof REMEDIATION_TOOLS)[number]

export const REMEDIATION_STATUSES = ['proposed', 'approved', 'denied', 'executed', 'failed', 'skipped'] as const
export type RemediationStatus = (typeof REMEDIATION_STATUSES)[number]

export interface RemediationSignal {
  sourceType: 'device_alert' | 'posture_alert' | 'dex' | 'ticket'
  sourceId?: string
  deviceId?: string
  kind?: string
  checkPath?: string
  ticketId?: string
}

interface Proposal {
  tool: RemediationTool
  toolArgs: Record<string, unknown>
  rationale: string
}

/** Deterministic, bounded tool selection — the agent never invents tools. */
function proposeTool(signal: RemediationSignal): Proposal {
  const deviceId = signal.deviceId
  if (signal.kind === 'high_cpu' || signal.kind === 'high_mem') {
    return {
      tool: 'restart_device',
      toolArgs: { deviceId },
      rationale: `Sustained ${signal.kind === 'high_cpu' ? 'CPU' : 'memory'} pressure — propose a controlled restart to clear runaway processes.`,
    }
  }
  if (signal.kind === 'low_disk' || signal.kind === 'offline' || signal.checkPath) {
    return {
      tool: 'collect_inventory',
      toolArgs: { deviceId },
      rationale: 'Collect a fresh inventory to pinpoint the condition before taking further action.',
    }
  }
  if (signal.sourceType === 'ticket' && signal.ticketId) {
    return {
      tool: 'add_ticket_note',
      toolArgs: { ticketId: signal.ticketId, body: 'Level-1 agent: flagged for review.' },
      rationale: 'Attach an internal note so the next technician has context.',
    }
  }
  return {
    tool: 'collect_inventory',
    toolArgs: { deviceId },
    rationale: 'Gather current endpoint telemetry before deciding on remediation.',
  }
}

export async function proposeRemediation(
  pool: DbPool,
  tenantId: string,
  signal: RemediationSignal,
  provider: AiProvider,
  model: string,
): Promise<Record<string, unknown>> {
  const proposal = proposeTool(signal)
  // Best-effort AI rationale enrichment; falls back to the deterministic text.
  let rationale = proposal.rationale
  try {
    const generated = await provider.generate(
      `You are a cautious IT support agent. Given this signal, write a single concise sentence (max 200 chars) explaining why a bounded remediation is worth considering. Never invent tools or execute anything. Signal: ${JSON.stringify(signal)}. Proposed tool: ${proposal.tool}.`,
      { maxTokens: 120 },
    )
    if (generated && generated.trim().length > 0) rationale = generated.trim().slice(0, 500)
  } catch {
    /* keep deterministic rationale */
  }

  return withTenant(pool, tenantId, async (client) => {
    if (signal.deviceId) {
      const device = await client.query('SELECT 1 FROM devices WHERE id = $1', [signal.deviceId])
      if (!device.rows[0]) throw AppError.notFound('Device not found')
    }
    const { rows } = await client.query(
      `INSERT INTO ai_remediations (tenant_id, source_type, source_id, device_id, tool, tool_args, rationale, status, proposed_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, 'proposed', 'ai')
       RETURNING *`,
      [tenantId, signal.sourceType, signal.sourceId ?? null, signal.deviceId ?? null, proposal.tool, JSON.stringify(proposal.toolArgs), rationale],
    )
    return rows[0]
  })
}

export async function listRemediations(
  pool: DbPool,
  tenantId: string,
  filters: { status?: RemediationStatus } = {},
): Promise<Record<string, unknown>[]> {
  return withTenant(pool, tenantId, async (client) => {
    const params: unknown[] = []
    const where: string[] = []
    if (filters.status) {
      params.push(filters.status)
      where.push(`r.status = $${params.length}`)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const { rows } = await client.query(
      `SELECT r.*, d.name AS device_name, u.name AS approver_name
         FROM ai_remediations r
         LEFT JOIN devices d ON d.id = r.device_id
         LEFT JOIN users u ON u.id = r.approved_by
         ${whereSql}
        ORDER BY r.created_at DESC
        LIMIT 200`,
      params,
    )
    return rows
  })
}

async function executeTool(
  client: import('pg').PoolClient,
  tenantId: string,
  remediation: Record<string, unknown>,
  actorId: string,
): Promise<Record<string, unknown>> {
  const tool = remediation.tool as RemediationTool
  const args = (remediation.tool_args ?? {}) as Record<string, unknown>

  if (tool === 'restart_device' || tool === 'collect_inventory') {
    const deviceId = args.deviceId as string
    const { rows } = await client.query(
      `INSERT INTO device_actions (tenant_id, device_id, action, payload, requested_by)
       VALUES ($1, $2, $3, $4::jsonb, $5) RETURNING id`,
      [tenantId, deviceId, tool === 'restart_device' ? 'restart' : 'collect_inventory', JSON.stringify({ aiRemediation: remediation.id }), actorId],
    )
    return { deviceActionId: rows[0].id }
  }

  if (tool === 'run_script') {
    const deviceId = args.deviceId as string
    const { rows } = await client.query(
      `INSERT INTO device_actions (tenant_id, device_id, action, payload, requested_by)
       VALUES ($1, $2, 'run_script', $3::jsonb, $4) RETURNING id`,
      [tenantId, deviceId, JSON.stringify({ scriptId: args.scriptId, aiRemediation: remediation.id }), actorId],
    )
    return { deviceActionId: rows[0].id }
  }

  if (tool === 'add_ticket_note') {
    const ticketId = args.ticketId as string
    await client.query(
      `INSERT INTO ticket_threads (tenant_id, ticket_id, author_id, kind, visibility, body)
       VALUES ($1, $2, $3, 'internal_note', 'internal', $4)`,
      [tenantId, ticketId, actorId, String(args.body ?? '')],
    )
    return { noteAdded: true }
  }

  if (tool === 'set_ticket_priority') {
    const ticketId = args.ticketId as string
    const priority = args.priority as string
    await client.query('UPDATE tickets SET priority = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2', [ticketId, tenantId, priority])
    return { prioritySet: priority }
  }

  throw AppError.badRequest('Unknown remediation tool', 'unknown_tool')
}

export async function approveAndExecute(
  pool: DbPool,
  tenantId: string,
  id: string,
  actorId: string,
): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    const existing = (await client.query('SELECT * FROM ai_remediations WHERE id = $1', [id])).rows[0]
    if (!existing) throw AppError.notFound('Remediation not found')
    if (existing.status !== 'proposed') throw AppError.badRequest('Only proposed remediations can be approved', 'invalid_status')

    let result: Record<string, unknown>
    let status: 'executed' | 'failed' = 'executed'
    try {
      result = await executeTool(client, tenantId, existing, actorId)
    } catch (err) {
      status = 'failed'
      result = { error: err instanceof Error ? err.message : 'execution failed' }
    }

    const { rows } = await client.query(
      `UPDATE ai_remediations SET status = $3, approved_by = $4, executed_at = now(), result = $5::jsonb, updated_at = now()
        WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, status, actorId, JSON.stringify(result)],
    )
    return rows[0]
  })
}

export async function denyRemediation(pool: DbPool, tenantId: string, id: string, actorId: string): Promise<Record<string, unknown>> {
  return withTenant(pool, tenantId, async (client) => {
    const existing = (await client.query('SELECT id FROM ai_remediations WHERE id = $1', [id])).rows[0]
    if (!existing) throw AppError.notFound('Remediation not found')
    const { rows } = await client.query(
      `UPDATE ai_remediations SET status = 'denied', approved_by = $3, updated_at = now() WHERE id = $1 AND tenant_id = $2 RETURNING *`,
      [id, tenantId, actorId],
    )
    return rows[0]
  })
}
