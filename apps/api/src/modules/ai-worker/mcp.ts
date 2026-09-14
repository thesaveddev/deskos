/**
 * Model Context Protocol (MCP) server for ReyDesk.
 *
 * Exposes ReyDesk tools (ticket, device, KB, asset) to external AI clients
 * (Claude, Gemini, Copilot Studio) via the standard MCP protocol.
 *
 * This allows users to interact with ReyDesk through their preferred AI client:
 *   "Ask Claude to check the user's asset, investigate the incident and raise
 *    the appropriate change."
 *
 * Authentication: API key in x-reydesk-api-key header or Bearer token.
 * Each external client gets a scoped API key with tool-level permissions.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify'
import { AppError } from '../../core/errors.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import { logAiActivity } from './governance.js'

// MCP protocol version
const MCP_PROTOCOL_VERSION = '2024-11-05'

interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

/** Registry of tools exposed via MCP. */
export const MCP_TOOLS: McpTool[] = [
  {
    name: 'reydesk_list_tickets',
    description: 'List tickets in the workspace with optional status/priority/assignee filters.',
    inputSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', description: 'Filter by status (open, pending_user, resolved, closed)' },
        priority: { type: 'string', description: 'Filter by priority (low, normal, high, urgent)' },
        assigneeId: { type: 'string', description: 'Filter by assignee user ID' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
      },
    },
  },
  {
    name: 'reydesk_get_ticket',
    description: 'Get full ticket details including conversation history and linked device.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: 'Ticket UUID' },
      },
      required: ['ticketId'],
    },
  },
  {
    name: 'reydesk_create_ticket',
    description: 'Create a new support ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string', description: 'Ticket subject' },
        description: { type: 'string', description: 'Ticket description/body' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'], description: 'Priority level' },
        type: { type: 'string', enum: ['incident', 'request', 'problem', 'change'], description: 'Ticket type' },
        requesterEmail: { type: 'string', description: 'Requester email' },
        deviceId: { type: 'string', description: 'Linked device UUID' },
      },
      required: ['subject'],
    },
  },
  {
    name: 'reydesk_add_ticket_note',
    description: 'Add a note (public or internal) to a ticket.',
    inputSchema: {
      type: 'object',
      properties: {
        ticketId: { type: 'string', description: 'Ticket UUID' },
        body: { type: 'string', description: 'Note body' },
        visibility: { type: 'string', enum: ['public', 'internal'], description: 'Note visibility (default: public)' },
      },
      required: ['ticketId', 'body'],
    },
  },
  {
    name: 'reydesk_list_devices',
    description: 'List managed devices with optional online/offline filter.',
    inputSchema: {
      type: 'object',
      properties: {
        online: { type: 'boolean', description: 'Filter by online status' },
        os: { type: 'string', description: 'Filter by OS (windows, macos, linux, android)' },
        limit: { type: 'number', description: 'Max results (default 20, max 100)' },
      },
    },
  },
  {
    name: 'reydesk_get_device',
    description: 'Get device details including inventory, metrics, and alerts.',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'Device UUID' },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'reydesk_get_device_inventory',
    description: 'Get full device inventory (hardware, OS, apps, security posture).',
    inputSchema: {
      type: 'object',
      properties: {
        deviceId: { type: 'string', description: 'Device UUID' },
      },
      required: ['deviceId'],
    },
  },
  {
    name: 'reydesk_search_knowledge',
    description: 'Search the knowledge base for articles matching a query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'reydesk_list_assets',
    description: 'List IT assets (hardware, software licenses, subscriptions).',
    inputSchema: {
      type: 'object',
      properties: {
        type: { type: 'string', description: 'Filter by asset type' },
        limit: { type: 'number', description: 'Max results (default 20)' },
      },
    },
  },
  {
    name: 'reydesk_get_asset',
    description: 'Get asset details including assignment, warranty, and location.',
    inputSchema: {
      type: 'object',
      properties: {
        assetId: { type: 'string', description: 'Asset UUID' },
      },
      required: ['assetId'],
    },
  },
]

