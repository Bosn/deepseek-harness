/** Raw Session journal transport and message-aligned pagination coverage. */

import { Buffer } from 'node:buffer'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionSeq } from '@deepseek-ai/dsh-session'
import { decodeStorageRecord, type ChunkRow } from '@deepseek-ai/dsh-session/chunk-rows'
import { ToolCallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionObservation } from '@deepseek-ai/dsh-session-query'
import SessionController, {
  DEFAULT_HISTORY_PAGE_MAX_BYTES,
} from '@deepseek-ai/dsh-api-session-controller/src/index.ts'
import { SessionHistoryController } from '@deepseek-ai/dsh-api-session-controller/src/history.ts'
import type {
  ChunkRowEvent,
  SessionFollowFrame,
  SessionHistoryRecord,
  SessionPage,
  SessionWireEvent,
} from '@deepseek-ai/dsh-api-session-controller/types'
import { createSessionTestRemote, installSessionReadTestServices } from './test-remote.ts'

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
  await ctx.plugin(AgentRegistry)
  installSessionReadTestServices(ctx)
  return { ctx }
}

/** Drain one Session follow until `count` event frames arrive. */
async function collect(
  iterable: AsyncIterable<SessionFollowFrame>,
  count: number,
  abort: AbortController,
): Promise<SessionFollowFrame[]> {
  const frames: SessionFollowFrame[] = []
  for await (const frame of iterable) {
    frames.push(frame)
    if (frames.filter(candidate => candidate.type === 'event').length >= count) abort.abort()
  }
  return frames
}

