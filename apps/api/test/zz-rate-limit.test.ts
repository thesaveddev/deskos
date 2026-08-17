import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { createTestApp } from './helpers.js'

describe('auth rate limiting', () => {
  let app: FastifyInstance

  beforeAll(async () => {
    app = await createTestApp()
  })

  afterAll(async () => {
    await app.close()
  })

  it('throttles repeated login attempts', async () => {
    const statuses: number[] = []
    for (let i = 0; i < 40; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/login',
        payload: { email: `brute-${i}@example.com`, password: 'whatever-123456' },
      })
      statuses.push(res.statusCode)
      if (res.statusCode === 429) break
    }
    expect(statuses[0]).toBe(401)
    expect(statuses).toContain(429)
    const limited = statuses.filter((s) => s === 429)
    expect(limited.length).toBeGreaterThan(0)
  })
})
