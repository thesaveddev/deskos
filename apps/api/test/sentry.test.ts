import { describe, expect, it } from 'vitest'
import { captureError, initSentry } from '../src/core/sentry.js'

describe('Sentry error capture', () => {
  it('initialises without crashing when no DSN is configured', () => {
    expect(() => initSentry({ dsn: '', environment: 'test', release: 'deskos-api@0.0.1' })).not.toThrow()
  })

  it('captureError is a safe no-op when Sentry is not initialised', () => {
    expect(() => captureError(new Error('boom'), '0123456789abcdef0123456789abcdef')).not.toThrow()
  })
})
