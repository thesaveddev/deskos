import { expect, test, type Page, type Route } from '@playwright/test'

/**
 * Layout audit: the highest-value public and authenticated surfaces must not
 * overflow horizontally at any supported viewport. This is a deterministic
 * structural regression guard (no screenshot baselines required) that keeps
 * the mobile/tablet shell honest as modules evolve.
 */

const VIEWPORTS = [
  { name: 'mobile-s', width: 320, height: 640 },
  { name: 'mobile-m', width: 375, height: 667 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desktop', width: 1280, height: 800 },
]

const PUBLIC_ROUTES = ['/', '/login', '/pricing', '/features', '/use-cases', '/contact']

async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  const metrics = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }))
  expect(metrics.scrollWidth, 'document must not overflow horizontally').toBeLessThanOrEqual(metrics.clientWidth + 1)
}

const membership = {
  tenant: { id: 'tenant-1', slug: 'acme', name: 'Acme Support' },
  orgRole: 'owner',
  permissions: [
    'ticket.read', 'ticket.write', 'device.read', 'rmm.read', 'monitoring.read',
    'kb.read', 'asset.read', 'report.read', 'audit.read', 'member.read',
    'telephony.read', 'chat.read', 'integration.read', 'grant.read', 'remote.attended',
  ],
}

const user = { id: 'user-1', email: 'james@example.com', name: 'James Adeyemi' }

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

async function mockConsoleApi(page: Page): Promise<void> {
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^.*\/api\/v1/, '')

    if (path === '/auth/refresh' && request.method() === 'POST') {
      return json(route, { user, accessToken: 'access-token', refreshToken: 'refresh-token' })
    }
    if (path === '/me' && request.method() === 'GET') {
      return json(route, { user, memberships: [membership] })
    }
    if (path === '/tickets/counts') return json(route, { byStatus: [], mine: 0, unassigned: 0, slaRisk: 0 })
    if (path.startsWith('/reports/tickets')) {
      return json(route, {
        totals: { total: 0, open: 0, resolved: 0, breached: 0 },
        byStatus: [], byPriority: [], resolution: { n: 0, avg_minutes: 0 },
        firstResponse: { n: 0, avg_minutes: 0 }, byAssignee: [], createdDaily: [],
      })
    }
    if (path.startsWith('/tickets')) return json(route, { tickets: [], total: 0, nextCursor: null })
    if (path.startsWith('/devices')) return json(route, { devices: [], total: 0, nextCursor: null })
    if (path.startsWith('/sessions')) return json(route, { sessions: [], total: 0, nextCursor: null })
    if (path.startsWith('/incidents')) return json(route, { incidents: [] })
    if (path.startsWith('/approvals')) return json(route, { approvals: [] })
    if (path.startsWith('/notifications')) return json(route, { notifications: [], unread: 0 })
    return json(route, {})
  })

  await page.addInitScript(({ token, tenantId }) => {
    localStorage.setItem('deskos.accessToken', token)
    localStorage.setItem('deskos.refreshToken', 'refresh-token')
    localStorage.setItem('deskos.activeTenant', tenantId)
  }, { token: 'access-token', tenantId: membership.tenant.id })
}

test.describe('public layout audit', () => {
  for (const route of PUBLIC_ROUTES) {
    for (const vp of VIEWPORTS) {
      test(`${route} at ${vp.name} (${vp.width}px) has no horizontal overflow`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height })
        await page.goto(route)
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible()
        await expect(page.getByText('Page not found')).toHaveCount(0)
        await expectNoHorizontalOverflow(page)
      })
    }
  }
})

test.describe('public connect route', () => {
  for (const vp of [VIEWPORTS[1], VIEWPORTS[3]]) {
    test(`/connect/:code renders (not 404) at ${vp.name} (${vp.width}px)`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/connect/12345678')
      // The connect experience surfaces a code or an explicit invalid-link
      // message; either way it must not fall through to the 404 page.
      await expect(page.getByText(/invalid or has expired|Support code/i).first()).toBeVisible()
      await expectNoHorizontalOverflow(page)
    })
  }
})

test.describe('authenticated console audit', () => {
  for (const vp of [VIEWPORTS[1], VIEWPORTS[3]]) {
    test(`dashboard at ${vp.name} (${vp.width}px) has no horizontal overflow`, async ({ page }) => {
      await mockConsoleApi(page)
      await page.setViewportSize({ width: vp.width, height: vp.height })
      await page.goto('/')
      await expect(page.getByText(/Good (morning|afternoon|evening), James\./)).toBeVisible()
      await expectNoHorizontalOverflow(page)
    })
  }

  test('narrow viewport exposes the mobile navigation toggle', async ({ page }) => {
    await mockConsoleApi(page)
    await page.setViewportSize({ width: 375, height: 667 })
    await page.goto('/')
    await expect(page.getByRole('button', { name: /menu|open navigation/i })).toBeVisible()
  })
})
