/** Cold Session history pagination and live-event source. */

import { Buffer } from 'node:buffer'
import type { Context } from '@deepseek-ai/cordis'
import { Deque } from '@deepseek-ai/dsh-deque'
import {
  isAppendSurfaceEvent,
  SessionLogOffset,
  SessionSeq,
} from '@deepseek-ai/dsh-session'
import { isChunkRow, packChunkRuns, type ChunkRow } from '@deepseek-ai/dsh-session/chunk-rows'
import type {
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset as SessionLogOffsetType,
  SessionSeqCursor,
} from '@deepseek-ai/dsh-session'
import { SessionQueryError, type SessionObservation } from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-subagent'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type {
  SessionAddress,
  SessionChunkRun,
  SessionEventEntry,
  SessionFollowRequest,
  SessionFollowFrame,
  SessionHistoryRecord,
  SessionPage,
  SessionPageRequest,
  SessionProjectionBaseline,
  SessionProjectionValues,
  SessionWireHeader,
  SessionWireEvent,
} from './types.ts'

const DEFAULT_MAX_MESSAGES = 50
const MESSAGE_TYPES = new Set(['user/message', 'assistant/message'])
// Browser Connection and Gateway clients mint 36-byte UUIDs for both carrier identifiers.
const CARRIER_UUID = '00000000-0000-4000-8000-000000000000'

/** Default maximum UTF-8 size of one browser-carried history page or opening snapshot. */
export const DEFAULT_HISTORY_PAGE_MAX_BYTES = 2 * 1024 * 1024

/** Implements cold-safe history operations delegated by the Session Controller. */
export class SessionHistoryController {
  private readonly closeFollowers = new Set<() => void>()

  /**
   * @param ctx - Host context carrying Session query and projection services.
   * @param promote - starts ordinary Session activation after snapshot delivery.
   * @param maxPageBytes - complete browser-carrier byte budget; zero disables the bound.
   */
  constructor(
    private readonly ctx: Context,
    private readonly promote: (observation: SessionObservation) => void,
    private readonly maxPageBytes = DEFAULT_HISTORY_PAGE_MAX_BYTES,
  ) {
    ctx.effect(() => () => {
      for (const close of this.closeFollowers) close()
      this.closeFollowers.clear()
    }, 'session-controller.history')
  }

  /**
   * Read one message-aligned history page without activating an Agent.
   * @param request - durable address and backwards-page cursor.
   * @param signal - caller cancellation for persistence reads.
   * @returns a contiguous event page.
   */
  async page(request: SessionPageRequest, signal: AbortSignal): Promise<SessionPage> {
    validatePageRequest(request)
    const throughSeq: SessionSeqCursor = request.throughSeq === -1
      ? -1
      : SessionSeq(request.throughSeq)
    const beforeSeq = request.beforeSeq === undefined
      ? undefined
      : SessionLogOffset(request.beforeSeq)
    using source = await this.sourceFor(request.address, signal, false)
    signal.throwIfAborted()
    const sourceLog = source.events
    const sourceCursor: SessionSeqCursor = sourceLog.at(-1)?.seq ?? -1
    if (throughSeq > sourceCursor) {
      throw new RemoteError(
        'gateway/bad-request',
        `session page through seq ${String(throughSeq)} is past cursor ${String(sourceCursor)}`,
        {},
      )
    }
    /* v8 ignore next -- Session and persistence validation guarantee a dense zero-based event prefix. */
    if (throughSeq >= 0 && sourceLog[throughSeq]?.seq !== throughSeq) {
      throw new RemoteError('gateway/internal', `session log does not contain through seq ${String(throughSeq)}`, {})
    }
    const page = paginate(
      sourceLog,
      beforeSeq,
      request.maxMessages ?? DEFAULT_MAX_MESSAGES,
      throughSeq,
    )
    const records = pageRecords(page.events)
    return boundHistoryValue({
      records,
      hasMore: page.hasMore,
    }, this.maxPageBytes, unaryCarrierBytes)
  }

