import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { FastifyInstance } from 'fastify'
import { recordAudit } from '../../core/audit.js'
import { notify } from '../../core/notify.js'
import { decryptSecret, encryptSecret } from '../../core/crypto.js'
import { AppError } from '../../core/errors.js'
import { withTenant } from '../../db/pool.js'
import { authenticate } from '../../middleware/authenticate.js'
import { requirePermission } from '../../middleware/requirePermission.js'
import { requireTenant } from '../../middleware/requireTenant.js'
import {
  appendCallActivity, ingestInboundCall, matchCallToTicket, normalizePhone, parseInboundCall,
  type CallDirection, type CallStatus,
} from './telephony.js'
import { dispatchTwilioCall, parseTwilioWebhook, verifyTwilioSignature, type TwilioConfig } from './twilio.js'
import '../../types.js'

const DIRECTIONS = ['inbound', 'outbound', 'internal'] as const
const STATUSES = ['ringing', 'answered', 'missed', 'completed', 'failed'] as const

const createCallSchema = z.object({
  direction: z.enum(DIRECTIONS),
  fromNumber: z.string().max(40).optional(),
  toNumber: z.string().max(40).optional(),
  status: z.enum(STATUSES).optional(),
  callerName: z.string().max(120).optional(),
  startedAt: z.string().optional(),
  durationSec: z.number().int().min(0).optional(),
  ticketId: z.string().min(1).optional(),
  providerCallId: z.string().max(200).optional(),
  recordingRef: z.string().max(500).optional(),
  ext: z.record(z.unknown()).optional(),
})
const clickToCallSchema = z.object({
  toNumber: z.string().trim().min(3).max(40),
  fromNumber: z.string().trim().max(40).optional(),
  ticketId: z.string().min(1).nullable().optional(),
})
const linkCallSchema = z.object({ ticketId: z.string().min(1).nullable() })
const integrationCreateSchema = z.object({
  name: z.string().trim().min(2).max(120),
  provider: z.string().trim().min(2).max(60).default('generic'),
  clickToCallUrl: z.string().trim().url().optional().or(z.literal('')),
  providerSecret: z.string().max(2000).optional(),
  providerConfig: z.record(z.unknown()).optional(),
  autoMatch: z.boolean().default(true),
  enabled: z.boolean().default(true),
})
const integrationUpdateSchema = integrationCreateSchema.partial()
const webhookPayloadSchema = z.record(z.unknown())

function hashWebhookToken(token: string): string { return createHash('sha256').update(token).digest('hex') }
function equalHash(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex'); const b = Buffer.from(right, 'hex')
  return a.length === b.length && timingSafeEqual(a, b)
}
function publicIntegration(row: Record<string, unknown>): Record<string, unknown> {
  const config = (row.provider_config ?? {}) as Record<string, unknown>
  return {
    id: row.id, name: row.name, provider: row.provider, enabled: row.enabled, auto_match: row.auto_match,
    click_to_call_url: row.click_to_call_url, has_provider_secret: Boolean(row.provider_secret_enc),
    provider_config: row.provider === 'twilio' ? { accountSid: config.accountSid ?? '', fromNumber: config.fromNumber ?? '', twimlUrl: config.twimlUrl ?? '', webhookUrl: config.webhookUrl ?? '' } : config,
    webhook_path: `/api/v1/telephony/webhooks/${row.id}`,
    created_at: row.created_at, updated_at: row.updated_at,
  }
}

function twilioConfigFrom(value: Record<string, unknown> | undefined): TwilioConfig {
  const config = value ?? {}
  const accountSid = typeof config.accountSid === 'string' ? config.accountSid.trim() : ''
  const fromNumber = typeof config.fromNumber === 'string' ? config.fromNumber.trim() : ''
  const twimlUrl = typeof config.twimlUrl === 'string' ? config.twimlUrl.trim() : ''
  const webhookUrl = typeof config.webhookUrl === 'string' ? config.webhookUrl.trim() : undefined
  if (!accountSid || !fromNumber || !twimlUrl) throw AppError.badRequest('Twilio requires an Account SID, caller ID, and TwiML URL', 'twilio_config_incomplete')
  return { accountSid, fromNumber, twimlUrl, ...(webhookUrl ? { webhookUrl } : {}) }
}

