import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface AppConfig {
  env: 'development' | 'test' | 'production'
  host: string
  port: number
  databaseUrl: string
  dbPoolMax: number
  jwtSecret: Uint8Array
  jwtIssuer: string
  accessTokenTtlSec: number
  refreshTokenTtlDays: number
  bcryptRounds: number
  uploadDir: string
  maxUploadBytes: number
  recordingDir: string
  maxRecordingBytes: number
  emailKey: string
  relaySecret: string
  publicUrl: string
  /** Browser origins allowed to call the API. Keep this explicit in production. */
  webOrigins: string[]
  relayUrl: string
  /** Absolute path to the signed portable helper binary served on the connect page. */
  helperBinaryPath: string
  deviceOfflineSec: number
  deviceLowDiskPct: number
  smtp: SmtpConfig
  imap: {
    enabled: boolean
    host: string
    port: number
    user: string
    pass: string
    tls: boolean
    pollIntervalSec: number
  }
  ice: IceConfig
  update: UpdateConfig
  otel: OtelConfig
  sentry: SentryConfig
  ai: AiConfig
  webauthn: WebauthnConfig
  push: PushConfig
}

export interface SentryConfig {
  /** Empty disables Sentry. */
  dsn: string
  environment: string
  release: string
}

export interface OtelConfig {
  /** When true, request spans are exported to `endpoint` in OTLP/HTTP JSON. */
  enabled: boolean
  /** Full OTLP/HTTP trace endpoint, e.g. `http://collector:4318/v1/traces`. */
  endpoint: string
  serviceName: string
  serviceVersion: string
}

export interface UpdateConfig {
  /** Latest agent version to offer. Empty disables the update channel. */
  version: string
  /** Minimum version required before this update applies. */
  minVersion: string
  /** Absolute URL of the release artifact. */
  url: string
  /** Lowercase hex SHA-256 of the artifact. */
  sha256: string
  /** Base64 ed25519 signature over `<version>:<sha256>` (optional in dev). */
  signature: string
  /** Percentage (0-100) of the fleet offered the update per rollout ring. */
  rolloutPercent: number
}

export interface AiConfig {
  /** Master switch; AI endpoints return 503 `ai_disabled` when false. */
  enabled: boolean
  /** OpenAI-compatible chat-completions base URL (e.g. `https://api.openai.com/v1`). */
  baseUrl: string
  /** Bearer key for the provider; empty for keyless local endpoints (Ollama, vLLM). */
  apiKey: string
  /** Chat model used for summaries and KB drafting. */
  model: string
  /** Provider protocol used by the deployment-level managed credential. */
  provider: 'openai_compatible' | 'azure_openai' | 'ollama' | 'vllm'
  /** Azure OpenAI API version when the managed provider is Azure. */
  azureApiVersion: string
  /** Per-request timeout in ms — AI must never block a critical path. */
  timeoutMs: number
}

export interface WebauthnConfig {
  /** Relying-party display name shown in the authenticator prompt. */
  rpName: string
  /** Relying-party ID (hostname only, no scheme/port) — e.g. `localhost` in dev. */
  rpId: string
  /** Allowed origin (scheme://host[:port]) for attestation/assertion checks. */
  origin: string
}

export interface PushConfig {
  /** True only when VAPID keys are configured — Web Push is opt-in per deployment. */
  enabled: boolean
  /** Base64url uncompressed P-256 application-server public key (RFC 8292). */
  publicKey: string
  /** Base64url PKCS8 DER P-256 private key (RFC 8292). */
  privateKey: string
  /** Contact for the push service (e.g. `mailto:admin@example.com`). */
  subject: string
  /** Message TTL in seconds — stale pushes are dropped by the push service. */
  ttlSec: number
}

export interface IceConfig {
  /** STUN server urls (e.g. `stun:stun.l.google.com:19302`). */
  stunUrls: string[]
  /** TURN server urls (e.g. `turn:turn.example.com:3478`, `turns:` for TLS 443). */
  turnUrls: string[]
  /** coturn `static-auth-secret` used to mint short-lived TURN credentials. */
  turnSharedSecret: string
  /** coturn `realm` matching the server configuration. */
  turnRealm: string
  /** Lifetime of minted TURN credentials, in seconds. */
  turnTtlSec: number
  /** Stable username prefix embedded in the minted coturn username. */
  turnUsername: string
}

export interface SmtpConfig {
  enabled: boolean
  host: string
  port: number
  user: string
  pass: string
  from: string
  tls: boolean
  /** Test-only: capture messages in memory instead of sending (jsonTransport). */
  jsonTransport: boolean
}

function resolveJwtSecret(env: AppConfig['env'], raw: string | undefined): Uint8Array {
  if (raw && raw.length > 0) return new TextEncoder().encode(raw)
  if (env === 'production') {
    throw new Error('REYDESK_JWT_SECRET must be set in production (legacy DESKOS_JWT_SECRET is still accepted)')
  }
  console.warn('[config] REYDESK_JWT_SECRET not set; generated an ephemeral secret (dev/test only)')
  return randomBytes(32)
}