/** Handle MCP tool calls against the ReyDesk database. */
async function handleToolCall(
  request: FastifyRequest,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const ctx = request.tenantCtx!
  const pool = request.server.db

  switch (toolName) {
    case 'reydesk_list_tickets': {
      return withTenant(pool, ctx.tenantId, async (client) => {
        const conditions: string[] = ['t.tenant_id = $1']
        const params: unknown[] = [ctx.tenantId]
        if (typeof args.status === 'string') { params.push(args.status); conditions.push(`t.status = $${params.length}`) }
        if (typeof args.priority === 'string') { params.push(args.priority); conditions.push(`t.priority = $${params.length}`) }
        if (typeof args.assigneeId === 'string') { params.push(args.assigneeId); conditions.push(`t.assignee_id = $${params.length}`) }
        const limit = Math.min(Math.max(1, Number(args.limit) || 20), 100)
        const { rows } = await client.query(
          `SELECT t.id, t.number, t.subject, t.status, t.priority, t.type, t.source,
                  t.created_at, t.updated_at,
                  u.name AS assignee_name, r.name AS requester_name
           FROM tickets t
           LEFT JOIN users u ON u.id = t.assignee_id
           LEFT JOIN users r ON r.id = t.requester_id
           WHERE ${conditions.join(' AND ')}
           ORDER BY t.created_at DESC LIMIT $${params.length + 1}`,
          [...params, limit],
        )
        return { tickets: rows }
      })
    }
    case 'reydesk_get_ticket': {
      const ticketId = String(args.ticketId)
      return withTenant(pool, ctx.tenantId, async (client) => {
        const { rows } = await client.query(
          `SELECT t.*, u.name AS requester_name, u.email AS requester_email,
                  d.name AS device_name, d.hostname, d.os
           FROM tickets t
           LEFT JOIN users u ON u.id = t.requester_id
           LEFT JOIN devices d ON d.id = t.device_id
           WHERE t.id = $1 AND t.tenant_id = $2`,
          [ticketId, ctx.tenantId],
        )
        if (!rows[0]) throw AppError.notFound('Ticket not found')
        const threads = await client.query(
          `SELECT kind, body, created_at FROM ticket_threads WHERE ticket_id = $1 ORDER BY created_at ASC`,
          [ticketId],
        )
        return { ticket: rows[0], conversation: threads.rows }
      })
    }
    case 'reydesk_create_ticket': {
      return withTenant(pool, ctx.tenantId, async (client) => {
        const { rows: num } = await client.query('SELECT COALESCE(max(number), 0) + 1 AS next FROM tickets WHERE tenant_id = $1', [ctx.tenantId])
        const number = num[0].next
        const { rows } = await client.query(
          `INSERT INTO tickets (tenant_id, number, subject, description, priority, type, source, requester_id, device_id)
           VALUES ($1, $2, $3, $4, $5, $6, 'mcp', NULL, $7) RETURNING *`,
          [ctx.tenantId, number, args.subject, args.description ?? '', args.priority ?? 'normal', args.type ?? 'incident', args.deviceId ?? null],
        )
        return { ticket: rows[0] }
      })
    }
    case 'reydesk_add_ticket_note': {
      const ticketId = String(args.ticketId)
      const visibility = args.visibility === 'internal' ? 'internal' : 'public'
      return withTenant(pool, ctx.tenantId, async (client) => {
        await client.query(
          `INSERT INTO ticket_threads (tenant_id, ticket_id, kind, visibility, body)
           VALUES ($1, $2, 'message', $3, $4)`,
          [ctx.tenantId, ticketId, visibility, args.body],
        )
        return { added: true }
      })
    }
    case 'reydesk_list_devices': {
      return withTenant(pool, ctx.tenantId, async (client) => {
        const conditions: string[] = ['d.tenant_id = $1']
        const params: unknown[] = [ctx.tenantId]
        if (typeof args.online === 'boolean') {
          if (args.online) conditions.push('d.last_seen_at > now() - interval \'15 minutes\'')
          else conditions.push('(d.last_seen_at IS NULL OR d.last_seen_at <= now() - interval \'15 minutes\')')
        }
        if (typeof args.os === 'string') { params.push(args.os); conditions.push(`LOWER(d.os) = LOWER($${params.length})`) }
        const limit = Math.min(Math.max(1, Number(args.limit) || 20), 100)
        const { rows } = await client.query(
          `SELECT d.id, d.name, d.hostname, d.os, d.os_version, d.device_type, d.last_seen_at
           FROM devices d
           WHERE ${conditions.join(' AND ')}
           ORDER BY d.last_seen_at DESC NULLS LAST LIMIT $${params.length + 1}`,
          [...params, limit],
        )
        return { devices: rows }
      })
    }
    case 'reydesk_get_device': {
      const deviceId = String(args.deviceId)
      return withTenant(pool, ctx.tenantId, async (client) => {
        const { rows } = await client.query('SELECT * FROM devices WHERE id = $1 AND tenant_id = $2', [deviceId, ctx.tenantId])
        if (!rows[0]) throw AppError.notFound('Device not found')
        const metrics = (await client.query('SELECT * FROM device_metrics WHERE device_id = $1 ORDER BY recorded_at DESC LIMIT 1', [deviceId])).rows[0]
        const alerts = (await client.query('SELECT * FROM device_alerts WHERE device_id = $1 AND resolved_at IS NULL ORDER BY created_at DESC LIMIT 10', [deviceId])).rows
        return { device: rows[0], metrics, openAlerts: alerts }
      })
    }
    case 'reydesk_get_device_inventory': {
      const deviceId = String(args.deviceId)
      return withTenant(pool, ctx.tenantId, async (client) => {
        const { rows } = await client.query('SELECT * FROM device_inventory WHERE device_id = $1', [deviceId])
        return { inventory: rows[0] ?? null }
      })
    }
    case 'reydesk_search_knowledge': {
      return withTenant(pool, ctx.tenantId, async (client) => {
        const limit = Math.min(Math.max(1, Number(args.limit) || 10), 50)
        const { rows } = await client.query(
          `SELECT id, title, slug, LEFT(body, 500) AS excerpt, updated_at
           FROM kb_articles
           WHERE tenant_id = $1 AND status = 'published'
             AND (title ILIKE $2 OR body ILIKE $2)
           ORDER BY updated_at DESC LIMIT $3`,
          [ctx.tenantId, `%${args.query}%`, limit],
        )
        return { articles: rows }
      })
    }
    case 'reydesk_list_assets': {
      return withTenant(pool, ctx.tenantId, async (client) => {
        const conditions: string[] = ['tenant_id = $1']
        const params: unknown[] = [ctx.tenantId]
        if (typeof args.type === 'string') { params.push(args.type); conditions.push(`type = $${params.length}`) }
        const limit = Math.min(Math.max(1, Number(args.limit) || 20), 100)
        const { rows } = await client.query(
          `SELECT id, tag, type, name, status, owner_id, location, warranty_until
           FROM assets WHERE ${conditions.join(' AND ')}
           ORDER BY created_at DESC LIMIT $${params.length + 1}`,
          [...params, limit],
        )
        return { assets: rows }
      })
    }
    case 'reydesk_get_asset': {
      const assetId = String(args.assetId)
      return withTenant(pool, ctx.tenantId, async (client) => {
        const { rows } = await client.query('SELECT * FROM assets WHERE id = $1 AND tenant_id = $2', [assetId, ctx.tenantId])
        if (!rows[0]) throw AppError.notFound('Asset not found')
        return { asset: rows[0] }
      })
    }
    default:
      throw AppError.badRequest(`Unknown MCP tool: ${toolName}`, 'unknown_mcp_tool')
  }
}

