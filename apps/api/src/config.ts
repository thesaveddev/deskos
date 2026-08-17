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
    throw new Error('DESKOS_JWT_SECRET must be set in production')
  }
  console.warn('[config] DESKOS_JWT_SECRET not set; generated an ephemeral secret (dev/test only)')
  return randomBytes(32)
}

function resolveEmailKey(env: AppConfig['env'], raw: string | undefined): string {
  if (raw && raw.length > 0) return raw
  if (env === 'production') {
    throw new Error('DESKOS_EMAIL_KEY must be set in production')
  }
  console.warn('[config] DESKOS_EMAIL_KEY not set; generated an ephemeral key (dev/test only)')
  return randomBytes(32).toString('hex')
}

function resolveRelaySecret(env: AppConfig['env'], raw: string | undefined): string {
  if (raw && raw.length > 0) return raw
  if (env === 'production') {
    throw new Error('DESKOS_RELAY_SECRET must be set in production')
  }
  return 'deskos-relay-dev-only'
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const nodeEnv = (env.NODE_ENV ?? 'development') as AppConfig['env']
  return {
    env: nodeEnv,
    host: env.HOST ?? '0.0.0.0',
    port: Number(env.PORT ?? 4000),
    databaseUrl: env.DATABASE_URL ?? 'postgresql://deskos:deskos_dev_only@localhost:5432/deskos',
    dbPoolMax: Math.max(2, Number(env.DESKOS_DB_POOL_MAX ?? 10)),
    jwtSecret: resolveJwtSecret(nodeEnv, env.DESKOS_JWT_SECRET),
    jwtIssuer: env.DESKOS_JWT_ISSUER ?? 'deskos',
    accessTokenTtlSec: Number(env.DESKOS_ACCESS_TTL_SEC ?? 15 * 60),
    refreshTokenTtlDays: Number(env.DESKOS_REFRESH_TTL_DAYS ?? 30),
    bcryptRounds: Number(env.DESKOS_BCRYPT_ROUNDS ?? 10),
    uploadDir: env.DESKOS_UPLOAD_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.uploads'),
    maxUploadBytes: Number(env.DESKOS_MAX_UPLOAD_BYTES ?? 25 * 1024 * 1024),
    recordingDir: env.DESKOS_RECORDING_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.recordings'),
    maxRecordingBytes: Number(env.DESKOS_MAX_RECORDING_BYTES ?? 1024 * 1024 * 1024),
    emailKey: resolveEmailKey(nodeEnv, env.DESKOS_EMAIL_KEY),
    relaySecret: resolveRelaySecret(nodeEnv, env.DESKOS_RELAY_SECRET),
    publicUrl: (env.DESKOS_PUBLIC_URL ?? 'http://localhost:5180').replace(/\/$/, ''),
    relayUrl: env.DESKOS_RELAY_URL ?? 'ws://localhost:4100/ws',
    helperBinaryPath:
      env.DESKOS_HELPER_BINARY ??
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        '..',
        '..',
        '..',
        'artifacts',
        'windows',
        'deskos-helper.exe',
      ),
    deviceOfflineSec: Number(env.DESKOS_DEVICE_OFFLINE_SEC ?? 120),
    deviceLowDiskPct: Number(env.DESKOS_DEVICE_LOW_DISK_PCT ?? 85),
    smtp: {
      enabled:
        Boolean(env.DESKOS_SMTP_HOST && env.DESKOS_SMTP_FROM) ||
        env.DESKOS_SMTP_JSON === 'true',
      host: env.DESKOS_SMTP_HOST ?? '',
      port: Number(env.DESKOS_SMTP_PORT ?? 587),
      user: env.DESKOS_SMTP_USER ?? '',
      pass: env.DESKOS_SMTP_PASS ?? '',
      from: env.DESKOS_SMTP_FROM ?? '',
      tls: env.DESKOS_SMTP_TLS !== 'false',
      jsonTransport: env.DESKOS_SMTP_JSON === 'true',
    },
    imap: {
      enabled: Boolean(env.DESKOS_IMAP_HOST && env.DESKOS_IMAP_USER && env.DESKOS_IMAP_PASS),
      host: env.DESKOS_IMAP_HOST ?? 'safari.mxrouting.net',
      port: Number(env.DESKOS_IMAP_PORT ?? 993),
      user: env.DESKOS_IMAP_USER ?? '',
      pass: env.DESKOS_IMAP_PASS ?? '',
      tls: env.DESKOS_IMAP_TLS !== 'false',
      pollIntervalSec: Number(env.DESKOS_IMAP_POLL_INTERVAL_SEC ?? 60),
    },
    ice: {
      stunUrls: splitCsv(env.DESKOS_ICE_STUN_URLS, 'stun:stun.l.google.com:19302'),
      turnUrls: splitCsv(env.DESKOS_ICE_TURN_URLS),
      turnSharedSecret: env.DESKOS_ICE_TURN_SECRET ?? '',
      turnRealm: env.DESKOS_ICE_TURN_REALM ?? 'deskos',
      turnTtlSec: Math.max(60, Number(env.DESKOS_ICE_TURN_TTL_SEC ?? 3600)),
      turnUsername: env.DESKOS_ICE_TURN_USERNAME ?? 'deskos',
    },
    update: {
      version: env.DESKOS_UPDATE_VERSION ?? '',
      minVersion: env.DESKOS_UPDATE_MIN_VERSION ?? env.DESKOS_UPDATE_VERSION ?? '',
      url: env.DESKOS_UPDATE_URL ?? '',
      sha256: (env.DESKOS_UPDATE_SHA256 ?? '').toLowerCase(),
      signature: env.DESKOS_UPDATE_SIGNATURE ?? '',
      rolloutPercent: Math.max(0, Math.min(100, Number(env.DESKOS_UPDATE_ROLLOUT_PERCENT ?? 100))),
    },
    otel: {
      enabled: Boolean(env.DESKOS_OTEL_ENDPOINT),
      endpoint: env.DESKOS_OTEL_ENDPOINT ?? '',
      serviceName: env.DESKOS_OTEL_SERVICE_NAME ?? 'deskos-api',
      serviceVersion: env.DESKOS_OTEL_SERVICE_VERSION ?? '0.0.1',
    },
    sentry: {
      dsn: env.DESKOS_SENTRY_DSN ?? '',
      environment: env.DESKOS_SENTRY_ENVIRONMENT ?? nodeEnv,
      release: env.DESKOS_SENTRY_RELEASE ?? 'deskos-api@0.0.1',
    },
    ai: {
      enabled: env.DESKOS_AI_ENABLED === 'true',
      baseUrl: env.DESKOS_AI_BASE_URL ?? 'https://api.openai.com/v1',
      apiKey: env.DESKOS_AI_API_KEY ?? '',
      model: env.DESKOS_AI_MODEL ?? 'gpt-4o-mini',
      timeoutMs: Math.max(1000, Number(env.DESKOS_AI_TIMEOUT_MS ?? 15000)),
    },
    webauthn: {
      rpName: env.DESKOS_WEBAUTHN_RP_NAME ?? 'DeskOS',
      rpId: env.DESKOS_WEBAUTHN_RP_ID ?? safeHostname(env.DESKOS_PUBLIC_URL ?? 'http://localhost:5180'),
      origin: env.DESKOS_WEBAUTHN_ORIGIN ?? (env.DESKOS_PUBLIC_URL ?? 'http://localhost:5180').replace(/\/$/, ''),
    },
    push: {
      enabled: Boolean(env.DESKOS_VAPID_PUBLIC_KEY && env.DESKOS_VAPID_PRIVATE_KEY && env.DESKOS_VAPID_SUBJECT),
      publicKey: env.DESKOS_VAPID_PUBLIC_KEY ?? '',
      privateKey: env.DESKOS_VAPID_PRIVATE_KEY ?? '',
      subject: env.DESKOS_VAPID_SUBJECT ?? 'mailto:admin@deskos.local',
      ttlSec: Math.max(60, Number(env.DESKOS_PUSH_TTL_SEC ?? 86400)),
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

function splitCsv(raw: string | undefined, fallback = ''): string[] {
  if (!raw) return fallback ? [fallback] : []
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
}