function requestAbsoluteUrlCandidates(request: { headers: Record<string, string | string[] | undefined>; url: string }): string[] {
  const first = (value: string | string[] | undefined): string | undefined => Array.isArray(value) ? value[0] : value
  const host = first(request.headers['x-forwarded-host']) ?? first(request.headers.host) ?? 'localhost'
  const protocol = first(request.headers['x-forwarded-proto']) ?? 'http'
  const urls = [`${protocol}://${host}${request.url}`]
  // Local Fastify injection and reverse proxies sometimes normalize the
  // default port differently. The signature still requires the secret, so
  // accepting these equivalent origin spellings is safe and avoids false
  // rejects without weakening authentication.
  if (host.endsWith(':80')) urls.push(`${protocol}://${host.slice(0, -3)}${request.url}`)
  if (host.endsWith(':443')) urls.push(`${protocol}://${host.slice(0, -4)}${request.url}`)
  if (protocol === 'http') urls.push(`https://${host}${request.url}`)
  return [...new Set(urls)]
}

async function addCallActivityIfLinked(client: Parameters<typeof appendCallActivity>[0], tenantId: string, call: Record<string, unknown>, event: string, meta: Record<string, unknown> = {}): Promise<void> {
  if (!call.ticket_id) return
  await appendCallActivity(client, tenantId, call.ticket_id as string, {
    id: call.id as string, direction: call.direction as CallDirection, status: call.status as CallStatus,
    fromNumber: String(call.from_number ?? ''), toNumber: String(call.to_number ?? ''), durationSec: Number(call.duration_sec ?? 0),
  }, event, meta)
}

