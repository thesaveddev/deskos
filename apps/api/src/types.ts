import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { AppConfig } from './config.js'
import type { DbPool } from './db/pool.js'
import type { OrgRole } from './core/permissions.js'
import type { MetricsRegistry } from './core/metrics.js'
import type { OtelTraceExporter } from './core/otel.js'
import type { EmailWorker } from './modules/email/email.worker.js'
import type { Mailer } from './modules/email/mailer.js'

export interface AuthUser {
  id: string
  email: string
  name: string
}

export interface TenantContext {
  tenantId: string
  slug: string
  name: string
  orgRole: OrgRole
  membershipId: string
}

export interface DeviceContext {
  deviceId: string
  tenantId: string
}

export interface OAuthContext {
  clientId: string
  tenantId: string
  scopes: string[]
  userId?: string
}

declare module 'fastify' {
  interface FastifyInstance {
    config: AppConfig
    db: DbPool
    emailWorker: EmailWorker | null
    mailer: Mailer
    metrics: MetricsRegistry
    otel: OtelTraceExporter
  }
  interface FastifyRequest {
    user?: AuthUser
    tenantCtx?: TenantContext
    deviceCtx?: DeviceContext
    oauthCtx?: OAuthContext
    /** W3C trace id (32 hex chars), set by the tracing hook. */
    traceId?: string
    /** W3C span id (16 hex chars), set by the tracing hook. */
    spanId?: string
    /** Monotonic epoch-ns timestamp captured when the request began. */
    startNs?: bigint
  }
}

export type { FastifyInstance, FastifyRequest }
