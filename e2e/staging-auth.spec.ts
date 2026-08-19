import { expect, test } from '@playwright/test'
import { assertStagingConfiguration, pageApi, signIn, staging, skipUnlessStaging, stagingMutationsEnabled, totp, waitForInboxMessage } from './staging.js'

test.describe.configure({ mode: 'serial' })

let activeTotpSecret = staging.totpSecret

test.describe('staging authentication and delivery', () => {
  test('authenticates against the real staging API and loads /me', async ({ page }, testInfo) => {
    skipUnlessStaging(testInfo)
    assertStagingConfiguration(testInfo, ['email', 'password'])

    await signIn(page)
    const me = await pageApi<{ user: { email: string }; memberships: unknown[] }>(page, '/me')
    expect(me.user.email).toBe(staging.email)
    expect(me.memberships.length).toBeGreaterThan(0)
  })

  test('sets up MFA through the real enrollment flow and exposes recovery codes', async ({ page }, testInfo) => {
    skipUnlessStaging(testInfo, true)
    assertStagingConfiguration(testInfo, ['email', 'password'])
    testInfo.skip(!staging.setupMfa, 'Set DESKOS_E2E_SETUP_MFA=true for the disposable staging account MFA setup journey.')

    await signIn(page)
    await page.goto('/settings/security')
    await page.getByRole('button', { name: 'My MFA' }).click()

    const setupButton = page.getByRole('button', { name: 'Set up authenticator MFA' })
    if (await setupButton.isVisible().catch(() => false)) {
      await setupButton.click()
      await expect(page.locator('.mfa-qr')).toBeVisible()
      const secret = (await page.locator('.auth-secret').first().textContent())?.trim()
      if (!secret) throw new Error('MFA setup key was not rendered by staging.')
      activeTotpSecret = secret
      await page.getByPlaceholder('6-digit code').fill(totp(secret))
      await page.getByRole('button', { name: 'Verify and enable' }).click()
      await expect(page.getByText('Save your recovery codes')).toBeVisible()
      await expect(page.locator('.auth-recovery-grid code')).toHaveCount(10)
    } else {
      await expect(page.getByText('MFA is enabled')).toBeVisible()
    }
  })

  test('re-authenticates with the real MFA challenge', async ({ page }, testInfo) => {
    skipUnlessStaging(testInfo)
    assertStagingConfiguration(testInfo, ['email', 'password'])
    testInfo.skip(!activeTotpSecret, 'Set DESKOS_E2E_TOTP_SECRET or run the MFA setup test first.')

    await page.goto('/login')
    await page.getByLabel('Email').fill(staging.email)
    await page.getByLabel('Password').fill(staging.password)
    await page.getByRole('button', { name: 'Sign in' }).click()
    await expect(page.getByLabel('Authenticator or recovery code')).toBeVisible()
    await page.getByLabel('Authenticator or recovery code').fill(totp(activeTotpSecret))
    await page.getByRole('button', { name: 'Verify' }).click()
    await expect(page).toHaveURL(/\/$/)
  })

  test('delivers a real password-reset email through the configured SMTP pipeline', async ({ page }, testInfo) => {
    skipUnlessStaging(testInfo, true)
    assertStagingConfiguration(testInfo, ['email', 'password', 'deliveryAddress', 'inboxApiUrl'])
    testInfo.skip(!stagingMutationsEnabled, 'Staging email delivery is a mutation and requires PLAYWRIGHT_STAGING_MUTATIONS=true.')

    await page.goto('/forgot-password')
    await page.locator('#forgot-email').fill(staging.deliveryAddress)
    await page.getByRole('button', { name: 'Send reset link' }).click()
    await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible()
    await waitForInboxMessage(staging.deliveryAddress, 'password reset')
  })
})
