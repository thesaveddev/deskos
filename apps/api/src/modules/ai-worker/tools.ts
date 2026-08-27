import { AppError } from '../../core/errors.js'
import type { DbClient } from '../../db/pool.js'
import { notify } from '../../core/notify.js'

/**
 * AI Worker tool catalog.
 *
 * Every tool the worker may call is declared here with its argument schema,
 * natural-language description, and a risk tier. The policy engine uses the
 * risk tier to decide whether a call needs a human approval before it runs:
 *   - `read`   — no side effects, always allowed
 *   - `low`    — reversible / low blast radius (notes, resolve, approved scripts)
 *   - `high`   — disruptive (restart), requires approval unless the tenant
 *                policy auto-approves it
 *
 * Tools execute against the existing control-plane tables (device_actions,
 * scripts, ticket_threads, tickets) — the worker never executes code itself.
 */

export type WorkerRiskTier = 'read' | 'low' | 'high'
export type WorkerStepStatus = 'pending' | 'running' | 'awaiting_approval' | 'dispatched' | 'succeeded' | 'failed' | 'skipped' | 'denied'

export interface WorkerStep {
  id: string
  phase: 'diagnose' | 'plan' | 'act' | 'verify'
  tool: string
  toolArgs: Record<string, unknown>
  risk: WorkerRiskTier
  rationale: string
  status: WorkerStepStatus
  result?: Record<string, unknown> | null
  error?: string | null
  startedAt?: string
  finishedAt?: string
  approvedBy?: string | null
  actionId?: string | null
}

