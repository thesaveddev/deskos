import type { DbClient } from '../../db/pool.js'
import { notify } from '../../core/notify.js'

/**
 * First active service_desk_manager in a tenant, falling back to the first
 * active owner — the default approver for requests that require one.
 */
export async function defaultApprover(client: DbClient, tenantId: string): Promise<string | null> {
  const manager = await client.query(
    `SELECT m.user_id
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1 AND m.org_role = 'service_desk_manager'
        AND m.status = 'active' AND u.status = 'active'
      ORDER BY m.created_at ASC LIMIT 1`,
    [tenantId],
  )
  if (manager.rows[0]) return manager.rows[0].user_id as string

  const owner = await client.query(
    `SELECT m.user_id
       FROM memberships m
       JOIN users u ON u.id = m.user_id
      WHERE m.tenant_id = $1 AND m.org_role = 'owner'
        AND m.status = 'active' AND u.status = 'active'
      ORDER BY m.created_at ASC LIMIT 1`,
    [tenantId],
  )
  return (owner.rows[0]?.user_id as string | undefined) ?? null
}

export interface TicketApprovalRequest {
  ticketId: string
  ticketNumber: number
  subject: string
  requesterId: string
  kind: string
  notificationBody: string
}

/**
 * Create a pending approval for a ticket and notify the default approver.
 * Returns the approval id, or null when the tenant has no approver.
 */
export async function requestTicketApproval(
  client: DbClient,
  tenantId: string,
  req: TicketApprovalRequest,
): Promise<string | null> {
  const approverId = await defaultApprover(client, tenantId)
  if (!approverId) return null

  const res = await client.query(
    `INSERT INTO ticket_approvals (tenant_id, ticket_id, approver_id, requested_by)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [tenantId, req.ticketId, approverId, req.requesterId],
  )
  await notify(client, tenantId, {
    userId: approverId,
    kind: req.kind,
    subjectType: 'ticket',
    subjectId: req.ticketId,
    body: req.notificationBody,
  })
  return res.rows[0].id as string
}

export interface ServiceApprovalRequest {
  ticketId: string
  ticketNumber: number
  serviceName: string
  requesterId: string
}

export async function requestServiceApproval(
  client: DbClient,
  tenantId: string,
  req: ServiceApprovalRequest,
): Promise<string | null> {
  return requestTicketApproval(client, tenantId, {
    ticketId: req.ticketId,
    ticketNumber: req.ticketNumber,
    subject: req.serviceName,
    requesterId: req.requesterId,
    kind: 'service.approval',
    notificationBody: `Service request #${req.ticketNumber} (${req.serviceName}) is awaiting your approval`,
  })
}

export async function requestChangeApproval(
  client: DbClient,
  tenantId: string,
  req: { ticketId: string; ticketNumber: number; subject: string; requesterId: string },
): Promise<string | null> {
  return requestTicketApproval(client, tenantId, {
    ticketId: req.ticketId,
    ticketNumber: req.ticketNumber,
    subject: req.subject,
    requesterId: req.requesterId,
    kind: 'change.approval',
    notificationBody: `Change #${req.ticketNumber} (${req.subject}) is awaiting your approval`,
  })
}
