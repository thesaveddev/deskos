import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'
import { addBusinessMinutes, checkBreachesForTenant, computeDeadlines } from '../src/modules/tickets/sla.js'
import { DEFAULT_SLA_MATRIX } from '../src/modules/tenants/defaults.js'
import { withTenant } from '../src/db/pool.js'
import { authHeaders, createTestApp, signupOwner } from './helpers.js'

describe('SLA engine', () => {
  describe('business hours math (unit)', () => {
    it('adds calendar minutes for 24/7 schedules', () => {
      const start = Date.UTC(2026, 0, 1, 10, 0)
      const result = addBusinessMinutes(start, 90, {})
      expect(result.toISOString()).toBe('2026-01-01T11:30:00.000Z')
    })

    it('skips out-of-hours time overnight', () => {
      const schedule = { mon: { start: '09:00', end: '17:00' }, tue: { start: '09:00', end: '17:00' } }
      // 2026-01-05 is a Monday
      const start = Date.UTC(2026, 0, 5, 16, 0) // Mon 16:00
      const result = addBusinessMinutes(start, 120, schedule)
      expect(result.toISOString()).toBe('2026-01-06T10:00:00.000Z') // Tue 10:00
    })

    it('skips weekends', () => {
      const schedule = { mon: { start: '09:00', end: '17:00' } }
      // 2026-01-09 is a Friday
      const start = Date.UTC(2026, 0, 9, 16, 0)
      const result = addBusinessMinutes(start, 60, schedule)
      expect(result.toISOString()).toBe('2026-01-12T10:00:00.000Z') // next Monday 10:00
    })

    it('skips holidays', () => {
      const schedule = { mon: { start: '09:00', end: '17:00' }, tue: { start: '09:00', end: '17:00' }, wed: { start: '09:00', end: '17:00' } }
      // Monday 16:30 + 60m: 30m fit Monday, Tuesday is a holiday, rest lands Wednesday
      const start = Date.UTC(2026, 0, 5, 16, 30)
      const result = addBusinessMinutes(start, 60, schedule, ['2026-01-06'])
      expect(result.toISOString()).toBe('2026-01-07T09:30:00.000Z')
    })
  })

  describe('deadline computation (unit)', () => {
    it('applies the priority matrix', () => {
      const from = Date.UTC(2026, 0, 1, 0, 0)
      const { dueResponseAt, dueResolutionAt } = computeDeadlines({
        priority: 'p1',
        matrix: DEFAULT_SLA_MATRIX,
        fromMs: from,
      })
      expect(dueResponseAt.getTime() - from).toBe(30 * 60_000)
      expect(dueResolutionAt.getTime() - from).toBe(240 * 60_000)
    })

    it('falls back to p3 for unknown priorities', () => {
      const from = Date.UTC(2026, 0, 1, 0, 0)
      const { dueResponseAt } = computeDeadlines({ priority: 'p9', matrix: DEFAULT_SLA_MATRIX, fromMs: from })
      expect(dueResponseAt.getTime() - from).toBe(240 * 60_000)
    })
  })

  describe('breach detection (integration)', () => {
    let app: FastifyInstance
    let owner: Awaited<ReturnType<typeof signupOwner>>

    beforeAll(async () => {
      app = await createTestApp()
      owner = await signupOwner(app, { tenantName: 'SLA Org' })
    })

    afterAll(async () => {
      await app.close()
    })

    it('flags overdue tickets once and records a system event', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/tickets',
        headers: authHeaders(owner),
        payload: { subject: 'Will breach SLA' },
      })
      expect(create.statusCode).toBe(201)
      const ticketId = create.json().ticket.id as string

      await withTenant(app.db, owner.tenantId!, (client) =>
        client.query(
          `UPDATE tickets SET due_response_at = now() - interval '1 minute', due_resolution_at = now() - interval '1 minute' WHERE id = $1`,
          [ticketId],
        ),
      )

      const first = await checkBreachesForTenant(app.db, owner.tenantId!)
      expect(first.responseBreaches.map((t) => t.id)).toContain(ticketId)
      expect(first.resolutionBreaches.map((t) => t.id)).toContain(ticketId)

      const second = await checkBreachesForTenant(app.db, owner.tenantId!)
      expect(second.responseBreaches).toHaveLength(0)
      expect(second.resolutionBreaches).toHaveLength(0)

      const detail = await app.inject({ method: 'GET', url: `/api/v1/tickets/${ticketId}`, headers: authHeaders(owner) })
      const body = detail.json()
      expect(body.ticket.sla_response_breached).toBe(true)
      expect(body.ticket.sla_resolution_breached).toBe(true)
      const breachEvents = body.threads.filter((t: { body: string }) => t.body.startsWith('SLA'))
      expect(breachEvents.length).toBe(2)
    })

    it('does not breach tickets that already have a first response', async () => {
      const create = await app.inject({
        method: 'POST',
        url: '/api/v1/tickets',
        headers: authHeaders(owner),
        payload: { subject: 'Responded in time' },
      })
      const ticketId = create.json().ticket.id as string
      await app.inject({
        method: 'POST',
        url: `/api/v1/tickets/${ticketId}/reply`,
        headers: authHeaders(owner),
        payload: { body: 'We are on it', visibility: 'public' },
      })
      await withTenant(app.db, owner.tenantId!, (client) =>
        client.query(`UPDATE tickets SET due_response_at = now() - interval '1 minute' WHERE id = $1`, [ticketId]),
      )

      const result = await checkBreachesForTenant(app.db, owner.tenantId!)
      expect(result.responseBreaches.map((t) => t.id)).not.toContain(ticketId)
    })
  })
})
