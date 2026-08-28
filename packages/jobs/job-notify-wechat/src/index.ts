/**
 * Host-level WeChat completion notices for `ctx.jobs`. The plugin observes the
 * process-wide job registry once, sends only bounded lifecycle metadata, and
 * never changes job settlement or in-session reporting.
 * @module @deepseek-ai/dsh-job-notify-wechat
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'

/** Cordis plugin name. */
export const name = 'job-notify-wechat'

/** The process-wide job registry is the sole observed lifecycle source. */
export const inject = ['jobs']

const DEFAULT_CHANNEL = 'openclaw-weixin'
const DEFAULT_ACCOUNT_KEY = 'WEIXIN_ACCOUNT_ID'
const DEFAULT_TARGET_KEY = 'WEIXIN_BOSN_TARGET'
const DEFAULT_TIMEOUT_MS = 45_000
const MAX_RECEIPT_BYTES = 64 * 1024

/** Deployment route and bounded sender configuration. */
export interface Config {
  /** Absolute owner wrapper or OpenClaw CLI path. */
  command: string
  /** Owner-only constants file containing the configured account and target. */
  routeFile: string
  /** Constants-file key holding the WeChat account id. */
  accountKey?: string
  /** Constants-file key holding the private owner target. */
  targetKey?: string
  /** OpenClaw channel name. */
  channel?: string
  /** Maximum wall time for one delivery subprocess. */
  timeoutMs?: number
}

/** Schemastery validation and supported deployment defaults. */
export const Config: z<Config> = z.object({
  command: z.string().required(),
  routeFile: z.string().required(),
  accountKey: z.string().default(DEFAULT_ACCOUNT_KEY),
  targetKey: z.string().default(DEFAULT_TARGET_KEY),
  channel: z.string().default(DEFAULT_CHANNEL),
  timeoutMs: z.number().step(1).min(1).default(DEFAULT_TIMEOUT_MS),
})

interface WeChatRoute {
  account: string
  target: string
}

interface ReceiptFacts {
  channels: Set<string>
  statuses: Set<string>
  messageIds: string[]
  ok: boolean
  dryRun: boolean
}

function parseConstants(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const rawLine of text.split(/\r?\n/u)) {
    let line = rawLine.trim()
    if (line.length === 0 || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice('export '.length).trimStart()
    const separator = line.indexOf('=')
    if (separator < 1) continue
    const key = line.slice(0, separator).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) continue
    let value = line.slice(separator + 1).trim()
    if (value.length >= 2 && (value[0] === "'" || value[0] === '"') && value.at(-1) === value[0]) {
      value = value.slice(1, -1)
    }
    values.set(key, value)
  }
  return values
}

function requireRouteValue(values: Map<string, string>, key: string): string {
  const value = values.get(key)?.trim()
  if (value === undefined || value.length === 0) {
    throw new Error(`job-notify-wechat: route key ${JSON.stringify(key)} is missing or empty`)
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && codePoint < 0x20) {
      throw new Error(`job-notify-wechat: route key ${JSON.stringify(key)} contains a control character`)
    }
  }
  return value
}

function loadRoute(config: Required<Config>): WeChatRoute {
  let text: string
  try {
    text = readFileSync(config.routeFile, 'utf8')
  } catch {
    throw new Error('job-notify-wechat: route file is unavailable')
  }
  const values = parseConstants(text)
  return {
    account: requireRouteValue(values, config.accountKey),
    target: requireRouteValue(values, config.targetKey),
  }
}

function terminalLabel(status: JobSnapshot['status']): string {
  switch (status) {
    case 'completed': return '完成'
    case 'killed': return '已取消'
    case 'failed': return '失败'
    case 'running':
    case 'stopping':
      throw new Error(`job-notify-wechat: non-terminal job status ${status}`)
  }
}

function completionMessage(snapshot: JobSnapshot): string {
  return `DSH任务 [${terminalLabel(snapshot.status)}]：${snapshot.id}（${snapshot.kind}）`
}

function idempotencyKey(snapshot: JobSnapshot, ownerId: string | undefined): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      ownerId ?? null,
      snapshot.id,
      snapshot.kind,
      snapshot.startedAt,
      snapshot.finishedAt ?? null,
      snapshot.status,
    ]))
    .digest('hex')
  return `dsh-job-wechat/v1/${digest}`
}

