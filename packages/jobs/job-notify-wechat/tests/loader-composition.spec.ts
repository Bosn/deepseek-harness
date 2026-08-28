import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import * as JobNotifyWechat from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function bootComposition(commandBody: string): Promise<{ ctx: Context; callsPath: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-job-notify-wechat-'))
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
    "- name: '@deepseek-ai/dsh-jobs-local'",
    "- name: '@deepseek-ai/dsh-job-notify-wechat'",
    '  config:',
    `    command: ${JSON.stringify(commandPath)}`,
    `    routeFile: ${JSON.stringify(routePath)}`,
    '    timeoutMs: 2000',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-jobs-local', LocalJobRegistry],
    ['@deepseek-ai/dsh-job-notify-wechat', JobNotifyWechat],
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
  context.jobs.attachController('test-controller')
  return { ctx: context, callsPath }
}

function startJob(ctx: Context, label: string): (outcome: JobOutcome) => void {
  let settle!: (outcome: JobOutcome) => void
  ctx.jobs.start({
    kind: 'bash',
    label,
    run: () => ({
      cancel() {},
      done: new Promise((resolve) => { settle = resolve }),
    }),
  })
  return settle
}

describe('job-notify-wechat through a real Loader composition', () => {
  it('sends one content-bounded private notice with a stable idempotency key', async () => {
    const { ctx, callsPath } = await bootComposition(
      'console.log(JSON.stringify({ action: \'send\', channel: \'openclaw-weixin\', dryRun: false, handledBy: \'plugin\', messageId: \'wechat-1\' }))',
    )
    const settle = startJob(ctx, 'SECRET_TOKEN=must-not-cross-the-channel')
    settle({ status: 'completed' })

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
      containsLabel: args.join('\n').includes('SECRET_TOKEN'),
    }).toMatchInlineSnapshot(`
      {
        "account": "owner-account",
        "channel": "openclaw-weixin",
        "command": [
          "message",
          "send",
        ],
        "containsLabel": false,
        "idempotencyKey": "dsh-job-wechat/v1/<sha256>",
        "json": "--json",
        "message": "DSH任务 [完成]：bash-1（bash）",
        "target": "owner-target@im.wechat",
      }
    `)
  })

  it('keeps a failed channel subprocess outside job settlement', async () => {
    const { ctx, callsPath } = await bootComposition('process.exitCode = 7')
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const settle = startJob(ctx, 'private command')
    settle({ status: 'failed', detail: 'exit code: 1' })

    await vi.waitFor(async () => {
      expect((await readFile(callsPath, 'utf8')).trim()).not.toBe('')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('notification failed for bash-1'))
    })
    expect(ctx.jobs.get('bash-1' as never).status).toBe('failed')
    expect(warn.mock.calls.flat().join('\n')).not.toContain('private command')
  })
})
