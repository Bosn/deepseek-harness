/**
 * Private WeChat notices for terminal top-level DSH turns. The plugin reads
 * durable session events, resolves the session title after a quiet period, and
 * sends only the final assistant message's visible text summary.
 * @module @deepseek-ai/dsh-turn-notify-wechat
 */

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Session, SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
// Type-only: applies the ctx.sessionTitle service declaration to this package face.
import type {} from '@deepseek-ai/dsh-session-title'
import { DeliveryOutbox, type DeliveryRecord } from './outbox.ts'

/** Cordis plugin name. */
export const name = 'turn-notify-wechat'

/** Durable sessions and their title projection are the observed completion sources. */
export const inject = ['sessions', 'sessionTitle']

const DEFAULT_CHANNEL = 'openclaw-weixin'
const DEFAULT_ACCOUNT_KEY = 'WEIXIN_ACCOUNT_ID'
const DEFAULT_TARGET_KEY = 'WEIXIN_BOSN_TARGET'
const DEFAULT_TIMEOUT_MS = 45_000
const DEFAULT_TITLE_MAX_CHARS = 80
const DEFAULT_SUMMARY_MAX_CHARS = 100
const DEFAULT_MESSAGE_MAX_BYTES = 8 * 1024
const DEFAULT_SETTLE_DELAY_MS = 5_000
const DEFAULT_MAX_CONCURRENT_DELIVERIES = 2
const DEFAULT_MAX_RETAINED_DELIVERIES = 64
const MAX_CONFIGURED_MESSAGE_BYTES = 16 * 1024
const MAX_CONFIGURED_RETAINED_DELIVERIES = 256
const MAX_TIMER_DELAY_MS = 2_147_483_647
const MAX_RECEIPT_BYTES = 64 * 1024
const PROCESS_ARGUMENT_PATTERN = /^[^\0]+$/u
const CHARACTER_SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

/** Deployment route, presentation bounds, and sender configuration. */
export interface Config {
  /** Absolute owner wrapper or OpenClaw CLI path. */
  command: string
  /** Owner-only constants file containing the configured account and target. */
  routeFile: string
  /** Absolute private outbox file; never shared between host processes. */
  outboxFile: string
  /** Initial exponential retry delay for a definite provider rejection. */
  retryDelayMs?: number
  /** Total sends per notice, including the first attempt. */
  maxAttempts?: number
  /** Constants-file key holding the WeChat account id. */
  accountKey?: string
  /** Constants-file key holding the private owner target. */
  targetKey?: string
  /** Non-empty NUL-free OpenClaw channel name. */
  channel?: string
  /** Maximum wall time for one delivery subprocess. */
  timeoutMs?: number
  /** Maximum Unicode characters retained from the resolved session title. */
  titleMaxChars?: number
  /** Maximum Unicode characters retained from the final assistant message. */
  summaryMaxChars?: number
  /** Maximum UTF-8 bytes retained from the assembled channel message. */
  messageMaxBytes?: number
  /** Quiet time before title resolution and delivery; a newer turn replaces the pending notice. */
  settleDelayMs?: number
  /** Maximum number of notification subprocesses allowed to run at once. */
  maxConcurrentDeliveries?: number
  /** Maximum number of pending and queued deliveries retained across sessions. */
  maxRetainedDeliveries?: number
}

/** Schemastery validation and supported deployment defaults. */
export const Config: z<Config> = z.object({
  command: z.string().required(),
  routeFile: z.string().required(),
  outboxFile: z.string().required(),
  retryDelayMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  maxAttempts: z.number().step(1).min(1).max(10).default(5),
  accountKey: z.string().default(DEFAULT_ACCOUNT_KEY),
  targetKey: z.string().default(DEFAULT_TARGET_KEY),
  channel: z.string().pattern(PROCESS_ARGUMENT_PATTERN).default(DEFAULT_CHANNEL),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_TIMEOUT_MS),
  titleMaxChars: z.number().step(1).min(1).default(DEFAULT_TITLE_MAX_CHARS),
  summaryMaxChars: z.number().step(1).min(1).default(DEFAULT_SUMMARY_MAX_CHARS),
  messageMaxBytes: z.number().step(1).min(256).max(MAX_CONFIGURED_MESSAGE_BYTES).default(DEFAULT_MESSAGE_MAX_BYTES),
  settleDelayMs: z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS).default(DEFAULT_SETTLE_DELAY_MS),
  maxConcurrentDeliveries: z.number().step(1).min(1).default(DEFAULT_MAX_CONCURRENT_DELIVERIES),
  maxRetainedDeliveries: z.number().step(1).min(1).max(MAX_CONFIGURED_RETAINED_DELIVERIES).default(DEFAULT_MAX_RETAINED_DELIVERIES),
})

