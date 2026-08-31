import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError, resolveRetryPolicy  } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ResolvedRetryPolicy, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import * as LlmPiAi from '@deepseek-ai/dsh-llm-pi-ai'
import { startMockLlmServer, type MockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as retry from '../src/index.ts'

let root: string | undefined
let context: Context | undefined
let apiKeyHome: string | undefined
let mockServer: MockLlmServer | undefined

class TransientOnceAdapter extends LlmAdapter {
  requests = 0
  private readonly retryPolicy = resolveRetryPolicy({
    mode: 'normal',
    maxRetries: 1,
    retryableCodes: ['RATE_LIMIT', 'SERVER'],
    backoff: { initialDelayMs: 1, maxDelayMs: 1, jitterRatio: 0 },
  }, 'loader test provider retryPolicy')

  override providerRetryPolicy(_provider: string): ResolvedRetryPolicy {
    return this.retryPolicy
  }

  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    if (this.requests === 1) throw new LlmError('temporary outage', 'SERVER')
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'recovered' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'recovered' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await mockServer?.close()
  mockServer = undefined
  vi.unstubAllEnvs()
  if (apiKeyHome !== undefined) await rm(apiKeyHome, { recursive: true, force: true })
  apiKeyHome = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function loadYaml(lines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-llm-retry-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [...lines, ''].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-llm-deepseek', LlmDeepSeek],
    ['@deepseek-ai/dsh-llm-pi-ai', LlmPiAi],
    ['@deepseek-ai/dsh-llm-retry', retry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  return context
}

describe('real Loader composition', () => {
  // Real-Loader composition resolves workspace packages through tsx at test
  // time; first resolution after the host/client program split is slow enough
  // to trip the default 5s budget on cold caches.
  it('loads provider-supplied policy and records recovery through the shipping loop', { timeout: 60_000 }, async () => {
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-llm-retry'",
      "- name: '@deepseek-ai/dsh-agent-loop'",
    ])

    const unloaded = [...loaded.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(loaded.agents).toBeInstanceOf(AgentRegistry)

    const adapter = new TransientOnceAdapter()
    loaded.llm.registerAdapter(['mock'], adapter)
    const { agent } = await loaded.agents.create({
      sessionId: SessionId('loader-retry'),
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(adapter.requests).toBe(2)
    expect(agent.session.events.filter(event => event.type === 'llm/retry')).toHaveLength(1)
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'recovered' }],
    })
  })

  async function cooldownHydra(sequence: readonly ('quota_exceeded' | 'success')[]): Promise<{
    loaded: Context
    agent: Agent
  }> {
    apiKeyHome = await mkdtemp(join(tmpdir(), 'dsh-llm-retry-key-home-'))
    vi.stubEnv('DSH_HOME', apiKeyHome)
    vi.stubEnv('DEEPSEEK_API_KEY', 'test-key')
    mockServer = await startMockLlmServer({ sequence })
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-llm-deepseek'",
      '  config:',
      `    baseURL: '${mockServer.baseURL}'`,
      '    retryPolicy:',
      '      mode: normal',
      '      maxRetries: 3',
      '      retryableCodes: [RATE_LIMIT]',
      '      backoff:',
      '        initialDelayMs: 1',
      '        maxDelayMs: 25',
      '        jitterRatio: 0',
      '        rateLimitDelaysMs: [25, 50, 75]',
      "- name: '@deepseek-ai/dsh-llm-retry'",
      "- name: '@deepseek-ai/dsh-agent-loop'",
    ])
    return {
      loaded,
      agent: (await loaded.agents.create({
        sessionId: SessionId('loader-cooldown'),
        agentOptions: {
          provider: 'deepseek-official',
          model: 'deepseek-v4-flash',
        },
      })).agent,
    }
  }

  // A real HTTP 429 whose provider error body carries the Model Studio
  // `insufficient_quota` wording: the shipped adapter must classify it as
  // throttling, and the shipped executor must cooldown-retry instead of ending
  // the turn at the first rejection.
  it('recovers a turn from a real quota-worded HTTP 429 across cooldown retries', { timeout: 60_000 }, async () => {
    const { loaded, agent } = await cooldownHydra(['quota_exceeded', 'success'])

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(mockServer?.requests.map(request => request.scriptBehavior))
      .toEqual(['quota_exceeded', 'success'])
    const retried = agent.session.events.filter(event => event.type === 'llm/retry')
    expect(retried).toHaveLength(1)
    expect(retried[0]?.data).toMatchObject({
      provider: 'deepseek-official',
      retry: 1,
      delayMs: 25,
      failure: { message: 'mock insufficient quota', code: 'RATE_LIMIT', status: 429 },
    })
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
    })
    expect(loaded.agents).toBeInstanceOf(AgentRegistry)
  })

  it('recovers a pi-ai route from a real quota-worded HTTP 429', { timeout: 60_000 }, async () => {
    vi.stubEnv('PI_AI_LOADER_TEST_KEY', 'test-key')
    mockServer = await startMockLlmServer({ sequence: ['quota_exceeded', 'success'] })
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-llm-pi-ai'",
      '  config:',
      '    providers:',
      '      qwen-test:',
      '        apiKeyEnv: PI_AI_LOADER_TEST_KEY',
      '        api: openai-completions',
      '        quotaWorded429IsRateLimit: true',
      `        baseURL: '${mockServer.baseURL}'`,
      '        models:',
      '          - id: qwen-test-model',
      '            contextWindow: 1000000',
      '            maxTokens: 32768',
      '        retryPolicy:',
      '          mode: normal',
      '          maxRetries: 3',
      '          retryableCodes: [RATE_LIMIT]',
      '          backoff:',
      '            initialDelayMs: 1',
      '            maxDelayMs: 25',
      '            jitterRatio: 0',
      '            rateLimitDelaysMs: [25]',
      "- name: '@deepseek-ai/dsh-llm-retry'",
      "- name: '@deepseek-ai/dsh-agent-loop'",
    ])
    const { agent } = await loaded.agents.create({
      sessionId: SessionId('loader-pi-ai-cooldown'),
      agentOptions: { provider: 'qwen-test', model: 'qwen-test-model' },
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'recover' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(mockServer.requests.map(request => request.scriptBehavior))
      .toEqual(['quota_exceeded', 'success'])
    const retried = agent.session.events.filter(event => event.type === 'llm/retry')
    expect(retried).toHaveLength(1)
    expect(retried[0]?.data).toMatchObject({
      provider: 'qwen-test',
      retry: 1,
      delayMs: 25,
      failure: { code: 'RATE_LIMIT', status: 429 },
    })
    expect(agent.session.deriveMessages().at(-1)).toMatchObject({
      role: 'assistant',
      source: { provider: 'qwen-test', model: 'qwen-test-model' },
    })
  })

  it('does not retry a quota-worded HTTP 429 on an OpenAI route', { timeout: 60_000 }, async () => {
    vi.stubEnv('PI_AI_LOADER_TEST_KEY', 'test-key')
    mockServer = await startMockLlmServer({ sequence: ['quota_exceeded', 'success'] })
    const loaded = await loadYaml([
      "- name: '@deepseek-ai/dsh-llm'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-llm-pi-ai'",
      '  config:',
      '    providers:',
      '      openai:',
      '        apiKeyEnv: PI_AI_LOADER_TEST_KEY',
      '        api: openai-completions',
      `        baseURL: '${mockServer.baseURL}'`,
      '        models:',
      '          - id: openai-test-model',
      '            contextWindow: 1000000',
      '            maxTokens: 32768',
      '        retryPolicy:',
      '          mode: normal',
      '          maxRetries: 3',
      '          retryableCodes: [RATE_LIMIT]',
      '          backoff:',
      '            initialDelayMs: 1',
      '            maxDelayMs: 25',
      '            jitterRatio: 0',
      '            rateLimitDelaysMs: [25]',
      "- name: '@deepseek-ai/dsh-llm-retry'",
      "- name: '@deepseek-ai/dsh-agent-loop'",
    ])
    const { agent } = await loaded.agents.create({
      sessionId: SessionId('loader-openai-quota'),
      agentOptions: { provider: 'openai', model: 'openai-test-model' },
    })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'stop' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(mockServer.requests.map(request => request.scriptBehavior)).toEqual(['quota_exceeded'])
    expect(agent.session.events.filter(event => event.type === 'llm/retry')).toHaveLength(0)
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: {
        reason: {
          kind: 'error',
          error: { code: 'QUOTA', status: 429 },
        },
      },
    })
  })

  it('ends the turn with the original 429 only after the cooldown schedule is exhausted', { timeout: 60_000 }, async () => {
    const { agent } = await cooldownHydra([
      'quota_exceeded',
      'quota_exceeded',
      'quota_exceeded',
      'quota_exceeded',
    ])

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'exhaust' }], source: { kind: 'user' } }))
    await agent.whenIdle()

    expect(mockServer?.requests).toHaveLength(4)
    expect(agent.session.events.filter(event => event.type === 'llm/retry')
      .map(event => event.data.delayMs)).toEqual([25, 50, 75])
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'turn/end',
      data: {
        reason: {
          kind: 'error',
          error: { message: 'mock insufficient quota', code: 'RATE_LIMIT', status: 429 },
        },
      },
    })
  })
})
