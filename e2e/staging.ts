import { createHmac } from 'node:crypto'
import { expect, type APIRequestContext, type Page, type TestInfo } from '@playwright/test'

export const stagingEnabled = process.env.PLAYWRIGHT_TARGET === 'staging' && process.env.PLAYWRIGHT_BASE_URL !== undefined
export const stagingMutationsEnabled = stagingEnabled && process.env.PLAYWRIGHT_STAGING_MUTATIONS === 'true'

export const staging = {
  email: process.env.DESKOS_E2E_EMAIL ?? '',
  password: process.env.DESKOS_E2E_PASSWORD ?? '',
  deviceId: process.env.DESKOS_E2E_DEVICE_ID ?? '',
  agentToken: process.env.DESKOS_E2E_AGENT_TOKEN ?? '',
  deliveryAddress: process.env.DESKOS_E2E_DELIVERY_ADDRESS ?? '',
  totpSecret: process.env.DESKOS_E2E_TOTP_SECRET ?? '',
  inboxApiUrl: process.env.DESKOS_E2E_INBOX_API_URL ?? '',
  inboxToken: process.env.DESKOS_E2E_INBOX_TOKEN ?? '',
  setupMfa: process.env.DESKOS_E2E_SETUP_MFA === 'true',
}

export function skipUnlessStaging(testInfo: TestInfo, needsMutation = false): void {
  testInfo.skip(!stagingEnabled, 'Set PLAYWRIGHT_TARGET=staging and PLAYWRIGHT_BASE_URL to run staging tests.')
  testInfo.skip(testInfo.project.name !== 'desktop', 'Staging mutation journeys run once in the desktop project.')
  if (needsMutation) {
    testInfo.skip(!stagingMutationsEnabled, 'Set PLAYWRIGHT_STAGING_MUTATIONS=true for staging mutations.')
  }
}

export function assertStagingConfiguration(testInfo: TestInfo, fields: Array<keyof typeof staging>): void {
  const missing = fields.filter((field) => !staging[field])
  testInfo.skip(missing.length > 0, `Missing staging E2E configuration: ${missing.join(', ')}`)
}

export async function signIn(page: Page): Promise<void> {
  await page.goto('/login')
  await page.getByLabel('Email').fill(staging.email)
  await page.getByLabel('Password').fill(staging.password)
  await page.getByRole('button', { name: 'Sign in' }).click()

  const mfaField = page.getByLabel('Authenticator or recovery code')
  if (await mfaField.isVisible().catch(() => false)) {
    if (!staging.totpSecret) throw new Error('Staging account requires MFA but DESKOS_E2E_TOTP_SECRET is not configured.')
    await mfaField.fill(totp(staging.totpSecret))
    await page.getByRole('button', { name: 'Verify' }).click()
  }
  await expect(page).toHaveURL(/\/$/)
}

export async function pageApi<T>(page: Page, path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  return page.evaluate(async ({ path, method, body }) => {
    const token = localStorage.getItem('reydesk.accessToken')
    const tenant = localStorage.getItem('reydesk.activeTenant')
    const response = await fetch(`/api/v1${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(tenant ? { 'x-deskos-tenant': tenant } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const text = await response.text()
    const payload = text ? JSON.parse(text) : null
    if (!response.ok) throw new Error(`${method ?? 'GET'} ${path} failed (${response.status}): ${payload?.error?.message ?? text}`)
    return payload as T
  }, { path, method: options.method ?? 'GET', body: options.body })
}

export async function agentApi<T>(request: APIRequestContext, path: string, body: unknown, expectedStatus = 200): Promise<T> {
  const response = await request.post(`${process.env.PLAYWRIGHT_BASE_URL}/api/v1${path}`, {
    headers: { authorization: `Bearer ${staging.agentToken}` },
    data: body,
  })
  const payload = await response.json()
  expect(response.status(), `${path} response`).toBe(expectedStatus)
  return payload as T
}

export function totp(secret: string, timestamp = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const normalized = secret.replace(/[^A-Z2-7]/gi, '').toUpperCase()
  let bits = ''
  for (const character of normalized) {
    const value = alphabet.indexOf(character)
    if (value < 0) throw new Error('Invalid base32 TOTP secret')
    bits += value.toString(2).padStart(5, '0')
  }
  const bytes = Buffer.alloc(Math.floor(bits.length / 8))
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2)
  }
  const counter = Math.floor(timestamp / 1000 / 30)
  const message = Buffer.alloc(8)
  message.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', bytes).update(message).digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary = ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff)
  return String(binary % 1_000_000).padStart(6, '0')
}

export async function waitForInboxMessage(recipient: string, subjectFragment: string, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch(`${staging.inboxApiUrl.replace(/\/$/, '')}/api/v1/search?query=${encodeURIComponent(`to:${recipient}`)}`, {
      headers: staging.inboxToken ? { authorization: `Bearer ${staging.inboxToken}` } : {},
    })
    if (response.ok) {
      const payload = await response.json() as { messages?: Array<{ Subject?: string; subject?: string }> }
      const found = payload.messages?.some((message) => (message.Subject ?? message.subject ?? '').toLowerCase().includes(subjectFragment.toLowerCase()))
      if (found) return
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
  throw new Error(`No inbox message containing “${subjectFragment}” arrived for ${recipient}`)
}
