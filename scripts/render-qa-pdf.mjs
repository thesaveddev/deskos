// Renders docs/qa-test-plan.html to a PDF using the project's Playwright Chromium.
import { chromium } from '@playwright/test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const htmlPath = join(root, 'docs', 'qa-test-plan.html')
const pdfPath = join(root, 'docs', 'qa-test-plan.pdf')

const browser = await chromium.launch()
const page = await browser.newPage({ deviceScaleFactor: 2 })
await page.goto(`file://${htmlPath.replaceAll('\\', '/')}`)
await page.pdf({
  path: pdfPath,
  format: 'A4',
  printBackground: true,
  margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
})
await browser.close()
console.log(`PDF written: ${pdfPath}`)