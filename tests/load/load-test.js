/**
 * DeskOS Load Test — k6
 *
 * Run: k6 run tests/load/load-test.js
 *
 * Requires: BASE_URL env var (default http://localhost:4000)
 *           TEST_EMAIL / TEST_PASSWORD for authenticated tests
 */

import http from 'k6/http'
import { check, sleep } from 'k6'
import { Rate, Trend } from 'k6/metrics'

const BASE_URL = __ENV.BASE_URL || 'http://localhost:4000'
const TEST_EMAIL = __ENV.TEST_EMAIL || ''
const TEST_PASSWORD = __ENV.TEST_PASSWORD || ''

const errorRate = new Rate('errors')
const loginDuration = new Trend('login_duration', true)
const ticketListDuration = new Trend('ticket_list_duration', true)
const healthDuration = new Trend('health_duration', true)

export const options = {
  stages: [
    { duration: '30s', target: 20 },   // ramp up
    { duration: '1m', target: 50 },    // sustained load
    { duration: '30s', target: 100 },  // peak
    { duration: '1m', target: 50 },    // scale down
    { duration: '30s', target: 0 },    // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000', 'p(99)<5000'],
    errors: ['rate<0.1'],
  },
}

function getAuthToken() {
  if (!TEST_EMAIL || !TEST_PASSWORD) return null
  const res = http.post(`${BASE_URL}/api/v1/auth/login`, JSON.stringify({
    email: TEST_EMAIL,
    password: TEST_PASSWORD,
  }), { headers: { 'Content-Type': 'application/json' } })

  if (res.status === 200) {
    const body = JSON.parse(res.body)
    return body.accessToken
  }
  return null
}

export function setup() {
  // Verify the API is reachable
  const healthRes = http.get(`${BASE_URL}/healthz`)
  check(healthRes, { 'healthz returns 200': (r) => r.status === 200 })

  const token = getAuthToken()
  return { token }
}

export default function (data) {
  // ── Health check (unauthenticated) ──
  {
    const start = Date.now()
    const res = http.get(`${BASE_URL}/healthz`)
    healthDuration.add(Date.now() - start)
    check(res, {
      'healthz status 200': (r) => r.status === 200,
      'healthz has ok': (r) => JSON.parse(r.body).status === 'ok',
    }) || errorRate.add(1)
  }

  // ── Readiness check ──
  {
    const res = http.get(`${BASE_URL}/readyz`)
    check(res, { 'readyz status 200': (r) => r.status === 200 }) || errorRate.add(1)
  }

  // ── Meta endpoint ──
  {
    const res = http.get(`${BASE_URL}/api/v1/meta`)
    check(res, { 'meta status 200': (r) => r.status === 200 }) || errorRate.add(1)
  }

  // Authenticated tests require a valid token
  if (!data.token) {
    sleep(1)
    return
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${data.token}`,
  }

  // ── Login (re-auth) ──
  if (TEST_EMAIL && TEST_PASSWORD) {
    const start = Date.now()
    const loginRes = http.post(`${BASE_URL}/api/v1/auth/login`, JSON.stringify({
      email: TEST_EMAIL,
      password: TEST_PASSWORD,
    }), { headers: { 'Content-Type': 'application/json' } })
    loginDuration.add(Date.now() - start)
    check(loginRes, {
      'login status 200': (r) => r.status === 200,
      'login has accessToken': (r) => !!JSON.parse(r.body).accessToken,
    }) || errorRate.add(1)
  }

  // ── List tickets ──
  {
    const start = Date.now()
    const res = http.get(`${BASE_URL}/api/v1/tickets?limit=20`, { headers })
    ticketListDuration.add(Date.now() - start)
    check(res, {
      'tickets status 200': (r) => r.status === 200,
      'tickets is array': (r) => Array.isArray(JSON.parse(r.body)),
    }) || errorRate.add(1)
  }

  // ── List devices ──
  {
    const res = http.get(`${BASE_URL}/api/v1/devices`, { headers })
    check(res, {
      'devices status 200': (r) => r.status === 200,
    }) || errorRate.add(1)
  }

  // ── List sessions ──
  {
    const res = http.get(`${BASE_URL}/api/v1/sessions`, { headers })
    check(res, {
      'sessions status 200': (r) => r.status === 200,
    }) || errorRate.add(1)
  }

  // ── Audit log ──
  {
    const res = http.get(`${BASE_URL}/api/v1/audit?limit=10`, { headers })
    check(res, {
      'audit status 200': (r) => r.status === 200,
    }) || errorRate.add(1)
  }

  // ── Marketplace ──
  {
    const res = http.get(`${BASE_URL}/api/v1/marketplace/apps`, { headers })
    check(res, {
      'marketplace status 200': (r) => r.status === 200,
    }) || errorRate.add(1)
  }

  // ── Monitoring rules ──
  {
    const res = http.get(`${BASE_URL}/api/v1/monitoring/rules`, { headers })
    check(res, {
      'monitoring status 200': (r) => r.status === 200,
    }) || errorRate.add(1)
  }

  sleep(1)
}

export function teardown() {
  console.log('Load test complete.')
}