export async function telephonyRoutes(app: FastifyInstance): Promise<void> {
  const read = [authenticate, requireTenant, requirePermission('telephony.read')]
  const manage = [authenticate, requireTenant, requirePermission('telephony.manage')]

  // Public provider callback. Generic providers use the one-time ReyDesk token;
  // Twilio uses its signed X-Twilio-Signature instead.
  app.post('/telephony/webhooks/:integrationId', { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (request) => {
    const { integrationId } = request.params as { integrationId: string }
    let integration: Record<string, unknown> | undefined
    const tenants = await app.db.query('SELECT id FROM tenants')
    for (const tenant of tenants.rows) {
      const row = (await withTenant(app.db, tenant.id, (client) => client.query('SELECT * FROM telephony_integrations WHERE id = $1 AND enabled = true', [integrationId]))).rows[0]
      if (row) { integration = row as Record<string, unknown>; break }
    }
    if (!integration) throw AppError.unauthorized('Unknown or disabled telephony integration')
    const payload = webhookPayloadSchema.parse(request.body ?? {})
    if (integration.provider === 'twilio') {
      const authToken = integration.provider_secret_enc ? decryptSecret(String(integration.provider_secret_enc), app.config.emailKey) : ''
      const config = twilioConfigFrom(integration.provider_config as Record<string, unknown> | undefined)
      const signatureHeader = request.headers['x-twilio-signature']
      const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader
      const callbackUrls = config.webhookUrl ? [config.webhookUrl] : requestAbsoluteUrlCandidates({ headers: request.headers, url: request.url })
      const validSignature = authToken && callbackUrls.some((url) => verifyTwilioSignature(authToken, url, payload, signature))
      if (!validSignature) throw AppError.unauthorized('Invalid Twilio webhook signature', 'twilio_signature_invalid')
    } else {
      const queryToken = (request.query as { token?: string }).token
      const headerToken = request.headers['x-reydesk-telephony-token']
      const supplied = (Array.isArray(headerToken) ? headerToken[0] : headerToken) ?? queryToken
      if (!supplied || supplied.length < 20 || supplied.length > 200) throw AppError.unauthorized('Missing telephony webhook token')
      if (!equalHash(String(integration.webhook_token_hash), hashWebhookToken(supplied))) throw AppError.unauthorized('Invalid telephony webhook token')
    }
    const input = integration.provider === 'twilio' ? parseTwilioWebhook(payload) : parseInboundCall(payload)
    const result = await withTenant(app.db, String(integration.tenant_id), async (client) => {
      const ingested = await ingestInboundCall(client, String(integration.tenant_id), { auto_match: Boolean(integration.auto_match), auto_create_ticket: Boolean(integration.auto_create_ticket) }, input)
      await recordAudit(client, String(integration.tenant_id), { actorType: 'system', action: ingested.created ? 'telephony.inbound_received' : 'telephony.inbound_updated', objectType: 'call_log', objectId: ingested.call.id as string, ip: request.ip, payload: { provider: integration.provider, event: input.eventType, matchStatus: ingested.match.status, ticketId: ingested.call.ticket_id ?? null } })
      if (ingested.created && input.direction === 'inbound') {
        const ticketId = ingested.call.ticket_id as string | null | undefined
        const recipient = ticketId
          ? (await client.query('SELECT assignee_id FROM tickets WHERE id = $1', [ticketId])).rows[0]?.assignee_id as string | undefined
          : (await client.query(`SELECT user_id FROM memberships WHERE tenant_id = $1 AND org_role IN ('owner', 'it_manager', 'service_desk_manager') AND status = 'active' ORDER BY CASE org_role WHEN 'owner' THEN 0 ELSE 1 END LIMIT 1`, [integration.tenant_id])).rows[0]?.user_id as string | undefined
        if (recipient) {
          await notify(client, String(integration.tenant_id), {
            userId: recipient,
            kind: 'telephony.call_received',
            subjectType: ticketId ? 'ticket' : 'call_log',
            subjectId: ticketId ?? String(ingested.call.id),
            body: `Inbound call received from ${input.fromNumber || 'an unknown number'}${ticketId ? ` for ticket #${ingested.match.ticketNumber ?? 'linked'}` : ''}.`,
          })
        }
      }
      return ingested
    })
    return { ok: true, call: { id: result.call.id, status: result.call.status, ticketId: result.call.ticket_id ?? null }, match: { status: result.match.status, candidates: result.match.candidates } }
  })

  app.get('/telephony/integrations', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    return withTenant(app.db, ctx.tenantId, (client) => client.query('SELECT * FROM telephony_integrations ORDER BY created_at DESC').then((result) => ({ integrations: result.rows.map(publicIntegration) })))
  })

  app.post('/telephony/integrations', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const body = integrationCreateSchema.parse(request.body)
    if (body.provider === 'twilio') {
      twilioConfigFrom(body.providerConfig)
      if (!body.providerSecret?.trim()) throw AppError.badRequest('Twilio requires an Auth Token', 'twilio_auth_token_missing')
    }
    const token = `reydesk_cti_${randomBytes(32).toString('base64url')}`
    const created = await withTenant(app.db, ctx.tenantId, async (client) => {
      try {
        const result = await client.query(
          `INSERT INTO telephony_integrations (tenant_id, name, provider, webhook_token_hash, click_to_call_url, provider_secret_enc, provider_config, auto_match, enabled, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10) RETURNING *`,
          [ctx.tenantId, body.name, body.provider, hashWebhookToken(token), body.clickToCallUrl || null, body.providerSecret ? encryptSecret(body.providerSecret, app.config.emailKey) : null, JSON.stringify(body.providerConfig ?? {}), body.autoMatch, body.enabled, request.user!.id],
        )
        let row = result.rows[0]
        if (body.provider === 'twilio' && !(body.providerConfig as Record<string, unknown> | undefined)?.webhookUrl) {
          const origin = requestAbsoluteUrlCandidates({ headers: request.headers, url: '' })[0].replace(/\/$/, '')
          const providerConfig = { ...((body.providerConfig ?? {}) as Record<string, unknown>), webhookUrl: `${origin}/api/v1/telephony/webhooks/${row.id}` }
          row = (await client.query('UPDATE telephony_integrations SET provider_config = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *', [row.id, JSON.stringify(providerConfig)])).rows[0]
        }
        await recordAudit(client, ctx.tenantId, { actorId: request.user!.id, action: 'telephony.integration_created', objectType: 'telephony_integration', objectId: row.id, ip: request.ip, payload: { provider: body.provider } })
        return row
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw AppError.conflict('An integration with this name already exists', 'telephony_integration_exists')
        throw err
      }
    })
    return reply.code(201).send({ integration: publicIntegration(created), webhookToken: token })
  })

  app.patch('/telephony/integrations/:id', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    const body = integrationUpdateSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const current = (await client.query('SELECT * FROM telephony_integrations WHERE id = $1', [id])).rows[0]
      if (!current) throw AppError.notFound('Telephony integration not found')
      const targetProvider = body.provider ?? current.provider
      if (targetProvider === 'twilio') {
        twilioConfigFrom((body.providerConfig ?? current.provider_config) as Record<string, unknown> | undefined)
        if (body.providerSecret !== undefined && !body.providerSecret.trim()) throw AppError.badRequest('Twilio requires an Auth Token', 'twilio_auth_token_missing')
        if (body.providerSecret === undefined && !current.provider_secret_enc) throw AppError.badRequest('Twilio requires an Auth Token', 'twilio_auth_token_missing')
      }
      const values: unknown[] = [id]
      const sets: string[] = []
      if (body.name !== undefined) { values.push(body.name); sets.push(`name = $${values.length}`) }
      if (body.provider !== undefined) { values.push(body.provider); sets.push(`provider = $${values.length}`) }
      if (body.clickToCallUrl !== undefined) { values.push(body.clickToCallUrl || null); sets.push(`click_to_call_url = $${values.length}`) }
      if (body.providerSecret !== undefined) { values.push(body.providerSecret ? encryptSecret(body.providerSecret, app.config.emailKey) : null); sets.push(`provider_secret_enc = $${values.length}`) }
      if (body.providerConfig !== undefined) { if (targetProvider === 'twilio') twilioConfigFrom(body.providerConfig); values.push(JSON.stringify(body.providerConfig)); sets.push(`provider_config = $${values.length}::jsonb`) }
      if (body.autoMatch !== undefined) { values.push(body.autoMatch); sets.push(`auto_match = $${values.length}`) }
      if (body.enabled !== undefined) { values.push(body.enabled); sets.push(`enabled = $${values.length}`) }
      if (!sets.length) throw AppError.badRequest('Nothing to update')
      try {
        const result = await client.query(`UPDATE telephony_integrations SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`, values)
        return { integration: publicIntegration(result.rows[0]) }
      } catch (err) {
        if ((err as { code?: string }).code === '23505') throw AppError.conflict('An integration with this name already exists', 'telephony_integration_exists')
        throw err
      }
    })
  })

  app.delete('/telephony/integrations/:id', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!
    const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const result = await client.query('DELETE FROM telephony_integrations WHERE id = $1 RETURNING id', [id])
      if (!result.rows[0]) throw AppError.notFound('Telephony integration not found')
      return reply.send({ ok: true })
    })
  })

  app.get('/telephony/calls', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!
    const { ticketId, direction, status, q } = request.query as Record<string, string | undefined>
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const where: string[] = []; const params: unknown[] = []
      if (ticketId) { params.push(ticketId); where.push(`c.ticket_id = $${params.length}`) }
      if (direction) { params.push(direction); where.push(`c.direction = $${params.length}`) }
      if (status) { params.push(status); where.push(`c.status = $${params.length}`) }
      if (q) { params.push(`%${q}%`); where.push(`(c.from_number ILIKE $${params.length} OR c.to_number ILIKE $${params.length} OR c.caller_name ILIKE $${params.length})`) }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const { rows } = await client.query(`SELECT c.*, t.number AS ticket_number, t.subject AS ticket_subject FROM call_logs c LEFT JOIN tickets t ON t.id = c.ticket_id ${whereSql} ORDER BY c.started_at DESC LIMIT 200`, params)
      return { calls: rows }
    })
  })

  app.get('/telephony/calls/:id', { preHandler: read }, async (request) => {
    const ctx = request.tenantCtx!; const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const { rows } = await client.query('SELECT c.*, t.number AS ticket_number, t.subject AS ticket_subject FROM call_logs c LEFT JOIN tickets t ON t.id = c.ticket_id WHERE c.id = $1', [id])
      if (!rows[0]) throw AppError.notFound('Call not found')
      return { call: rows[0] }
    })
  })

  app.post('/telephony/click-to-call', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!; const body = clickToCallSchema.parse(request.body)
    const call = await withTenant(app.db, ctx.tenantId, async (client) => {
      if (body.ticketId && !(await client.query('SELECT 1 FROM tickets WHERE id = $1', [body.ticketId])).rows[0]) throw AppError.notFound('Ticket not found')
      const result = await client.query(`INSERT INTO call_logs (tenant_id, direction, from_number, to_number, status, started_at, ticket_id, ext) VALUES ($1, 'outbound', $2, $3, 'ringing', now(), $4, $5::jsonb) RETURNING *`, [ctx.tenantId, body.fromNumber ?? '', body.toNumber, body.ticketId ?? null, JSON.stringify({ source: 'click_to_call', dialUri: `tel:${body.toNumber}` })])
      const row = result.rows[0]
      await addCallActivityIfLinked(client, ctx.tenantId, row, 'telephony.click_to_call', { phone: normalizePhone(body.toNumber) })
      await recordAudit(client, ctx.tenantId, { actorId: request.user!.id, action: 'telephony.click_to_call', objectType: 'call_log', objectId: row.id, ip: request.ip, payload: { ticketId: body.ticketId ?? null } })
      return row
    })

    // Provider dispatch is optional. Twilio gets a real REST call; generic
    // integrations retain the existing provider-neutral JSON contract.
    const provider = (await withTenant(app.db, ctx.tenantId, (client) => client.query(
      `SELECT provider, click_to_call_url, provider_secret_enc, provider_config FROM telephony_integrations
        WHERE enabled = true AND (click_to_call_url IS NOT NULL OR provider = 'twilio')
        ORDER BY CASE WHEN provider = 'twilio' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
    ))).rows[0]
    let providerCallId: string | null = null
    if (provider?.provider === 'twilio') {
      try {
        const twilio = await dispatchTwilioCall({
          toNumber: body.toNumber,
          callId: call.id,
          config: twilioConfigFrom(provider.provider_config as Record<string, unknown> | undefined),
          authToken: decryptSecret(String(provider.provider_secret_enc ?? ''), app.config.emailKey),
        })
        providerCallId = twilio.providerCallId
        await withTenant(app.db, ctx.tenantId, (client) => client.query('UPDATE call_logs SET provider_call_id = $2, status = $3, ext = ext || $4::jsonb WHERE id = $1', [call.id, twilio.providerCallId, twilio.status, JSON.stringify({ providerDispatch: 'accepted', twilio: twilio.raw })]))
      } catch (err) {
        throw AppError.badRequest(err instanceof Error ? err.message : 'Twilio rejected the call', 'twilio_call_failed')
      }
    } else if (provider?.click_to_call_url) {
      const headers: Record<string, string> = { 'content-type': 'application/json', 'x-reydesk-call-id': call.id }
      if (provider.provider_secret_enc) headers.authorization = `Bearer ${decryptSecret(provider.provider_secret_enc, app.config.emailKey)}`
      let providerResponse: Response
      try {
        providerResponse = await fetch(provider.click_to_call_url, { method: 'POST', headers, body: JSON.stringify({ provider: provider.provider, callId: call.id, fromNumber: body.fromNumber ?? '', toNumber: body.toNumber, ticketId: body.ticketId ?? null }) })
      } catch {
        throw AppError.badRequest('The configured telephony provider could not be reached', 'telephony_provider_unreachable')
      }
      if (!providerResponse.ok) throw AppError.badRequest('The configured telephony provider rejected the call', 'telephony_provider_rejected')
      let providerPayload: Record<string, unknown> = {}
      try { providerPayload = await providerResponse.json() as Record<string, unknown> } catch { /* provider may return 204 */ }
      providerCallId = typeof providerPayload.providerCallId === 'string' ? providerPayload.providerCallId : typeof providerPayload.callId === 'string' ? providerPayload.callId : null
      if (providerCallId) await withTenant(app.db, ctx.tenantId, (client) => client.query('UPDATE call_logs SET provider_call_id = $2, ext = ext || $3::jsonb WHERE id = $1', [call.id, providerCallId, JSON.stringify({ providerDispatch: 'accepted' })]))
    }
    return reply.code(201).send({ call: { ...call, provider_call_id: providerCallId ?? call.provider_call_id }, dialUri: `tel:${body.toNumber}` })
  })

  app.post('/telephony/calls', { preHandler: manage }, async (request, reply) => {
    const ctx = request.tenantCtx!; const body = createCallSchema.parse(request.body)
    const call = await withTenant(app.db, ctx.tenantId, async (client) => {
      if (body.ticketId && !(await client.query('SELECT id FROM tickets WHERE id = $1', [body.ticketId])).rows[0]) throw AppError.notFound('Ticket not found')
      const match = await matchCallToTicket(client, ctx.tenantId, { direction: body.direction, fromNumber: body.fromNumber ?? '', toNumber: body.toNumber ?? '', ticketNumber: undefined }, body.direction === 'inbound')
      const ticketId = body.ticketId ?? (body.direction === 'inbound' ? match.ticketId : null)
      const ext = { ...(body.ext ?? {}), match: { status: match.status, candidateCount: match.candidates.length, contactId: match.contactId ?? null } }
      const { rows } = await client.query(`INSERT INTO call_logs (tenant_id, direction, from_number, to_number, status, caller_name, started_at, duration_sec, ticket_id, provider_call_id, recording_ref, ext) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb) RETURNING *`, [ctx.tenantId, body.direction, body.fromNumber ?? '', body.toNumber ?? '', body.status ?? 'completed', body.callerName ?? null, body.startedAt ?? new Date(), body.durationSec ?? 0, ticketId, body.providerCallId ?? null, body.recordingRef ?? null, JSON.stringify(ext)])
      await addCallActivityIfLinked(client, ctx.tenantId, rows[0], 'telephony.call_logged', { matchStatus: match.status })
      await recordAudit(client, ctx.tenantId, { actorId: request.user!.id, action: 'telephony.call_logged', objectType: 'call_log', objectId: rows[0].id, ip: request.ip, payload: { direction: body.direction, ticketId } })
      return rows[0]
    })
    return reply.code(201).send({ call })
  })

  app.post('/telephony/calls/:id/match', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!; const { id } = request.params as { id: string }
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const call = (await client.query('SELECT * FROM call_logs WHERE id = $1', [id])).rows[0]
      if (!call) throw AppError.notFound('Call not found')
      const match = await matchCallToTicket(client, ctx.tenantId, { direction: call.direction, fromNumber: call.from_number, toNumber: call.to_number, ticketNumber: undefined }, true)
      if (match.ticketId && !call.ticket_id) {
        const updated = (await client.query('UPDATE call_logs SET ticket_id = $2 WHERE id = $1 RETURNING *', [id, match.ticketId])).rows[0]
        await addCallActivityIfLinked(client, ctx.tenantId, updated, 'telephony.call_matched', { matchStatus: match.status })
        return { call: updated, match }
      }
      return { call, match }
    })
  })

  app.patch('/telephony/calls/:id', { preHandler: manage }, async (request) => {
    const ctx = request.tenantCtx!; const { id } = request.params as { id: string }; const body = linkCallSchema.parse(request.body)
    return withTenant(app.db, ctx.tenantId, async (client) => {
      const existing = (await client.query('SELECT * FROM call_logs WHERE id = $1', [id])).rows[0]
      if (!existing) throw AppError.notFound('Call not found')
      if (body.ticketId && !(await client.query('SELECT id FROM tickets WHERE id = $1', [body.ticketId])).rows[0]) throw AppError.notFound('Ticket not found')
      const updated = (await client.query('UPDATE call_logs SET ticket_id = $2 WHERE id = $1 RETURNING *', [id, body.ticketId])).rows[0]
      if (body.ticketId) await addCallActivityIfLinked(client, ctx.tenantId, updated, 'telephony.call_linked', { previousTicketId: existing.ticket_id ?? null })
      if (existing.ticket_id && existing.ticket_id !== body.ticketId) await appendCallActivity(client, ctx.tenantId, existing.ticket_id, { id, direction: existing.direction, status: existing.status, fromNumber: existing.from_number, toNumber: existing.to_number, durationSec: existing.duration_sec }, 'telephony.call_unlinked', { nextTicketId: body.ticketId ?? null })
      await recordAudit(client, ctx.tenantId, { actorId: request.user!.id, action: 'telephony.call_linked', objectType: 'call_log', objectId: id, ip: request.ip, payload: { ticketId: body.ticketId } })
      return { call: updated }
    })
  })
}