  /**
   * Follow events appended after an initial cursor on one durable address.
   * @param request - durable address and last committed sequence already held by the caller.
   * @param signal - stream cancellation owned by the Remote carrier.
   * @returns a complete opening snapshot followed by gap-free event frames.
   */
  async *follow(request: SessionFollowRequest, signal: AbortSignal): AsyncIterable<SessionFollowFrame> {
    validateFollowRequest(request)
    const { address } = request
    const target = addressId(address)
    const buffered = new Deque<SessionEvent>()
    let snapshotCursor: SessionSeqCursor | undefined
    let wake: (() => void) | undefined
    const notify = (): void => {
      const resume = wake
      wake = undefined
      resume?.()
    }
    const follower = { closed: false }
    const close = (): void => {
      follower.closed = true
      notify()
    }
    this.closeFollowers.add(close)
    const disposeEvent = this.ctx.on('session/event', (session, event) => {
      if (session.id !== target) return
      buffered.pushBack(event)
      notify()
    }, { global: true })
    const disposeCreated = this.ctx.on('session/created', (session) => {
      if (session.id !== target) return
      // Constructor seed events have no session/event notification. Normally
      // only the end-seed suffix is new; if persistence advanced after the
      // opening observation, replay everything beyond that snapshot cursor.
      const suffix = session.snapshotEvents(snapshotCursor === undefined
        ? session.firstLiveSeq
        : SessionLogOffset(snapshotCursor + 1))
      for (let index = suffix.length - 1; index >= 0; index -= 1) {
        buffered.pushFront(suffix[index] as SessionEvent)
      }
      notify()
    }, { global: true })
    const onAbort = (): void => { notify() }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      using source = await this.sourceFor(address, signal, true)
      const events = source.events
      signal.throwIfAborted()
      const cursor = source.cursor
      snapshotCursor = cursor
      const page = paginate(events, undefined, request.maxMessages ?? DEFAULT_MAX_MESSAGES)
      yield boundHistoryValue({
        type: 'snapshot' as const,
        header: wireHeader(source.header, source.inheritedEventCount),
        cursor,
        records: pageRecords(page.events),
        hasMore: page.hasMore,
        projections: source.projections === undefined
          ? { asOfSeq: cursor, values: {} }
          : projectionBlock(source.projections),
      }, this.maxPageBytes, streamCarrierBytes)
      if (address.kind === 'session' && source.source === 'prepared') {
        const promotion = source.retain()
        try {
          this.promote(promotion)
        } catch (error: unknown) {
          promotion[Symbol.dispose]()
          throw error
        }
      }
      let nextOffset = SessionLogOffset(cursor + 1)
      while (!follower.closed && !signal.aborted) {
        const item = buffered.popFront()
        if (item === undefined) {
          await new Promise<void>((resolve) => { wake = resolve })
          continue
        }
        const expectedSeq = SessionSeq(nextOffset)
        if (item.seq < expectedSeq) continue
        if (item.seq !== expectedSeq) {
          throw new RemoteError('gateway/internal', `session event stream skipped seq ${String(expectedSeq)}`, {})
        }
        nextOffset = SessionLogOffset(nextOffset + 1)
        yield entryFor(item)
      }
    } finally {
      this.closeFollowers.delete(close)
      signal.removeEventListener('abort', onAbort)
      disposeCreated()
      disposeEvent()
    }
  }

  private async sourceFor(
    address: SessionAddress,
    signal: AbortSignal,
    withProjections: boolean,
  ): Promise<SessionObservation> {
    const sessionId = addressId(address)
    try {
      const observation = await this.ctx.sessionQuery.observeSession(sessionId, {
        signal,
        projectionMode: withProjections || address.kind === 'subagent' ? 'all' : 'none',
      })
      if (observation.header.cwd === undefined) {
        observation[Symbol.dispose]()
        rejectNotFound(address)
      }
      try {
        validateAddress(
          address,
          observation.header,
          observation.inheritedEventCount,
          observation.projections,
        )
      } catch (error: unknown) {
        observation[Symbol.dispose]()
        throw error
      }
      return observation
    } catch (error: unknown) {
      if (error instanceof SessionQueryError
        && error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') rejectNotFound(address)
      throw error
    }
  }

}

function projectionBlock(
  snapshot: NonNullable<SessionObservation['projections']>,
): SessionProjectionBaseline {
  return {
    asOfSeq: snapshot.asOfSeq,
    // Projection definitions validate whole JSON values before snapshot publication.
    values: snapshot.values as SessionProjectionValues,
  }
}

function validatePageRequest(request: SessionPageRequest): void {
  if (!Number.isSafeInteger(request.throughSeq)
    || request.throughSeq < -1
    || Object.is(request.throughSeq, -0)) {
    throw new RemoteError('gateway/bad-request', 'throughSeq must be an integer greater than or equal to -1', {})
  }
  if (request.beforeSeq !== undefined
    && (!Number.isSafeInteger(request.beforeSeq)
      || request.beforeSeq < 0
      || Object.is(request.beforeSeq, -0))) {
    throw new RemoteError('gateway/bad-request', 'beforeSeq must be a non-negative safe integer', {})
  }
  if (request.maxMessages !== undefined
    && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) {
    throw new RemoteError('gateway/bad-request', 'maxMessages must be a positive safe integer', {})
  }
}

