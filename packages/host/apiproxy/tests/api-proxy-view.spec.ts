/**
 * Tool-card view computation over the mux live path: three standard card types
 * arrive on the frame, a presenterless tool ships no view field, a call-only
 * presenter keeps raw result content out of the view payload, and a throwing
 * presenter soft-falls to no view (the event still ships). Result pairing
 * works both through the live open-call table and the backscan fallback after
 * turn/end cleared it.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { CallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { MuxFrame, RpcRequest, HistoryEntry } from '@deepseek-ai/dsh-host-apiproxy/api'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    'test/big': string
  }
  interface SessionProjectionMap {
    'test/big': string
  }
}

const reply = (text: string): Promise<ContentBlock[]> => Promise.resolve([{ type: 'text', text }])

function tool(name: string, presenters: Pick<ToolDefinition, 'presentCall' | 'presentResult'>): ToolDefinition {
  return defineContentToolFixture({
    name,
    description: `tool ${name}`,
    parameters: {},
    execute: () => reply(`ran:${name}`),
    ...presenters,
  })
}

/** Append a production-shaped human prompt to the session surface. */
function appendUserText(session: Session, text: string): SessionEvent {
  return session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }], source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/** Append a production-shaped assistant message to the session surface. */
function appendAssistantText(session: Session, text: string, step: number): SessionEvent {
  return session.append('assistant/message', {
    turn: 1,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'p', model: 'm' },
    }),
  }, { surfaceOp: 'append' })
}

/**
 * Append a plugin-owned log-only event. The host proxy is projection-only, so it
 * declares no compaction vocabulary; the cast writes the real event shape without
 * depending on the owning package.
 */
function appendExtension(session: Session, type: string, data: unknown): SessionEvent {
  return (session.append as unknown as (type: string, data: unknown) => SessionEvent)(type, data)
}

async function harness(): Promise<{ ctx: Context }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  ctx.tools.register(tool('gen', {
    presentCall: () => ({ card: 'generic', title: 'gen call' }),
    presentResult: (_args, result) => ({ card: 'generic', title: result.isError ? 'gen failed' : 'gen done' }),
  }))
  ctx.tools.register(tool('term', {
    presentCall: args => ({ card: 'terminal', title: (args as { cmd?: string }).cmd ?? '' }),
    presentResult: () => ({ card: 'terminal', output: 'done' }),
  }))
  ctx.tools.register(tool('diffy', {
    presentCall: () => ({ card: 'diff', title: 'Write f.txt', diffs: [{ path: 'f.txt', oldText: null, newText: 'x' }] }),
  }))
  ctx.tools.register(tool('call-only', {
    presentCall: () => ({ card: 'generic', title: 'program', kind: 'execute', rawInput: 'return value' }),
  }))
  ctx.tools.register(tool('plain', {}))
  ctx.tools.register(tool('boom', {
    presentCall: () => { throw new Error('presenter exploded') },
  }))
  return { ctx }
}

/** Drain frames from an open mux stream until `count` session/event frames arrived. */
async function collect(iterable: AsyncIterable<RpcRequest<MuxFrame>>, count: number, abort: AbortController): Promise<MuxFrame[]> {
  const frames: MuxFrame[] = []
  for await (const frame of iterable) {
    frames.push(frame.payload)
    if (frames.filter(f => f.type === 'session/event').length >= count) abort.abort()
  }
  return frames
}

