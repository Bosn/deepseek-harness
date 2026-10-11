/** Exact live metadata maintained only by native post-commit events. */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId, type Session, type SessionEvent, type SessionSeqCursor } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { z } from 'zod'
import type { SessionSupervisionMetadataRequest, SessionSupervisionMetadataValue, SessionSupervisionProjection, SessionSupervisionTerminalReason } from './types.ts'

const terminals = ['completed', 'aborted', 'blocked', 'error', 'max-tokens', 'interrupted', 'forked', 'unknown'] as const
const projectionSchema = z.object({
  turn: z.number().int().nonnegative().safe(), open: z.boolean(),
  terminalReason: z.enum(terminals).nullable(),
}).strict()
const requestSchema = z.object({
  sessionId: z.string().min(1).max(1024).transform(SessionId),
  nativeTurnId: z.string().regex(/^[1-9][0-9]*$/).max(16)
    .refine(value => Number.isSafeInteger(Number(value))),
}).strict()

/** Fold native boundaries without inspecting any error or cancellation body. */
export function foldSupervisionBoundary(state: SessionSupervisionProjection, event: SessionEvent): SessionSupervisionProjection {
  if (event.type === 'turn/start') return { turn: event.data.turn, open: true, terminalReason: null }
  if (event.type !== 'turn/end') return state
  if (event.data.turn !== state.turn || !state.open) return { ...state, open: false, terminalReason: 'unknown' }
  const kind = event.data.reason.kind
  const terminalReason: SessionSupervisionTerminalReason = terminals.includes(kind as SessionSupervisionTerminalReason)
    ? kind as SessionSupervisionTerminalReason : 'unknown'
  return { ...state, open: false, terminalReason }
}

interface LiveCell {
  readonly state: SessionSupervisionProjection
  readonly asOfSeq: SessionSeqCursor
}

/**
 * Controller-private memory observation. Seed events, cache rows and history
 * cannot initialize a cell; only an observed native turn start can do so.
 */
export class LiveSupervisionMetadata {
  private cells = new WeakMap<Session, LiveCell>()
  private disposed = false

  /** @param ctx - native lifecycle owner; subscriptions are fiber effects. */
  constructor(private readonly ctx: Context) {
    ctx.on('session/event', (session: Session, event: SessionEvent) => this.observe(session, event))
    ctx.on('session/disposed', (session: Session) => { this.cells.delete(session) })
    ctx.effect(() => () => { this.disposed = true; this.cells = new WeakMap() })
  }

  private observe(session: Session, event: SessionEvent): void {
    if (this.disposed) return
    const previous = this.cells.get(session)
    if (previous !== undefined && previous.asOfSeq !== event.seq - 1) {
      this.cells.delete(session)
      return
    }
    if (event.type === 'turn/start') {
      this.cells.set(session, {
        state: { turn: event.data.turn, open: true, terminalReason: null }, asOfSeq: event.seq,
      })
    } else if (previous !== undefined) {
      this.cells.set(session, {
        state: foldSupervisionBoundary(previous.state, event), asOfSeq: event.seq,
      })
    }
  }

  /**
   * @param request - exact session and turn selected by the owner consumer.
   * @returns bounded live metadata or an explicit obstruction; no bodies or I/O.
   */
  read(request: SessionSupervisionMetadataRequest): SessionSupervisionMetadataValue {
    const parsed = requestSchema.safeParse(request)
    if (!parsed.success) throw new RemoteError('gateway/bad-request', 'Exact sessionId/nativeTurnId required', {})
    const { sessionId, nativeTurnId } = parsed.data
    const base = { nativeTaskId: sessionId, nativeSessionId: sessionId, nativeTurnId,
      status: 'unknown' as const, nativeStatus: 'unknown', metadataSeq: null, terminalReason: null }
    if (this.disposed) return { ...base, coverage: 'unavailable', reason: 'projection-unavailable-or-stale' }
    const session = this.ctx.sessions.get(sessionId)
    if (session === undefined) return { ...base, coverage: 'unavailable', reason: 'not-attached' }
    if (session.id !== sessionId) return { ...base, coverage: 'unavailable', reason: 'identity-mismatch' }
    const cell = this.disposed ? undefined : this.cells.get(session)
    if (cell === undefined || cell.asOfSeq !== session.seq - 1) return { ...base, coverage: 'unavailable',
      reason: !this.disposed && cell === undefined && session.seq === 0 ? 'no-turn' : 'projection-unavailable-or-stale' }
    const checked = projectionSchema.safeParse(cell.state)
    if (!checked.success || (checked.data.open && checked.data.terminalReason !== null)) {
      return { ...base, coverage: 'unavailable', reason: 'projection-corrupt' }
    }
    const state = checked.data
    if (String(state.turn) !== nativeTurnId) return { ...base, coverage: 'unavailable', reason: state.turn === 0 ? 'no-turn' : 'identity-mismatch' }
    const cut = { ...base, metadataSeq: cell.asOfSeq, terminalReason: state.terminalReason }
    if (state.open) return { ...cut, status: 'running', nativeStatus: 'turn-open', coverage: 'partial', reason: 'question-count-unavailable' }
    const nativeStatus = state.terminalReason ?? 'unknown'
    const status = nativeStatus === 'completed' ? 'succeeded' : nativeStatus === 'aborted' ? 'cancelled'
      : nativeStatus === 'error' ? 'failed' : nativeStatus === 'blocked' ? 'waiting-input' : 'unknown'
    return { ...cut, nativeStatus, status, coverage: status === 'unknown' ? 'unavailable' : 'partial',
      reason: status === 'unknown' ? 'terminal-reason-unknown' : 'question-count-unavailable' }
  }

}
