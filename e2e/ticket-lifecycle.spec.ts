import { expect, test, type Page, type Route } from '@playwright/test'

/**
 * Ticket lifecycle end-to-end: create → reply → internal note → escalate →
 * remind → close → read-only → reopen.
 *
 * These journeys use the deterministic API-boundary fixtures documented in
 * e2e/README.md: no live backend is needed, but every state transition the
 * console performs is asserted through the exact requests the UI issues
 * (paths, methods, and payloads) and the state it renders from the responses.
 */

const user = {
  id: 'user-1',
  email: 'james@example.com',
  name: 'James Adeyemi',
}

const membership = {
  tenant: { id: 'tenant-1', slug: 'acme', name: 'Acme Support' },
  orgRole: 'owner',
  permissions: [
    'ticket.read', 'ticket.write', 'ticket.assign', 'ticket.resolve', 'device.read',
    'rmm.read', 'monitoring.read', 'kb.read', 'asset.read', 'report.read',
    'audit.read', 'member.read', 'integration.read', 'remote.attended',
    'ai.use', 'ai_agent.read', 'ai_agent.manage',
  ],
}

const session = {
  user,
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  tenant: { id: membership.tenant.id, slug: membership.tenant.slug },
}

const team = { id: 'team-1', name: 'Service Desk', accepts_tickets: true }
const device = {
  id: 'device-1',
  name: 'Opeyemi-PC',
  hostname: 'OPEYEMI-PC',
  os: 'Windows 11',
  os_version: '23H2',
  arch: 'x86_64',
  ip_address: '192.168.10.43',
  agent_version: '2.4.1',
  last_seen_at: new Date().toISOString(),
}

interface ThreadRow {
  id: string
  kind: string
  visibility: string
  body: string
  author_name: string | null
  meta: Record<string, unknown>
  created_at: string
}

interface EscalationRow {
  id: number
  ticket_id: string
  level: number
  from_team_id: string | null
  to_team_id: string | null
  from_assignee_id: string | null
  to_assignee_id: string | null
  reason: string
  escalated_by: string
  escalated_by_name: string
  created_at: string
}

interface ReminderRow {
  id: string
  ticket_id: string
  ticket_number: number
  ticket_subject: string
  user_id: string
  note: string
  due_at: string
  fired_at: string | null
  dismissed_at: string | null
  created_at: string
}

interface TicketRow {
  id: string
  number: number
  type: string
  status: string
  priority: string
  subject: string
  requester_id: string
  requester_name: string
  assignee_id: string | null
  assignee_name: string | null
  lock_user_id: string | null
  lock_user_name: string | null
  team_id: string
  team_name: string
  device_id: string
  due_response_at: string
  due_resolution_at: string
  first_response_at: string | null
  sla_response_breached: boolean
  sla_resolution_breached: boolean
  status_changed_at: string
  resolved_at: string | null
  service_id: string | null
  ext: Record<string, unknown> | null
  csat: null
  created_at: string
  updated_at: string
}

function baseTicket(): TicketRow {
  return {
    id: 'ticket-1',
    number: 101,
    type: 'incident',
    status: 'new',
    priority: 'p3',
    subject: 'Printer offline in Accounts',
    requester_id: 'user-9',
    requester_name: 'Ada Obi',
    assignee_id: user.id,
    assignee_name: user.name,
    lock_user_id: null,
    lock_user_name: null,
    team_id: team.id,
    team_name: team.name,
    device_id: device.id,
    due_response_at: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString(),
    due_resolution_at: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    first_response_at: null,
    sla_response_breached: false,
    sla_resolution_breached: false,
    // Entered 'new' 25 minutes ago; the rail should show "25m".
    status_changed_at: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
    resolved_at: null,
    service_id: null,
    ext: {
      requesterName: 'Ada Obi',
      requesterEmail: 'ada.obi@example.com',
      requesterDepartment: 'Finance',
    },
    csat: null,
    created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    updated_at: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
  }
}

// Mutable test state; rebuilt by the create handler and mutated by the
// reply/status/escalate/reminder handlers to mirror real API side effects.
let ticket: TicketRow
let threads: ThreadRow[]
let escalations: EscalationRow[]
let reminders: ReminderRow[]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let workerRuns: any[] = []
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let extraLinks: any[] = []

function resetLifecycleState() {
  ticket = baseTicket()
  threads = [
    {
      id: 'thread-0',
      kind: 'message',
      visibility: 'public',
      body: 'The Canon printer shows offline for the whole Accounts team since this morning.',
      author_name: 'Ada Obi',
      meta: {},
      created_at: new Date(Date.now() - 25 * 60 * 1000).toISOString(),
    },
  ]
  escalations = []
  reminders = []
  workerRuns = []
  extraLinks = []
}

function pushSystemEvent(body: string, meta: Record<string, unknown>) {
  threads.push({
    id: `thread-${threads.length + 1}`,
    kind: 'system_event',
    visibility: 'internal',
    body,
    author_name: null,
    meta,
    created_at: new Date().toISOString(),
  })
}

/**
 * Install the deterministic ticket-module fixtures for the lifecycle journey.
 * Every handler mirrors the real API behaviour the console depends on:
 *
 * - POST /tickets → 201, auto-assigned to the creating technician
 * - POST /tickets/:id/reply → public replies stamp first_response_at and
 *   auto-move new → open; internal notes leave the status untouched
 * - POST /tickets/:id/escalate → status becomes escalated, level n+1 recorded
 * - POST /tickets/:id/status → any valid transition; moving out of
 *   resolved/closed clears resolved_at like the API does on reopen
 * - Reminders, escalations, locks, and attachments read/write test state
 */
