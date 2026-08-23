import { expect, test, type Page, type Route } from '@playwright/test'

const user = {
  id: 'user-1',
  email: 'james@example.com',
  name: 'James Adeyemi',
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

const session = {
  user,
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  tenant: { id: membership.tenant.id, slug: membership.tenant.slug },
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  })
}

function errorBody(code: string, message: string, status: number, details?: Record<string, unknown>) {
  return { error: { code, message, ...(details ? { details } : {}) } }
}

async function mockDeskOsApi(page: Page, options: { mfa?: boolean; authenticated?: boolean } = {}) {
  let mfaEnabled = options.mfa ?? false

  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace(/^.*\/api\/v1/, '')

    if (path === '/auth/login' && request.method() === 'POST') {
      const body = request.postDataJSON() as { email?: string; password?: string; mfaCode?: string }
      if (body.email !== user.email || body.password !== 'correct-horse-battery-9') {
        return json(route, errorBody('invalid_credentials', 'Invalid email or password', 401), 401)
      }
      if (mfaEnabled && !body.mfaCode) {
        return json(route, errorBody('mfa_required', 'MFA code required', 401), 401)
      }
      if (mfaEnabled && body.mfaCode !== '123456' && body.mfaCode !== 'RECOVERY-1') {
        return json(route, errorBody('mfa_invalid', 'Invalid authentication or recovery code', 401), 401)
      }
      return json(route, { ...session, tenant: membership.tenant })
    }

    if (path === '/auth/logout' && request.method() === 'POST') {
      return route.fulfill({ status: 204, body: '' })
    }

    if (path === '/auth/refresh' && request.method() === 'POST') {
      return json(route, session)
    }

    if (path === '/me' && request.method() === 'GET') {
      return json(route, { user, memberships: [membership] })
    }

    // Keep the dashboard deterministic without coupling this browser journey
    // to the shape or availability of every dashboard data source.
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

    // Unused shell requests should not turn this into an integration test.
    return json(route, {})
  })

  if (options.authenticated !== false) {
    await page.addInitScript(({ token, tenantId }) => {
      localStorage.setItem('deskos.accessToken', token)
      localStorage.setItem('deskos.refreshToken', 'refresh-token')
      localStorage.setItem('deskos.activeTenant', tenantId)
    }, { token: session.accessToken, tenantId: membership.tenant.id })
  }
}

async function seedLockIdentity(page: Page) {
  await page.addInitScript((lockedUser) => {
    sessionStorage.setItem('deskos.lockedUser', JSON.stringify(lockedUser))
  }, user)
}

test.describe('authentication and lock screen', () => {
  test('signs out to the sign-in page', async ({ page }) => {
    await mockDeskOsApi(page)
    await page.goto('/')

    await expect(page.getByText(/Good (morning|afternoon|evening), James\./)).toBeVisible()
    await page.getByRole('button', { name: 'Sign out' }).click()

    await expect(page).toHaveURL(/\/login$/)
    await expect(page.getByRole('heading', { name: /sign in/i })).toBeVisible()
  })

  test('unlocks with the password on desktop and mobile', async ({ page }) => {
    await mockDeskOsApi(page, { authenticated: false })
    await seedLockIdentity(page)
    await page.goto('/lock')

    await expect(page.getByText('James Adeyemi')).toBeVisible()
    await page.getByPlaceholder('Password').fill('correct-horse-battery-9')
    await page.getByRole('button', { name: 'Unlock' }).click()

    await expect(page).toHaveURL(/\/$/)
    await expect(page.getByText(/James\./)).toBeVisible()
    expect(await page.evaluate(() => window.innerWidth)).toBeGreaterThan(0)
  })

  test('shows an MFA challenge, rejects invalid codes, and supports recovery-code mode', async ({ page }) => {
    await mockDeskOsApi(page, { mfa: true, authenticated: false })
    await seedLockIdentity(page)
    await page.goto('/lock')

    await page.getByPlaceholder('Password').fill('correct-horse-battery-9')
    await page.getByRole('button', { name: 'Unlock' }).click()
    await expect(page.getByPlaceholder('Authenticator code')).toBeVisible()
    await expect(page.getByText(/authentication code from your authenticator/i)).toBeVisible()

    await page.getByPlaceholder('Authenticator code').fill('000000')
    await page.getByRole('button', { name: 'Verify and unlock' }).click()
    await expect(page.getByRole('alert')).toContainText('not valid')

    await page.getByRole('button', { name: 'Use a recovery code instead' }).click()
    await expect(page.getByPlaceholder(/Recovery code/)).toBeVisible()
    await expect(page.getByText(/Recovery codes are single-use/i)).toBeVisible()

    await page.getByPlaceholder(/Recovery code/).fill('RECOVERY-1')
    await page.getByRole('button', { name: 'Verify and unlock' }).click()
    await expect(page).toHaveURL(/\/$/)
  })

  test('a fresh tab honours a persisted lock instead of opening the dashboard', async ({ page }) => {
    await mockDeskOsApi(page)
    // Simulate a lock that was set in another tab: a valid token plus the
    // persisted lock flag. The new tab must show the lock screen, not the
    // dashboard, even though the token is still valid.
    await page.addInitScript(() => {
      localStorage.setItem('deskos.locked', '1')
    })
    await page.goto('/')

    await expect(page.getByText('James Adeyemi')).toBeVisible()
    await expect(page.getByPlaceholder('Password')).toBeVisible()
    await expect(page.getByText(/Good (morning|afternoon|evening), James\./)).not.toBeVisible()

    // Unlocking clears the persisted flag and reveals the dashboard.
    await page.getByPlaceholder('Password').fill('correct-horse-battery-9')
    await page.getByRole('button', { name: 'Unlock' }).click()
    await expect(page.getByText(/Good (morning|afternoon|evening), James\./)).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('deskos.locked'))).toBeNull()
  })

  test('keeps the lock screen usable at a narrow viewport', async ({ page }) => {
    await mockDeskOsApi(page, { authenticated: false })
    await seedLockIdentity(page)
    await page.goto('/lock')

    const screen = page.locator('.lock-screen')
    const card = page.locator('.lock-screen-card')
    await expect(screen).toBeVisible()
    await expect(card).toBeVisible()

    const metrics = await page.evaluate(() => ({
      viewport: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
    }))
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.viewport + 1)
  })
})
