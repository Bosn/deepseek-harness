// Real-composition proof: a produced-file chip opens bytes from the isolated
// workspace-file origin, not the headless Host desktop.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SEED = fileURLToPath(
  new URL('../../../snapshots/web/permission-policy-context/session.jsonl', import.meta.url),
)
const MODE = webSnapshotMode()
const SEED_ID = 'workspace-file-open-web-e2e'
const PRODUCED = 'policy-neutral.txt'
const ACTIVE = 'preview.html'

describe('web e2e: opening a produced workspace file', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ workspaceFiles: true })
    await mkdir(join(scaffold.workspaceCwd, 'workspace'), { recursive: true })
    await writeFile(join(scaffold.workspaceCwd, PRODUCED), 'neutral\n')
    await writeFile(join(scaffold.workspaceCwd, ACTIVE), '<h1>produced</h1>\n')
    const raw = await readFile(SEED, 'utf8')
    expect(raw, 'borrowed recording must carry the write this scenario reads').toContain(PRODUCED)
    await seedSession(scaffold, raw, SEED_ID)
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it.skipIf(MODE === 'record')(
    'opens the chip as confined bytes on a distinct origin',
    async () => {
      onTestFailed(() => saveFailureShot(page, 'web-e2e-workspace-file-open'))
      const groupRow = page.locator('[role="treeitem"]').first()
      await groupRow.waitFor({ timeout: 15_000 })
      if (await groupRow.getAttribute('aria-expanded') !== 'true') await groupRow.click()
      const sessionRow = page.locator('[role="treeitem"]').nth(1)
      await sessionRow.waitFor({ timeout: 10_000 })
      await sessionRow.click()

      const chip = page.getByRole('button', { name: `Open ${PRODUCED}`, exact: true }).first()
      await chip.waitFor({ timeout: 15_000 })
      expect(await chip.innerText()).toBe(PRODUCED)

      const [opened] = await Promise.all([
        page.context().waitForEvent('page', { timeout: 15_000 }),
        chip.click(),
      ])
      await opened.waitForLoadState('domcontentloaded')
      const url = new URL(opened.url())
      expect(url.pathname).toBe(`/f/${SEED_ID}/${PRODUCED}`)
      expect(await opened.locator('body').innerText()).toContain('neutral')

      const app = new URL(scaffold.baseUrl)
      expect(url.hostname).toBe(app.hostname)
      expect(url.port).not.toBe(app.port)
      const filesOrigin = url.origin
      const served = await page.request.get(opened.url())
      expect(served.status()).toBe(200)
      expect(served.headers()['x-content-type-options']).toBe('nosniff')
      expect(served.headers()['cache-control']).toBe('no-store')
      expect(served.headers()['content-security-policy']).toBeUndefined()

      await opened.goto(`${filesOrigin}/f/${SEED_ID}/${ACTIVE}`, { waitUntil: 'load' })
      expect(await opened.evaluate(() => {
        try {
          window.localStorage.setItem('probe', '1')
          return 'ok'
        } catch {
          return 'blocked'
        }
      })).toBe('ok')
      expect(await opened.evaluate(async (base) => {
        try {
          await fetch(`${base}/api/session/list`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              type: 'client-request', rpcId: 'x', method: 'session/list', payload: {},
            }),
          })
          return 'reached'
        } catch {
          return 'blocked'
        }
      }, scaffold.baseUrl)).toBe('blocked')

      expect((await page.request.get(`${filesOrigin}/`)).status()).toBe(404)
      expect((await page.request.get(
        `${filesOrigin}/f/${SEED_ID}/..%2Fetc%2Fhosts`,
      )).status()).toBe(404)

      await opened.close()
      expect(tripwire.pageErrors).toEqual([])
      expect(tripwire.warnings).toEqual([])
    },
    90_000,
  )
})