function validateFollowRequest(request: SessionFollowRequest): void {
  if (request.maxMessages !== undefined
    && (!Number.isSafeInteger(request.maxMessages) || request.maxMessages <= 0)) {
    throw new RemoteError('gateway/bad-request', 'maxMessages must be a positive safe integer', {})
  }
}

function addressId(address: SessionAddress): SessionId {
  return address.kind === 'session' ? address.sessionId : address.childSessionId
}

function validateAddress(
  address: SessionAddress,
  header: SessionHeader,
  inheritedEventCount: SessionLogOffsetType,
  projections: SessionObservation['projections'],
): void {
  if (address.kind === 'session') {
    if (header.origin === 'subagent') {
      throw new RemoteError('session/agent-busy', 'subagent Sessions require their durable parent address', {
        reason: 'use subagent delivery for this child session',
      })
    }
    return
  }
  if (header.origin !== 'subagent' || header.parentSession !== address.parentSessionId) {
    throw new RemoteError('subagent/unauthorized', 'subagent does not belong to the supplied parent', {
      childSessionId: address.childSessionId,
    })
  }
  const identity = projections?.values.subagent
  if (identity === null) {
    throw new RemoteError('subagent/catalog-diagnostic', 'subagent descriptor is corrupt', {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: 'corrupt',
    })
  }
  if (identity === undefined || identity.seq < inheritedEventCount) {
    throw new RemoteError('subagent/catalog-diagnostic', 'subagent descriptor is unavailable', {
      parentSessionId: address.parentSessionId,
      childSessionId: address.childSessionId,
      reason: 'unsupported',
    })
  }
  if (identity.mode !== address.mode) {
    throw new RemoteError('subagent/unauthorized', 'subagent mode does not match the supplied address', {
      childSessionId: address.childSessionId,
    })
  }
}

function rejectNotFound(address: SessionAddress): never {
  if (address.kind === 'session') {
    throw new RemoteError('session/not-found', `session "${address.sessionId}" not found`, { sessionId: address.sessionId })
  }
  throw new RemoteError('subagent/not-found', 'subagent is unavailable', {
    parentSessionId: address.parentSessionId,
    childSessionId: address.childSessionId,
  })
}

function paginate(
  events: readonly SessionEvent[],
  beforeSeq: SessionLogOffsetType | undefined,
  maxMessages: number,
  throughSeq: SessionSeqCursor = events.at(-1)?.seq ?? -1,
): { readonly events: SessionEvent[]; readonly hasMore: boolean } {
  const end = SessionLogOffset(Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1))
  let count = 0
  let cut = SessionLogOffset(0)
  for (let index = end - 1; index >= 0; index--) {
    const event = events[index] as SessionEvent
    if (!MESSAGE_TYPES.has(event.type) || !isAppendSurfaceEvent(event)) continue
    count++
    const sources = event.sourceEventSeqs
    let groupStart = event.seq
    if (sources !== undefined) {
      for (const source of sources) {
        if (source < groupStart) groupStart = source
      }
    }
    if (count >= maxMessages) {
      cut = SessionLogOffset(groupStart)
      break
    }
  }
  return { events: events.slice(cut, end), hasMore: cut > 0 }
}

/** Translate logical Session metadata to the unchanged v0 browser wire. */
function wireHeader(
  header: SessionHeader,
  inheritedEventCount: SessionLogOffsetType,
): SessionWireHeader {
  const { isSeeded, ...wire } = header
  return {
    ...wire,
    ...isSeeded ? { seedLength: inheritedEventCount } : {},
  }
}

function entryFor(event: SessionEvent): SessionEventEntry {
  return {
    type: 'event',
    // Session.append validates and freezes event data as JSON before publication.
    event: event as unknown as SessionWireEvent,
  }
}

function chunkEntryFor(row: ChunkRow): SessionChunkRun {
  switch (row.type) {
    case 'text-chunks':
      return {
        type: 'chunks',
        event: { type: 'chunkrow/text-chunks', seq: row.seq0, time: row.time0, data: row.data },
      }
    case 'reasoning-chunks':
      return {
        type: 'chunks',
        event: { type: 'chunkrow/reasoning-chunks', seq: row.seq0, time: row.time0, data: row.data },
      }
    case 'tool-call-chunks':
      return {
        type: 'chunks',
        event: { type: 'chunkrow/tool-call-chunks', seq: row.seq0, time: row.time0, data: row.data },
      }
  }
}

