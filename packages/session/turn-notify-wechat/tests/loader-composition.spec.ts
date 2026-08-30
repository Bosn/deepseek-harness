import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId, type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as TurnNotifyWechat from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function bootComposition(commandBody: string): Promise<{ ctx: Context; callsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-turn-notify-wechat-'))
  const commandPath = join(root, 'fake-ocw.mjs')
  const callsPath = join(root, 'calls.jsonl')
  const routePath = join(root, 'constants.env')
  const configPath = join(root, 'cordis.yml')
  await writeFile(commandPath, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs'
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(process.argv.slice(2)) + '\\n')
${commandBody}
`)
  await chmod(commandPath, 0o700)
  await writeFile(routePath, [
    'WEIXIN_ACCOUNT_ID=owner-account',
    'WEIXIN_BOSN_TARGET=owner-target@im.wechat',
    '',
  ].join('\n'))
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-session-projection'",
    "- name: '@deepseek-ai/dsh-session-title'",
    '  config:',
    '    fallbackMaxWords: 8',
    '    fallbackMaxBytes: 80',
    '    maxTitleBytes: 120',
    "- name: '@deepseek-ai/dsh-turn-notify-wechat'",
    '  config:',
    `    command: ${JSON.stringify(commandPath)}`,
    `    routeFile: ${JSON.stringify(routePath)}`,
    '    timeoutMs: 2000',
    '    settleDelayMs: 10',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-session-title', SessionTitleService],
    ['@deepseek-ai/dsh-turn-notify-wechat', TurnNotifyWechat],
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
  const unloaded = [...context.loader.entries()]
    .filter(entry => entry.fiber === undefined && !entry.disabled)
    .map(entry => entry.options.name)
  expect(unloaded).toEqual([])
  return { ctx: context, callsPath }
}

async function appendCompletedTurn(ctx: Context, id: string, assistantText: string): Promise<Session> {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: '修复 DSH 微信完成通知' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  await vi.waitFor(() => {
    expect(ctx.sessionTitle.get(session)?.title).toBe('修复 DSH 微信完成通知')
  })
  session.append('step/start', { turn: 1, step: 1 })
  session.append('assistant/message', {
    turn: 1,
    step: 1,
    message: createAssistantMessage({
      content: [
        { type: 'reasoning', text: 'private chain of thought' },
        { type: 'text', text: assistantText },
      ],
      source: { provider: 'test', model: 'test' },
    }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  return session
}

describe('turn-notify-wechat through a real Loader composition', () => {
  it('sends the folded task title and final assistant summary from a logged top-level turn', async () => {
    const { ctx, callsPath } = await bootComposition(
      'console.log(JSON.stringify({ action: \'send\', channel: \'openclaw-weixin\', dryRun: false, handledBy: \'plugin\', messageId: \'wechat-1\' }))',
    )
    await appendCompletedTurn(ctx, 'loader-turn-notice', '# 已完成\n- 微信只发送标题与摘要')

    await vi.waitFor(async () => {
      expect((await readFile(callsPath, 'utf8')).trim()).not.toBe('')
    })
    const calls = (await readFile(callsPath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as string[])
    expect(calls).toHaveLength(1)
    const args = calls[0] as string[]
    const valueAfter = (flag: string): string | undefined => args[args.indexOf(flag) + 1]
    expect({
      command: args.slice(0, 2),
      channel: valueAfter('--channel'),
      account: valueAfter('--account'),
      target: valueAfter('--target'),
      message: valueAfter('--message'),
      idempotencyKey: valueAfter('--idempotency-key')?.replace(/[0-9a-f]{64}$/u, '<sha256>'),
      json: args.at(-1),
      containsReasoning: args.join('\n').includes('private chain of thought'),
    }).toMatchInlineSnapshot(`
      {
        "account": "owner-account",
        "channel": "openclaw-weixin",
        "command": [
          "message",
          "send",
        ],
        "containsReasoning": false,
        "idempotencyKey": "dsh-turn-wechat/v1/<sha256>",
        "json": "--json",
        "message": "DSH任务 [完成]：修复 DSH 微信完成通知
      已完成；微信只发送标题与摘要",
        "target": "owner-target@im.wechat",
      }
    `)
  })

  it('keeps a failed channel subprocess outside the committed turn result', async () => {
    const { ctx, callsPath } = await bootComposition('process.exitCode = 7')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const session = await appendCompletedTurn(ctx, 'loader-failed-notice', '任务完成')

    await vi.waitFor(async () => {
      expect((await readFile(callsPath, 'utf8')).trim()).not.toBe('')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('notification failed for session loader-failed-notice turn 1'))
    })
    expect(session.events.findLast(event => event.type === 'turn/end'))
      .toMatchObject({ data: { reason: { kind: 'completed' } } })
    expect(warn.mock.calls.flat().join('\n')).not.toContain('任务完成')
  })
})
