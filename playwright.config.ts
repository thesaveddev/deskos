import { defineConfig, devices } from '@playwright/test'

const externalBaseUrl = process.env.PLAYWRIGHT_BASE_URL
const stagingTarget = process.env.PLAYWRIGHT_TARGET === 'staging'

export default defineConfig({
  testDir: './e2e',
  outputDir: './artifacts/playwright/test-results',
  // Staging journeys share one disposable account and endpoint; keep them
  // serialized so MFA setup and remote-session cleanup cannot race each other.
  fullyParallel: !stagingTarget,
  ...(stagingTarget ? { workers: 1 } : {}),
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { outputFolder: 'artifacts/playwright/report', open: 'never' }], ['line']] : 'list',
  use: {
    baseURL: externalBaseUrl ?? 'http://127.0.0.1:5181',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop',
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'mobile',
      // Use Chromium for both projects so CI only needs one browser binary.
      // The device profile still exercises a narrow, touch-oriented viewport.
      use: { ...devices['Pixel 5'] },
    },
  ],
  ...(externalBaseUrl ? {} : {
    webServer: {
      command: 'npm run build --workspace @deskos/web && npm run preview --workspace @deskos/web -- --host 127.0.0.1 --port 5181',
      url: 'http://127.0.0.1:5181',
      reuseExistingServer: false,
      timeout: 120_000,
    },
  }),
})
