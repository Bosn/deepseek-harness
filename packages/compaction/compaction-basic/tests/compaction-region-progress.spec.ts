import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import BasicCompactionEngine from '@deepseek-ai/dsh-compaction-basic'
import type { BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import LlmRuntime, { createMessage, createSystemMessage, createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  ContentBlock,
  GenerateOptions,
  LlmResolvedModelInfo,
  StreamChunk,
  TokenUsage,
} from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import TokenMeter, { estimateHeaderBytes, estimateMessageBytes } from '@deepseek-ai/dsh-token-meter'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { estimateCompactionInstructionBytes } from '../src/summarizer.ts'
import type { SummarizationInput } from '../src/summarizer.ts'

/** Region partition forward-progress and transaction-budget coverage. */

const MODEL = 'test-model'
const SIGNAL = new AbortController().signal

class ContextAdapter extends LlmAdapter {
  constructor(private readonly contextWindow: number) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: this.contextWindow },
    })
  }

  override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'ok' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function createContext(contextWindow = 1_000_000): Context {
  const ctx = new Context()
  void new LlmRuntime(ctx)
  new SessionProjectionRegistry(ctx)
  void new TokenMeter(ctx)
  ctx.llm.registerAdapter([MODEL], new ContextAdapter(contextWindow))
  return ctx
}

class TestCompactionEngine extends BasicCompactionEngine {
  readonly calls: SummarizationInput[] = []

  override async summarize(
    input: SummarizationInput,
    _agent: Agent,
    _signal?: AbortSignal,
  ): Promise<{
    summary: ContentBlock[]
    provider: string
    model: string
    maxTokens?: number
    usage?: TokenUsage
  }> {
    this.calls.push(input)
    return {
      summary: [{ type: 'text', text: 'small checkpoint' }],
      provider: 'summary-provider',
      model: 'summary-model',
      maxTokens: 123,
    }
  }
}

function service(config: BasicCompactionConfig = { auto: false }): TestCompactionEngine {
  return new TestCompactionEngine(createContext(), { headroomTokens: 0, maxTokens: 8192, ...config })
}

function agent(session: Session): Agent {
  return { session } as Agent
}

/**
 * Closed two-message turns plus one open turn. A `system` text places a
 * `system/message` at surface node 0, and each message text stays small so a
 * tuned summarizer-input cap can separate the system head from the region.
 */
function conversation(turns: number, system: string): Session {
  const session = Session.create(SessionId('region-progress'))
  for (const [index] of Array.from({ length: turns }).entries()) {
    const turn = index + 1
    session.append('turn/start', { turn })
    if (turn === 1) {
      session.append('system/message', {
        turn,
        step: 1,
        message: createSystemMessage(system),
      }, { surfaceOp: 'append' })
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: `user ${turn} `.repeat(8) }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: `assistant ${turn} `.repeat(8) }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: turns + 1 })
  return session
}

/** Two individually-sized chunks that exceed the default summarizer cap together. */
function twoChunkConversation(): Session {
  const session = Session.create(SessionId('region-budget'))
  const chunks = ['a'.repeat(360 * 1024), 'b'.repeat(360 * 1024)]
  for (const [index, chunk] of chunks.entries()) {
    const turn = index + 1
    session.append('turn/start', { turn })
    if (turn === 1) {
      session.append('system/message', {
        turn,
        step: 1,
        message: createSystemMessage('s'),
      }, { surfaceOp: 'append' })
      session.append('request/header', {
        header: { config: { provider: MODEL, model: MODEL } },
        reason: 'initial',
      })
    }
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: chunk }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/start', { turn, step: 1 })
    session.append('assistant/message', {
      stream: [],
      turn,
      step: 1,
      message: createMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        source: { kind: 'model', provider: MODEL, model: MODEL },
      }),
    }, { surfaceOp: 'append' })
    session.append('step/end', { turn, step: 1 })
    session.append('turn/end', { turn, reason: { kind: 'completed' } })
  }
  session.append('turn/start', { turn: chunks.length + 1 })
  return session
}