function resolveEmailKey(env: AppConfig['env'], raw: string | undefined): string {
  if (raw && raw.length > 0) return raw
  if (env === 'production') {
    throw new Error('REYDESK_EMAIL_KEY must be set in production (legacy DESKOS_EMAIL_KEY is still accepted)')
  }
  console.warn('[config] REYDESK_EMAIL_KEY not set; generated an ephemeral key (dev/test only)')
  return randomBytes(32).toString('hex')
}

function resolveRelaySecret(env: AppConfig['env'], raw: string | undefined): string {
  if (raw && raw.length > 0) return raw
  if (env === 'production') {
    throw new Error('REYDESK_RELAY_SECRET must be set in production (legacy DESKOS_RELAY_SECRET is still accepted)')
  }
  return 'reydesk-relay-dev-only'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const value = (key: string): string | undefined => env[key] ?? env[key.replace(/^REYDESK_/, 'DESKOS_')]
  const nodeEnv = (env.NODE_ENV ?? 'development') as AppConfig['env']
  const configuredPort = Number(env.PORT ?? 4000)
  // Some local shells inject PORT=0. Vite still proxies to 4000, so allowing
  // the API watcher to choose an ephemeral port makes the web app look offline
  // after a restart. Keep the documented development port stable in that case.
  const port = nodeEnv !== 'production' && configuredPort === 0 ? 4000 : configuredPort

  return {
    env: nodeEnv,
    host: env.HOST ?? '0.0.0.0',
    port,
    databaseUrl: env.DATABASE_URL ?? 'postgresql://deskos:deskos_dev_only@localhost:5432/deskos',
    dbPoolMax: Math.max(2, Number(value('REYDESK_DB_POOL_MAX') ?? 10)),
    jwtSecret: resolveJwtSecret(nodeEnv, value('REYDESK_JWT_SECRET')),
    jwtIssuer: value('REYDESK_JWT_ISSUER') ?? 'reydesk',
    accessTokenTtlSec: Number(value('REYDESK_ACCESS_TTL_SEC') ?? 15 * 60),
    refreshTokenTtlDays: Number(value('REYDESK_REFRESH_TTL_DAYS') ?? 30),
    bcryptRounds: Number(value('REYDESK_BCRYPT_ROUNDS') ?? 10),
    uploadDir: value('REYDESK_UPLOAD_DIR') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.uploads'),
    maxUploadBytes: Number(value('REYDESK_MAX_UPLOAD_BYTES') ?? 25 * 1024 * 1024),
    recordingDir: value('REYDESK_RECORDING_DIR') ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.recordings'),
    maxRecordingBytes: Number(value('REYDESK_MAX_RECORDING_BYTES') ?? 1024 * 1024 * 1024),
    emailKey: resolveEmailKey(nodeEnv, value('REYDESK_EMAIL_KEY')),
    relaySecret: resolveRelaySecret(nodeEnv, value('REYDESK_RELAY_SECRET')),
    publicUrl: resolvePublicUrl(nodeEnv, value('REYDESK_PUBLIC_URL')),
    webOrigins: splitCsv(value('REYDESK_WEB_ORIGINS'), resolvePublicUrl(nodeEnv, value('REYDESK_PUBLIC_URL'))),
    relayUrl: resolveRelayUrl(nodeEnv, value('REYDESK_RELAY_URL')),
    helperBinaryPath:
      value('REYDESK_HELPER_BINARY') ??
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'artifacts',
        'windows',
        'reydesk-helper.exe',
      ),
    deviceOfflineSec: Number(value('REYDESK_DEVICE_OFFLINE_SEC') ?? 120),
    deviceLowDiskPct: Number(value('REYDESK_DEVICE_LOW_DISK_PCT') ?? 85),
    smtp: {
      enabled:
        Boolean(value('REYDESK_SMTP_HOST') && value('REYDESK_SMTP_FROM')) ||
        value('REYDESK_SMTP_JSON') === 'true',
      host: value('REYDESK_SMTP_HOST') ?? '',
      port: Number(value('REYDESK_SMTP_PORT') ?? 587),
      user: value('REYDESK_SMTP_USER') ?? '',
      pass: value('REYDESK_SMTP_PASS') ?? '',
      from: value('REYDESK_SMTP_FROM') ?? '',
      tls: value('REYDESK_SMTP_TLS') !== 'false',
      jsonTransport: value('REYDESK_SMTP_JSON') === 'true',
    },
    imap: {
      enabled: Boolean(value('REYDESK_IMAP_HOST') && value('REYDESK_IMAP_USER') && value('REYDESK_IMAP_PASS')),
      host: value('REYDESK_IMAP_HOST') ?? 'safari.mxrouting.net',
      port: Number(value('REYDESK_IMAP_PORT') ?? 993),
      user: value('REYDESK_IMAP_USER') ?? '',
      pass: value('REYDESK_IMAP_PASS') ?? '',
      tls: value('REYDESK_IMAP_TLS') !== 'false',
      pollIntervalSec: Number(value('REYDESK_IMAP_POLL_INTERVAL_SEC') ?? 60),
    },
    ice: {
      stunUrls: splitCsv(value('REYDESK_ICE_STUN_URLS'), 'stun:stun.l.google.com:19302'),
      turnUrls: splitCsv(value('REYDESK_ICE_TURN_URLS')),
      turnSharedSecret: value('REYDESK_ICE_TURN_SECRET') ?? '',
      turnRealm: value('REYDESK_ICE_TURN_REALM') ?? 'reydesk',
      turnTtlSec: Math.max(60, Number(value('REYDESK_ICE_TURN_TTL_SEC') ?? 3600)),
      turnUsername: value('REYDESK_ICE_TURN_USERNAME') ?? 'reydesk',
    },
    update: {
      version: value('REYDESK_UPDATE_VERSION') ?? '',
      minVersion: value('REYDESK_UPDATE_MIN_VERSION') ?? value('REYDESK_UPDATE_VERSION') ?? '',
      url: value('REYDESK_UPDATE_URL') ?? '',
      sha256: (value('REYDESK_UPDATE_SHA256') ?? '').toLowerCase(),
      signature: value('REYDESK_UPDATE_SIGNATURE') ?? '',
      rolloutPercent: Math.max(0, Math.min(100, Number(value('REYDESK_UPDATE_ROLLOUT_PERCENT') ?? 100))),
    },
    otel: {
      enabled: Boolean(value('REYDESK_OTEL_ENDPOINT')),
      endpoint: value('REYDESK_OTEL_ENDPOINT') ?? '',
      serviceName: value('REYDESK_OTEL_SERVICE_NAME') ?? 'reydesk-api',
      serviceVersion: value('REYDESK_OTEL_SERVICE_VERSION') ?? '0.0.1',
    },
    sentry: {
      dsn: value('REYDESK_SENTRY_DSN') ?? '',
      environment: value('REYDESK_SENTRY_ENVIRONMENT') ?? nodeEnv,
      release: value('REYDESK_SENTRY_RELEASE') ?? 'reydesk-api@0.0.1',
    },
    ai: {
      enabled: value('REYDESK_AI_ENABLED') === 'true',
      baseUrl: value('REYDESK_AI_BASE_URL') ?? 'https://api.openai.com/v1',
      apiKey: value('REYDESK_AI_API_KEY') ?? '',
      model: value('REYDESK_AI_MODEL') ?? 'gpt-4o-mini',
      provider: (value('REYDESK_AI_PROVIDER') as AppConfig['ai']['provider'] | undefined) ?? 'openai_compatible',
      azureApiVersion: value('REYDESK_AI_AZURE_API_VERSION') ?? '2024-10-21',
      timeoutMs: Math.max(1000, Number(value('REYDESK_AI_TIMEOUT_MS') ?? 15000)),
    },
    webauthn: {
      rpName: value('REYDESK_WEBAUTHN_RP_NAME') ?? 'ReyDesk',
      rpId: value('REYDESK_WEBAUTHN_RP_ID') ?? safeHostname(resolvePublicUrl(nodeEnv, value('REYDESK_PUBLIC_URL'))),
      origin: value('REYDESK_WEBAUTHN_ORIGIN') ?? resolvePublicUrl(nodeEnv, value('REYDESK_PUBLIC_URL')),
    },
    push: {
      enabled: Boolean(value('REYDESK_VAPID_PUBLIC_KEY') && value('REYDESK_VAPID_PRIVATE_KEY') && value('REYDESK_VAPID_SUBJECT')),
      publicKey: value('REYDESK_VAPID_PUBLIC_KEY') ?? '',
      privateKey: value('REYDESK_VAPID_PRIVATE_KEY') ?? '',
      subject: value('REYDESK_VAPID_SUBJECT') ?? 'mailto:admin@reydesk.local',
      ttlSec: Math.max(60, Number(value('REYDESK_PUSH_TTL_SEC') ?? 86400)),
    },
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname || 'localhost'
  } catch {
    return 'localhost'
  }
}

function resolvePublicUrl(env: AppConfig['env'], raw: string | undefined): string {
  const value = (raw ?? 'http://localhost:5180').replace(/\/$/, '')
  if (env === 'production' && !value.startsWith('https://')) {
    throw new Error('REYDESK_PUBLIC_URL must use https:// in production')
  }
  return value
}

function resolveRelayUrl(env: AppConfig['env'], raw: string | undefined): string {
  const value = raw ?? 'ws://localhost:4100/ws'
  if (env === 'production' && !value.startsWith('wss://')) {
    throw new Error('REYDESK_RELAY_URL must use wss:// in production')
  }
  return value
}

function splitCsv(raw: string | undefined, fallback = ''): string[] {
  if (!raw) return fallback ? [fallback] : []
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}