describe('mux live view computation', () => {
  it('attaches the three standard card views, omits view without a presenter, soft-falls on throw', async () => {
    const { ctx } = await harness()
    const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const abort = new AbortController()
    const stream = api.events.mux({ rpcId: RpcId('t-mux'), payload: {} }, abort.signal)
    const collected = collect(stream, 9, abort)
    const rawResult = `RAW_RESULT:${'x'.repeat(64 * 1024)}`

    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('c-gen'), name: 'gen', arguments: '{}' })
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('c-term'), name: 'term', arguments: '{"cmd":"echo hi"}' })
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('c-diff'), name: 'diffy', arguments: '{}' })
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('c-call-only'), name: 'call-only', arguments: '{}' })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: CallId('c-call-only'),
        content: [{ type: 'text', text: rawResult }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('c-plain'), name: 'plain', arguments: '{}' })
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('c-boom'), name: 'boom', arguments: '{}' })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: CallId('c-gen'),
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })

    const frames = await collected
    const events = frames.filter(f => f.type === 'session/event')
    const byCall = new Map(events
      .filter(f => f.event.type === 'tool/call' || f.event.type === 'tool/result')
      .map(f => [
        `${f.event.type}:${f.event.type === 'tool/call'
          ? f.event.data.callId
          : (f.event.data as SessionEvent<'tool/result'>['data']).message.source.callId}`,
        f,
      ]))

    expect(byCall.get('tool/call:c-gen')?.view).toEqual({ for: 'call', view: { card: 'generic', title: 'gen call' } })
    expect(byCall.get('tool/call:c-term')?.view).toEqual({ for: 'call', view: { card: 'terminal', title: 'echo hi' } })
    expect(byCall.get('tool/call:c-diff')?.view?.view.card).toBe('diff')
    expect(byCall.get('tool/call:c-call-only')?.view).toEqual({
      for: 'call',
      view: { card: 'generic', title: 'program', kind: 'execute', rawInput: 'return value' },
    })
    const callOnlyResult = byCall.get('tool/result:c-call-only')
    expect('view' in (callOnlyResult ?? {})).toBe(false)
    const serializedResult = JSON.stringify(callOnlyResult)
    expect(serializedResult.indexOf(rawResult)).toBeGreaterThanOrEqual(0)
    expect(serializedResult.indexOf(rawResult)).toBe(serializedResult.lastIndexOf(rawResult))
    // No presenter → the frame carries no view property at all.
    expect('view' in (byCall.get('tool/call:c-plain') ?? {})).toBe(false)
    // Throwing presenter → soft-fall: event ships, no view.
    expect(byCall.get('tool/call:c-boom')).toBeDefined()
    expect('view' in (byCall.get('tool/call:c-boom') ?? {})).toBe(false)
    // Result pairing through the live table: presentResult saw the call's args.
    expect(byCall.get('tool/result:c-gen')?.view).toEqual({ for: 'result', view: { card: 'generic', title: 'gen done' } })
  })

  it('serves history entries with call/result views, backscan pairing, and soft-falls', async () => {
    const { ctx } = await harness()
    const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create()
    // history resolves the agent first; a live structural stub is enough (only
    // .session is read on this path).
    ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
    session.append('turn/start', { turn: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('h-term'), name: 'term', arguments: '{"cmd":"ls"}' })
    // meta rides through to presentResult's ToolResult (the spread arm).
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: CallId('h-term'),
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
      meta: { n: 1 },
    }, { surfaceOp: 'append' })
    // Unpaired result: no tool/call with this id anywhere in the page.
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: CallId('h-orphan'),
        content: [{ type: 'text', text: 'x' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    // Paired, but the call's stored arguments do not parse: backscan soft-falls.
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('h-bad'), name: 'term', arguments: '{broken' })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: CallId('h-bad'),
        content: [{ type: 'text', text: 'y' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    // Presenterless tool: pairing succeeds but presentResult is absent.
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('h-plain'), name: 'plain', arguments: '{}' })
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: CallId('h-plain'),
        content: [{ type: 'text', text: 'z' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })

    const response = await api.sessions.history({ rpcId: RpcId('t-hist'), payload: { sessionId: session.id } })
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    const entries = response.result.value.events
    const byKey = new Map(entries
      .filter(entry => entry.event.type === 'tool/call' || entry.event.type === 'tool/result')
      .map(entry => [
        `${entry.event.type}:${entry.event.type === 'tool/call'
          ? entry.event.data.callId
          : (entry.event.data as SessionEvent<'tool/result'>['data']).message.source.callId}`,
        entry,
      ]))
    expect(byKey.get('tool/call:h-term')?.view).toEqual({ for: 'call', view: { card: 'terminal', title: 'ls' } })
    expect(byKey.get('tool/result:h-term')?.view).toEqual({ for: 'result', view: { card: 'terminal', output: 'done' } })
    expect('view' in (byKey.get('tool/result:h-orphan') ?? {})).toBe(false)
    expect('view' in (byKey.get('tool/result:h-bad') ?? {})).toBe(false)
    expect('view' in (byKey.get('tool/result:h-plain') ?? {})).toBe(false)
  })

  it('counts only append-origin messages toward maxMessages and keeps each compaction summary with its replacement', async () => {
    const { ctx } = await harness()
    const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create()
    ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
    session.append('turn/start', { turn: 1 })
    const first = appendUserText(session, 'first prompt')
    appendAssistantText(session, 'first reply', 1)
    const third = appendUserText(session, 'second prompt')
    appendAssistantText(session, 'second reply', 2)
    const shadowed = [...session.surface.nodes]
    // A compaction transaction: a log-only summary record immediately followed by the
    // replacement that shadows the range.
    const summary = appendExtension(session, 'compaction/summary', {
      summary: [{ type: 'text', text: 'summary' }],
      shadowedRange: { start: shadowed[0], end: shadowed.at(-1) },
      shadowedSeqs: shadowed,
      shadowedTokenCount: 0,
      provider: 'p',
      model: 'm',
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: '<context_checkpoint>summary</context_checkpoint>' }],
      source: { kind: 'plugin', plugin: 'compact' },
    }), {
      surfaceOp: { op: 'replace', start: shadowed[0] as number, end: shadowed.at(-1) as number },
      sourceEventSeqs: [...shadowed, summary.seq],
    })

    const response = await api.sessions.history({
      rpcId: RpcId('t-hist-compact'),
      payload: { sessionId: session.id, maxMessages: 2 },
    })
    if (!response.result.ok) throw new Error('unreachable')
    const page = response.result.value.events.map(entry => entry.event)
    // Two append-origin messages fill the page even though a replacement copy of
    // the same event type sits in the window: the copy is model-only.
    const messages = page.filter(event => event.type === 'user/message' || event.type === 'assistant/message')
    expect(messages.map(event => event.seq)).toEqual([third.seq, third.seq + 1, third.seq + 3])
    expect(page.some(event => event.seq === first.seq)).toBe(false)
    expect(response.result.value.hasMore).toBe(true)
    // The range stays contiguous, so the checkpoint's summary record is readable on
    // the same page as the checkpoint itself.
    const summaryIndex = page.findIndex(event => event.seq === summary.seq)
    expect(summaryIndex).toBeGreaterThan(-1)
    expect(page[summaryIndex + 1]?.seq).toBe(summary.seq + 1)
    expect(page.map(event => event.seq)).toEqual(page.map((_event, index) => third.seq + index))
  })

  it('paginates a message with many provenance sources without variadic argument expansion', async () => {
    const { ctx } = await harness()
    const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create()
    ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
    session.append('turn/start', { turn: 1 })
    const sources = Array.from({ length: 128 }, (_unused, index) => session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index, text: 'x' },
    }).seq)
    const message = session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'x'.repeat(sources.length) }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: sources })

    const scalarMin = Math.min
    const min = vi.spyOn(Math, 'min').mockImplementation((...values) => {
      if (values.length > 2) throw new RangeError('variadic minimum rejected by regression harness')
      return scalarMin(...values)
    })
    try {
      const response = await api.sessions.history({
        rpcId: RpcId('t-hist-large-provenance'),
        payload: { sessionId: session.id, maxMessages: 1 },
      })
      if (!response.result.ok) throw new Error('unreachable')
      expect(response.result.value.events.map(entry => entry.event.seq)).toEqual([...sources, message.seq])
      expect(response.result.value.hasMore).toBe(true)
    } finally {
      min.mockRestore()
    }
  })

  it('drops a disposed session from the live open-call table (result after dispose gets no view)', async () => {
    const { ctx } = await harness()
    const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const abort = new AbortController()
    const stream = api.events.mux({ rpcId: RpcId('t-mux3'), payload: {} }, abort.signal)

    let session: Session | undefined
    const fiber = await ctx.plugin(Object.assign((inner: Context) => {
      session = inner.sessions.create('session-doomed' as SessionId)
    }, { inject: ['sessions'] }))
    session?.append('turn/start', { turn: 1 })
    session?.append('tool/call', { turn: 1, step: 1, callId: CallId('c-doomed'), name: 'term', arguments: '{"cmd":"x"}' })
    // Disposing the owning fiber detaches the session mid-stream; the
    // session/disposed listener must clear its open-call table entry.
    await fiber.dispose()

    const frames = await collect(stream, 2, abort)
    const call = frames.find(f => f.type === 'session/event' && f.event.type === 'tool/call')
    expect(call?.type === 'session/event' && call.view?.for).toBe('call')
  })

  it('pairs a result after turn/end via the in-memory backscan fallback', async () => {
    const { ctx } = await harness()
    const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const abort = new AbortController()
    const stream = api.events.mux({ rpcId: RpcId('t-mux2'), payload: {} }, abort.signal)
    const collected = collect(stream, 4, abort)

    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    session.append('tool/call', { turn: 1, step: 1, callId: CallId('c-late'), name: 'term', arguments: '{"cmd":"tail"}' })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    // The turn/end above cleared the live table; pairing must fall back to
    // scanning the session's in-memory events.
    session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: CallId('c-late'),
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })

    const frames = await collected
    const result = frames.find(f => f.type === 'session/event' && f.event.type === 'tool/result')
    expect(result?.type === 'session/event' && result.view).toEqual({ for: 'result', view: { card: 'terminal', output: 'done' } })
  })
})

