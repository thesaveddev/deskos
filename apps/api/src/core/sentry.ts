import * as Sentry from '@sentry/node'
import type { SentryConfig } from '../config.js'

/**
 * Sentry is optional: without `REYDESK_SENTRY_DSN` these functions are no-ops so
 * the API never depends on a Sentry account. Errors are captured only for
 * unexpected (5xx) failures; expected AppError responses are handled by the
 * normal error contract and are not sent to Sentry.
 */
export function initSentry(config: SentryConfig): void {
  if (!config.dsn) return
  Sentry.init({
    dsn: config.dsn,
    environment: config.environment,
    release: config.release,
    tracesSampleRate: 0.1,
  })
}

export function captureError(error: unknown, traceId?: string): void {
  if (!Sentry.isInitialized()) return
  Sentry.withScope((scope) => {
    if (traceId) scope.setTag('traceId', traceId)
    Sentry.captureException(error)
  })
}
