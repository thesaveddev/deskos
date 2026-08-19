import { expect, test } from '@playwright/test'
import { agentApi, assertStagingConfiguration, pageApi, signIn, skipUnlessStaging, staging } from './staging.js'

const permissions = [
  'view_screen',
  'control_input',
  'clipboard',
  'terminal',
  'elevation',
  'file_transfer',
  'system_manage',
]

test.describe('staging remote-support journey', () => {
  test('completes consent, secure media, control, transfer, terminal, and termination', async ({ page, request }, testInfo) => {
    skipUnlessStaging(testInfo, true)
    assertStagingConfiguration(testInfo, ['email', 'password', 'deviceId', 'agentToken'])

    await signIn(page)
    const created = await pageApi<{ session: { id: string; state: string }; joinToken: string }>(page, '/sessions', {
      method: 'POST',
      body: {
        deviceId: staging.deviceId,
        type: 'attended',
        permissions,
        reason: 'Automated staging remote-support journey',
      },
    })
    const sessionId = created.session.id

    try {
      await page.goto(`/sessions/${sessionId}`)
      await expect(page.getByRole('heading', { name: 'Session state' })).toBeVisible()
      await expect(page.getByText('Waiting for the endpoint')).toBeVisible()

      // The staging endpoint agent is real and authenticated with its device token.
      // This is the endpoint's consent signal, not a browser-boundary mock.
      await agentApi(request, `/agent/sessions/${sessionId}/consent`, { granted: true, permissions })
      await agentApi(request, `/agent/sessions/${sessionId}/state`, { state: 'active' })

      await expect(page.getByText(/Connected|Negotiating secure media/)).toBeVisible({ timeout: 30_000 })
      await expect(page.locator('video')).toBeVisible({ timeout: 30_000 })

      const enableControl = page.getByRole('button', { name: 'Enable input control' })
      await expect(enableControl).toBeVisible()
      await enableControl.click()
      await expect(page.getByRole('button', { name: 'Disable input control' })).toBeVisible()
      await page.locator('.session-stage').focus()
      await page.keyboard.press('a')

      const fileInput = page.locator('.file-upload-label input[type="file"]')
      await expect(fileInput).toBeEnabled({ timeout: 30_000 })
      await fileInput.setInputFiles({
        name: 'deskos-playwright-check.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('DeskOS staging remote-support transfer check\n'),
      })
      await expect(page.getByText(/File uploaded successfully/i)).toBeVisible({ timeout: 30_000 })

      const startTerminal = page.getByRole('button', { name: 'Start terminal' })
      await expect(startTerminal).toBeEnabled({ timeout: 30_000 })
      await startTerminal.click()
      await expect(page.getByText(/Terminal connected|Elevated terminal ready/i)).toBeVisible({ timeout: 30_000 })
      const terminal = page.locator('textarea[placeholder="PowerShell command"]')
      await terminal.fill('echo DESKOS_PLAYWRIGHT_REMOTE_OK')
      await page.getByRole('button', { name: 'Send' }).click()
      await expect(page.locator('.terminal-output')).toContainText('DESKOS_PLAYWRIGHT_REMOTE_OK', { timeout: 30_000 })

      // The technician ends the live session from the browser console.
      await page.getByRole('button', { name: 'End session' }).click()
      await expect(page.getByText('Session ended')).toBeVisible({ timeout: 15_000 })
      const ended = await pageApi<{ session: { state: string } }>(page, `/sessions/${sessionId}`)
      expect(ended.session.state).toBe('ended')
    } finally {
      // Keep the staging device reusable if a browser assertion fails midway.
      await pageApi(page, `/sessions/${sessionId}/end`, { method: 'POST', body: {} }).catch(() => undefined)
    }
  })
})
