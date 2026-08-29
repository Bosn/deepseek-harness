import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { CallId, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import {
  Session,
  SessionId,
  SESSION_FORMAT_VERSION,
  type SessionEvent,
  type TurnEndReason,
} from '@deepseek-ai/dsh-session'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())
const characterSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { apply, type Config } from '../src/index.ts'
import * as Invariant from '../src/invariant.ts'

type SessionEventListener = (session: Session, event: SessionEvent) => void

interface ExecError extends Error {
  killed?: boolean
}

interface Invocation {
  command: string
  args: string[]
  options: {
    env: NodeJS.ProcessEnv
    signal: AbortSignal
  }
  callback: (error: ExecError | null, stdout: string) => void
  settled: boolean
}

interface MountedPlugin {
  listener: SessionEventListener
  titles: Map<Session, string>
  warn: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
  cleanup(): Promise<void>
}

const DEFAULT_ROUTE = [
  'WEIXIN_ACCOUNT_ID=owner-account',
  'WEIXIN_BOSN_TARGET=owner-target@im.wechat',
  '',
].join('\n')

let root: string
let routeSequence: number
let sessionSequence: number
let invocations: Invocation[]
let cleanups: Array<() => Promise<void>>

beforeEach(async () => {
  vi.useFakeTimers()
  root = await mkdtemp(join(tmpdir(), 'dsh-turn-notify-wechat-unit-'))
  routeSequence = 0
  sessionSequence = 0
  invocations = []
  cleanups = []
  execFileMock.mockReset()
  execFileMock.mockImplementation((
    command: unknown,
    args: unknown,
    options: unknown,
    callback: unknown,
  ) => {
    const rawCallback = callback as Invocation['callback']
    const invocation: Invocation = {
      command: command as string,
      args: [...args as string[]],
      options: options as Invocation['options'],
      callback(error, stdout) {
        invocation.settled = true
        rawCallback(error, stdout)
      },
      settled: false,
    }
    invocations.push(invocation)
    return undefined
  })
})

afterEach(async () => {
  const disposals = cleanups.map(cleanup => cleanup())
  for (const invocation of invocations) {
    if (!invocation.settled) {
      invocation.callback(Object.assign(new Error('test cleanup'), { name: 'AbortError' }), '')
    }
  }
  await Promise.all(disposals)
  delete process.env.DSH_NOTIFY_TEST_TOKEN
  vi.useRealTimers()
  await rm(root, { recursive: true, force: true })
})

function contextHarness(): {
  ctx: Context
  listener(): SessionEventListener | undefined
  rawCleanup(): (() => Promise<void>) | undefined
  titles: Map<Session, string>
  warn: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
} {
  let listener: SessionEventListener | undefined
  let rawCleanup: (() => Promise<void>) | undefined
  const titles = new Map<Session, string>()
  const warn = vi.fn()
  const detach = vi.fn()
  const ctx = {
    on(eventName: string, candidate: SessionEventListener) {
      expect(eventName).toBe('session/event')
      listener = candidate
      return detach
    },
    sessionTitle: {
      get(session: Session) {
        const title = titles.get(session)
        return title === undefined ? undefined : { title }
      },
    },
    logger: { warn },
    effect(setup: () => () => Promise<void>) {
      rawCleanup = setup()
      return vi.fn()
    },
  } as unknown as Context
  return {
    ctx,
    listener: () => listener,
    rawCleanup: () => rawCleanup,
    titles,
    warn,
    detach,
  }
}

function applyAt(ctx: Context, routeFile: string, overrides: Partial<Config> = {}): void {
  apply(ctx, {
    command: '/owner/bin/ocw',
    routeFile,
    accountKey: 'WEIXIN_ACCOUNT_ID',
    targetKey: 'WEIXIN_BOSN_TARGET',
    channel: 'openclaw-weixin',
    timeoutMs: 1000,
    titleMaxChars: 80,
    summaryMaxChars: 100,
    settleDelayMs: 5000,
    maxConcurrentDeliveries: 2,
    ...overrides,
  })
}

