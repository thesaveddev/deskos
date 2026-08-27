import type { DbClient } from '../../db/pool.js'

export async function buildWorkerContext(client: DbClient, tenantId: string, ticketId: string, deviceId: string | null): Promise<Record<string, unknown>> {
  const ticket = (await client.query(`SELECT requester_id, device_id, service_id, asset_id FROM tickets WHERE id = $1`, [ticketId])).rows[0]
  const effectiveDeviceId = deviceId ?? ticket?.device_id ?? null
  const [requester, device, asset, service, edges] = await Promise.all([
    ticket?.requester_id ? client.query(`SELECT id, name, email FROM users WHERE id = $1`, [ticket.requester_id]) : { rows: [] },
    effectiveDeviceId ? client.query(`SELECT id, name, hostname, os, os_version, device_type, last_seen_at FROM devices WHERE id = $1`, [effectiveDeviceId]) : { rows: [] },
    ticket?.asset_id ? client.query(`SELECT id, tag, type, name, status, owner_id, location, warranty_until FROM assets WHERE id = $1`, [ticket.asset_id]) : effectiveDeviceId ? client.query(`SELECT id, tag, type, name, status, owner_id, location, warranty_until FROM assets WHERE device_id = $1 LIMIT 1`, [effectiveDeviceId]) : { rows: [] },
    ticket?.service_id ? client.query(`SELECT id, name, description, category_id, approval_required FROM services WHERE id = $1`, [ticket.service_id]) : { rows: [] },
    client.query(`SELECT subject_type, subject_id, relation, object_type, object_id, confidence, source FROM knowledge_graph_edges WHERE tenant_id = $1 AND ((subject_type = 'ticket' AND subject_id = $2) OR (subject_type = 'device' AND subject_id = $3) OR (subject_type = 'user' AND subject_id = $4)) ORDER BY confidence DESC LIMIT 100`, [tenantId, ticketId, effectiveDeviceId, ticket?.requester_id ?? null]),
  ])
  return { requester: requester.rows[0] ?? null, device: device.rows[0] ?? null, asset: asset.rows[0] ?? null, service: service.rows[0] ?? null, graphEdges: edges.rows }
}
