import path from 'node:path'
import { parse as parseQueryString } from 'node:querystring'
import { fileURLToPath } from 'node:url'
import Fastify, { type FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import multipart from '@fastify/multipart'
import rateLimit from '@fastify/rate-limit'
import staticPlugin from '@fastify/static'
import { ZodError } from 'zod'
import type { AppConfig } from './config.js'
import { AppError, toErrorBody } from './core/errors.js'
import { BRAND } from './core/brand.js'
import { MetricsRegistry } from './core/metrics.js'
import { OtelTraceExporter, unixNano } from './core/otel.js'
import { captureError, initSentry } from './core/sentry.js'
import { buildTraceparent, newSpanId, newTraceId, parseTraceparent, parseTraceparentContext } from './core/tracing.js'
import { createPool } from './db/pool.js'
import { assetRoutes } from './modules/assets/assets.routes.js'
import { attachmentRoutes } from './modules/attachments/attachments.routes.js'
import { auditRoutes } from './modules/audit/audit.routes.js'
import { automationRoutes } from './modules/automation/automation.routes.js'
import { authRoutes } from './modules/auth/auth.routes.js'
import { authHardeningRoutes } from './modules/auth/auth.hardening.routes.js'
import { webauthnRoutes } from './modules/auth/webauthn.routes.js'
import { cannedRoutes } from './modules/canned/canned.routes.js'
import { catalogueRoutes } from './modules/catalogue/catalogue.routes.js'
import { dexRoutes } from './modules/dex/dex.routes.js'
import { agentRoutes } from './modules/devices/agent.routes.js'
import { deviceRoutes } from './modules/devices/devices.routes.js'
import { aiRoutes } from './modules/ai/ai.routes.js'
import { createAiProvider } from './modules/ai/gateway.js'
import { createTenantAiProvider, purgeExpiredAiUsage } from './modules/ai/settings.js'
import { runTicketTriage, setTriageDispatcher } from './modules/ai/triage.js'
import { aiAgentRoutes } from './modules/ai-agent/ai-agent.routes.js'
import { chatRoutes } from './modules/chat/chat.routes.js'
import { adRoutes } from './modules/ad/ad.routes.js'
import { telephonyRoutes } from './modules/telephony/telephony.routes.js'
import { webhookRoutes } from './modules/webhooks/webhooks.routes.js'
import { createEmailRoutes } from './modules/email/email.routes.js'
import { EmailWorker } from './modules/email/email.worker.js'
import { Mailer } from './modules/email/mailer.js'
import { EmailQueue } from './modules/email/email.queue.js'
import { entraRoutes } from './modules/entra/entra.routes.js'
import { grantRoutes } from './modules/grants/grants.routes.js'
import { incidentRoutes } from './modules/incidents/incidents.routes.js'
import { kbRoutes } from './modules/knowledge/kb.routes.js'
import { memberRoutes } from './modules/members/members.routes.js'
import { monitoringRoutes } from './modules/monitoring/monitoring.routes.js'
import { mspRoutes } from './modules/msp/msp.routes.js'
import { notificationRoutes } from './modules/notifications/notifications.routes.js'
import { startNotificationRealtime } from './modules/notifications/realtime.js'
import { patchRoutes } from './modules/patches/patches.routes.js'
import { notificationPreferenceRoutes } from './modules/notifications/preferences.routes.js'
import { setEmailDispatcher, setPushDispatcher } from './core/notify.js'
import { oauthRoutes } from './modules/oauth/oauth.routes.js'
import { pushRoutes } from './modules/push/push.routes.js'
import { sendPushToUser } from './modules/push/push.js'
import { openApiRoutes } from './modules/openapi/openapi.routes.js'
import { portalRoutes } from './modules/portal/portal.routes.js'
import { reportRoutes } from './modules/reports/reports.routes.js'
import { rmmRoutes } from './modules/rmm/rmm.routes.js'
import { adhocSessionRoutes, connectRoutes } from './modules/remote/adhoc.routes.js'
import { probeRoutes } from './modules/remote/probe.routes.js'
import { marketplaceRoutes } from './modules/marketplace/marketplace.routes.js'
import { supportRoutes } from './modules/support/support.routes.js'
import { notesRoutes } from './modules/notes/notes.routes.js'
import { billingRoutes } from './modules/billing/billing.routes.js'
import { recordingRoutes } from './modules/remote/recording.routes.js'
import { remoteRoutes } from './modules/remote/remote.routes.js'
import { scriptRoutes } from './modules/scripts/scripts.routes.js'
import { searchRoutes, teamRoutes } from './modules/teams/teams.routes.js'
import { tenantRoutes } from './modules/tenants/tenants.routes.js'
import { ticketRoutes } from './modules/tickets/tickets.routes.js'
import { ticketLinkRoutes } from './modules/tickets/links.routes.js'
import { escalationRoutes } from './modules/tickets/escalation.routes.js'
import { ticketLockRoutes } from './modules/tickets/locks.routes.js'
import './types.js'

function friendlyValidationMessage(error: ZodError): string {
  const fields = new Set(error.issues.map((issue) => String(issue.path[0] ?? 'request')))
  const hasEmail = fields.has('email')
  const hasPassword = fields.has('password')
  const passwordIssue = error.issues.find((issue) => issue.path[0] === 'password')
  const passwordMinimum = passwordIssue && 'minimum' in passwordIssue ? Number(passwordIssue.minimum) : undefined

  if (hasEmail && hasPassword && fields.size === 2) {
    if (passwordMinimum && passwordMinimum >= 10) return 'Enter a valid email address and a password with at least 10 characters.'
    return 'Enter a valid email address and your password.'
  }
  if (hasEmail) return 'Enter a valid email address.'
  if (hasPassword) {
    if (passwordMinimum && passwordMinimum >= 10) return 'Password must be at least 10 characters.'
    return 'Enter your password.'
  }

  const labels: Record<string, string> = {
    name: 'your name',
    tenantName: 'an organisation name',
    refreshToken: 'your session token',
    mfaCode: 'your authentication code',
    code: 'the verification code',
  }
  const firstField = String(error.issues[0]?.path[0] ?? '')
  if (firstField && labels[firstField]) return `Please enter ${labels[firstField]}.`
  return 'Some details are missing or invalid. Please review the form and try again.'
}

export async function buildApp(config: AppConfig): Promise<FastifyInstance> {
  initSentry(config.sentry)

  const app = Fastify({
    logger: { level: config.env === 'test' ? 'silent' : 'info' },
    trustProxy: false,
  })

  const pool = createPool(config.databaseUrl, { max: config.dbPoolMax })
  const emailWorker: EmailWorker = new EmailWorker(config.imap, config.emailKey, pool)
  const mailer: Mailer = new Mailer(config.smtp)
  const emailQueue: EmailQueue = new EmailQueue(mailer)
  const aiRetentionTimer = setInterval(() => {
    void purgeExpiredAiUsage(pool).catch((error) => app.log.warn({ error }, 'AI usage retention purge failed'))
  }, 6 * 60 * 60 * 1000)
  aiRetentionTimer.unref?.()
  const metrics = new MetricsRegistry()
  const otel = new OtelTraceExporter(config.otel)

  app.decorate('config', config)
  app.decorate('db', pool)
  app.decorate('emailWorker', emailWorker)
  app.decorate('emailQueue', emailQueue)
  app.decorate('mailer', mailer)
  app.decorate('metrics', metrics)
  app.decorate('otel', otel)
  const notificationRealtime = await startNotificationRealtime(pool, app.log)

  // Web Push: wire the fire-and-forget dispatcher into the notification
  // pipeline. Disabled deployments (no VAPID keys) no-op without touching the DB.
  setPushDispatcher(({ tenantId, userId, kind, body }) => {
    if (!config.push.enabled) return Promise.resolve(0)
    const http = app.pushHttp ??
      (async (endpoint, init) => {
        const res = await fetch(endpoint, { method: init.method, headers: init.headers, body: init.body as unknown as BodyInit })
        return { status: res.status }
      })
    return sendPushToUser(pool, config.push, tenantId, userId, kind, body, config.emailKey, http)
  })
  // Email preferences use the same queue and branded templates as password,
  // ticket, and magic-link mail. The recipient lookup is deliberately done
  // here at the application boundary so core notification writes stay small
  // and transaction-safe.
  setTriageDispatcher(async (tenantId, ticketId, trigger = 'created') => {
    const tenantAi = await createTenantAiProvider(pool, config, tenantId, app.aiProvider).catch((error) => {
      // Keep ticket creation resilient when AI is intentionally disabled or
      // not yet configured. Triage will record a disabled/handoff state.
      if (error && typeof error === 'object' && 'code' in error && String((error as { code?: unknown }).code) === 'ai_unavailable') {
        return { provider: createAiProvider(config.ai), model: config.ai.model }
      }
      throw error
    })
    return runTicketTriage({
      pool,
      provider: tenantAi.provider,
      model: tenantAi.model,
      mailer,
      emailQueue,
      publicUrl: config.publicUrl,
    }, tenantId, ticketId, trigger)
  })

  setEmailDispatcher(async ({ tenantId, userId, kind, body, subjectType, subjectId }) => {
    const recipient = (await pool.query(
      `SELECT u.email, t.name AS tenant_name
         FROM users u JOIN memberships m ON m.user_id = u.id
         JOIN tenants t ON t.id = m.tenant_id
        WHERE u.id = $1 AND m.tenant_id = $2 AND m.status IN ('active', 'invited') AND u.status <> 'disabled'`,
      [userId, tenantId],
    )).rows[0]
    if (!recipient || !app.mailer.enabled) {
      app.log.warn({ userId, tenantId, kind, mailConfigured: app.mailer.enabled }, 'Email notification could not be dispatched')
      return false
    }

    const publicUrl = config.publicUrl.replace(/\/$/, '')
    let action: { label: string; url: string } | undefined
    if (subjectType === 'ticket' && subjectId) {
      const ticket = (await pool.query('SELECT number FROM tickets WHERE id = $1 AND tenant_id = $2', [subjectId, tenantId])).rows[0]
      if (ticket) {
        const staffView = kind === 'ticket.lock_release_requested' || kind === 'sla.breached' || kind === 'service.approval' || kind === 'service.approval_decided' || kind === 'change.approval'
        action = { label: staffView ? 'Open ticket' : 'View request', url: staffView ? `${publicUrl}/tickets/${subjectId}` : `${publicUrl}/portal/tickets/${ticket.number}` }
      }
    } else if (subjectType === 'remote_session' && subjectId) {
      action = { label: 'Open session', url: `${publicUrl}/sessions/${subjectId}` }
    } else if (subjectType === 'device' && subjectId) {
      action = { label: 'View device', url: `${publicUrl}/devices/${subjectId}` }
    }

    return app.emailQueue.addAndSend(app.mailer.buildNotificationMail({
      to: recipient.email,
      tenantName: recipient.tenant_name,
      kind,
      body,
      action,
      settingsUrl: `${publicUrl}/settings/notifications`,
    }))
  })

  app.addHook('onClose', async (instance) => {
    setTriageDispatcher(null)
    instance.emailWorker?.stop()
    clearInterval(aiRetentionTimer)
    await notificationRealtime.stop()
    await instance.otel.stop()
    await instance.db.end()
  })

  await app.register(helmet, { global: true, contentSecurityPolicy: false })
  await app.register(cors, { origin: config.webOrigins, credentials: true })
  await app.register(multipart, {
    limits: { fileSize: config.maxUploadBytes, files: 1 },
  })
  // Twilio sends signed application/x-www-form-urlencoded callbacks. Fastify
  // does not parse that media type by default, so keep a small parser here
  // instead of adding a second dependency for one provider boundary.
  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_request, body, done) => {
    done(null, parseQueryString(body as string))
  })
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    errorResponseBuilder: (_req, context) => {
      const err = new Error('Rate limit exceeded') as Error & { statusCode: number }
      err.statusCode = context.ban ? 403 : 429
      return err
    },
  })

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      const { statusCode, body } = toErrorBody(error)
      return reply.status(statusCode).send(body)
    }
    // Fastify 5 types the handler's error as `unknown`; narrow once here.
    const err = error as Error & { statusCode?: number; validation?: unknown }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: { code: 'validation_error', message: friendlyValidationMessage(err) },
      })
    }
    if (err.validation) {
      return reply.status(400).send({
        error: { code: 'validation_error', message: err.message },
      })
    }
    const statusCode = err.statusCode
    if (statusCode === 429) {
      return reply.status(429).send({
        error: { code: 'rate_limited', message: 'Too many requests' },
      })
    }
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply.status(statusCode).send({
        error: { code: 'request_error', message: err.message },
      })
    }
    request.log.error(error)
    captureError(error, request.traceId)
    return reply.status(500).send({
      error: { code: 'internal_error', message: 'Internal server error', traceId: request.traceId },
    })
  })

  app.addHook('onRequest', async (request) => {
    const traceId = parseTraceparent(request.headers.traceparent as string | undefined) ?? newTraceId()
    const spanId = newSpanId()
    request.traceId = traceId
    request.spanId = spanId
    request.startNs = unixNano()
  })

  app.addHook('onSend', async (request, reply, payload) => {
    reply.header('traceparent', buildTraceparent(request.traceId ?? newTraceId(), request.spanId ?? newSpanId()))
    reply.header('x-trace-id', request.traceId ?? newTraceId())
    return payload
  })

  app.addHook('onResponse', (request, reply, done) => {
    const statusClass = `${Math.floor(reply.statusCode / 100)}xx` as '1xx' | '2xx' | '3xx' | '4xx' | '5xx'
    app.metrics.observeRequest(request.method, statusClass, reply.elapsedTime)
    app.otel.record({
      name: `${request.method} ${request.routeOptions.url ?? request.url}`,
      traceId: request.traceId ?? newTraceId(),
      spanId: request.spanId ?? newSpanId(),
      parentSpanId: parseTraceparentContext(request.headers.traceparent as string | undefined)?.spanId ?? '',
      startTimeNs: request.startNs ?? unixNano(),
      endTimeNs: unixNano(),
      statusCode: reply.statusCode >= 500 ? 2 : 1,
      attributes: [
        { key: 'http.method', value: { stringValue: request.method } },
        { key: 'http.route', value: { stringValue: request.routeOptions.url ?? request.url } },
        { key: 'http.status_code', value: { intValue: String(reply.statusCode) } },
      ],
    })
    done()
  })

  app.get('/healthz', async () => ({ status: 'ok', service: `${BRAND.slug}-api` }))
  app.get('/metrics', async (_request, reply) => {
    const body = app.metrics.render({
      total: app.db.totalCount,
      idle: app.db.idleCount,
      waiting: app.db.waitingCount,
    })
    return reply.type('text/plain; version=0.0.4').send(body)
  })
  app.get('/readyz', async (_request, reply) => {
    try {
      await app.db.query('SELECT 1')
      return reply.send({ status: 'ok', service: `${BRAND.slug}-api`, database: 'ok' })
    } catch {
      return reply.code(503).send({ status: 'not_ready', service: `${BRAND.slug}-api`, database: 'unavailable' })
    }
  })
  app.get('/api/v1/meta', async () => ({ name: `${BRAND.name} API`, version: '0.0.1' }))

  await app.register(async (v1) => {
    await v1.register(authRoutes)
    await v1.register(authHardeningRoutes)
    await v1.register(webauthnRoutes)
    await v1.register(tenantRoutes)
    await v1.register(memberRoutes)
    await v1.register(auditRoutes)
    await v1.register(monitoringRoutes)
    await v1.register(mspRoutes)
    await v1.register(notificationRoutes)
    await v1.register(notificationPreferenceRoutes)
    await v1.register(ticketRoutes)
    await v1.register(ticketLinkRoutes)
    await v1.register(escalationRoutes)
    await v1.register(ticketLockRoutes)
    await v1.register(attachmentRoutes)
    await v1.register(teamRoutes)
    await v1.register(searchRoutes)
    await v1.register(reportRoutes)
    await v1.register(rmmRoutes)
    await v1.register(dexRoutes)
    await v1.register(automationRoutes)
    await v1.register(assetRoutes)
    await v1.register(catalogueRoutes)
    await v1.register(entraRoutes)
    await v1.register(adRoutes)
    await v1.register(aiRoutes)
    await v1.register(aiAgentRoutes)
    await v1.register(chatRoutes)
    await v1.register(telephonyRoutes)
    await v1.register(incidentRoutes)
    await v1.register(grantRoutes)
    await v1.register(scriptRoutes)
    await v1.register(patchRoutes)
    await v1.register(remoteRoutes)
    await v1.register(recordingRoutes)
    await v1.register(cannedRoutes)
    await v1.register(deviceRoutes)
    await v1.register(agentRoutes)
    await v1.register(webhookRoutes)
    await v1.register(oauthRoutes)
    await v1.register(pushRoutes)
    await v1.register(openApiRoutes)
    await v1.register(createEmailRoutes(emailWorker))
    await v1.register(portalRoutes)
    await v1.register(kbRoutes)
    await v1.register(adhocSessionRoutes)
    await v1.register(probeRoutes)
    await v1.register(marketplaceRoutes)
    await v1.register(supportRoutes)
    await v1.register(notesRoutes)
    await v1.register(billingRoutes)
  }, { prefix: '/api/v1' })

  // Public, unauthenticated connect flow for ad-hoc (unmanaged) support links.
  // Registered under /api/connect so the JSON info/claim endpoints never shadow
  // the human-facing /connect/:code SPA page served by the web app.
  await app.register(connectRoutes, { prefix: '/api' })

  // Serve the React frontend in production (SPA bundled alongside the API).
  const webDist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'web', 'dist')
  await app.register(staticPlugin, {
    root: webDist,
    prefix: '/',
    wildcard: false,
    decorateReply: false,
  })
  // SPA fallback: any non-API, non-file request returns index.html.
  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/') || request.url.startsWith('/healthz') || request.url.startsWith('/readyz') || request.url.startsWith('/metrics')) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } })
    }
    return reply.sendFile('index.html')
  })

  return app
}