type BoundedHistoryValue = {
  readonly records: readonly SessionHistoryRecord[]
  readonly hasMore: boolean
  readonly projections?: SessionProjectionBaseline
}

type CarrierBytes<T> = (value: T) => number

/** Price one unary page inside the complete Connection response JSON message. */
function unaryCarrierBytes(value: unknown): number {
  return serializedBytes({
    type: 'server-response',
    rpcId: CARRIER_UUID,
    result: { ok: true, value },
  })
}

/** Price one opening snapshot inside the complete Gateway stream JSON message. */
function streamCarrierBytes(value: unknown): number {
  return serializedBytes({ type: 'item', streamId: CARRIER_UUID, value })
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

/** Read the inclusive final Session sequence represented by one wire record. */
function recordLastSeq(record: SessionHistoryRecord): number {
  if (record.type === 'event') return record.event.seq
  const length = record.event.type === 'chunkrow/tool-call-chunks'
    ? record.event.data.args.length
    : record.event.data.texts.length
  return record.event.seq + length - 1
}

/** Find the first record containing or following one logical Session sequence. */
function recordIndexFromSeq(records: readonly SessionHistoryRecord[], target: number): number {
  let low = 0
  let high = records.length
  while (low < high) {
    const middle = (low + high) >> 1
    if (recordLastSeq(records[middle] as SessionHistoryRecord) < target) low = middle + 1
    else high = middle
  }
  return low
}

/** Read the append-message group start represented by one scalar history record. */
function messageGroupStart(record: SessionHistoryRecord): number | undefined {
  if (record.type !== 'event'
    || !MESSAGE_TYPES.has(record.event.type)
    || !isAppendSurfaceEvent(record.event as unknown as SessionEvent)) return undefined
  let start = record.event.seq
  for (const source of record.event.sourceEventSeqs ?? []) start = Math.min(start, source)
  return start
}

/**
 * Keep the newest contiguous message-group suffix that fits a complete carrier
 * message. The newest group remains intact when it alone exceeds the budget.
 */
function boundHistoryValue<T extends BoundedHistoryValue>(
  value: T,
  maxBytes: number,
  carrierBytes: CarrierBytes<T>,
): T {
  if (maxBytes <= 0) return value
  const records = value.records
  const prefix = new Array<number>(records.length + 1).fill(0)
  for (let index = 0; index < records.length; index++) {
    prefix[index + 1] = (prefix[index] as number) + serializedBytes(records[index])
  }

  const fit = (candidate: T): { readonly cut: number; readonly fits: boolean } => {
    const untrimmedShellBytes = carrierBytes({ ...candidate, records: [] })
    const trimmedShellBytes = candidate.hasMore
      ? untrimmedShellBytes
      : carrierBytes({ ...candidate, records: [], hasMore: true })
    const total = (cut: number): number => (cut === 0 ? untrimmedShellBytes : trimmedShellBytes)
      + ((prefix[records.length] as number) - (prefix[cut] as number))
      + Math.max(0, records.length - cut - 1)
    if (total(0) <= maxBytes) return { cut: 0, fits: true }

    let cut = 0
    let foundNewest = false
    for (let index = records.length - 1; index >= 0; index--) {
      const startSeq = messageGroupStart(records[index] as SessionHistoryRecord)
      if (startSeq === undefined) continue
      const candidateCut = recordIndexFromSeq(records, startSeq)
      if (total(candidateCut) <= maxBytes) {
        cut = candidateCut
        foundNewest = true
        continue
      }
      if (!foundNewest) return { cut: candidateCut, fits: false }
      return { cut, fits: true }
    }
    return { cut, fits: false }
  }

  const applyCut = (candidate: T, cut: number): T => ({
    ...candidate,
    records: records.slice(cut),
    hasMore: candidate.hasMore || cut > 0,
  })
  const first = fit(value)
  if (first.fits) return applyCut(value, first.cut)
  if ('projections' in value) {
    const withoutProjections = { ...value } as T & { projections?: SessionProjectionBaseline }
    delete withoutProjections.projections
    const second = fit(withoutProjections)
    return applyCut(withoutProjections, second.cut)
  }
  return applyCut(value, first.cut)
}

/** Encode one bounded logical page without changing its pagination cut. */
function pageRecords(events: readonly SessionEvent[]): SessionHistoryRecord[] {
  return packChunkRuns(events).map(record => isChunkRow(record)
    ? chunkEntryFor(record)
    : entryFor(record))
}