async function mount(
  route = DEFAULT_ROUTE,
  overrides: Partial<Config> = {},
): Promise<MountedPlugin> {
  routeSequence += 1
  const routeFile = join(root, `route-${routeSequence}.env`)
  await writeFile(routeFile, route)
  const harness = contextHarness()
  applyAt(harness.ctx, routeFile, overrides)
  const listener = harness.listener()
  const rawCleanup = harness.rawCleanup()
  if (listener === undefined || rawCleanup === undefined) {
    throw new Error('test harness did not capture plugin lifecycle')
  }
  let disposed = false
  const cleanup = async (): Promise<void> => {
    if (disposed) return
    disposed = true
    await rawCleanup()
  }
  cleanups.push(cleanup)
  return {
    listener,
    titles: harness.titles,
    warn: harness.warn,
    detach: harness.detach,
    cleanup,
  }
}

function createSession(origin?: 'subagent'): Session {
  sessionSequence += 1
  const id = SessionId(`session-${sessionSequence}`)
  return Session.create(id, undefined, {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: sessionSequence,
    ...origin === undefined ? {} : { origin },
  })
}

function emitTurn(
  mounted: MountedPlugin,
  session: Session,
  turn: number,
  content: Parameters<typeof createAssistantMessage>[0]['content'],
  reason: TurnEndReason = { kind: 'completed' },
): Extract<SessionEvent, { type: 'turn/end' }> {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    turn,
    step: 1,
    message: createAssistantMessage({
      content,
      source: { provider: 'test', model: 'test' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  const terminal = session.append('turn/end', { turn, reason })
  mounted.listener(session, terminal)
  return terminal
}

function invocationValue(invocation: Invocation, flag: string): string {
  const result = invocation.args[invocation.args.indexOf(flag) + 1]
  if (result === undefined) throw new Error(`missing command flag ${flag}`)
  return result
}

function characterLength(value: string): number {
  return Array.from(characterSegmenter.segment(value)).length
}

function advanceToDelivery(): Invocation {
  expect(invocations).toHaveLength(0)
  vi.advanceTimersByTime(5000)
  const invocation = invocations[0]
  if (invocation === undefined) throw new Error('test harness did not capture delivery command')
  return invocation
}

function succeed(invocation: Invocation, receipt: unknown = {
  channel: 'openclaw-weixin',
  status: 'sent',
  messageId: 'wechat-1',
}): void {
  invocation.callback(null, JSON.stringify(receipt))
}

describe('turn-notify-wechat plugin', () => {
  it('parses deployment constants, scrubs the child environment, and detaches before stopping', async () => {
    process.env.DSH_NOTIFY_TEST_TOKEN = 'must-not-cross-process'
    const mounted = await mount([
      '',
      '# comment',
      'ignored-without-separator',
      '=ignored-empty-key',
      'BAD-KEY=ignored',
      'ONE=x',
      "SINGLE='quoted'",
      'DOUBLE="quoted"',
      "MISMATCH='quoted\"",
      'PLAIN=[unquoted]',
      'export WEIXIN_ACCOUNT_ID = "owner-account"',
      "WEIXIN_BOSN_TARGET='owner-target@im.wechat'",
      '',
    ].join('\n'))
    const session = createSession()
    mounted.titles.set(session, '微信通知修复')
    emitTurn(mounted, session, 1, [{ type: 'text', text: '已完成目标。' }])
    const invocation = advanceToDelivery()
    expect(invocation.command).toBe('/owner/bin/ocw')
    expect(invocation.args).toEqual(expect.arrayContaining([
      '--account', 'owner-account',
      '--target', 'owner-target@im.wechat',
    ]))
    expect(invocation.options.env.LANG).toBe('C.UTF-8')
    expect(invocation.options.env.DSH_NOTIFY_TEST_TOKEN).toBeUndefined()
    expect(invocation.options.signal).toBeInstanceOf(AbortSignal)
    succeed(invocation)
    await vi.runAllTimersAsync()

    await mounted.cleanup()
    expect(mounted.detach).toHaveBeenCalledOnce()
    emitTurn(mounted, session, 2, [{ type: 'text', text: '不会发送' }])
    vi.advanceTimersByTime(5000)
    expect(invocations).toHaveLength(1)
  })

  it('fails load for an unavailable, missing, empty, or control-character route', async () => {
    const validRouteFile = join(root, 'valid-route.env')
    await writeFile(validRouteFile, DEFAULT_ROUTE)
    const relativeCommand = contextHarness()
    expect(() => { applyAt(relativeCommand.ctx, validRouteFile, { command: 'ocw' }) })
      .toThrow('command must be an absolute path')

    const unavailable = contextHarness()
    expect(() => { applyAt(unavailable.ctx, join(root, 'missing.env')) })
      .toThrow('route file is unavailable')

    for (const [route, expected] of [
      ['WEIXIN_BOSN_TARGET=target\n', 'WEIXIN_ACCOUNT_ID'],
      ['WEIXIN_ACCOUNT_ID=\nWEIXIN_BOSN_TARGET=target\n', 'WEIXIN_ACCOUNT_ID'],
      ['WEIXIN_ACCOUNT_ID=owner\u0001account\nWEIXIN_BOSN_TARGET=target\n', 'control character'],
    ] as const) {
      routeSequence += 1
      const routeFile = join(root, `invalid-route-${routeSequence}.env`)
      await writeFile(routeFile, route)
      const harness = contextHarness()
      expect(() => { applyAt(harness.ctx, routeFile) }).toThrow(expected)
    }
  })

  it('cancels a pending settle timer during disposal', async () => {
    const mounted = await mount()
    const session = createSession()
    mounted.titles.set(session, '关闭前待发送')
    emitTurn(mounted, session, 1, [{ type: 'text', text: '完成' }])
    await mounted.cleanup()
    vi.advanceTimersByTime(5000)
    expect(invocations).toHaveLength(0)
    expect(mounted.detach).toHaveBeenCalledOnce()
  })

  it('uses the session title, final visible assistant text, terminal label, and stable turn identity', async () => {
    const mounted = await mount()
    const reasons: Array<{ reason: TurnEndReason; label: string }> = [
      { reason: { kind: 'completed' }, label: '完成' },
      { reason: { kind: 'aborted', reason: { kind: 'user' } }, label: '已取消' },
      { reason: { kind: 'error', error: { message: 'failure', code: 'UNKNOWN' } }, label: '失败' },
      { reason: { kind: 'max-tokens' }, label: '输出截断' },
      { reason: { kind: 'blocked' }, label: '已阻止' },
      { reason: { kind: 'interrupted' }, label: '已中断' },
    ]
    const keys: string[] = []

    for (const [index, { reason, label }] of reasons.entries()) {
      const session = createSession()
      mounted.titles.set(session, '  修复 DSH 微信通知： ')
      const terminal = emitTurn(mounted, session, 1, [
        { type: 'reasoning', text: 'private reasoning' },
        { type: 'tool-call', id: CallId(`call-${index}`), name: 'bash', arguments: '{"secret":true}' },
        { type: 'text', text: '# 状态\n- [任务](https://example.test)已完成\n![截图](https://example.test/x.png)' },
      ], reason)
      const invocation = advanceToDelivery()
      expect(invocationValue(invocation, '--message')).toBe(
        `DSH任务 [${label}]：修复 DSH 微信通知\n状态；任务已完成；截图`,
      )
      expect(invocation.args.join('\n')).not.toContain('private reasoning')
      expect(invocation.args.join('\n')).not.toContain('secret')
      const key = invocationValue(invocation, '--idempotency-key')
      expect(key).toMatch(/^dsh-turn-wechat\/v1\/[0-9a-f]{64}$/u)
      keys.push(key)
      succeed(invocation, {
        channel: 'openclaw-weixin', status: 'sent', messageId: `wechat-${index}`,
      })
      await vi.runAllTimersAsync()

      if (index === 0) {
        mounted.listener(session, terminal)
        vi.advanceTimersByTime(5000)
        const repeated = invocations.at(-1)
        expect(repeated).toBeDefined()
        expect(invocationValue(repeated as Invocation, '--idempotency-key')).toBe(key)
        succeed(repeated as Invocation)
        await vi.runAllTimersAsync()
      }
      invocations = []
    }
    expect(new Set(keys)).toHaveLength(reasons.length)
  })

  it('applies Codex-style Markdown cleanup and exact Unicode title and summary bounds', async () => {
    const mounted = await mount(DEFAULT_ROUTE, { titleMaxChars: 4, summaryMaxChars: 8 })
    const session = createSession()
    mounted.titles.set(session, '👩‍💻中文标题')
    emitTurn(mounted, session, 1, [{
      type: 'text',
      text: '普通内容很长很长\n\n- 结论：完成',
    }])
    vi.advanceTimersByTime(5000)
    const invocation = invocations[0]
    expect(invocation).toBeDefined()
    const message = invocationValue(invocation as Invocation, '--message')
    expect(message).toBe('DSH任务 [完成]：👩‍💻中文…\n结论：完成')
    expect(characterLength(message.split('\n')[0]?.split('：').at(-1) ?? '')).toBe(4)
    expect(characterLength(message.split('\n')[1] ?? '')).toBe(5)
    succeed(invocation as Invocation)
    await vi.runAllTimersAsync()

    invocations = []
    const exact = createSession()
    mounted.titles.set(exact, '正好四字')
    emitTurn(mounted, exact, 1, [{ type: 'text', text: '👩‍💻一二三四五六七八' }])
    vi.advanceTimersByTime(5000)
    const bounded = invocationValue(invocations[0] as Invocation, '--message').split('\n')[1]
    expect(bounded).toBe('👩‍💻一二三四五六…')
    expect(characterLength(bounded ?? '')).toBe(8)
    succeed(invocations[0] as Invocation)
    await vi.runAllTimersAsync()

    invocations = []
    const processSafe = createSession()
    mounted.titles.set(processSafe, '\0任务\0')
    emitTurn(mounted, processSafe, 1, [{ type: 'text', text: '\0完成\0' }])
    vi.advanceTimersByTime(5000)
    expect(invocationValue(invocations[0] as Invocation, '--message'))
      .toBe('DSH任务 [完成]：任务\n完成')
    succeed(invocations[0] as Invocation)
    await vi.runAllTimersAsync()
  })

  it('supports one-character bounds, mixed summary ranking, and future terminal tags', async () => {
    const oneCharacter = await mount(DEFAULT_ROUTE, { titleMaxChars: 1, summaryMaxChars: 1 })
    const minimal = createSession()
    oneCharacter.titles.set(minimal, '任务')
    emitTurn(oneCharacter, minimal, 1, [{ type: 'text', text: '完成' }])
    vi.advanceTimersByTime(5000)
    expect(invocationValue(invocations[0] as Invocation, '--message')).toBe('DSH任务 [完成]：…\n…')
    succeed(invocations[0] as Invocation)
    await vi.runAllTimersAsync()

    invocations = []
    const ranked = await mount(DEFAULT_ROUTE, { summaryMaxChars: 30 })
    for (const [index, text] of [
      `普通第一行\n结论：完成\n普通第二行\n${'超'.repeat(40)}`,
      `结论：完成\n普通第一行\n普通第二行\n${'长'.repeat(40)}`,
    ].entries()) {
      const session = createSession()
      ranked.titles.set(session, '摘要排序')
      emitTurn(ranked, session, 1, [{ type: 'text', text }])
      vi.advanceTimersByTime(5000)
      expect(invocationValue(invocations[0] as Invocation, '--message'))
        .toBe('DSH任务 [完成]：摘要排序\n结论：完成；普通第一行；普通第二行')
      succeed(invocations[0] as Invocation, {
        channel: 'openclaw-weixin', status: 'sent', messageId: `ranked-${index}`,
      })
      await vi.runAllTimersAsync()
      invocations = []
    }

    const future = createSession()
    ranked.titles.set(future, '未来终态')
    emitTurn(ranked, future, 1, [{ type: 'text', text: '完成' }], {
      kind: 'future-terminal',
    } as unknown as TurnEndReason)
    vi.advanceTimersByTime(5000)
    expect(invocationValue(invocations[0] as Invocation, '--message'))
      .toBe('DSH任务 [结束]：未来终态\n完成')
    succeed(invocations[0] as Invocation)
    await vi.runAllTimersAsync()

    invocations = []
    const sentence = createSession()
    ranked.titles.set(sentence, '句子摘要')
    emitTurn(ranked, sentence, 1, [{
      type: 'text', text: `第一句完成。${'第二句很长'.repeat(10)}`,
    }])
    vi.advanceTimersByTime(5000)
    expect(invocationValue(invocations[0] as Invocation, '--message'))
      .toBe('DSH任务 [完成]：句子摘要\n第一句完成。')
    succeed(invocations[0] as Invocation)
    await vi.runAllTimersAsync()
  })

  it('coalesces to the newest turn and lets a newer textless turn cancel an older pending notice', async () => {
    const mounted = await mount()
    const session = createSession()
    mounted.titles.set(session, '同一会话')
    emitTurn(mounted, session, 1, [{ type: 'text', text: '第一条' }])
    vi.advanceTimersByTime(1000)
    emitTurn(mounted, session, 2, [{ type: 'text', text: '第二条' }])
    vi.advanceTimersByTime(4999)
    expect(invocations).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(invocationValue(invocations[0] as Invocation, '--message')).toContain('\n第二条')
    succeed(invocations[0] as Invocation)
    await vi.runAllTimersAsync()

    invocations = []
    emitTurn(mounted, session, 3, [{ type: 'text', text: '待取消' }])
    emitTurn(mounted, session, 4, [{ type: 'reasoning', text: 'no visible text' }])
    vi.advanceTimersByTime(5000)
    expect(invocations).toHaveLength(0)
  })

  it('bounds delivery subprocess concurrency and drains queued notices as slots settle', async () => {
    const mounted = await mount(DEFAULT_ROUTE, { maxConcurrentDeliveries: 2 })
    for (let index = 1; index <= 4; index += 1) {
      const session = createSession()
      mounted.titles.set(session, `并发任务 ${index}`)
      emitTurn(mounted, session, 1, [{ type: 'text', text: `完成 ${index}` }])
    }

    vi.advanceTimersByTime(5000)
    expect(invocations).toHaveLength(2)
    expect(invocations.filter(invocation => !invocation.settled)).toHaveLength(2)

    succeed(invocations[0] as Invocation)
    await vi.runAllTimersAsync()
    expect(invocations).toHaveLength(3)
    expect(invocations.filter(invocation => !invocation.settled)).toHaveLength(2)

    succeed(invocations[1] as Invocation)
    await vi.runAllTimersAsync()
    expect(invocations).toHaveLength(4)
    expect(invocations.filter(invocation => !invocation.settled)).toHaveLength(2)

    succeed(invocations[2] as Invocation)
    succeed(invocations[3] as Invocation)
    await vi.runAllTimersAsync()
    expect(mounted.warn).not.toHaveBeenCalled()
  })

  it('replaces a queued notice for the same session and drops queued work on teardown', async () => {
    const mounted = await mount(DEFAULT_ROUTE, { maxConcurrentDeliveries: 1 })
    const active = createSession()
    mounted.titles.set(active, '占用交付槽')
    emitTurn(mounted, active, 1, [{ type: 'text', text: '占用中' }])

    const queued = createSession()
    mounted.titles.set(queued, '排队会话')
    emitTurn(mounted, queued, 1, [{ type: 'text', text: '旧摘要' }])
    vi.advanceTimersByTime(5000)
    expect(invocations).toHaveLength(1)

    emitTurn(mounted, queued, 2, [{ type: 'text', text: '新摘要' }])
    vi.advanceTimersByTime(5000)
    expect(invocations).toHaveLength(1)

    succeed(invocations[0] as Invocation)
    await vi.runAllTimersAsync()
    expect(invocations).toHaveLength(2)
    expect(invocationValue(invocations[1] as Invocation, '--message')).toContain('\n新摘要')

    const neverStarted = createSession()
    mounted.titles.set(neverStarted, '关闭时排队')
    emitTurn(mounted, neverStarted, 1, [{ type: 'text', text: '不应启动' }])
    vi.advanceTimersByTime(5000)
    expect(invocations).toHaveLength(2)

    const disposal = mounted.cleanup()
    ;(invocations[1] as Invocation).callback(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
      '',
    )
    await disposal
    expect(invocations).toHaveLength(2)
    expect(mounted.warn).not.toHaveBeenCalled()
  })

  it('suppresses subagent, textless, and titleless turn notices', async () => {
    const mounted = await mount()
    const child = createSession('subagent')
    mounted.titles.set(child, '子任务')
    emitTurn(mounted, child, 1, [{ type: 'text', text: 'child output' }])

    const textless = createSession()
    mounted.titles.set(textless, '没有可见回复')
    emitTurn(mounted, textless, 1, [{ type: 'reasoning', text: 'reasoning only' }])

    const noAssistant = createSession()
    mounted.titles.set(noAssistant, '没有 assistant event')
    noAssistant.append('turn/start', { turn: 1 })
    const noAssistantTerminal = noAssistant.append('turn/end', {
      turn: 1,
      reason: { kind: 'completed' },
    })
    mounted.listener(noAssistant, noAssistantTerminal)

    const emptySummary = createSession()
    mounted.titles.set(emptySummary, '摘要为空')
    emitTurn(mounted, emptySummary, 1, [{ type: 'text', text: '### *** ___' }])

    const titleless = createSession()
    emitTurn(mounted, titleless, 1, [{ type: 'text', text: 'visible output' }])

    const emptyTitle = createSession()
    mounted.titles.set(emptyTitle, ' ： ')
    emitTurn(mounted, emptyTitle, 1, [{ type: 'text', text: 'visible output' }])
    vi.advanceTimersByTime(5000)
    expect(invocations).toHaveLength(0)
    expect(mounted.warn).toHaveBeenCalledWith(expect.stringContaining('session title unavailable'))
    expect(mounted.warn).toHaveBeenCalledWith(expect.stringContaining('session title empty'))
  })

  it('accepts nested sent, delivered, and ok receipts without trusting unrelated values', async () => {
    const mounted = await mount()
    const receipts = [
      {
        action: 'send',
        channel: 'openclaw-weixin',
        dryRun: false,
        handledBy: 'plugin',
        messageId: 'wechat-cli-contract',
      },
      {
        channel: 'openclaw-weixin',
        deliveryStatus: 7,
        delivery_status: '',
        status: 'sent',
        messageId: 0,
        message_id: false,
        result: [null, 'ignored', { channel: 7 }],
      },
      {
        channel: 'openclaw-weixin',
        delivery_status: 'delivered',
        messageId: ' wechat-delivered ',
      },
      {
        channel: 'openclaw-weixin',
        ok: true,
        status: 200,
        message_id: 'wechat-ok',
      },
    ]
    for (const receipt of receipts) {
      const session = createSession()
      mounted.titles.set(session, '回执校验')
      emitTurn(mounted, session, 1, [{ type: 'text', text: '完成' }])
      const invocation = advanceToDelivery()
      succeed(invocation, receipt)
      await vi.runAllTimersAsync()
      invocations = []
    }
    expect(mounted.warn).not.toHaveBeenCalled()
  })

  it('rejects malformed, dry-run, wrong-channel, and unverifiable receipts', async () => {
    const mounted = await mount()
    const cases: Array<{ stdout: string; expected: string }> = [
      { stdout: '{', expected: 'invalid JSON' },
      { stdout: '"primitive"', expected: 'invalid receipt' },
      { stdout: 'null', expected: 'invalid receipt' },
      { stdout: '[]', expected: 'invalid receipt' },
      {
        stdout: JSON.stringify({
          channel: 'openclaw-weixin', dryRun: true, status: 'sent', messageId: 'wechat-1',
        }),
        expected: 'dry-run receipt',
      },
      {
        stdout: JSON.stringify({ status: 'sent', messageId: 'wechat-1' }),
        expected: 'different channel',
      },
      {
        stdout: JSON.stringify({ channel: 'discord', status: 'sent', messageId: 'discord-1' }),
        expected: 'different channel',
      },
      {
        stdout: JSON.stringify({
          channel: 'openclaw-weixin',
          status: 'sent',
          messageId: 'wechat-1',
          nested: { channel: 'discord' },
        }),
        expected: 'different channel',
      },
      {
        stdout: JSON.stringify({ channel: 'openclaw-weixin', status: 'queued', messageId: 'wechat-1' }),
        expected: 'no verifiable sent receipt',
      },
      {
        stdout: JSON.stringify({ action: 'poll', channel: 'openclaw-weixin', messageId: 'wechat-1' }),
        expected: 'no verifiable sent receipt',
      },
      {
        stdout: JSON.stringify({ channel: 'openclaw-weixin', status: 'sent', messageId: '' }),
        expected: 'no verifiable sent receipt',
      },
      {
        stdout: JSON.stringify({ channel: 'openclaw-weixin', status: 'sent', message_id: true }),
        expected: 'no verifiable sent receipt',
      },
      {
        stdout: JSON.stringify({ channel: 'openclaw-weixin', status: 'sent', messageId: {} }),
        expected: 'no verifiable sent receipt',
      },
    ]
    for (const testCase of cases) {
      const session = createSession()
      mounted.titles.set(session, '回执失败')
      emitTurn(mounted, session, 1, [{ type: 'text', text: '完成' }])
      const invocation = advanceToDelivery()
      invocation.callback(null, testCase.stdout)
      await vi.runAllTimersAsync()
      expect(mounted.warn).toHaveBeenLastCalledWith(expect.stringContaining(testCase.expected))
      invocations = []
    }
  })

  it('contains command exits and timeouts, and suppresses teardown abort warnings', async () => {
    const mounted = await mount()
    const session = createSession()
    const privateSummary = 'PRIVATE SUMMARY MUST NOT REACH LOGS'
    execFileMock.mockImplementationOnce(() => {
      throw new TypeError(`invalid argv: ${privateSummary}`)
    })
    mounted.titles.set(session, '启动校验')
    emitTurn(mounted, session, 1, [{ type: 'text', text: privateSummary }])
    vi.advanceTimersByTime(5000)
    await vi.runAllTimersAsync()
    expect(mounted.warn).toHaveBeenLastCalledWith(expect.stringContaining('(spawn validation)'))
    expect(mounted.warn).toHaveBeenLastCalledWith(expect.not.stringContaining(privateSummary))

    mounted.titles.set(session, '命令失败')
    emitTurn(mounted, session, 2, [{ type: 'text', text: '完成' }])
    const failed = advanceToDelivery()
    failed.callback(Object.assign(new Error('exit'), {
      name: 'ExitError',
      killed: false,
    }), '')
    await vi.runAllTimersAsync()
    expect(mounted.warn).toHaveBeenLastCalledWith(expect.stringContaining('(ExitError)'))

    invocations = []
    emitTurn(mounted, session, 3, [{ type: 'text', text: '再次完成' }])
    const timedOut = advanceToDelivery()
    timedOut.callback(Object.assign(new Error('timeout'), { killed: true }), '')
    await vi.runAllTimersAsync()
    expect(mounted.warn).toHaveBeenLastCalledWith(expect.stringContaining('(timeout)'))

    mounted.warn.mockClear()
    invocations = []
    emitTurn(mounted, session, 4, [{ type: 'text', text: '关闭中' }])
    const pending = advanceToDelivery()
    const disposal = mounted.cleanup()
    pending.callback(Object.assign(new Error('aborted'), { name: 'AbortError' }), '')
    await disposal
    expect(mounted.warn).not.toHaveBeenCalled()
  })
})

describe('turn-notify-wechat invariant companion', () => {
  it('reserves the package name with an explained empty installer', async () => {
    const dispose = vi.fn()
    let installer: InvariantInstaller | undefined
    const register = vi.fn((packageName: string, candidate: InvariantInstaller) => {
      expect(packageName).toBe('@deepseek-ai/dsh-turn-notify-wechat')
      installer = candidate
      return dispose
    })
    const ctx = { invariants: { register } } as unknown as Context
    await expect(Invariant.apply(ctx)).resolves.toBe(dispose)
    expect(installer).toBeDefined()
    const fail = (): never => { throw new Error('unexpected invariant failure') }
    expect(installer?.({} as Context, fail)).toBeUndefined()
  })
})