type TurnEndEvent = Extract<SessionEvent, { type: 'turn/end' }>

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
  failed: boolean
}

interface PendingCompletion {
  session: Session
  terminal: TurnEndEvent
  summary: string
  timer: ReturnType<typeof setTimeout>
  record: DeliveryRecord
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
    throw new Error(`turn-notify-wechat: route key ${JSON.stringify(key)} is missing or empty`)
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0)
    if (codePoint !== undefined && codePoint < 0x20) {
      throw new Error(`turn-notify-wechat: route key ${JSON.stringify(key)} contains a control character`)
    }
  }
  return value
}

function loadRoute(config: Required<Config>): WeChatRoute {
  let text: string
  try {
    text = readFileSync(config.routeFile, 'utf8')
  } catch {
    throw new Error('turn-notify-wechat: route file is unavailable')
  }
  const values = parseConstants(text)
  return {
    account: requireRouteValue(values, config.accountKey),
    target: requireRouteValue(values, config.targetKey),
  }
}

function characterLength(value: string): number {
  return Array.from(CHARACTER_SEGMENTER.segment(value)).length
}

function ellipsize(value: string, limit: number): string {
  const characters = Array.from(CHARACTER_SEGMENTER.segment(value), part => part.segment)
  if (characters.length <= limit) return value
  if (limit === 1) return '…'
  const prefix = characters.slice(0, limit - 1).join('').replace(/[；，。\s]+$/u, '')
  return `${prefix}…`
}

function ellipsizeUtf8(value: string, limit: number): string {
  if (Buffer.byteLength(value, 'utf8') <= limit) return value
  const budget = limit - Buffer.byteLength('…', 'utf8')
  let used = 0
  let prefix = ''
  for (const { segment } of CHARACTER_SEGMENTER.segment(value)) {
    const bytes = Buffer.byteLength(segment, 'utf8')
    if (used + bytes > budget) break
    prefix += segment
    used += bytes
  }
  prefix = prefix.replace(/[；，。 \t]+$/u, '')
  return `${prefix}…`
}

function normalizeTaskTitle(value: string, limit: number): string {
  const normalized = value.replace(/\0/gu, '').replace(/\s+/gu, ' ').trim().replace(/[:：]+$/u, '').trim()
  return ellipsize(normalized, limit)
}

function summarizeMessage(message: string, limit: number): string {
  const cleaned = message
    .replace(/\0/gu, '')
    .replace(/!\[([^\]]*)\]\([^)]+\)/gu, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, '$1')
    .replace(/[#>*`]+/gu, '')
    .replace(/(?<![\p{L}\p{N}])_+|_+(?![\p{L}\p{N}])/gu, '')
  const lines: string[] = []
  for (const rawLine of cleaned.split(/\r?\n/u)) {
    const line = rawLine
      .replace(/^\s*(?:[-+•]|\d+[.)])\s*/u, '')
      .trim()
      .replace(/\s+/gu, ' ')
    if (line.length > 0) lines.push(line)
  }
  const compact = lines.join('；')
  if (characterLength(compact) <= limit) return compact

  const outcomeWords = [
    '结论', '已完成', '完成', '已修复', '修复', '成功', '失败',
    '阻塞', '原因', '上线', '未修改', '未完成', '跳过',
  ]
  const ranked = lines
    .map((line, index) => ({ line, index }))
    .sort((left, right) => {
      const leftRank = outcomeWords.some(word => left.line.includes(word)) ? 0 : 1
      const rightRank = outcomeWords.some(word => right.line.includes(word)) ? 0 : 1
      return leftRank - rightRank || left.index - right.index
    })
  const selected: string[] = []
  for (const { line } of ranked) {
    const candidate = [...selected, line].join('；')
    if (characterLength(candidate) <= limit) {
      selected.push(line)
    } else if (selected.length === 0) {
      const sentenceEnd = line.search(/[。！？!?]/u)
      const sentence = sentenceEnd < 0 ? line : line.slice(0, sentenceEnd + 1)
      selected.push(ellipsize(sentence, limit))
    }
    if (characterLength(selected.join('；')) >= limit - 12) break
  }
  return ellipsize(selected.join('；'), limit)
}