describe('history page byte limit', () => {
  /** Serialized wire-entry replica; tool views only exist where a presenter matched. */
  const entryBytes = (event: SessionEvent, view?: HistoryEntry['view']): number =>
    Buffer.byteLength(JSON.stringify({ event, ...view === undefined ? {} : { view } }), 'utf8')

  /** Total serialized bytes of the log suffix starting at fromSeq, with optional views. */
  const windowBytes = (log: SessionEvent[], fromSeq: number, views?: Map<number, HistoryEntry['view']>): number =>
    log.filter(event => event.seq >= fromSeq).reduce((sum, event) => sum + entryBytes(event, views?.get(event.seq)), 0)

  const sessionWith = async (): Promise<{ ctx: Context; session: Session; log: SessionEvent[] }> => {
    const { ctx } = await harness()
    const session = ctx.sessions.create()
    ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
    const log: SessionEvent[] = []
    log.push(session.append('turn/start', { turn: 1 }))
    return { ctx, session, log }
  }

  const apiWith = (ctx: Context, historyPageMaxBytes: number) => createApiProxy(ctx, {
    defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
    cwd: '/tmp',
    historyPageMaxBytes,
  })

  const readPage = async (api: ReturnType<typeof createApiProxy>, sessionId: SessionId):
  Promise<{ events: HistoryEntry[]; hasMore: boolean }> => {
    const response = await api.sessions.history({ rpcId: RpcId('t-hist-bytes'), payload: { sessionId } })
    expect(response.result.ok).toBe(true)
    if (!response.result.ok) throw new Error('unreachable')
    return response.result.value
  }

  const readWire = async (api: ReturnType<typeof createApiProxy>, sessionId: SessionId):
  Promise<{ rpcId: RpcId; result: { ok: boolean; value?: unknown } }> => {
    const response = await api.sessions.history({ rpcId: RpcId('t-hist-bytes'), payload: { sessionId } })
    expect(response.result.ok).toBe(true)
    return response
  }

  /**
   * Serialized bytes around the events array of one history RPC response,
   * reproduced from the gateway's own accounting: the `ok()` envelope (the
   * `{}` placeholder stands where the real value serializes) plus the value
   * shell with an empty events array. The filled array adds one comma per
   * gap, priced against the kept count by each test.
   */
  const frameBytes = (hasMore: boolean, projections?: unknown): number =>
    Buffer.byteLength(JSON.stringify({ rpcId: RpcId('t-hist-bytes'), result: { ok: true, value: {} } }), 'utf8') - 2
    + Buffer.byteLength(JSON.stringify({ events: [], hasMore, ...projections === undefined ? {} : { projections } }), 'utf8')

  const BIG_TEXT = 'p'.repeat(4_000)
  const bigStateUnit = () => ({
    key: 'test/big',
    stateSchema: z.string(),
    init: () => BIG_TEXT,
    apply: state => state,
    wire: { viewSchema: z.string(), view: state => state },
    stateVersion: 1,
  }) satisfies ProjectionDefinition<'test/big', string>

  const projectionSessionWith = async (): Promise<{ ctx: Context; session: Session; log: SessionEvent[] }> => {
    const { ctx } = await harness()
    await ctx.plugin(SessionProjectionRegistry)
    ctx.sessionProjections.register(bigStateUnit())
    const session = ctx.sessions.create()
    ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
    const log: SessionEvent[] = []
    log.push(session.append('turn/start', { turn: 1 }))
    return { ctx, session, log }
  }

  it('keeps a page that fits the budget untouched, hasMore included', async () => {
    const { ctx, session, log } = await sessionWith()
    log.push(appendUserText(session, 'first'))
    log.push(appendAssistantText(session, 'first reply', 1))
    log.push(appendUserText(session, 'second'))
    log.push(appendAssistantText(session, 'second reply', 2))
    const budget = frameBytes(false) + windowBytes(log, log[0]!.seq) + (log.length - 1)
    const page = await readPage(apiWith(ctx, budget), session.id)
    expect(page.events.map(entry => entry.event.seq)).toEqual(log.map(event => event.seq))
    expect(page.hasMore).toBe(false)
  })

  it('drops the oldest whole message groups at the exact budget and turns hasMore on', async () => {
    const { ctx, session, log } = await sessionWith()
    log.push(appendUserText(session, 'first'))
    log.push(appendAssistantText(session, 'first reply', 1))
    const third = appendUserText(session, 'second')
    log.push(third)
    log.push(appendAssistantText(session, 'second reply', 2))
    const budget = frameBytes(false) + windowBytes(log, third.seq) + 1
    const page = await readPage(apiWith(ctx, budget), session.id)
    // The second exchange fills the budget exactly and survives intact; the
    // oldest group is dropped whole and the kept range stays contiguous.
    expect(page.events.map(entry => entry.event.seq)).toEqual([third.seq, third.seq + 1])
    expect(page.hasMore).toBe(true)
  })

  it('keeps the newest message group whole even when it alone exceeds the budget', async () => {
    const { ctx, session, log } = await sessionWith()
    log.push(appendUserText(session, 'first'))
    log.push(appendAssistantText(session, 'first reply', 1))
    const last = appendAssistantText(session, 'last reply', 2)
    log.push(last)
    const page = await readPage(apiWith(ctx, 1), session.id)
    expect(page.events.map(entry => entry.event.seq)).toEqual([last.seq])
    expect(page.hasMore).toBe(true)
  })

  it('cuts at the group start of a chunked message instead of mid-stream', async () => {
    const { ctx, session, log } = await sessionWith()
    log.push(appendUserText(session, 'first'))
    log.push(appendAssistantText(session, 'first reply', 1))
    const sources = Array.from({ length: 64 }, (_unused, index) => session.append('assistant/chunk', {
      turn: 1,
      step: 2,
      chunk: { type: 'text-delta', index, text: 'y'.repeat(200) },
    }).seq)
    const message = session.append('assistant/message', {
      turn: 1,
      step: 2,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'y'.repeat(200 * sources.length) }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: sources })
    const budget = entryBytes(log[0] as SessionEvent)
    const page = await readPage(apiWith(ctx, budget), session.id)
    const expected = [...sources, message.seq]
    expect(page.events.map(entry => entry.event.seq)).toEqual(expected)
    expect(page.hasMore).toBe(true)
  })

  it('accounts multibyte text in UTF-8 bytes, not UTF-16 code units', async () => {
    const { ctx, session, log } = await sessionWith()
    log.push(appendUserText(session, '你'.repeat(60)))
    const last = appendAssistantText(session, '你'.repeat(600), 1)
    log.push(last)
    // Code-unit accounting would see the whole log under this budget and
    // serve it; UTF-8 accounting must keep only the newest group.
    const codeUnits = log.reduce((sum, event) => sum + JSON.stringify({ event }).length, 0)
    const page = await readPage(apiWith(ctx, codeUnits), session.id)
    expect(page.events.map(entry => entry.event.seq)).toEqual([last.seq])
    expect(page.hasMore).toBe(true)
  })

  it('counts host-computed view bytes toward the page budget', async () => {
    const { ctx, session, log } = await sessionWith()
    log.push(appendUserText(session, 'old'))
    log.push(appendAssistantText(session, 'old reply', 1))
    const third = appendUserText(session, 'new')
    log.push(third)
    log.push(appendAssistantText(session, 'new reply', 2))
    const call = session.append('tool/call', { turn: 1, step: 3, callId: CallId('c-budget'), name: 'term', arguments: '{"cmd":"ls"}' })
    log.push(call)
    const result = session.append('tool/result', {
      turn: 1, step: 3,
      message: createToolResultMessage({
        callId: CallId('c-budget'),
        content: [{ type: 'text', text: 'ok' }],
        isError: false,
      }),
    }, { surfaceOp: 'append' })
    log.push(result)
    const oldReply = log[2] as SessionEvent
    const views = new Map<number, HistoryEntry['view']>([
      [call.seq, { for: 'call', view: { card: 'terminal', title: 'ls' } }],
      [result.seq, { for: 'result', view: { card: 'terminal', output: 'done' } }],
    ])
    // Budget: the whole old-message suffix (plus response frame) minus one
    // fits only when the two tool views are excluded from the accounting.
    const budget = frameBytes(false) + windowBytes(log, oldReply.seq, views) + 4 - 1
    const page = await readPage(apiWith(ctx, budget), session.id)
    // View-aware accounting keeps the newest group; viewless accounting would
    // have pulled the oldest reply in as well under the same budget.
    expect(page.events.map(entry => entry.event.seq)).toEqual(log.filter(e => e.seq >= third.seq).map(e => e.seq))
    expect(page.hasMore).toBe(true)
  })

  it('keeps the newest fitting suffix when an older group at the page head breaks the budget', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create()
    ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
    // No turn/start: the oldest message group starts at page index zero, so a
    // naive kept-count would snap back to the whole page length when the head
    // candidate breaks the budget. Three complete groups: solo / first pair /
    // second pair.
    const log: SessionEvent[] = []
    log.push(appendUserText(session, 'solo'))
    log.push(appendUserText(session, 'first'))
    log.push(appendAssistantText(session, 'first reply', 1))
    log.push(appendUserText(session, 'second'))
    log.push(appendAssistantText(session, 'second reply', 2))
    // The [first pair, second pair] suffix fills the budget exactly; the solo
    // head group pushes it over.
    const budget = frameBytes(false) + windowBytes(log, 1) + 3
    const api = apiWith(ctx, budget)
    const page = await readPage(api, session.id)
    expect(page.events.map(entry => entry.event.seq)).toEqual(log.slice(1).map(event => event.seq))
    expect(page.hasMore).toBe(true)
    // The complete ok() RPC response serializes within the budget.
    const wire = await readWire(api, session.id)
    expect(Buffer.byteLength(JSON.stringify(wire), 'utf8')).toBeLessThanOrEqual(budget)
  })

  it('drops a projections block that alone keeps the page over budget', async () => {
    const { ctx, session, log } = await projectionSessionWith()
    log.push(appendUserText(session, 'first'))
    log.push(appendAssistantText(session, 'first reply', 1))
    log.push(appendUserText(session, 'second'))
    log.push(appendAssistantText(session, 'second reply', 2))
    // With the projections block attached, even the newest message group is
    // over budget; without it, that exchange fits exactly. The block is dropped
    // for this read rather than shipping an over-budget page.
    const budget = frameBytes(false) + windowBytes(log, 3) + 1
    const api = apiWith(ctx, budget)
    const page = await readPage(api, session.id)
    expect(page.events.map(entry => entry.event.seq)).toEqual([log[3]!.seq, log[4]!.seq])
    expect(page.hasMore).toBe(true)
    expect('projections' in page).toBe(false)
    const wire = await readWire(api, session.id)
    expect(Buffer.byteLength(JSON.stringify(wire), 'utf8')).toBeLessThanOrEqual(budget)
  })

  it('counts a projections block inside the budget when the page still fits', async () => {
    const { ctx, session, log } = await projectionSessionWith()
    log.push(appendUserText(session, 'first'))
    log.push(appendAssistantText(session, 'first reply', 1))
    log.push(appendUserText(session, 'second'))
    log.push(appendAssistantText(session, 'second reply', 2))
    // Price the block the gateway will attach: the test unit plus the
    // gateway's own fixed-shape sessionListMetadata unit (registered when
    // createApiProxy runs, so it cannot be snapshotted before the budget is
    // chosen). Digit lengths are fixed (13-digit timestamps), so the
    // reconstruction differs from the real shell by only registration-order
    // quoting — far below the 64-byte slack, and far below one message group.
    const reconstructedBlock = {
      asOfSeq: log[log.length - 1]!.seq,
      values: {
        'test/big': BIG_TEXT,
        sessionListMetadata: { blank: false, lastPromptAt: 1_000_000_000_000 },
      },
    }
    // The newest exchange plus the (weighty) projections block fits; the
    // older exchange pushes the page over.
    const budget = frameBytes(false, reconstructedBlock) + windowBytes(log, 3) + 1 + 64
    const api = apiWith(ctx, budget)
    const page = await readPage(api, session.id)
    expect(page.events.map(entry => entry.event.seq)).toEqual([log[3]!.seq, log[4]!.seq])
    expect(page.hasMore).toBe(true)
    expect('projections' in page).toBe(true)
    const wire = await readWire(api, session.id)
    expect(Buffer.byteLength(JSON.stringify(wire), 'utf8')).toBeLessThanOrEqual(budget)
  })

  it('keeps the newest group whole and drops projections when the group alone exceeds the budget', async () => {
    const { ctx, session, log } = await projectionSessionWith()
    log.push(appendUserText(session, 'first'))
    log.push(appendAssistantText(session, 'first reply', 1))
    log.push(appendUserText(session, 'second'))
    log.push(appendAssistantText(session, 'second reply', 2))
    // Far below any entry: the bound's sole over-budget escape is the newest
    // message group itself — the projections block must not ride along.
    const api = apiWith(ctx, 1)
    const page = await readPage(api, session.id)
    expect(page.events.map(entry => entry.event.seq)).toEqual([log[4]!.seq])
    expect(page.hasMore).toBe(true)
    expect('projections' in page).toBe(false)
  })

  it('serves uncut pages when the budget is disabled (zero)', async () => {
    const { ctx, session, log } = await sessionWith()
    log.push(appendUserText(session, 'first'))
    log.push(appendAssistantText(session, 'first reply', 1))
    const page = await readPage(apiWith(ctx, 0), session.id)
    expect(page.events.map(entry => entry.event.seq)).toEqual(log.map(event => event.seq))
    expect(page.hasMore).toBe(false)
  })
})