/**
 * Register the MCP JSON-RPC endpoint.
 *
 * POST /api/v1/mcp — accepts JSON-RPC 2.0 messages:
 *   - initialize: returns server capabilities
 *   - tools/list: returns available tools
 *   - tools/call: executes a tool
 */
export async function mcpRoutes(app: FastifyInstance): Promise<void> {
  app.post('/mcp', { preHandler: [authenticate, requireTenant] }, async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as { jsonrpc?: string; method?: string; params?: Record<string, unknown>; id?: string | number } | undefined
    if (!body || body.jsonrpc !== '2.0' || !body.method) {
      return reply.code(400).send({ jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' }, id: body?.id ?? null })
    }

    const startTime = Date.now()

    try {
      let result: unknown

      switch (body.method) {
        case 'initialize':
          result = {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'reydesk', version: '1.0.0' },
          }
          break

        case 'tools/list':
          result = { tools: MCP_TOOLS }
          break

        case 'tools/call': {
          const params = body.params as { name?: string; arguments?: Record<string, unknown> } | undefined
          if (!params?.name) throw AppError.badRequest('Tool name is required')
          const toolResult = await handleToolCall(request, params.name, params.arguments ?? {})
          result = { content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }] }
          break
        }

        default:
          return reply.code(400).send({
            jsonrpc: '2.0',
            error: { code: -32601, message: `Method not found: ${body.method}` },
            id: body.id ?? null,
          })
      }

      // Log the MCP activity
      const ctx = request.tenantCtx!
      void logAiActivity(app.db, ctx.tenantId, {
        actor_type: 'external_client',
        action: body.method,
        tool_name: body.method === 'tools/call' ? (body.params as { name?: string })?.name : undefined,
        resource_type: 'mcp',
        duration_ms: Date.now() - startTime,
        success: true,
        ip_address: request.ip,
      })

      return reply.send({ jsonrpc: '2.0', result, id: body.id ?? null })
    } catch (err) {
      const code = err && typeof err === 'object' && 'statusCode' in err ? -32000 : -32603
      return reply.code(200).send({
        jsonrpc: '2.0',
        error: { code, message: err instanceof Error ? err.message : 'Internal error' },
        id: body.id ?? null,
      })
    }
  })
}
