import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import type { JobDoneListener, JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execFileMock = vi.hoisted(() => vi.fn())

vi.mock('node:child_process', () => ({ execFile: execFileMock }))

import { apply } from '../src/index.ts'
import * as Invariant from '../src/invariant.ts'

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
}

interface MountedPlugin {
  listener: JobDoneListener
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
let snapshotSequence: number
let invocations: Invocation[]
let cleanups: Array<() => Promise<void>>

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-job-notify-wechat-unit-'))
  routeSequence = 0
  snapshotSequence = 0
  invocations = []
  cleanups = []
  execFileMock.mockReset()
  execFileMock.mockImplementation((
    command: unknown,
    args: unknown,
    options: unknown,
    callback: unknown,
  ) => {
    invocations.push({
      command: command as string,
      args: [...args as string[]],
      options: options as Invocation['options'],
      callback: callback as Invocation['callback'],
    })
    return undefined
  })
})

afterEach(async () => {
  await Promise.all(cleanups.map(cleanup => cleanup()))
  delete process.env.DSH_NOTIFY_TEST_TOKEN
  await rm(root, { recursive: true, force: true })
})

function contextHarness(): {
  ctx: Context
  listener(): JobDoneListener | undefined
  rawCleanup(): (() => Promise<void>) | undefined
  warn: ReturnType<typeof vi.fn>
  detach: ReturnType<typeof vi.fn>
} {
  let listener: JobDoneListener | undefined
  let rawCleanup: (() => Promise<void>) | undefined
  const warn = vi.fn()
  const detach = vi.fn()
  const ctx = {
    jobs: {
      onJobDone(candidate: JobDoneListener) {
        listener = candidate
        return detach
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
    warn,
    detach,
  }
}

function applyAt(ctx: Context, routeFile: string): void {
  apply(ctx, {
    command: '/owner/bin/ocw',
    routeFile,
    accountKey: 'WEIXIN_ACCOUNT_ID',
    targetKey: 'WEIXIN_BOSN_TARGET',
    channel: 'openclaw-weixin',
    timeoutMs: 1000,
  })
}

async function mount(route = DEFAULT_ROUTE): Promise<MountedPlugin> {
  routeSequence += 1
  const routeFile = join(root, `route-${routeSequence}.env`)
  await writeFile(routeFile, route)
  const harness = contextHarness()
  applyAt(harness.ctx, routeFile)
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
  return { listener, warn: harness.warn, detach: harness.detach, cleanup }
}

function snapshot(
  status: JobSnapshot['status'] = 'completed',
  overrides: Partial<JobSnapshot> = {},
): JobSnapshot {
  snapshotSequence += 1
  return {
    id: `bash-${snapshotSequence}` as JobSnapshot['id'],
    kind: 'bash',
    label: 'private command',
    status,
    startedAt: 100,
    finishedAt: 200,
    reported: false,
    ...overrides,
  }
}

const owner = { id: 'owner-session' } as unknown as Agent

function notify(
  mounted: MountedPlugin,
  value: JobSnapshot = snapshot(),
  jobOwner: Agent | undefined = owner,
): { invocation: Invocation; settled: Promise<void> } {
  const before = invocations.length
  const returned = mounted.listener(value, jobOwner)
  expect(invocations).toHaveLength(before + 1)
  const invocation = invocations[before]
  if (invocation === undefined) throw new Error('test harness did not capture delivery command')
  return {
    invocation,
    settled: Promise.resolve(returned).then(() => undefined),
  }
}

function succeed(invocation: Invocation, receipt: unknown): void {
  invocation.callback(null, JSON.stringify(receipt))
}

describe('job-notify-wechat plugin', () => {
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
    const { invocation, settled } = notify(mounted)
    expect(invocation.command).toBe('/owner/bin/ocw')
    expect(invocation.args).toEqual(expect.arrayContaining([
      '--account', 'owner-account',
      '--target', 'owner-target@im.wechat',
    ]))
    expect(invocation.options.env.LANG).toBe('C.UTF-8')
    expect(invocation.options.env.DSH_NOTIFY_TEST_TOKEN).toBeUndefined()
    expect(invocation.options.signal).toBeInstanceOf(AbortSignal)
    succeed(invocation, {
      channel: 'openclaw-weixin',
      status: 'sent',
      messageId: 'wechat-1',
    })
    await settled

    await mounted.cleanup()
    expect(mounted.detach).toHaveBeenCalledOnce()
    expect(mounted.listener(snapshot(), undefined)).toBeUndefined()
  })

  it('fails load for an unavailable, missing, empty, or control-character route', async () => {
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

  it('formats every terminal status and derives a stable identity without payload fields', async () => {
    const mounted = await mount()
    const messages: string[] = []
    const keys: string[] = []
    const exact = snapshot('completed', { id: 'bash-42' as JobSnapshot['id'] })
    const terminalSnapshots = [
      exact,
      exact,
      snapshot('killed'),
      snapshot('failed'),
    ]
    const unfinished: JobSnapshot = snapshot('completed')
    delete unfinished.finishedAt
    terminalSnapshots.push(unfinished)
    for (const value of terminalSnapshots) {
      const jobOwner = value.finishedAt === undefined ? undefined : owner
      const { invocation, settled } = notify(mounted, value, jobOwner)
      const after = (flag: string): string => {
        const result = invocation.args[invocation.args.indexOf(flag) + 1]
        if (result === undefined) throw new Error(`missing command flag ${flag}`)
        return result
      }
      messages.push(after('--message'))
      keys.push(after('--idempotency-key'))
      succeed(invocation, {
        channel: 'openclaw-weixin',
        status: 'sent',
        messageId: `wechat-${messages.length}`,
      })
      await settled
    }

    expect(messages).toEqual([
      'DSH任务 [完成]：bash-42（bash）',
      'DSH任务 [完成]：bash-42（bash）',
      'DSH任务 [已取消]：bash-2（bash）',
      'DSH任务 [失败]：bash-3（bash）',
      'DSH任务 [完成]：bash-4（bash）',
    ])
    expect(keys[0]).toBe(keys[1])
    expect(keys[0]).toMatch(/^dsh-job-wechat\/v1\/[0-9a-f]{64}$/u)
    expect(keys[4]).not.toBe(keys[0])
    expect(invocations.flatMap(invocation => invocation.args).join('\n'))
      .not.toContain('private command')

    for (const status of ['running', 'stopping'] as const) {
      expect(() => mounted.listener(snapshot(status), owner)).toThrow(`non-terminal job status ${status}`)
    }
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
      const { invocation, settled } = notify(mounted)
      succeed(invocation, receipt)
      await settled
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
      const { invocation, settled } = notify(mounted)
      invocation.callback(null, testCase.stdout)
      await settled
      expect(mounted.warn).toHaveBeenLastCalledWith(expect.stringContaining(testCase.expected))
    }
  })

  it('contains command exits and timeouts, and suppresses teardown abort warnings', async () => {
    const mounted = await mount()
    const failed = notify(mounted)
    failed.invocation.callback(Object.assign(new Error('exit'), {
      name: 'ExitError',
      killed: false,
    }), '')
    await failed.settled
    expect(mounted.warn).toHaveBeenLastCalledWith(expect.stringContaining('(ExitError)'))

    const timedOut = notify(mounted)
    timedOut.invocation.callback(Object.assign(new Error('timeout'), { killed: true }), '')
    await timedOut.settled
    expect(mounted.warn).toHaveBeenLastCalledWith(expect.stringContaining('(timeout)'))

    mounted.warn.mockClear()
    const pending = notify(mounted)
    const disposal = mounted.cleanup()
    pending.invocation.callback(Object.assign(new Error('aborted'), { name: 'AbortError' }), '')
    await Promise.all([pending.settled, disposal])
    expect(mounted.warn).not.toHaveBeenCalled()
  })
})

describe('job-notify-wechat invariant companion', () => {
  it('reserves the package name with an explained empty installer', async () => {
    const dispose = vi.fn()
    let installer: InvariantInstaller | undefined
    const register = vi.fn((packageName: string, candidate: InvariantInstaller) => {
      expect(packageName).toBe('@deepseek-ai/dsh-job-notify-wechat')
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
