// An authenticated non-loopback page remains process-local unless the deployment
// also declares that its authority may render Host-backed settings.
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  acknowledgeReloadConnectionLoss, launchWebScaffold, watchConsole, webSnapshotMode,
  WELCOME_NOTICE_COPY,
  type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE } from './support.ts'

const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('web e2e: remote welcome notice', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const calls: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      remoteAuthority: 'remote.localhost',
      welcomeNoticePending: true,
    })
    browser = await chromium.launch()
    page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
      locale: ZH_BROWSER_LOCALE,
    })
    tripwire = watchConsole(page)
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/')) calls.push(url.pathname.slice('/api/'.length))
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('#root', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('advances process-locally and presents the notice again after reload', async () => {
    const welcome = page.getByRole('dialog', { name: WELCOME_NOTICE_COPY.zh.title })
    await welcome.waitFor({ timeout: 15_000 })
    expect(await page.locator('#root').evaluate(root => (root as HTMLElement).inert)).toBe(true)

    await welcome.getByRole('button', { name: WELCOME_NOTICE_COPY.zh.continueLabel }).click()
    await welcome.waitFor({ state: 'detached', timeout: 15_000 })
    await expect.poll(
      () => page.locator('#root').evaluate(root => (root as HTMLElement).inert),
      { timeout: 15_000 },
    ).toBe(false)

    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置' })
    await settings.waitFor({ timeout: 10_000 })
    await settings.getByRole('button', { name: '模型' }).click()
    await settings.getByText(
      '加载提供方目录失败: settings are unavailable in this browser',
      { exact: true },
    ).waitFor({ timeout: 10_000 })
    expect(calls.filter(method => method === 'settings/describe')).toHaveLength(0)

    const reloadWarnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    acknowledgeReloadConnectionLoss(tripwire, reloadWarnings)
    await welcome.waitFor({ timeout: 15_000 })
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})

describe.skipIf(MODE === 'record')('web e2e: privileged remote Models settings', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  const calls: string[] = []

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      remoteAuthority: 'privileged.localhost',
      privilegedHosts: ['privileged.localhost'],
    })
    browser = await chromium.launch()
    page = await browser.newPage({
      viewport: { width: 1440, height: 960 },
      locale: ZH_BROWSER_LOCALE,
    })
    tripwire = watchConsole(page)
    page.on('request', (request) => {
      const url = new URL(request.url())
      if (url.pathname.startsWith('/api/')) calls.push(url.pathname.slice('/api/'.length))
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('loads Host-backed Models settings at the declared authority', async () => {
    expect(await page.evaluate(() => (
      globalThis as typeof globalThis & { __DSH_PRIVILEGED_HOSTS__?: unknown }
    ).__DSH_PRIVILEGED_HOSTS__))
      .toEqual(['privileged.localhost'])
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '模型' }).click()
    await dialog.getByText('填入各提供方的 API 密钥即可使用其模型。').waitFor({ timeout: 10_000 })
    await expect.poll(
      () => calls.filter(method => method === 'settings/describe').length,
      { timeout: 10_000 },
    ).toBeGreaterThan(0)
    const add = dialog.getByRole('button', { name: '添加提供方' })
    await expect.poll(async () => add.isEnabled(), { timeout: 10_000 }).toBe(true)
    expect(await dialog.getByText('加载提供方目录失败', { exact: false }).count()).toBe(0)
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
  }, 60_000)
})