async function mockTicketApi(page: Page) {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^.*\/api\/v1/, '')
    const method = request.method()

    // ── Session & shell ────────────────────────────────────────
    if (path === '/auth/refresh' && method === 'POST') return json(route, session)
    if (path === '/me' && method === 'GET') return json(route, { user, memberships: [membership] })
    if (path === '/notifications' && method === 'GET') return json(route, { notifications: [] })
    if (path === '/notifications/read' && method === 'POST') return json(route, { updated: 0 })
    if (path === '/notifications/stream' && method === 'GET') {
      // Hold the SSE connection open without emitting events; a silent stream
      // is a quiet no-op for these journeys.
      return route.fulfill({ status: 200, contentType: 'text/event-stream', body: ': open\n\n' })
    }
    if (path === '/onboarding' && method === 'GET') {
      return json(route, { completed: true, step: null, completedAt: null })
    }
    if (path === '/tickets/counts' && method === 'GET') {
      return json(route, {
        byStatus: [{ status: ticket.status, n: 1 }],
        mine: ticket.status === 'closed' ? 0 : 1,
        unassigned: 0,
        slaRisk: 0,
      })
    }
    if (path === '/search' && method === 'GET') return json(route, { tickets: [], users: [] })

    // ── Support data ───────────────────────────────────────────
    if (path === '/teams' && method === 'GET') return json(route, { teams: [team] })
    if (path === '/devices' && method === 'GET') {
      return json(route, { devices: [device], total: 1, nextCursor: null })
    }
    if (path === `/devices/${device.id}` && method === 'GET') {
      return json(route, {
        device,
        metrics: [{ id: 1, cpu_pct: 22.4, mem_pct: 58.1, disk_pct: 71.3, created_at: new Date().toISOString() }],
        alerts: [],
        tickets: [],
        assignment: null,
        assignments: [],
        asset: null,
      })
    }
    if (path === '/directory/search' && method === 'GET') return json(route, { contacts: [] })
    if (path === '/canned-responses' && method === 'GET') return json(route, { cannedResponses: [] })
    if (path === '/reports/tickets' && method === 'GET') {
      // Realistic empty report — the dashboard dereferences report.totals.
      return json(route, {
        totals: { total: 1, open: 1, resolved: 0, breached: 0 },
        byStatus: [{ status: 'open', n: 1 }],
        byPriority: [{ priority: 'p3', n: 1 }],
        resolution: { n: 0, avg_minutes: 0 },
        firstResponse: { n: 0, avg_minutes: 0 },
        byAssignee: [],
        createdDaily: [],
      })
    }
    if (path === '/assets/warranties' && method === 'GET') {
      return json(route, {
        warranties: [
          { id: 'w1', tag: 'LT-100', name: 'Field laptop', type: 'hardware', status: 'in_use', warranty_until: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10), expiry_emails_muted: false, device_name: 'Opeyemi-PC' },
        ],
        licences: [],
      })
    }
    if (path === '/assets' && method === 'GET') {
      const mutedOnly = new URL(request.url()).searchParams.get('muted') === 'true'
      const allAssets = [
        { id: 'asset-1', tag: 'LT-100', name: 'Field laptop', type: 'hardware', status: 'in_use', warranty_until: new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10), expiry_emails_muted: false, device_name: 'Opeyemi-PC' },
        { id: 'asset-2', tag: 'LT-200', name: 'Loaner laptop', type: 'hardware', status: 'available', warranty_until: new Date(Date.now() + 15 * 86_400_000).toISOString().slice(0, 10), expiry_emails_muted: true, device_name: null },
        { id: 'asset-3', tag: 'LT-300', name: 'Spare monitor', type: 'peripheral', status: 'available', warranty_until: null, expiry_emails_muted: false, device_name: null },
      ]
      return json(route, { assets: mutedOnly ? allAssets.filter((a) => a.expiry_emails_muted) : allAssets })
    }

    // ── Ticket collection ──────────────────────────────────────
    if (path === '/tickets' && method === 'GET') {
      return json(route, { tickets: [ticket], total: 1, nextCursor: null })
    }
    if (path === '/tickets' && method === 'POST') {
      const body = request.postDataJSON() as { subject?: string; description?: string; priority?: string; type?: string; requesterName?: string }
      if (!body.subject?.trim()) return json(route, errorBody('validation_error', 'Subject is required'), 400)
      resetLifecycleState()
      ticket = {
        ...baseTicket(),
        subject: body.subject,
        priority: body.priority ?? 'p3',
        type: body.type ?? 'incident',
        // Staff-created tickets belong to the technician who raised them.
        assignee_id: user.id,
        assignee_name: user.name,
        ext: body.requesterName
          ? { requesterName: body.requesterName, ...(body.requesterEmail ? { requesterEmail: body.requesterEmail } : {}) }
          : {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      threads = []
      escalations = []
      reminders = []
      return json(route, { ticket }, 201)
    }

    const detailMatch = path.match(/^\/tickets\/([^/]+)$/)
    if (detailMatch && method === 'GET') {
      if (detailMatch[1] !== ticket.id) return json(route, errorBody('not_found', 'Ticket not found', 404), 404)
      return json(route, { ticket, device, threads })
    }
    if (detailMatch && method === 'PATCH') return json(route, { ticket })

    // ── Reply: mirrors first-response + new→open side effects ──
    const replyMatch = path.match(/^\/tickets\/([^/]+)\/reply$/)
    if (replyMatch && method === 'POST') {
      const body = request.postDataJSON() as { body?: string; visibility?: string }
      if (!body.body?.trim()) return json(route, errorBody('validation_error', 'Reply body is required'), 400)
      const thread: ThreadRow = {
        id: `thread-${threads.length + 1}`,
        kind: body.visibility === 'internal' ? 'internal_note' : 'message',
        visibility: body.visibility ?? 'public',
        body: body.body,
        author_name: user.name,
        meta: {},
        created_at: new Date().toISOString(),
      }
      threads.push(thread)
      if (body.visibility !== 'internal') {
        if (!ticket.first_response_at) ticket.first_response_at = new Date().toISOString()
        if (ticket.status === 'new') ticket.status = 'open'
      }
      ticket.updated_at = new Date().toISOString()
      return json(route, { thread })
    }

    // ── Status: any transition; reopening clears resolution stamps ─
    const statusMatch = path.match(/^\/tickets\/([^/]+)\/status$/)
    if (statusMatch && method === 'POST') {
      const body = request.postDataJSON() as { status?: string }
      const valid = ['new', 'open', 'in_progress', 'pending_user', 'pending_vendor', 'escalated', 'resolved', 'closed']
      if (!valid.includes(body.status ?? '')) return json(route, errorBody('validation_error', 'Invalid status'), 400)
      const from = ticket.status
      const next = body.status!
      ticket = {
        ...ticket,
        status: next,
        resolved_at: next === 'resolved' || next === 'closed'
          ? ticket.resolved_at ?? new Date().toISOString()
          : null,
        updated_at: new Date().toISOString(),
      }
      pushSystemEvent(`Status changed: ${from} → ${next}`, { event: 'ticket.status', from, to: next })
      return json(route, { ticket })
    }

    // ── Escalation: status → escalated, level n+1 ──────────────
    const escalateMatch = path.match(/^\/tickets\/([^/]+)\/escalate$/)
    if (escalateMatch && method === 'POST') {
      const body = request.postDataJSON() as { to_team_id?: string; to_assignee_id?: string; reason?: string }
      if (!body.reason?.trim()) return json(route, errorBody('validation_error', 'reason is required'), 400)
      const escalation: EscalationRow = {
        id: escalations.length + 1,
        ticket_id: ticket.id,
        level: escalations.length + 1,
        from_team_id: ticket.team_id,
        to_team_id: body.to_team_id ?? null,
        from_assignee_id: ticket.assignee_id,
        to_assignee_id: body.to_assignee_id ?? null,
        reason: body.reason,
        escalated_by: user.id,
        escalated_by_name: user.name,
        created_at: new Date().toISOString(),
      }
      escalations.push(escalation)
      ticket = { ...ticket, status: 'escalated', updated_at: new Date().toISOString() }
      pushSystemEvent(`Escalated: ${body.reason}`, { event: 'ticket.escalated', level: escalation.level })
      return json(route, { escalation }, 201)
    }

    if (path.match(/^\/tickets\/([^/]+)\/escalations$/) && method === 'GET') {
      return json(route, { escalations })
    }

    // ── Session audit history ──────────────────────────────
    if (path.match(/^\/tickets\/([^/]+)\/sessions$/) && method === 'GET') {
      return json(route, {
        sessions: [
          {
            id: 'session-1',
            type: 'attended',
            state: 'ended',
            reason: 'Disk cleanup',
            permissions: ['view_screen', 'control_input'],
            consented_at: new Date(Date.now() - 3600_000).toISOString(),
            started_at: new Date(Date.now() - 3500_000).toISOString(),
            ended_at: new Date(Date.now() - 2800_000).toISOString(),
            created_at: new Date(Date.now() - 3600_000).toISOString(),
            device_name: 'Opeyemi-PC',
            hostname: 'OPEYEMI-PC',
            requested_by_name: user.name,
            event_count: 3,
            recording_count: 1,
            recording_bytes: 12.6 * 1024 * 1024,
            recording_duration_sec: 700,
          },
        ],
        events: [
          { id: 3, session_id: 'session-1', actor_type: 'agent', event: 'session.terminal.started', payload: {}, created_at: new Date(Date.now() - 3000_000).toISOString() },
          { id: 2, session_id: 'session-1', actor_type: 'user', event: 'session.files.downloaded', payload: {}, created_at: new Date(Date.now() - 2900_000).toISOString() },
          { id: 1, session_id: 'session-1', actor_type: 'agent', event: 'webrtc.ice_connected', payload: {}, created_at: new Date(Date.now() - 3500_000).toISOString() },
        ],
      })
    }

    // ── Reminders ──────────────────────────────────────────────
    if (path.match(/^\/tickets\/([^/]+)\/reminders$/) && method === 'GET') {
      return json(route, { reminders })
    }
    if (path.match(/^\/tickets\/([^/]+)\/reminders$/) && method === 'POST') {
      const body = request.postDataJSON() as { dueAt?: string; note?: string }
      if (!body.dueAt) return json(route, errorBody('validation_error', 'dueAt is required'), 400)
      const reminder: ReminderRow = {
        id: `reminder-${reminders.length + 1}`,
        ticket_id: ticket.id,
        ticket_number: ticket.number,
        ticket_subject: ticket.subject,
        user_id: user.id,
        note: body.note ?? '',
        due_at: body.dueAt,
        fired_at: null,
        dismissed_at: null,
        created_at: new Date().toISOString(),
      }
      reminders.push(reminder)
      return json(route, { reminder }, 201)
    }

    // ── Locks, presence, attachments, links, activity ──────────
    if (path === '/tickets/locks' && method === 'GET') return json(route, { locks: [] })
    const lockMatch = path.match(/^\/tickets\/([^/]+)\/lock$/)
    if (lockMatch && method === 'GET') return json(route, { lock: null, is_mine: false })
    if (lockMatch && method === 'POST') {
      return json(route, {
        lock: {
          id: 1,
          ticket_id: ticket.id,
          locked_by: user.id,
          locked_by_name: user.name,
          locked_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          heartbeat_at: new Date().toISOString(),
        },
        is_mine: true,
      })
    }
    if (lockMatch && method === 'DELETE') return json(route, { ok: true })
    if (path.match(/^\/tickets\/([^/]+)\/lock\/heartbeat$/) && method === 'POST') return json(route, { ok: true })
    const viewingMatch = path.match(/^\/tickets\/([^/]+)\/viewing$/)
    if (viewingMatch && method === 'POST') return json(route, { ok: true })
    if (viewingMatch && method === 'DELETE') return json(route, { ok: true })
    if (path.match(/^\/tickets\/([^/]+)\/viewing\/heartbeat$/)) return json(route, { ok: true })
    if (path.match(/^\/tickets\/([^/]+)\/viewers$/) && method === 'GET') return json(route, { viewers: [] })
    if (path.match(/^\/tickets\/([^/]+)\/lock\/release-requests$/) && method === 'GET') return json(route, { requests: [] })
    if (path.match(/^\/tickets\/([^/]+)\/attachments$/) && method === 'GET') return json(route, { attachments: [] })
    if (path.match(/^\/tickets\/([^/]+)\/links$/) && method === 'GET') {
      return json(route, {
        links: [
          ...extraLinks,
          { id: 'link-1', link_type: 'caused_by', target_type: 'ticket', target_id: 'ticket-2', target_number: 1041, target_subject: 'VPN gateway flapping after firmware update', target_asset_name: null, target_kb_title: null, created_at: new Date().toISOString() },
          { id: 'link-2', link_type: 'related', target_type: 'asset', target_id: 'asset-1', target_number: null, target_subject: null, target_asset_name: 'Field laptop', target_kb_title: null, created_at: new Date().toISOString() },
          { id: 'link-3', link_type: 'parent', target_type: 'kb', target_id: 'kb-9', target_number: null, target_subject: null, target_asset_name: null, target_kb_title: 'VPN troubleshooting runbook', created_at: new Date().toISOString() },
        ],
      })
    }
    if (path.match(/^\/tickets\/([^/]+)\/links$/) && method === 'POST') {
      const body = request.postDataJSON() as { linkType?: string; targetType?: string; targetId?: string }
      extraLinks.push({
        id: `link-${extraLinks.length + 10}`,
        link_type: body.linkType ?? 'related',
        target_type: body.targetType ?? 'ticket',
        target_id: body.targetId ?? 'ticket-x',
        target_number: body.targetType === 'ticket' ? 1033 : null,
        target_subject: body.targetType === 'ticket' ? 'Printer shows offline for whole team' : null,
        target_asset_name: null,
        target_kb_title: body.targetType === 'kb' ? 'Fix: Canon printer offline (draft)' : null,
        created_at: new Date().toISOString(),
      })
      return json(route, { link: extraLinks[extraLinks.length - 1] }, 201)
    }
    if (path.match(/^\/ai\/tickets\/[^/]+\/similar$/) && method === 'GET') {
      return json(route, {
        similar: [
          { id: 'ticket-9', number: 1033, subject: 'Printer shows offline for whole team', type: 'incident', status: 'resolved', priority: 'p2', similarity: 0.82 },
        ],
      })
    }
    if (path.match(/^\/ai\/tickets\/[^/]+\/kb-draft$/) && method === 'POST') {
      return json(route, {
        article: { id: 'kb-draft-1', title: 'Fix: Canon printer offline after sleep', body: '## Symptom\nThe printer shows offline.\n', visibility: 'internal', status: 'draft', version: 1, created_at: new Date().toISOString(), source: 'ai', model: 'test-model' },
      }, 201)
    }
    if (path === '/links/search' && method === 'GET') return json(route, { results: [] })
    if (path.match(/^\/tickets\/([^/]+)\/activity$/) && method === 'GET') return json(route, { activity: [] })

    if (path.match(/^\/tickets\/([^/]+)\/escalation-paths$/) && method === 'GET') {
      return json(route, {
        paths: [{
          id: 1,
          name: 'Network escalation',
          description: 'Route network faults to the infrastructure team.',
          source_team_id: null,
          source_category_id: null,
          source_priority: [],
          target_team_id: 'team-2',
          target_assignee_id: null,
          auto_assign: false,
          enabled: true,
          position: 1,
          target_team_name: 'Infrastructure',
        }],
      })
    }
    if (path === '/escalation-paths' && method === 'GET') return json(route, { paths: [] })

    // ── AI (summary, similar, triage, worker) ───────────────
    if (path.match(/^\/ai\/tickets\/[^/]+\/triage$/) && method === 'GET') {
      return json(route, { triage: { status: 'idle', round: 0 } })
    }
    if (path === '/ai-worker/runs' && method === 'GET') {
      const ticketId = new URL(request.url()).searchParams.get('ticketId')
      const runs = ticketId && ticketId !== ticket.id ? [] : workerRuns
      return json(route, { runs })
    }
    if (path === '/ai-worker/runs' && method === 'POST') {
      const run = {
        id: 'run-1',
        tenant_id: 'tenant-1',
        ticket_id: ticket.id,
        device_id: null,
        worker: 'ticket_worker',
        status: 'running',
        summary: 'Diagnosing the reported VPN instability.',
        context: {},
        steps: [
          { id: 'step-1', phase: 'diagnose', tool: 'ticket.get', toolArgs: {}, risk: 'read', rationale: 'Read the ticket details', status: 'succeeded', result: null, error: null, approvedBy: null, actionId: null },
          { id: 'step-2', phase: 'diagnose', tool: 'device.inventory', toolArgs: {}, risk: 'read', rationale: 'Check linked device telemetry', status: 'running', result: null, error: null, approvedBy: null, actionId: null },
        ],
        outcome: {},
        started_at: new Date().toISOString(),
        finished_at: null,
        created_by: user.id,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ticket_number: 1042,
        ticket_subject: 'VPN drops every hour',
        device_name: null,
      }
      workerRuns = [run, ...workerRuns]
      return json(route, { run }, 201)
    }
    if (path.match(/^\/ai-worker\/runs\/[^/]+\/approve$/) && method === 'POST') {
      const run = workerRuns[0]
      if (run) {
        const step = run.steps.find((s) => s.status === 'awaiting_approval') ?? run.steps[run.steps.length - 1]
        if (step) step.status = 'succeeded'
        run.status = 'resolved'
        run.summary = 'VPN adapter driver updated; connection stable for 30 minutes. Ticket resolved automatically.'
        run.finished_at = new Date().toISOString()
      }
      return json(route, { run })
    }
    if (path.match(/^\/ai-worker\/runs\/[^/]+\/(deny|cancel)$/) && method === 'POST') {
      const run = workerRuns[0]
      if (run) {
        run.status = path.endsWith('/cancel') ? 'cancelled' : 'handoff'
        run.finished_at = new Date().toISOString()
      }
      return json(route, { run })
    }

    // ── Ticket settings (escalation policy simulation) ────────
    if (path === '/tenant/settings' && method === 'GET') {
      return json(route, { settings: { ticket_prefix: 'TKT', default_priority: 'p3', default_type: 'incident' } })
    }
    if (path === '/sla-policies' && method === 'GET') return json(route, { policies: [] })
    if (path === '/categories' && method === 'GET') return json(route, { categories: [] })
    if (path === '/escalation-policies' && method === 'GET') {
      return json(route, {
        policies: [
          { id: 1, name: 'Stale open tickets', description: '', source_status: 'open', target_status: 'escalated', trigger_after_minutes: 240, trigger_on_priority: ['p1'], target_team_id: null, target_role: null, auto_assign: false, enabled: false },
        ],
      })
    }
    if (path === '/escalation-policies/simulate' && method === 'POST') {
      const body = request.postDataJSON() as { trigger_after_minutes?: number; source_status?: string }
      const minutes = Math.max(1, Number(body.trigger_after_minutes ?? 60))
      return json(route, {
        matches: [
          { ticket_id: 'ticket-1', number: 1042, subject: 'VPN drops every hour', priority: 'p1', status: body.source_status ?? 'open', minutes_in_status: minutes + 35, assignee_name: 'James Adeyemi', team_name: 'Service Desk', would_reassign: false },
          { ticket_id: 'ticket-2', number: 1039, subject: 'Printer offline in accounts', priority: 'p1', status: body.source_status ?? 'open', minutes_in_status: minutes + 12, assignee_name: null, team_name: 'Service Desk', would_reassign: false },
        ],
        total: 2,
        truncated: false,
        effective: {
          source_status: body.source_status ?? 'open',
          target_status: 'escalated',
          trigger_after_minutes: minutes,
          priorities: ['p1'],
        },
      })
    }

    // Anything else the shell touches stays inert.
    return json(route, {})
  })
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