function messageBytes(session: Session, seq: SessionSeq): number {
  const message = session.deriveEventMessage(session.eventAt(seq)!)
  return message === null ? 0 : estimateMessageBytes(message)
}

function compactionStarts(session: Session): number {
  return session.snapshotEvents().filter(event => event.type === 'compaction/start').length
}

describe('region partition forward progress', () => {
  it('rejects a partition whose only front drop is the carried checkpoint', async () => {
    // The replay fits the cap without the system head but not with it, so the
    // trim's minimal drop is the region's first node. After one transaction
    // that node is the carried checkpoint, and re-summarizing it alone leaves
    // the region exactly as large — the fixed point behind the recorded
    // five-hour pre-step blockage.
    const session = conversation(4, 's'.repeat(8 * 1024))
    const compact = service()
    const nodes = session.surface.nodes
    await compact.compactRegion(nodes[1]!, nodes[2]!, agent(session), SIGNAL)

    const afterNodes = session.surface.nodes
    const checkpointSeq = afterNodes[1]!
    expect(session.eventAt(checkpointSeq)?.type).toBe('user/message')
    const headerBytes = estimateHeaderBytes(session.requestHeader())
    const instructionBytes = estimateCompactionInstructionBytes()
    const systemBytes = messageBytes(session, afterNodes[0]!)
    const checkpointBytes = messageBytes(session, checkpointSeq)
    const suffixBytes = afterNodes.slice(2)
      .reduce((total, seq) => total + messageBytes(session, seq), 0)
    const tunedCap = headerBytes + checkpointBytes + suffixBytes + instructionBytes
      + Math.floor(systemBytes / 2)
    expect(headerBytes + checkpointBytes + suffixBytes + instructionBytes)
      .toBeLessThanOrEqual(tunedCap)
    expect(headerBytes + systemBytes + checkpointBytes + suffixBytes + instructionBytes)
      .toBeGreaterThan(tunedCap)

    const startsBefore = compactionStarts(session)
    await expect(compact.compactRegion(
      checkpointSeq,
      afterNodes.at(-1)!,
      agent(session),
      SIGNAL,
      tunedCap,
    )).rejects.toThrow(/carried compaction checkpoint.*absorb no new content/)
    // The degenerate partition is rejected before any summarizer call or
    // durable bracket, so the surface keeps its committed checkpoint.
    expect(compact.calls).toHaveLength(1)
    expect(compactionStarts(session)).toBe(startsBefore)
  })

  it('still compacts a region that is exactly one checkpoint', async () => {
    // The guard owns the partition case only: re-compacting a checkpoint as
    // the whole region is a bounded single transaction and must keep working.
    const session = conversation(4, 's'.repeat(8 * 1024))
    const compact = service()
    const nodes = session.surface.nodes
    await compact.compactRegion(nodes[1]!, nodes[2]!, agent(session), SIGNAL)

    const checkpointSeq = session.surface.nodes[1]!
    await compact.compactRegion(checkpointSeq, checkpointSeq, agent(session), SIGNAL)
    expect(compact.calls).toHaveLength(2)
  })
})

describe('region transaction budget', () => {
  it('fails loud when the partition needs more transactions than the ceiling', async () => {
    const session = twoChunkConversation()
    const compact = service({ maxRegionTransactions: 1 })
    const nodes = session.surface.nodes

    await expect(compact.compactRegion(
      nodes[1]!,
      nodes.at(-1)!,
      agent(session),
      SIGNAL,
    )).rejects.toThrow(/exhausted its 1-transaction limit.*raise the configured/)
    // The first bounded transaction committed before the ceiling rejected the
    // second, so exactly one summarizer call ran.
    expect(compact.calls).toHaveLength(1)
    expect(compactionStarts(session)).toBe(1)
  })

  it('completes the same partition within a raised ceiling', async () => {
    const session = twoChunkConversation()
    const compact = service({ maxRegionTransactions: 2 })
    const nodes = session.surface.nodes

    await compact.compactRegion(nodes[1]!, nodes.at(-1)!, agent(session), SIGNAL)
    expect(compact.calls).toHaveLength(2)
    expect(compactionStarts(session)).toBe(2)
  })
})