/** Open follow and wait until its cursor is fixed before appending fixtures. */
async function openFollow(
  history: SessionHistoryController,
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<AsyncIterable<SessionFollowFrame>> {
  const iterator = history.follow({
    address: { kind: 'session', sessionId },
  }, signal)[Symbol.asyncIterator]()
  await expect(iterator.next()).resolves.toMatchObject({
    done: false,
    value: { type: 'snapshot' },
  })
  return { [Symbol.asyncIterator]: () => iterator }
}

/** Expand packed page records for assertions over the logical journal. */
function pageEvents(page: SessionPage): SessionWireEvent[] {
  return page.records.flatMap(record => record.type === 'event'
    ? [record.event]
    : decodeStorageRecord(chunkRow(record.event)).map(event => event as unknown as SessionWireEvent))
}

const CARRIER_UUID = '00000000-0000-4000-8000-000000000000'

/** Price the complete Connection response emitted for one history page. */
function pageCarrierBytes(page: SessionPage): number {
  return Buffer.byteLength(JSON.stringify({
    type: 'server-response',
    rpcId: CARRIER_UUID,
    result: { ok: true, value: page },
  }), 'utf8')
}

/** Price the complete Gateway stream message emitted for one follow frame. */
function followCarrierBytes(frame: SessionFollowFrame): number {
  return Buffer.byteLength(JSON.stringify({
    type: 'item',
    streamId: CARRIER_UUID,
    value: frame,
  }), 'utf8')
}

/** First logical Session sequence represented by one scalar or packed record. */
function recordFirstSeq(record: SessionHistoryRecord): number {
  return record.event.seq
}

function chunkRow(event: ChunkRowEvent): ChunkRow {
  switch (event.type) {
    case 'chunkrow/text-chunks':
      return { type: 'text-chunks', seq0: SessionSeq(event.seq), time0: event.time, data: event.data }
    case 'chunkrow/reasoning-chunks':
      return { type: 'reasoning-chunks', seq0: SessionSeq(event.seq), time0: event.time, data: event.data }
    case 'chunkrow/tool-call-chunks':
      return { type: 'tool-call-chunks', seq0: SessionSeq(event.seq), time0: event.time, data: event.data }
  }
}

describe('Session history raw journal', () => {
  it('bounds the complete unary response at UTF-8 message-group boundaries', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    appendUserText(session, '旧'.repeat(600))
    const sources = Array.from({ length: 3 }, () => session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: '中'.repeat(80) },
    }).seq)
    const grouped = session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: '中'.repeat(240) }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: sources })
    const newest = appendUserText(session, 'newest')
    const disabled = new SessionHistoryController(
      ctx,
      (observation) => { observation[Symbol.dispose]() },
      0,
    )
    const request = {
      address: { kind: 'session' as const, sessionId: session.id },
      throughSeq: newest.seq,
    }
    const full = await disabled.page(request, new AbortController().signal)
    const cut = full.records.findIndex(record => recordFirstSeq(record) >= sources[0]!)
    const expected: SessionPage = { records: full.records.slice(cut), hasMore: true }
    const exactBudget = pageCarrierBytes(expected)
    const bounded = new SessionHistoryController(
      ctx,
      (observation) => { observation[Symbol.dispose]() },
      exactBudget,
    )

    const page = await bounded.page(request, new AbortController().signal)

    expect(page).toEqual(expected)
    expect(page.records[0]).toMatchObject({
      type: 'chunks',
      event: { seq: sources[0] },
    })
    expect(pageEvents(page).map(event => event.seq)).toEqual([
      ...sources,
      grouped.seq,
      newest.seq,
    ])
    expect(pageCarrierBytes(page)).toBe(exactBudget)
    expect(page.hasMore).toBe(true)
    await ctx.fiber.dispose()
  })

  it('keeps one oversized newest packed group whole and allows zero to disable the bound', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    appendUserText(session, 'older')
    const sources = Array.from({ length: 4 }, () => session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: '界'.repeat(500) },
    }).seq)
    const newest = session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: '界'.repeat(2_000) }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: sources })
    const request = {
      address: { kind: 'session' as const, sessionId: session.id },
      throughSeq: newest.seq,
    }
    const tiny = new SessionHistoryController(
      ctx,
      (observation) => { observation[Symbol.dispose]() },
      64,
    )
    const disabled = new SessionHistoryController(
      ctx,
      (observation) => { observation[Symbol.dispose]() },
      0,
    )

    const page = await tiny.page(request, new AbortController().signal)
    const full = await disabled.page(request, new AbortController().signal)

    expect(pageEvents(page).map(event => event.seq)).toEqual([...sources, newest.seq])
    expect(page.records[0]).toMatchObject({ type: 'chunks', event: { seq: sources[0] } })
    expect(page.hasMore).toBe(true)
    expect(pageCarrierBytes(page)).toBeGreaterThan(64)
    expect(pageEvents(full).map(event => event.seq)).toEqual([0, ...sources, newest.seq])
    expect(full.hasMore).toBe(false)
    await ctx.fiber.dispose()
  })

  it('cuts a byte-bounded page after packed tool-call chunks', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    session.append('turn/start', { turn: 1 })
    appendUserText(session, 'older')
    const callId = ToolCallId('byte-bounded-call')
    const sources = Array.from({ length: 3 }, () => session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: {
        type: 'tool-call-delta',
        index: 0,
        id: callId,
        argumentsDelta: 'x'.repeat(100),
      },
    }).seq)
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{
          type: 'tool-call',
          id: callId,
          name: 'fixture',
          arguments: 'x'.repeat(300),
        }],
        source: { kind: 'model', provider: 'p', model: 'm' },
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: sources })
    const newest = appendUserText(session, 'newest')
    const request = {
      address: { kind: 'session' as const, sessionId: session.id },
      throughSeq: newest.seq,
    }
    const disabled = new SessionHistoryController(
      ctx,
      (observation) => { observation[Symbol.dispose]() },
      0,
    )
    const full = await disabled.page(request, new AbortController().signal)
    const expected: SessionPage = { records: full.records.slice(-1), hasMore: true }
    const bounded = new SessionHistoryController(
      ctx,
      (observation) => { observation[Symbol.dispose]() },
      pageCarrierBytes(expected),
    )

    const page = await bounded.page(request, new AbortController().signal)

    expect(full.records[2]).toMatchObject({
      type: 'chunks',
      event: {
        type: 'chunkrow/tool-call-chunks',
        data: { args: ['x'.repeat(100), 'x'.repeat(100), 'x'.repeat(100)] },
      },
    })
    expect(page).toEqual(expected)
    expect(pageEvents(page).map(event => event.seq)).toEqual([newest.seq])
    await ctx.fiber.dispose()
  })

  it('keeps an indivisible non-message page whole when it exceeds the byte bound', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const extension = appendExtension(session, 'fixture/large', { text: '界'.repeat(1_000) })
    const bounded = new SessionHistoryController(
      ctx,
      (observation) => { observation[Symbol.dispose]() },
      64,
    )

    const page = await bounded.page({
      address: { kind: 'session', sessionId: session.id },
      throughSeq: extension.seq,
    }, new AbortController().signal)

    expect(pageEvents(page).map(event => event.seq)).toEqual([extension.seq])
    expect(page.hasMore).toBe(false)
    expect(pageCarrierBytes(page)).toBeGreaterThan(64)
    await ctx.fiber.dispose()
  })

  it('drops an indivisible projection baseline before exceeding a follow carrier budget', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    appendUserText(session, 'short')
    ctx.provide('sessionQuery', {
      observeSession: () => Promise.resolve({
        source: 'live',
        header: session.header,
        events: session.snapshotEvents(),
        cursor: session.seq - 1,
        projections: {
          asOfSeq: session.seq - 1,
          values: { 'fixture/large': '投影'.repeat(2_000) },
        },
        retain: vi.fn(),
        [Symbol.dispose]: vi.fn(),
      } as unknown as SessionObservation),
    } as never)
    const unbounded = new SessionHistoryController(ctx, vi.fn(), 0)
    const firstAbort = new AbortController()
    const firstIterator = unbounded.follow({
      address: { kind: 'session', sessionId: session.id },
    }, firstAbort.signal)[Symbol.asyncIterator]()
    const first = await firstIterator.next()
    firstAbort.abort()
    await firstIterator.return?.()
    if (first.done || first.value.type !== 'snapshot') throw new Error('missing opening snapshot')
    const expected = { ...first.value }
    delete expected.projections
    const budget = followCarrierBytes(expected)
    const bounded = new SessionHistoryController(ctx, vi.fn(), budget)
    const abort = new AbortController()
    const iterator = bounded.follow({
      address: { kind: 'session', sessionId: session.id },
    }, abort.signal)[Symbol.asyncIterator]()

    const result = await iterator.next()
    abort.abort()
    await iterator.return?.()
    if (result.done || result.value.type !== 'snapshot') throw new Error('missing bounded snapshot')
    expect(result.value.projections).toBeUndefined()
    expect(result.value.records).toHaveLength(1)
    expect(followCarrierBytes(result.value)).toBe(budget)
    await ctx.fiber.dispose()
  })

  it('validates the configurable history carrier budget', () => {
    expect(SessionController.Config({}).historyPageMaxBytes).toBe(DEFAULT_HISTORY_PAGE_MAX_BYTES)
    expect(SessionController.Config({ historyPageMaxBytes: 0 }).historyPageMaxBytes).toBe(0)
    for (const historyPageMaxBytes of [-1, 1.5]) {
      expect(() => SessionController.Config({ historyPageMaxBytes })).toThrow()
    }
  })

  it('follows raw tool events and preserves result metadata without a Tools service', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const abort = new AbortController()
    const stream = await openFollow(history, session.id, abort.signal)
    const collected = collect(stream, 2, abort)
    const call = session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('raw-call'), name: 'custom', arguments: '{malformed',
    })
    const result = session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('raw-call'),
        content: [{ type: 'text', text: 'raw output' }],
        isError: false,
      }),
      meta: { nested: { count: 2 }, paths: ['a.ts', 'b.ts'] },
    }, { surfaceOp: 'append' })

    const frames = await collected
    expect(frames).toEqual([
      { type: 'event', event: call },
      { type: 'event', event: result },
    ])
    expect((frames[1] as Extract<SessionFollowFrame, { type: 'event' }>).event.data)
      .toMatchObject({ meta: { nested: { count: 2 }, paths: ['a.ts', 'b.ts'] } })
  })

  it('follows live results without rescanning Session history', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const abort = new AbortController()
    const stream = await openFollow(history, session.id, abort.signal)
    const iterator = stream[Symbol.asyncIterator]()

    session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('live-fast'), name: 'term', arguments: '{"cmd":"pwd"}',
    })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'event', event: { type: 'tool/call', data: { callId: 'live-fast' } } },
    })

    const events = vi.spyOn(session, 'snapshotEvents').mockImplementation(() => {
      throw new Error('live result rescanned Session history')
    })
    try {
      session.append('tool/result', {
        turn: 1, step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('live-fast'),
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      await expect(iterator.next()).resolves.toMatchObject({
        value: { type: 'event', event: { type: 'tool/result', data: { message: { source: { callId: 'live-fast' } } } } },
      })
    } finally {
      events.mockRestore()
      abort.abort()
      await iterator.next()
      await ctx.fiber.dispose()
    }
  })

  it('serves raw call and result entries without parsing tool arguments', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const start = session.append('turn/start', { turn: 1 })
    const call = session.append('tool/call', {
      turn: 1, step: 1, callId: ToolCallId('history-call'), name: 'custom', arguments: '{broken',
    })
    const result = session.append('tool/result', {
      turn: 1, step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('history-call'),
        content: [{ type: 'text', text: 'failed raw output' }],
        isError: true,
      }),
      meta: { persisted: true, count: 3 },
    }, { surfaceOp: 'append' })

    const response = await remote.page({
      address: { kind: 'session', sessionId: session.id },
      throughSeq: session.seq - 1,
    })
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error('unreachable')
    expect(response.value.records).toEqual([
      { type: 'event', event: start },
      { type: 'event', event: call },
      { type: 'event', event: result },
    ])
  })

  it('counts only append-origin messages toward maxMessages and keeps each compaction summary with its replacement', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    session.append('turn/start', { turn: 1 })
    const first = appendUserText(session, 'first prompt')
    appendAssistantText(session, 'first reply', 1)
    const third = appendUserText(session, 'second prompt')
    appendAssistantText(session, 'second reply', 2)
    const shadowed = [...session.surface.nodes]
    const shadowedStart = shadowed[0]
    const shadowedEnd = shadowed.at(-1)
    if (shadowedStart === undefined || shadowedEnd === undefined) {
      throw new Error('expected a non-empty surface')
    }
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
      surfaceOp: { op: 'replace', start: shadowedStart, end: shadowedEnd },
      sourceEventSeqs: [...shadowed, summary.seq],
    })

    const response = await remote.page({
      address: { kind: 'session', sessionId: session.id },
      throughSeq: session.seq - 1,
      maxMessages: 2,
    })
    if (!response.ok) throw new Error('unreachable')
    const page = pageEvents(response.value)
    // Two append-origin messages fill the page even though a replacement copy of
    // the same event type sits in the window: the copy is model-only.
    const messages = page.filter(event => event.type === 'user/message' || event.type === 'assistant/message')
    expect(messages.map(event => event.seq)).toEqual([third.seq, third.seq + 1, third.seq + 3])
    expect(page.some(event => event.seq === first.seq)).toBe(false)
    expect(response.value.hasMore).toBe(true)
    // The range stays contiguous, so the checkpoint's summary record is readable on
    // the same page as the checkpoint itself.
    const summaryIndex = page.findIndex(event => event.seq === summary.seq)
    expect(summaryIndex).toBeGreaterThan(-1)
    expect(page[summaryIndex + 1]?.seq).toBe(summary.seq + 1)
    expect(page.map(event => event.seq)).toEqual(page.map((_event, index) => third.seq + index))
  })

  it('paginates a message with many provenance sources without variadic argument expansion', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    session.append('turn/start', { turn: 1 })
    const sources = Array.from({ length: 128 }, () => session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'text-delta', index: 0, text: 'x' },
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
      const response = await remote.page({
        address: { kind: 'session', sessionId: session.id },
        throughSeq: message.seq,
        maxMessages: 1,
      })
      if (!response.ok) throw new Error('unreachable')
      expect(pageEvents(response.value).map(event => event.seq)).toEqual([...sources, message.seq])
      expect(response.value.records.filter(record => record.type === 'chunks')).toHaveLength(1)
      expect(response.value.hasMore).toBe(true)
    } finally {
      min.mockRestore()
    }
  })

  it('encodes reasoning and tool-call runs as aligned chunk events', async () => {
    const { ctx } = await harness()
    const remote = createSessionTestRemote(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const reasoning = [0, 1, 2].map(index => session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'reasoning-delta', index: 0, text: `r${String(index)}` },
    }))
    const callId = ToolCallId('packed-call')
    const toolCall = [0, 1, 2].map(index => session.append('assistant/chunk', {
      turn: 1,
      step: 1,
      chunk: { type: 'tool-call-delta', index: 1, id: callId, argumentsDelta: `a${String(index)}` },
    }))

    const response = await remote.page({
      address: { kind: 'session', sessionId: session.id },
      throughSeq: session.seq - 1,
    })
    if (!response.ok) throw new Error('unreachable')
    expect(response.value.records).toEqual([
      {
        type: 'chunks',
        event: {
          type: 'chunkrow/reasoning-chunks',
          seq: reasoning[0]?.seq,
          time: reasoning[0]?.time,
          data: {
            turn: 1,
            step: 1,
            index: 0,
            dt: reasoning.slice(1).map((event, index) => event.time - (reasoning[index]?.time ?? 0)),
            texts: ['r0', 'r1', 'r2'],
          },
        },
      },
      {
        type: 'chunks',
        event: {
          type: 'chunkrow/tool-call-chunks',
          seq: toolCall[0]?.seq,
          time: toolCall[0]?.time,
          data: {
            turn: 1,
            step: 1,
            index: 1,
            id: callId,
            dt: toolCall.slice(1).map((event, index) => event.time - (toolCall[index]?.time ?? 0)),
            args: ['a0', 'a1', 'a2'],
          },
        },
      },
    ])
    await ctx.fiber.dispose()
  })

  it('follows a result after turn/end without reading the addressed Session log', async () => {
    const { ctx } = await harness()
    const session = ctx.sessions.create(undefined, { meta: { cwd: '/workspace' } })
    const history = new SessionHistoryController(ctx, (observation) => { observation[Symbol.dispose]() })
    const abort = new AbortController()
    const stream = await openFollow(history, session.id, abort.signal)
    const iterator = stream[Symbol.asyncIterator]()

    session.append('turn/start', { turn: 1 })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'event', event: { type: 'turn/start' } },
    })
    session.append('tool/call', { turn: 1, step: 1, callId: ToolCallId('c-late'), name: 'term', arguments: '{"cmd":"tail"}' })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'event', event: { type: 'tool/call' } },
    })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await expect(iterator.next()).resolves.toMatchObject({
      value: { type: 'event', event: { type: 'turn/end' } },
    })
    const events = vi.spyOn(session, 'snapshotEvents').mockImplementation(() => {
      throw new Error('live result rescanned Session history')
    })
    try {
      const result = session.append('tool/result', {
        turn: 1, step: 1,
        message: createToolResultMessage({
          callId: ToolCallId('c-late'),
          content: [{ type: 'text', text: 'ok' }],
          isError: false,
        }),
      }, { surfaceOp: 'append' })
      await expect(iterator.next()).resolves.toEqual({
        done: false,
        value: { type: 'event', event: result },
      })
    } finally {
      events.mockRestore()
      abort.abort()
      await iterator.next()
      await ctx.fiber.dispose()
    }
  })
})