function visibleAssistantText(session: Session, turn: number): string | undefined {
  const assistant = session.snapshotEvents().findLast(event =>
    event.type === 'assistant/message' && event.data.turn === turn)
  if (assistant?.type !== 'assistant/message') return undefined
  const text: string[] = []
  for (const block of assistant.data.message.content) {
    if (block.type === 'text') text.push(block.text)
  }
  const joined = text.join('\n')
  return joined.trim().length > 0 ? joined : undefined
}

function terminalLabel(reason: TurnEndReason): string {
  switch (reason.kind) {
    case 'completed': return '完成'
    case 'aborted': return '已取消'
    case 'error': return '失败'
    case 'max-tokens': return '输出截断'
    case 'blocked': return '已阻止'
    case 'interrupted': return '已中断'
    default: return '结束'
  }
}

function completionMessage(
  title: string,
  summary: string,
  reason: TurnEndReason,
  maxBytes: number,
): string {
  return ellipsizeUtf8(`DSH任务 [${terminalLabel(reason)}]：${title}\n${summary}`, maxBytes)
}

function idempotencyKey(session: Session, terminal: TurnEndEvent): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      String(session.id),
      terminal.data.turn,
      terminal.seq,
      terminal.time,
      terminal.data.reason.kind,
    ]))
    .digest('hex')
  return `dsh-turn-wechat/v1/${digest}`
}