function inspectReceipt(value: unknown, facts: ReceiptFacts): void {
  if (Array.isArray(value)) {
    for (const child of value) inspectReceipt(child, facts)
    return
  }
  if (typeof value !== 'object' || value === null) return
  const record = value as Record<string, unknown>
  if (record.dryRun === true) facts.dryRun = true
  if (record.ok === true) facts.ok = true
  const channel = record.channel
  if (typeof channel === 'string' && channel.length > 0) facts.channels.add(channel)
  for (const key of ['deliveryStatus', 'delivery_status', 'status']) {
    const status = record[key]
    if (typeof status === 'string' && status.length > 0) facts.statuses.add(status)
  }
  for (const key of ['messageId', 'message_id']) {
    const messageId = record[key]
    if ((typeof messageId === 'string' || typeof messageId === 'number')
      && String(messageId).trim().length > 0) {
      facts.messageIds.push(String(messageId).trim())
    }
  }
  for (const child of Object.values(record)) inspectReceipt(child, facts)
}

function parseReceipt(stdout: string, channel: string): void {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new Error('job-notify-wechat: delivery returned invalid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('job-notify-wechat: delivery returned an invalid receipt')
  }
  const facts: ReceiptFacts = {
    channels: new Set(),
    statuses: new Set(),
    messageIds: [],
    ok: false,
    dryRun: false,
  }
  inspectReceipt(value, facts)
  if (facts.dryRun) throw new Error('job-notify-wechat: delivery returned a dry-run receipt')
  if (facts.channels.size !== 1 || !facts.channels.has(channel)) {
    throw new Error('job-notify-wechat: delivery returned a different channel')
  }
  const action = (value as Record<string, unknown>).action
  const sent = action === 'send'
    || facts.statuses.has('sent')
    || facts.statuses.has('delivered')
    || facts.ok
  if (!sent || facts.messageIds.length === 0) {
    throw new Error('job-notify-wechat: delivery returned no verifiable sent receipt')
  }
}

function scrubbedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { LANG: 'C.UTF-8' }
  for (const key of [
    'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR',
    'XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS',
  ]) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function sendCompletion(
  config: Required<Config>,
  route: WeChatRoute,
  snapshot: JobSnapshot,
  ownerId: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  const args = [
    'message', 'send',
    '--channel', config.channel,
    '--account', route.account,
    '--target', route.target,
    '--message', completionMessage(snapshot),
    '--idempotency-key', idempotencyKey(snapshot, ownerId),
    '--json',
  ]
  return new Promise((resolve, reject) => {
    execFile(config.command, args, {
      encoding: 'utf8',
      env: scrubbedEnvironment(),
      maxBuffer: MAX_RECEIPT_BYTES,
      signal,
      timeout: config.timeoutMs,
      windowsHide: true,
    }, (error, stdout) => {
      if (error !== null) {
        const reason = error.killed ? 'timeout' : error.name
        reject(new Error(`job-notify-wechat: delivery command failed (${reason})`))
        return
      }
      try {
        parseReceipt(stdout, config.channel)
        resolve()
      } catch (receiptError: unknown) {
        reject(new Error(String(receiptError).replace(/^Error: /u, '')))
      }
    })
  })
}

/**
 * Observe every terminal host job once and send a private WeChat notice. The
 * listener contains sender failures and teardown aborts before they can affect
 * the registry's committed terminal state.
 * @param ctx - unscoped host context carrying the process-wide job registry.
 * @param config - validated sender and route-file configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as Required<Config>
  const route = loadRoute(resolved)
  const abortController = new AbortController()
  const inFlight = new Set<Promise<void>>()
  let closing = false

  const detach = ctx.jobs.onJobDone((snapshot, owner) => {
    if (closing) return
    const operation = sendCompletion(
      resolved,
      route,
      snapshot,
      owner === undefined ? undefined : String(owner.id),
      abortController.signal,
    ).catch((error: unknown) => {
      if (closing) return
      const reason = String(error)
      ctx.logger.warn(`job-notify-wechat: notification failed for ${snapshot.id} (${reason})`)
    })
    inFlight.add(operation)
    void operation.finally(() => { inFlight.delete(operation) })
    return operation
  })

  ctx.effect(() => async () => {
    closing = true
    detach()
    abortController.abort()
    await Promise.allSettled([...inFlight])
  }, 'job-notify-wechat teardown')
}
