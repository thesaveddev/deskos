import { expect, test } from '@playwright/test'
import { signIn } from './staging.js'

/**
 * Production verification for the ticket side rail and session audit history.
 *
 * Opt-in only: requires PLAYWRIGHT_TARGET=prod + PLAYWRIGHT_BASE_URL +
 * DESKOS_E2E_EMAIL/DESKOS_E2E_PASSWORD. CI never sets PLAYWRIGHT_TARGET=prod,
 * so this spec is inert in the pipeline.
 *
 * Read-only guarantees: signs in, reads /tickets, opens one ticket, verifies
 * the rail panels render, and optionally reads one session console. Never
 * mutates production data.
 */

const enabled = process.env.PLAYWRIGHT_TARGET === 'prod' && process.env.PLAYWRIGHT_BASE_URL !== undefined

/**
 * Production sign-in. Targets the login form's input roles directly because
 * the PasswordField renders a "Show password" toggle whose aria-label also
 * matches getByLabel('Password'), which the shared staging helper resolves
 * ambiguously.
 */
async function signInProd(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/login')
  await page.locator('input[type="email"]').fill(process.env.DESKOS_E2E_EMAIL ?? '')
  await page.locator('input[type="password"]').fill(process.env.DESKOS_E2E_PASSWORD ?? '')
  await page.getByRole('button', { name: 'Sign in', exact: true }).click()
  // The app holds live sockets open, so networkidle never fires; the redirect
  // off /login is the reliable signed-in signal.
  await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 20_000 })
}

test.skip(!enabled, 'Set PLAYWRIGHT_TARGET=prod and PLAYWRIGHT_BASE_URL to verify production.')

test.describe.configure({ mode: 'serial' })

test('ticket side rail renders with session history on production', async ({ page }) => {
  await signInProd(page)

  // Find a ticket to inspect — newest first, limit 1 keeps the read minimal.
  const tickets = await page.evaluate(async () => {
    const token = localStorage.getItem('reydesk.accessToken')
    const tenant = localStorage.getItem('reydesk.activeTenant')
    const response = await fetch('/api/v1/tickets?limit=1', {
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(tenant ? { 'x-deskos-tenant': tenant } : {}),
      },
    })
    if (!response.ok) throw new Error(`tickets list failed (${response.status})`)
    return (await response.json()) as { tickets: Array<{ id: string; number: number }> }
  })
  expect(tickets.tickets.length, 'production tenant should have at least one ticket').toBeGreaterThan(0)

  const ticket = tickets.tickets[0]
  await page.goto(`/tickets/${ticket.id}`)
  await expect(page).toHaveURL(new RegExp(ticket.id))

  // The side rail exists and holds its core panels.
  await expect(page.locator('.ticket-side-rail')).toBeVisible()
  for (const heading of ['Escalation history', 'Session history', 'SLA', 'Device health']) {
    await expect(
      page.locator('.ticket-side-rail').getByText(heading, { exact: false }).first(),
    ).toBeVisible()
  }

  // Session history panel: each linked session shows its jump link. If the
  // ticket has no linked sessions the panel shows its empty copy instead —
  // both are valid production states, assert whichever renders honestly.
  const sessionPanel = page.locator('.ticket-side-rail').getByText('Session history', { exact: false }).first()
  await expect(sessionPanel).toBeVisible()
  const jumpLinks = page.locator('.ticket-session-jump')
  const emptyNote = page.locator('.ticket-rail-empty')
  if (await jumpLinks.first().isVisible().catch(() => false)) {
    await expect(jumpLinks.first()).toContainText('View console')
  } else {
    await expect(emptyNote.filter({ hasText: /session/i }).first()).toBeVisible()
  }

  // Rail collapse toggle round-trips and persists.
  const collapseToggle = page.locator('.ticket-rail-collapse')
  const expandToggle = page.locator('.ticket-rail-expand')
  if (await collapseToggle.isVisible().catch(() => false)) {
    await collapseToggle.click()
    await expect(page.locator('.ticket-side-rail.collapsed')).toBeVisible()
    await expect(expandToggle).toBeVisible()
    await expandToggle.click()
    await expect(page.locator('.ticket-side-rail.collapsed')).toHaveCount(0)
  }
})

test('session console deep-links back to its ticket on production', async ({ page }) => {
  await signInProd(page)

  // Pick the newest ticket that has a linked session via the rail endpoint.
  const linked = await page.evaluate(async () => {
    const token = localStorage.getItem('reydesk.accessToken')
    const tenant = localStorage.getItem('reydesk.activeTenant')
    const headers = {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(tenant ? { 'x-deskos-tenant': tenant } : {}),
    }
    const list = await (await fetch('/api/v1/tickets?limit=20', { headers })).json()
    for (const ticket of list.tickets ?? []) {
      const sessions = await (await fetch(`/api/v1/tickets/${ticket.id}/sessions`, { headers })).json()
      const first = (sessions.sessions ?? [])[0]
      if (first) return { ticketId: ticket.id, sessionId: first.id, ticketNumber: ticket.number }
    }
    return null
  })

  test.skip(!linked, 'No ticket on this production tenant has a linked session yet.')

  if (linked) {
    await page.goto(`/sessions/${linked.sessionId}`)
    // The console must render (loading may still resolve to ended state).
    await expect(page.locator('.console-breadcrumb')).toBeVisible()
    await expect(page.locator('.console-breadcrumb .console-ticket-link')).toContainText(`Ticket #${linked.ticketNumber}`)
    // Follow it: the deep link must land on the ticket detail page.
    await page.locator('.console-actions .console-ticket-link').click()
    await expect(page).toHaveURL(new RegExp(`/tickets/${linked.ticketId}`))
  }
})