function inspectReceipt(value: unknown, facts: ReceiptFacts): void {
  if (Array.isArray(value)) {
    for (const child of value) inspectReceipt(child, facts)
    return
  }
  if (typeof value !== 'object' || value === null) return
  const record = value as Record<string, unknown>
  if (record.ok === false || (record.error !== undefined && record.error !== null)) facts.failed = true
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

function parseReceipt(stdout: string, channel: string): string {
  let value: unknown
  try {
    value = JSON.parse(stdout)
  } catch {
    throw new Error('turn-notify-wechat: delivery returned invalid JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('turn-notify-wechat: delivery returned an invalid receipt')
  }
  const facts: ReceiptFacts = {
    channels: new Set(),
    statuses: new Set(),
    messageIds: [],
    ok: false,
    dryRun: false,
    failed: false,
  }
  inspectReceipt(value, facts)
  if (facts.dryRun) throw new Error('turn-notify-wechat: delivery returned a dry-run receipt')
  if (facts.channels.size !== 1 || !facts.channels.has(channel)) {
    throw new Error('turn-notify-wechat: delivery returned a different channel')
  }
  const action = (value as Record<string, unknown>).action
  const sent = action === 'send'
    || facts.statuses.has('sent')
    || facts.statuses.has('delivered')
    || facts.ok
  if (!sent || facts.failed || [...facts.statuses].some(status => ['failed', 'unknown', 'queued', 'pending', 'error'].includes(status)) || facts.messageIds.length === 0) {
    throw new Error('turn-notify-wechat: delivery returned no verifiable sent receipt')
  }
  return facts.messageIds[0] as string
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
  delivery: DeliveryRecord,
  signal: AbortSignal,
): Promise<string> {
  const args = [
    'message', 'send',
    '--channel', config.channel,
    '--account', route.account,
    '--target', route.target,
    '--message', delivery.message,
    '--idempotency-key', delivery.key,
    '--json',
  ]
  return new Promise((resolve, reject) => {
    try {
      execFile(config.command, args, {
        encoding: 'utf8',
        env: scrubbedEnvironment(),
        maxBuffer: MAX_RECEIPT_BYTES,
        signal,
        timeout: config.timeoutMs,
        windowsHide: true,
      }, (error, stdout) => {
        const reason = error?.killed === true ? 'timeout' : (error?.name ?? 'structured error')
        const failure = deliveryFailure(stdout, reason)
        if (error !== null || failure.structured === true) {
          reject(failure)
          return
        }
        try {
          resolve(parseReceipt(stdout, config.channel))
        } catch (receiptError: unknown) {
          reject(new Error(String(receiptError).replace(/^Error: /u, '')))
        }
      })
    } catch {
      reject(new Error('turn-notify-wechat: delivery command failed (spawn validation)'))
    }
  })
}

interface DeliveryFailure extends Error {
  retryable?: boolean
  structured?: boolean
  code?: string
  unknownAfterSend?: boolean
}

function deliveryFailure(stdout: string, reason: string): DeliveryFailure {
  const failure: DeliveryFailure = new Error(`turn-notify-wechat: delivery command failed (${reason})`)
  failure.code = 'command_failure'
  failure.unknownAfterSend = true
  try {
    const result: unknown = JSON.parse(stdout)
    if (typeof result !== 'object' || result === null) return failure
    const value = (result as Record<string, unknown>).error
    if (typeof value !== 'object' || value === null) return failure
    const detail = value as Record<string, unknown>
    if (typeof detail.code !== 'string' || !/^[a-z_]{1,64}$/u.test(detail.code)
      || typeof detail.unknownAfterSend !== 'boolean') return failure
    failure.structured = true
    failure.code = detail.code
    failure.unknownAfterSend = detail.unknownAfterSend
    failure.retryable = ['provider_rejected', 'connection_failed', 'fetch_unavailable', 'send_in_progress'].includes(detail.code) && detail.unknownAfterSend === false
  } catch { /* Non-JSON process output cannot prove that no message was sent. */ }
  return failure
}

/**
 * Persist observed top-level completions and recover only this outbox on restart.
 * Definite provider rejections retry within the configured bound; uncertain sends stop.
 * @param ctx - Sessions, titles and host lifecycle.
 * @param config - Validated private delivery route, outbox and timing bounds.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as Required<Config>
  if (!isAbsolute(resolved.command)) throw new Error('turn-notify-wechat: command must be an absolute path')
  if (!isAbsolute(resolved.outboxFile)) throw new Error('turn-notify-wechat: outboxFile must be an absolute path')
  const route = loadRoute(resolved)
  const routeHash = createHash('sha256').update(JSON.stringify([resolved.channel, route.account, route.target])).digest('hex')
  const outbox = new DeliveryOutbox(resolved.outboxFile, routeHash)
  const abortController = new AbortController()
  const inFlight = new Set<Promise<void>>()
  const pendingBySession = new Map<Session, PendingCompletion>()
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  let activeDeliveries = 0
  let nextRetentionOrder = Math.max(0, ...outbox.records.map(record => record.retainedAt))
  let closing = false
  let storageFailed = false

  const save = (): boolean => {
    try { outbox.save(); return true } catch {
      storageFailed = true
      ctx.logger.warn('turn-notify-wechat: outbox persistence failed; delivery stopped')
      return false
    }
  }

  const clearPending = (session: Session): void => {
    const previous = pendingBySession.get(session)
    if (previous !== undefined) clearTimeout(previous.timer)
    pendingBySession.delete(session)
  }

  const retained = (): DeliveryRecord[] => outbox.records.filter(record =>
    record.state === 'pending' || record.state === 'queued' || record.state === 'retry')

  const pumpDeliveries = (): void => {
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    retryTimer = undefined
    if (closing || storageFailed) return
    while (activeDeliveries < resolved.maxConcurrentDeliveries) {
      const delivery = outbox.records.find(record =>
        (record.state === 'queued' || record.state === 'retry') && record.nextAttemptAt <= Date.now())
      if (delivery === undefined) break
      delivery.state = 'sending'
      delivery.attempts += 1
      if (!save()) return
      activeDeliveries += 1
      const operation = sendCompletion(resolved, route, delivery, abortController.signal)
        .then((messageId) => { delivery.state = 'sent'; delivery.messageId = messageId; delete delivery.code; save() })
        .catch((error: unknown) => {
          const failure = error as DeliveryFailure
          delivery.code = failure.code ?? 'invalid_receipt'
          if (failure.retryable === true && delivery.attempts < resolved.maxAttempts) {
            delivery.state = 'retry'
            delivery.nextAttemptAt = Date.now() + Math.min(MAX_TIMER_DELAY_MS, resolved.retryDelayMs * 2 ** (delivery.attempts - 1))
          } else {
            delivery.state = failure.unknownAfterSend === false ? 'failed' : 'unknown'
          }
          save()
          if (!closing) ctx.logger.warn(`turn-notify-wechat: notification failed for session ${delivery.sessionId} turn ${delivery.turn} (${String(error)}; code=${delivery.code}; state=${delivery.state})`)
        }).finally(() => {
          activeDeliveries -= 1
          inFlight.delete(operation)
          pumpDeliveries()
        })
      inFlight.add(operation)
    }
    const waiting = outbox.records.filter(record => record.state === 'queued' || record.state === 'retry')
    if (waiting.length > 0 && activeDeliveries < resolved.maxConcurrentDeliveries) {
      const delay = Math.max(0, Math.min(MAX_TIMER_DELAY_MS, Math.min(...waiting.map(record => record.nextAttemptAt)) - Date.now()))
      retryTimer = setTimeout(pumpDeliveries, delay)
    }
  }

  const dispatch = (pending: PendingCompletion): void => {
    if (closing || pendingBySession.get(pending.session) !== pending) return
    pendingBySession.delete(pending.session)
    const rawTitle = ctx.sessionTitle.get(pending.session)?.title
    const title = rawTitle === undefined ? '' : normalizeTaskTitle(rawTitle, resolved.titleMaxChars)
    if (title.length === 0) {
      pending.record.state = 'failed'
      pending.record.code = 'title_unavailable'
      save()
      ctx.logger.warn(`turn-notify-wechat: notification skipped for session ${pending.session.id} turn ${pending.terminal.data.turn} (session title ${rawTitle === undefined ? 'unavailable' : 'empty'})`)
      return
    }
    pending.record.message = completionMessage(title, pending.summary, pending.terminal.data.reason, resolved.messageMaxBytes)
    pending.record.state = 'queued'
    pending.record.nextAttemptAt = Date.now()
    if (save()) pumpDeliveries()
  }

  const detach = ctx.on('session/event', (session, event) => {
    if (closing || storageFailed || event.type !== 'turn/end' || session.header.origin === 'subagent') return
    const key = idempotencyKey(session, event)
    if (outbox.records.some(record => record.key === key)) return
    clearPending(session)
    for (const record of retained()) {
      if (record.sessionId === String(session.id)) { record.state = 'failed'; record.code = 'superseded' }
    }
    const source = visibleAssistantText(session, event.data.turn)
    if (source === undefined) { save(); return }
    const summary = summarizeMessage(source, resolved.summaryMaxChars)
    if (summary.length === 0) { save(); return }
    const retainedRecords = retained()
    if (retainedRecords.length >= resolved.maxRetainedDeliveries) {
      const oldest = retainedRecords.sort((a, b) => a.retainedAt - b.retainedAt)[0]
      if (oldest !== undefined) {
        const kind = oldest.state === 'pending' ? 'pending' : 'queued'
        for (const [pendingSession, pending] of pendingBySession) {
          if (pending.record === oldest) clearPending(pendingSession)
        }
        oldest.state = 'failed'; oldest.code = 'retention_limit'
        ctx.logger.warn(`turn-notify-wechat: retained delivery limit reached; dropped oldest ${kind} notification for session ${oldest.sessionId} turn ${oldest.turn}`)
      }
    }
    nextRetentionOrder += 1
    const rawTitle = ctx.sessionTitle.get(session)?.title
    const title = rawTitle === undefined ? '' : normalizeTaskTitle(rawTitle, resolved.titleMaxChars)
    const record: DeliveryRecord = {
      key, sessionId: String(session.id), turn: event.data.turn,
      message: title.length === 0 ? '' : completionMessage(title, summary, event.data.reason, resolved.messageMaxBytes),
      state: 'pending', attempts: 0, nextAttemptAt: Date.now() + resolved.settleDelayMs, retainedAt: nextRetentionOrder,
    }
    outbox.records.push(record)
    if (!save()) return
    const pending: PendingCompletion = {
      session, terminal: event, summary, record,
      timer: setTimeout(() => { dispatch(pending) }, resolved.settleDelayMs),
    }
    pendingBySession.set(session, pending)
  })

  ctx.effect(() => async () => {
    closing = true
    detach()
    if (retryTimer !== undefined) clearTimeout(retryTimer)
    for (const pending of pendingBySession.values()) clearTimeout(pending.timer)
    pendingBySession.clear()
    abortController.abort()
    await Promise.allSettled([...inFlight])
    outbox.close()
  }, 'turn-notify-wechat teardown')
  pumpDeliveries()
}