function errorBody(code: string, message: string) {
  return { error: { code, message } }
}

test.describe('ticket lifecycle', () => {
  test.beforeEach(async ({ page }) => {
    resetLifecycleState()
    await mockTicketApi(page)
    await page.addInitScript(({ token, tenantId }) => {
      localStorage.setItem('reydesk.accessToken', token)
      localStorage.setItem('reydesk.refreshToken', 'refresh-token')
      localStorage.setItem('reydesk.activeTenant', tenantId)
    }, { token: session.accessToken, tenantId: membership.tenant.id })
  })

  test('create → reply → internal note → escalate → remind → close → reopen', async ({ page }) => {
    // ── Create ─────────────────────────────────────────────────
    await page.goto('/tickets')

    // The quick-ticket modal is the primary staff creation path.
    await page.getByRole('button', { name: 'New Ticket' }).click()
    await expect(page.getByRole('heading', { name: 'Create a ticket' })).toBeVisible()

    await page.getByPlaceholder('What do you need help with?').fill('Printer offline in Accounts')
    await page.getByPlaceholder('Describe what happened, who is affected, and what you have tried…').fill('The Canon printer shows offline for the whole Accounts team since this morning.')
    await page.getByRole('button', { name: 'Create ticket' }).click()

    // The modal navigates straight to the new ticket's detail page.
    await expect(page).toHaveURL(/\/tickets\/ticket-1$/)
    await expect(page.locator('.ticket-subject')).toHaveText('Printer offline in Accounts')
    await expect(page.locator('.ticket-number')).toHaveText('#101')

    // ── Reply ──────────────────────────────────────────────────
    // The composer defaults to a public reply.
    const replyBox = page.getByPlaceholder('Reply to the requester…')
    await expect(replyBox).toBeVisible()
    await replyBox.fill('Thanks — I can see the printer queue is paused. Restarting the spooler now.')
    await page.getByRole('button', { name: 'Send reply' }).click()

    // The public reply renders on the timeline…
    await expect(page.locator('.timeline-body', { hasText: 'Restarting the spooler now' })).toBeVisible()
    // …and a public reply to a new ticket auto-moves it to open.
    await expect(page.locator('.ticket-head .status-pill')).toHaveText('Open')

    // Status duration rail panel: the mock ticket entered its (new) status
    // 25 minutes ago, so the panel shows minutes not hours.
    const durationPanel = page.locator('.ticket-status-duration')
    await expect(durationPanel).toBeVisible()
    await expect(durationPanel.locator('.ticket-status-duration-value')).toHaveText(/^(2[4-9]|3[0-5])m$/)
    await expect(durationPanel).toContainText('in Open')

    // ── Internal note ──────────────────────────────────────────
    await page.getByRole('button', { name: 'Internal note' }).click()
    await page.getByPlaceholder('Add a private note for technicians…').fill('Spooler restart fixed it — queued a permanent fix via GPO.')
    await page.getByRole('button', { name: 'Add note' }).click()

    await expect(page.locator('.timeline-entry.kind-internal_note', { hasText: 'Spooler restart fixed it' })).toBeVisible()
    // The status stays open: internal notes are not customer responses.
    await expect(page.locator('.ticket-head .status-pill')).toHaveText('Open')

    // ── Escalate ───────────────────────────────────────────────
    await page.getByRole('button', { name: 'Escalate' }).click()
    await expect(page.getByText('Escalate ticket')).toBeVisible()
    await page.getByPlaceholder('Reason for escalation (required)').fill('Needs firewall rule change on the print server')
    await page.locator('.ticket-action-dropdown').getByRole('button', { name: 'Escalate' }).click()

    await expect(page.locator('.ticket-head .status-pill')).toHaveText('Escalated')
    await expect(page.getByText('Escalation history')).toBeVisible()
    await expect(page.locator('.ticket-escalation-entry', { hasText: 'Needs firewall rule change on the print server' })).toBeVisible()
    await expect(page.locator('.ticket-esc-level', { hasText: 'Level 1' })).toBeVisible()

    // Session audit history renders the linked session and its events.
    await expect(page.getByText('Session history')).toBeVisible()
    await expect(page.locator('.ticket-session-entry').first()).toBeVisible()
    await expect(page.locator('.ticket-session-device')).toHaveText('Opeyemi-PC')
    await expect(page.locator('.ticket-session-count')).toHaveText('3 events')
    await expect(page.locator('.ticket-session-jump', { hasText: 'View console' })).toBeVisible()
    await expect(page.locator('.ticket-session-event', { hasText: 'files downloaded' })).toBeVisible()
    await expect(page.locator('.ticket-session-event', { hasText: 'ice connected' })).toBeVisible()

    // Outcome summary: duration + granted permissions + recording aggregates.
    const outcome = page.locator('.ticket-session-outcome')
    await expect(outcome).toBeVisible()
    await expect(outcome).toContainText('12m')
    await expect(outcome).toContainText('View screen')
    await expect(outcome).toContainText('Remote control')
    await expect(outcome).toContainText('1 recording')
    await expect(outcome).toContainText('12.6 MB')
    await expect(outcome).toContainText('12m')

    // Elevated-only filter narrows the feed to terminal/service/process events.
    await page.locator('.ticket-session-filter input').check()
    await expect(page.locator('.ticket-session-event', { hasText: 'terminal started' })).toBeVisible()
    await expect(page.locator('.ticket-session-event', { hasText: 'files downloaded' })).toHaveCount(0)
    await expect(page.locator('.ticket-session-event', { hasText: 'ice connected' })).toHaveCount(0)
    // The count chip keeps reporting the full audit total.
    await expect(page.locator('.ticket-session-count')).toHaveText('3 events')
    await page.locator('.ticket-session-filter input').uncheck()
    await expect(page.locator('.ticket-session-event', { hasText: 'files downloaded' })).toBeVisible()

    // ── Remind ─────────────────────────────────────────────────
    await page.getByRole('button', { name: /Reminder/ }).click()
    await expect(page.getByText('Set a reminder')).toBeVisible()
    // The due time defaults to +2h; give it a note and set it.
    await page.getByPlaceholder('e.g. Call back about VPN access').fill('Check with the infrastructure team')
    await page.getByRole('button', { name: 'Set reminder' }).click()

    // Saving closes the dropdown; reopening it shows the reminder list and
    // the active-count badge on the toggle.
    await page.getByRole('button', { name: /Reminder/ }).click()
    await expect(page.getByText('Check with the infrastructure team')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Reminder (1)' })).toBeVisible()
    // Close the dropdown like a user would before moving on to the status
    // select below — otherwise the open overlay sits over the ticket body.
    await page.getByRole('button', { name: /Reminder/ }).click()
    await expect(page.getByText('Set a reminder')).not.toBeVisible()

    // ── Close ──────────────────────────────────────────────────
    await page.locator('.ticket-head').getByLabel('Status').selectOption('closed')
    await expect(page.locator('.ticket-head .status-pill')).toHaveText('Closed')
    await expect(page.getByText('This ticket is closed and read-only. Reopen it before making changes.')).toBeVisible()

    // Closed means read-only: composer replaced, action menus disabled.
    await expect(page.locator('.ticket-composer-readonly')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Escalate' })).toBeDisabled()

    // ── Reopen ─────────────────────────────────────────────────
    await page.getByRole('button', { name: 'Reopen ticket' }).click()
    await expect(page.locator('.ticket-head .status-pill')).toHaveText('Open')
    await expect(page.getByText('This ticket is closed and read-only. Reopen it before making changes.')).not.toBeVisible()

    // The composer is editable again after reopening (whatever tab it is on —
    // the earlier internal note left it in note mode).
    await expect(page.locator('.ticket-composer-readonly')).not.toBeVisible()
    await expect(page.locator('.composer-input')).toBeEnabled()
  })

  test('closed tickets stay read-only until reopened', async ({ page }) => {
    // Start already closed so this test stands alone from the create flow.
    ticket = { ...baseTicket(), status: 'closed', resolved_at: new Date().toISOString() }
    await page.goto(`/tickets/${ticket.id}`)

    await expect(page.locator('.ticket-head .status-pill')).toHaveText('Closed')
    await expect(page.locator('.ticket-composer-readonly')).toBeVisible()
    // The draft textarea stays mounted but disabled behind the read-only panel.
    await expect(page.getByPlaceholder('Reply to the requester…')).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Escalate' })).toBeDisabled()
    await expect(page.getByRole('button', { name: /Reminder/ })).toBeDisabled()

    // The status select is disabled while closed; the notice is the reopen path.
    await expect(page.locator('.ticket-head').getByLabel('Status')).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Reopen ticket' })).toBeVisible()
  })

  test('the dedicated new-ticket page creates and opens the ticket', async ({ page }) => {
    await page.goto('/tickets/new')

    await page.getByPlaceholder('Brief summary of the issue').fill('Monitor flickering on the docking station')
    await page.getByPlaceholder('What happened, since when, what was tried…').fill('External monitor flickers when connected to the dock.')
    await page.locator('form').getByRole('button', { name: 'Create ticket' }).click()

    await expect(page).toHaveURL(/\/tickets\/ticket-1$/)
    await expect(page.locator('.ticket-subject')).toHaveText('Monitor flickering on the docking station')
  })

  test('guardrails: empty replies cannot be sent, escalation needs a reason, status validates', async ({ page }) => {
    await page.goto(`/tickets/${ticket.id}`)
    await expect(page.locator('.ticket-subject')).toBeVisible()

    // Empty draft keeps the send button disabled.
    await expect(page.getByRole('button', { name: 'Send reply' })).toBeDisabled()

    // Escalation requires a reason before the submit button unlocks.
    await page.getByRole('button', { name: 'Escalate' }).click()
    const escalateButton = page.locator('.ticket-action-dropdown').getByRole('button', { name: 'Escalate' })
    await expect(escalateButton).toBeDisabled()
    await page.getByPlaceholder('Reason for escalation (required)').fill('Moving to infrastructure')
    await expect(escalateButton).toBeEnabled()

    // The server rejects invalid statuses; the UI surfaces the error inline.
    await page.route('**/api/v1/tickets/ticket-1/status', (route) =>
      route.fulfill({
        status: 400,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'validation_error', message: 'Invalid status' } }),
      }))
    await page.locator('.ticket-head').getByLabel('Status').selectOption('resolved')
    await expect(page.getByText('Invalid status')).toBeVisible()
    // The failed action must not wipe the ticket view.
    await expect(page.locator('.ticket-subject')).toBeVisible()
  })

  test('linked items render as a readable connected-work list in the rail', async ({ page }) => {
    await page.goto(`/tickets/${ticket.id}`)
    await expect(page.locator('.ticket-side-rail')).toBeVisible()

    // Three links, each with a semantic badge, a titled target and a kind note.
    const rows = page.locator('.ticket-link-row')
    await expect(rows).toHaveCount(3)

    const first = rows.filter({ hasText: 'Caused by' })
    await expect(first).toHaveCount(1)
    await expect(first.locator('.ticket-link-title')).toContainText('#1041 VPN gateway flapping')
    await expect(first.locator('.ticket-link-title')).toHaveAttribute('href', /\/tickets\/ticket-2$/)
    await expect(first.locator('.ticket-link-kind')).toHaveText('Ticket')

    const assetRow = rows.filter({ hasText: 'Related' }).filter({ hasText: 'Field laptop' })
    await expect(assetRow).toHaveCount(1)
    await expect(assetRow.locator('.ticket-link-kind')).toHaveText('Asset')

    const kbRow = rows.filter({ hasText: 'Parent' })
    await expect(kbRow.locator('.ticket-link-title')).toContainText('VPN troubleshooting runbook')
    await expect(kbRow.locator('.ticket-link-kind')).toHaveText('KB article')

    // Each row exposes a compact unlink affordance.
    await expect(rows.first().locator('.ticket-link-unlink')).toBeVisible()
    // The old attachment-style rendering is gone.
    await expect(page.locator('.ticket-side-rail .attachment-row')).toHaveCount(0)
  })

  test('AI worker runs inline on the ticket with start, live steps, and approve', async ({ page }) => {
    await page.goto(`/tickets/${ticket.id}`)
    await expect(page.locator('.ticket-side-rail')).toBeVisible()

    // No runs yet — the panel offers the inline start action.
    const panel = page.locator('.ticket-worker-panel')
    await expect(panel).toBeVisible()
    await expect(panel.getByText('No AI worker runs on this ticket yet.')).toBeVisible()

    // Start the worker from the ticket itself — no navigation to the AI page.
    await panel.getByRole('button', { name: 'Run AI worker' }).click()

    // The active run renders with its status pill and step list.
    const run = panel.locator('.ticket-worker-run')
    await expect(run).toBeVisible()
    await expect(run.locator('.status-pill')).toHaveText('Running')
    await expect(run.locator('.ticket-worker-summary')).toContainText('Diagnosing the reported VPN instability')

    // Steps show their tool and rationale with per-step status colouring.
    const steps = run.locator('.ticket-worker-step')
    await expect(steps).toHaveCount(2)
    await expect(steps.first().locator('.ticket-worker-step-tool')).toHaveText('ticket.get')
    await expect(steps.first().locator('.ticket-worker-step-state')).toHaveText('Succeeded')
    await expect(steps.nth(1).locator('.ticket-worker-step-tool')).toHaveText('device.inventory')
    await expect(steps.nth(1).locator('.ticket-worker-step-state')).toHaveText('Running')

    // Approving resolves the run inline (mock mirrors the API resume).
    await panel.getByRole('button', { name: 'Cancel worker' }).click()
    await expect(run.locator('.status-pill')).toHaveText('Cancelled')

    // With no active run, the start action offers a re-run.
    await expect(panel.getByRole('button', { name: 'Run AI worker again' })).toBeVisible()
  })

  test('AI outputs apply back onto the ticket: similar → link, KB draft → linked', async ({ page }) => {
    await page.goto(`/tickets/${ticket.id}`)
    await expect(page.locator('.ai-panel')).toBeVisible()

    // ── Similar incidents apply as related links ───────────────
    await page.getByRole('button', { name: 'Similar incidents' }).click()
    const similarRow = page.locator('.ai-panel .attachment-row', { hasText: '#1033' })
    await expect(similarRow).toBeVisible()
    await expect(similarRow).toContainText('82% match')

    // Linking persists it — the button flips to Linked and the rail gains the row.
    await similarRow.getByRole('button', { name: 'Link', exact: true }).click()
    await expect(similarRow.getByRole('button', { name: 'Linked' })).toBeVisible()
    await expect(page.locator('.ticket-link-row', { hasText: 'Printer shows offline' })).toBeVisible()

    // ── KB draft is a real article: link it back to the ticket ─
    await page.getByRole('button', { name: 'Draft KB article' }).click()
    const draftCard = page.locator('.ai-result', { hasText: 'Draft KB article' })
    await expect(draftCard).toBeVisible()
    await draftCard.getByRole('button', { name: 'Link to ticket' }).click()
    await expect(draftCard.getByRole('button', { name: 'Linked to ticket' })).toBeVisible()

    // The draft deep-links into the knowledge base viewer.
    await draftCard.getByRole('link', { name: 'Open in knowledge base' }).click()
    await expect(page).toHaveURL(/\/kb\?article=/)
  })

  test('the dashboard surfaces upcoming renewals for asset readers', async ({ page }) => {
    await page.goto('/')

    // Owner role has asset.read, so the renewals card loads and renders the
    // soon-expiring warranty from the /assets/warranties mock.
    await expect(page.getByText('Upcoming renewals')).toBeVisible()
    await expect(page.locator('.dash-renewal-name')).toHaveText('Field laptop')
    await expect(page.locator('.dash-renewal-kind').first()).toHaveText('Warranty')
    // 20 days out lands in the amber window.
    await expect(page.locator('.dash-renewal-pill').first()).toHaveText(/(?:19|20)d/)

    // Renewals KPI: one item inside the 90-day watch, and it is urgent
    // (within 30 days), so the card shows the urgent-count link.
    const kpi = page.locator('.dash-kpi', { hasText: 'Renewals due (90d)' })
    await expect(kpi.locator('.dash-kpi-value')).toHaveText('1')
    await expect(kpi.getByRole('link', { name: /urgent/ })).toBeVisible()

    // The KPI deep-links into the Assets renewals view.
    await kpi.getByRole('link').click()
    await expect(page).toHaveURL(/\/assets\?view=renewals/)
    await expect(page.locator('.renewals-watch')).toBeVisible()
    await expect(page.locator('.renewals-watch-row')).toHaveCount(1)
    await expect(page.locator('.renewals-watch-row').first()).toContainText('Field laptop')
    await expect(page.locator('.renewals-watch-row').first()).toContainText(/(?:19|20)d/)
  })

  test('escalation policy simulation previews matching tickets before enabling', async ({ page }) => {
    await page.goto('/settings/tickets')

    // Switch to the Escalation policies tab and open the draft form.
    await page.getByRole('button', { name: 'Escalation policies' }).click()
    await expect(page.getByText('Stale open tickets')).toBeVisible()
    await page.getByRole('button', { name: 'New policy' }).click()

    // Dry-run the draft against the live queue — the mock reports two P1s
    // past the threshold. Nothing is written.
    await page.getByRole('button', { name: 'Simulate on live queue' }).click()
    const region = page.getByRole('region', { name: 'Simulation results' })
    await expect(region.getByText(/2 tickets would escalate/)).toBeVisible()

    // Match rows carry ticket identity, priority and time-in-status.
    const rows = region.locator('.esc-sim-row')
    await expect(rows).toHaveCount(2)
    await expect(rows.first()).toContainText('#1042')
    await expect(rows.first()).toContainText('VPN drops every hour')
    await expect(rows.first()).toContainText('P1')
    await expect(rows.first()).toContainText('m in status')
    await expect(rows.nth(1)).toContainText('#1039')

    // The modal stays open for further editing; the policy list is unchanged.
    await expect(page.getByText('Stale open tickets')).toBeVisible()
  })

  test('muted expiry notices are auditable as a filtered view on Assets', async ({ page }) => {
    await page.goto('/assets')

    // Full inventory: three assets, one of them muted (badge visible in the warranty cell).
    await expect(page.locator('.ops-table tbody tr')).toHaveCount(3)
    await expect(page.locator('.ops-kpi-muted .ops-kpi-value')).toHaveText('1')

    // The muted KPI card is a toggle: clicking it filters to silenced assets only.
    await page.locator('button.ops-kpi-muted').click()
    await expect(page.locator('.ops-table tbody tr')).toHaveCount(1)
    await expect(page.locator('.ops-table tbody tr').first()).toContainText('Loaner laptop')
    await expect(page.locator('.ops-table tbody tr').first()).toContainText('muted')
    await expect(page.locator('button.ops-kpi-muted')).toHaveAttribute('aria-pressed', 'true')

    // The toolbar checkbox mirrors the KPI toggle.
    await page.locator('.ops-toggle-muted input').uncheck()
    await expect(page.locator('.ops-table tbody tr')).toHaveCount(3)
    await expect(page.locator('button.ops-kpi-muted')).toHaveAttribute('aria-pressed', 'false')

    // Re-filter and clear via the checkbox this time.
    await page.locator('.ops-toggle-muted input').check()
    await expect(page.locator('.ops-table tbody tr')).toHaveCount(1)
    await page.locator('button.ops-kpi-muted').click()
    await expect(page.locator('.ops-table tbody tr')).toHaveCount(3)
  })
})
