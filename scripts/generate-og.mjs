/**
 * Renders apps/web/public/og-reydesk.svg to apps/web/public/og-reydesk.png
 * at 2x (2400x1260).
 *
 * Social crawlers — Open Graph, Twitter/X, Slack, WhatsApp, LinkedIn —
 * ignore SVG images, so the PNG is the one that actually appears when
 * reydesk.com is shared. Run after changing the SVG:
 *
 *   node scripts/generate-og.mjs
 */
import { chromium } from '@playwright/test'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const root = process.cwd()
const svg = path.join(root, 'apps', 'web', 'public', 'og-reydesk.svg')
const png = path.join(root, 'apps', 'web', 'public', 'og-reydesk.png')

const browser = await chromium.launch()
const page = await browser.newPage({
  viewport: { width: 1200, height: 630 },
  deviceScaleFactor: 2,
})
await page.goto(pathToFileURL(svg).href)
await page.screenshot({ path: png })
await browser.close()

console.log(`wrote ${png} (2400x1260)`)
