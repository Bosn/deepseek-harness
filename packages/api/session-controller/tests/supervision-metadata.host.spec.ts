import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId, SessionLogOffset, SessionSeq, type Session } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import ProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { describe, expect, it, vi, onTestFinished } from 'vitest'
import { z } from 'zod'
import { LiveSupervisionMetadata, foldSupervisionBoundary } from '../src/supervision-metadata.ts'
import { createSessionTestController } from './test-remote.ts'

async function harness(mount = true) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ProjectionRegistry)
  onTestFinished(() => { vi.restoreAllMocks(); return ctx.fiber.dispose() })
  return { ctx, reader: mount ? new LiveSupervisionMetadata(ctx) : undefined }
}
const request = (id: SessionId, nativeTurnId = '1') => ({ sessionId: id, nativeTurnId })
function cells(reader: LiveSupervisionMetadata) {
  return (reader as unknown as { cells: WeakMap<Session, unknown> }).cells
}

describe('live-only supervision metadata', () => {
  it('reads exact committed native status without history, inbox, other views or persistence', async () => {
    const { ctx, reader } = await harness()
    const session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    vi.spyOn(session, 'snapshotEvents').mockImplementation(() => { throw new Error('body read') })
    vi.spyOn(session, 'eventAt').mockImplementation(() => { throw new Error('event read') })
    for (const name of ['stateOf', 'snapshot', 'checkpoint', 'restoreFloor', 'restore', 'hydrate'] as const) {
      vi.spyOn(ctx.sessionProjections, name).mockImplementation(() => { throw new Error('projection or cold I/O') })
    }
    const result = reader!.read(request(session.id))
    expect(result).toMatchObject({ status: 'running', metadataSeq: 0, terminalReason: null, coverage: 'partial', reason: 'question-count-unavailable' })
    expect(result).not.toHaveProperty('questionCount')
    expect(JSON.stringify(result)).not.toMatch(/body|messages|inbox|stack/)
  })
  it.each(['completed','aborted','blocked','error','max-tokens','interrupted','forked'] as const)('reports native %s with no terminal body', async (kind) => {
    const { ctx, reader } = await harness(), session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    const reason = kind === 'aborted' ? { kind, reason: { kind: 'hook' as const, reason: 'TEST-private-hook' } }
      : kind === 'error' ? { kind, error: { code: 'UNKNOWN', message: 'TEST-private-error' } } : { kind }
    session.append('turn/end', { turn: 1, reason })
    const result = reader!.read(request(session.id))
    expect(result.terminalReason).toBe(kind)
    expect(result.status).toBe(kind === 'completed' ? 'succeeded' : kind === 'aborted' ? 'cancelled' : kind === 'error' ? 'failed' : kind === 'blocked' ? 'waiting-input' : 'unknown')
    expect(JSON.stringify(result)).not.toContain('TEST-private')
  })
  it('keeps unknown extension and invalid boundary unknown instead of completed', async () => {
    const { ctx, reader } = await harness(), session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    const state = foldSupervisionBoundary({ turn: 1, open: true, terminalReason: null },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'extension' } } } as never)
    expect(state.terminalReason).toBe('unknown')
    cells(reader!).set(session, { state, asOfSeq: SessionSeq(0) })
    expect(reader!.read(request(session.id))).toMatchObject({ status: 'unknown', reason: 'terminal-reason-unknown' })
    expect(foldSupervisionBoundary({ turn: 1, open: true, terminalReason: null },
      { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } } as never).terminalReason).toBe('unknown')
  })
  it('cold, empty, absent, late registration and old watermark refuse hydration', async () => {
    const { ctx, reader } = await harness(), session = ctx.sessions.create()
    expect(reader!.read(request(SessionId('TEST-cold')))).toMatchObject({ status: 'unknown', reason: 'not-attached' })
    expect(reader!.read(request(session.id))).toMatchObject({ status: 'unknown', reason: 'no-turn' })
    session.append('turn/start', { turn: 1 })
    vi.spyOn(session, 'seq', 'get').mockReturnValue(SessionLogOffset(2))
    expect(reader!.read(request(session.id))).toMatchObject({ status: 'unknown', reason: 'projection-unavailable-or-stale' })
  })
  it('missing cell and disposed contribution refuse reads without materialization', async () => {
    const { ctx } = await harness(false)
    const session = ctx.sessions.create();session.append('turn/start', { turn: 1 })
    const reader = new LiveSupervisionMetadata(ctx)
    vi.spyOn(session, 'snapshotEvents').mockImplementation(() => { throw new Error('late history') })
    expect(reader.read(request(session.id)).reason).toBe('projection-unavailable-or-stale')
    await ctx.fiber.dispose()
    expect(reader.read(request(session.id))).toMatchObject({ status: 'unknown', reason: 'projection-unavailable-or-stale' })
  })
  it('rejects wrong session/turn, corrupted state and extra request fields', async () => {
    const { ctx, reader } = await harness(), session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    expect(reader!.read(request(session.id,'2'))).toMatchObject({ status: 'unknown', reason: 'identity-mismatch' })
    expect(() => reader!.read({ ...request(session.id), extra: true } as never)).toThrow('Exact sessionId')
    expect(() => reader!.read(request(session.id,'0'))).toThrow('Exact sessionId')
    cells(reader!).set(session, { state: { turn: 'corrupt' }, asOfSeq: SessionSeq(0) })
    expect(reader!.read(request(session.id))).toMatchObject({ status: 'unknown', reason: 'projection-corrupt' })
  })
  it('production SessionController exposes the same exact no-cold method', async () => {
    const { ctx } = await harness(false)
    const controller = createSessionTestController(ctx,{ cwd: '/tmp', defaultModelSelection: () => ({ provider: 'TEST', model: 'TEST' }) })
    const session = ctx.sessions.create();session.append('turn/start',{ turn: 1 })
    vi.spyOn(ctx.sessionQuery,'observeSession').mockImplementation(() => { throw new Error('cold hydration') })
    expect(controller.supervisionMetadata(request(session.id)).status).toBe('running')
  })
  it('checkpoint and cold hydration cannot serialize or initialize the private cell', async () => {
    const { ctx } = await harness(false)
    ctx.sessionProjections.register({ key: 'sessionListMetadata', stateVersion: 1,
      stateSchema: z.object({ blank: z.boolean(), lastPromptAt: z.number().nullable() }),
      init: () => ({ blank: false, lastPromptAt: null }), apply: state => state,
      wire: { viewSchema: z.object({ blank: z.boolean(), lastPromptAt: z.number().nullable() }), view: state => state } })
    const session = ctx.sessions.create();session.append('turn/start', { turn: 1 })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const reader = new LiveSupervisionMetadata(ctx)
    const checkpoint = ctx.sessionProjections.checkpoint(session)
    expect(checkpoint).toHaveProperty('sessionListMetadata')
    expect(checkpoint).not.toHaveProperty('supervisionMetadata')
    const persisted = { ...checkpoint, supervisionMetadata: { ver: 1, seq: SessionSeq(1), val: { turn: 1, open: false, terminalReason: 'completed' } } }
    ctx.sessionProjections.hydrate(session, persisted, session.snapshotEvents(), SessionLogOffset(0))
    expect(reader.read(request(session.id))).toMatchObject({ status: 'unknown', reason: 'projection-unavailable-or-stale' })
    session.append('turn/start', { turn: 2 })
    expect(reader.read(request(session.id,'2')).status).toBe('running')
    expect(JSON.stringify(ctx.sessionProjections.checkpoint(session))).not.toContain('supervisionMetadata')
    expect(ctx.sessionProjections.checkpoint(session).sessionListMetadata?.seq).toBe(2)
  })
  it('unrelated commits advance only the watermark without reading their data', async () => {
    const { ctx, reader } = await harness(), session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    const event = { type: 'TEST-unrelated', seq: SessionSeq(1), get data() { throw new Error('inbox body touched') } }
    ctx.emit('session/event', session, event as never)
    vi.spyOn(session, 'seq', 'get').mockReturnValue(SessionLogOffset(2))
    expect(reader!.read(request(session.id))).toMatchObject({ status: 'running', metadataSeq: 1 })
  })
  it('a sequence gap invalidates coverage and cannot turn a later end into success', async () => {
    const { ctx, reader } = await harness(), session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    ctx.emit('session/event', session, { type: 'turn/end', seq: SessionSeq(2), data: { turn: 1, reason: { kind: 'completed' } } } as never)
    expect(reader!.read(request(session.id)).status).toBe('unknown')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(reader!.read(request(session.id)).status).toBe('unknown')
    session.append('turn/start', { turn: 2 })
    expect(reader!.read(request(session.id,'2')).status).toBe('running')
  })
  it('restarted observers and disposed Sessions cannot reuse former live observations', async () => {
    const { ctx, reader } = await harness(), session = ctx.sessions.create()
    session.append('turn/start', { turn: 1 })
    const restarted = new LiveSupervisionMetadata(ctx)
    expect(restarted.read(request(session.id)).status).toBe('unknown')
    ctx.emit('session/disposed', session)
    expect(reader!.read(request(session.id)).status).toBe('unknown')
    expect(cells(reader!).has(session)).toBe(false)
  })
})