export interface WorkerToolDef {
  name: string
  description: string
  risk: WorkerRiskTier
  /** JSON-schema-ish arg validation; return an error string or null. */
  validate: (args: Record<string, unknown>) => string | null
  /** Execute the tool. `client` is an open tenant-scoped transaction. */
  run: (ctx: ToolCtx, args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

export interface ToolCtx {
  client: DbClient
  tenantId: string
  ticketId: string | null
  deviceId: string | null
  /** id of the worker run driving this call */
  runId: string
}

const uuid = (value: unknown): string | null => (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : null)

export const WORKER_TOOLS: WorkerToolDef[] = [
  {
    name: 'ticket.get',
    description: 'Read the ticket subject, status, priority, requester, linked device, and the public conversation timeline. Use this first to understand the issue.',
    risk: 'read',
    validate: (args) => (uuid(args.ticketId) ? null : 'ticketId must be a valid id'),
    async run(ctx, args) {
      const { rows } = await ctx.client.query(
        `SELECT t.id, t.number, t.subject, t.status, t.priority, t.type, t.source,
                t.device_id, t.requester_id, t.assignee_id,
                u.name AS requester_name, u.email AS requester_email,
                d.name AS device_name, d.hostname, d.os,
                COALESCE(string_agg(th.body, ' ' ORDER BY th.created_at)
                  FILTER (WHERE th.kind IN ('message', 'internal_note')), '') AS conversation
           FROM tickets t
           LEFT JOIN users u ON u.id = t.requester_id
           LEFT JOIN devices d ON d.id = t.device_id
           LEFT JOIN ticket_threads th ON th.ticket_id = t.id
          WHERE t.id = $1
          GROUP BY t.id, u.name, u.email, d.name, d.hostname, d.os`,
        [args.ticketId],
      )
      const ticket = rows[0]
      if (!ticket) throw AppError.notFound('Ticket not found')
      return {
        id: ticket.id,
        number: ticket.number,
        subject: ticket.subject,
        status: ticket.status,
        priority: ticket.priority,
        type: ticket.type,
        source: ticket.source,
        requester: { name: ticket.requester_name, email: ticket.requester_email },
        device: ticket.device_id
          ? { id: ticket.device_id, name: ticket.device_name, hostname: ticket.hostname, os: ticket.os }
          : null,
        conversation: String(ticket.conversation).slice(0, 6000),
      }
    },
  },
  {
    name: 'device.inventory',
    description: 'Read the linked device inventory, latest metrics and open alerts. Use this to diagnose the issue from the endpoint state.',
    risk: 'read',
    validate: (args) => (uuid(args.deviceId) ? null : 'deviceId must be a valid id'),
    async run(ctx, args) {
      const deviceId = args.deviceId as string
      const inventory = (await ctx.client.query(
        `SELECT hardware, os, apps, security_posture, collected_at FROM device_inventory WHERE device_id = $1`,
        [deviceId],
      )).rows[0] ?? null
      const metrics = (await ctx.client.query(
        `SELECT cpu_pct, mem_pct, disk_pct, disk_free_bytes, uptime_seconds, process_count, recorded_at
           FROM device_metrics WHERE device_id = $1 ORDER BY recorded_at DESC LIMIT 1`,
        [deviceId],
      )).rows[0] ?? null
      const alerts = (await ctx.client.query(
        `SELECT kind, severity, message, created_at FROM device_alerts
          WHERE device_id = $1 AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 10`,
        [deviceId],
      )).rows
      const device = (await ctx.client.query(
        `SELECT name, hostname, os, os_version, agent_version, last_seen_at, device_type
           FROM devices WHERE id = $1`,
        [deviceId],
      )).rows[0] ?? null
      return {
        device,
        inventory,
        metrics,
        openAlerts: alerts,
        online: device?.last_seen_at != null && new Date(device.last_seen_at).getTime() > Date.now() - 15 * 60 * 1000,
      }
    },
  },
  {
    name: 'device.run_script',
    description: 'Run an approved script from the tenant script library on the linked device. Choose a script whose name or category matches the diagnosed issue. The script must already be approved by a human.',
    risk: 'low',
    validate: (args) => {
      if (!uuid(args.scriptId)) return 'scriptId must be a valid id'
      if (args.args !== undefined && (typeof args.args !== 'object' || args.args === null || Array.isArray(args.args))) return 'args must be an object'
      return null
    },
    async run(ctx, args) {
      const deviceId = ctx.deviceId
      if (!deviceId) return { skipped: true, reason: 'no device linked to this run' }
      const script = (await ctx.client.query(
        `SELECT id, name, approval_status, privilege_level, body FROM scripts WHERE id = $1 AND tenant_id = $2`,
        [args.scriptId, ctx.tenantId],
      )).rows[0]
      if (!script) throw AppError.badRequest('Script not found in this organization', 'script_not_found')
      if (script.approval_status !== 'approved') throw AppError.badRequest('Script is not approved', 'script_not_approved')
      const { rows } = await ctx.client.query(
        `INSERT INTO device_actions (tenant_id, device_id, action, payload, requested_by)
         VALUES ($1, $2, 'run_script', $3::jsonb, NULL) RETURNING id`,
        [ctx.tenantId, deviceId, JSON.stringify({ scriptId: args.scriptId, scriptArgs: args.args ?? {}, aiWorkerRunId: ctx.runId })],
      )
      return { actionId: rows[0].id, script: script.name, dispatched: true }
    },
  },
  {
    name: 'device.restart',
    description: 'Restart the linked device. Disruptive: require explicit approval unless the organization policy auto-approves restarts.',
    risk: 'high',
    validate: () => null,
    async run(ctx) {
      const deviceId = ctx.deviceId
      if (!deviceId) return { skipped: true, reason: 'no device linked to this run' }
      const { rows } = await ctx.client.query(
        `INSERT INTO device_actions (tenant_id, device_id, action, payload, requested_by)
         VALUES ($1, $2, 'restart', $3::jsonb, NULL) RETURNING id`,
        [ctx.tenantId, deviceId, JSON.stringify({ aiWorkerId: ctx.runId })],
      )
      return { actionId: rows[0].id, dispatched: true }
    },
  },
  {
    name: 'ticket.note',
    description: 'Add an internal note to the ticket so technicians have full context of what the worker did.',
    risk: 'low',
    validate: (args) => (typeof args.body === 'string' && args.body.length > 0 && args.body.length <= 8000 ? null : 'body must be a non-empty string up to 8000 chars'),
    async run(ctx, args) {
      if (!ctx.ticketId) return { skipped: true, reason: 'no ticket linked to this run' }
      await ctx.client.query(
        `INSERT INTO ticket_threads (tenant_id, ticket_id, author_id, kind, visibility, body, meta)
         VALUES ($1, $2, NULL, 'ai_worker', 'internal', $3, $4::jsonb)`,
        [ctx.tenantId, ctx.ticketId, String(args.body), JSON.stringify({ workerRunId: ctx.runId, source: 'ai_worker' })],
      )
      return { noteAdded: true }
    },
  },
  {
    name: 'ticket.resolve',
    description: 'Mark the ticket resolved and notify the requester that their issue has been fixed. Use only when a verification step confirms the fix.',
    risk: 'low',
    validate: (args) => (typeof args.message === 'string' && args.message.length > 0 && args.message.length <= 4000 ? null : 'message must be a non-empty string up to 4000 chars'),
    async run(ctx, args) {
      if (!ctx.ticketId) return { skipped: true, reason: 'no ticket linked to this run' }
      const ticket = (await ctx.client.query(
        `SELECT number, subject, requester_id FROM tickets WHERE id = $1`,
        [ctx.ticketId],
      )).rows[0]
      if (!ticket) throw AppError.notFound('Ticket not found')
      await ctx.client.query(
        `UPDATE tickets SET status = 'resolved', resolved_at = COALESCE(resolved_at, now()), updated_at = now() WHERE id = $1`,
        [ctx.ticketId],
      )
      await ctx.client.query(
        `INSERT INTO ticket_threads (tenant_id, ticket_id, author_id, kind, visibility, body, meta)
         VALUES ($1, $2, NULL, 'ai_worker', 'public', $3, $4::jsonb)`,
        [ctx.tenantId, ctx.ticketId, String(args.message), JSON.stringify({ runId: ctx.runId, source: 'ai_worker' })],
      )
      if (ticket.requester_id) {
        await notify(ctx.client, ctx.tenantId, {
          userId: ticket.requester_id,
          kind: 'ticket.resolved',
          subjectType: 'ticket',
          subjectId: ctx.ticketId,
          body: `Your request #${ticket.number} was resolved${typeof args.message === 'string' && args.message ? ` — ${args.message.slice(0, 200)}` : ''}`,
        })
      }
      return { resolved: true, ticketNumber: ticket.number }
    },
  },
  {
    name: 'ticket.handoff',
    description: 'Hand the ticket to a human technician with an internal note explaining why the worker could not resolve it.',
    risk: 'low',
    validate: (args) => (typeof args.reason === 'string' && args.reason.length > 0 && args.reason.length <= 4000 ? null : 'reason must be a non-empty string up to 4000 chars'),
    async run(ctx, args) {
      if (!ctx.ticketId) return { skipped: true, reason: 'no ticket linked to this run' }
      const ticket = (await ctx.client.query(
        `SELECT number, subject FROM tickets WHERE id = $1`,
        [ctx.ticketId],
      )).rows[0]
      if (!ticket) throw AppError.notFound('Ticket not found')
      await ctx.client.query(
        `INSERT INTO ticket_threads (tenant_id, ticket_id, author_id, kind, visibility, body, meta)
         VALUES ($1, $2, NULL, 'ai_worker', 'internal', $3, $4::jsonb)`,
        [ctx.tenantId, ctx.ticketId, `AI worker handed this ticket to a technician: ${String(args.reason)}`, JSON.stringify({ runId: ctx.runId, source: 'ai_worker' })],
      )
      if (ticket.status === 'pending_user') {
        await ctx.client.query(`UPDATE tickets SET status = 'open', updated_at = now() WHERE id = $1`, [ctx.ticketId])
      }
      return { handedOff: true, ticketNumber: ticket.number }
    },
  },
]

export function getWorkerTool(name: string): WorkerToolDef {
  const tool = WORKER_TOOLS.find((t) => t.name === name)
  if (!tool) throw AppError.badRequest(`Unknown worker tool: ${name}`, 'unknown_tool')
  return tool
}

export function workerToolCatalogForPrompt(): string {
  return WORKER_TOOLS
    .filter((t) => t.risk === 'low' || t.risk === 'high')
    .map((t) => `- ${t.name}: ${t.description} (risk: ${t.risk})`)
    .join('\n')
}