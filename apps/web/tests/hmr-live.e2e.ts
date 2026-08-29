/** Published dsh web + pnpm dev:web → browser HMR, with no page reload. */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Fiber } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import type { SubprocessHandle, SubprocessSpawnSpec } from '@deepseek-ai/dsh-subprocess'
import {
  CLIENT_BUILD_RECORD_PATH,
  clientArtifactPaths,
  readClientBuildRecord,
} from '../../../scripts/client-build-environment.ts'
import { REPO_ROOT } from './support.ts'

function spawnSpec(argv: readonly string[], cwd: string, env?: Record<string, string>): SubprocessSpawnSpec {
  return {
    argv,
    cwd,
    stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
    graceMs: 5_000,
    ...env === undefined ? {} : { env },
  }
}

function waitForOutput(child: SubprocessHandle, pattern: RegExp, label: string): Promise<string> {
  return new Promise((resolveReady, reject) => {
    let output = ''
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      child.stdout?.off('data', onData)
      child.stderr?.off('data', onData)
    }
    const resolveOnce = (value: string): void => {
      if (settled) return
      settled = true
      cleanup()
      resolveReady(value)
    }
    const rejectOnce = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onData = (chunk: Buffer): void => {
      output += chunk.toString()
      const match = pattern.exec(output)
      if (match === null) return
      resolveOnce(match[1] ?? match[0])
    }
    const timer = setTimeout(() => { rejectOnce(new Error(`${label} not ready:\n${output}`)) }, 60_000)
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    void child.done.then((outcome) => {
      rejectOnce(new Error(`${label} exited before ready (${JSON.stringify(outcome)}):\n${output}`))
    }, (error: unknown) => {
      rejectOnce(new Error(`${label} failed before ready:\n${output}`, { cause: error }))
    })
  })
}

async function stopTree(child: SubprocessHandle): Promise<void> {
  child.terminate()
  const stopped = await child.waitForExit(AbortSignal.timeout(15_000))
  if (!stopped) throw new Error(`process tree ${String(child.pid)} did not stop after termination escalation`)
  await child.done
}

/** Test whether a caught filesystem failure carries one expected error code. */
function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

/** Resolve one artifact path while rejecting a lexical escape from the repository. */
function resolveArtifactPath(root: string, path: string): string {
  const absoluteRoot = resolve(root)
  const absolutePath = resolve(absoluteRoot, path)
  const repositoryPath = relative(absoluteRoot, absolutePath)
  if (repositoryPath === '' || repositoryPath === '..'
    || repositoryPath.startsWith(`..${sep}`) || isAbsolute(repositoryPath)) {
    throw new Error(`client artifact path escapes the repository: ${JSON.stringify(path)}`)
  }
  return absolutePath
}

/** Create missing artifact parents one level at a time and reject link-shaped ancestors. */
async function prepareArtifactParent(root: string, path: string): Promise<string> {
  const absoluteRoot = resolve(root)
  const rootEntry = await lstat(absoluteRoot)
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error(`client artifact root is not a real directory: ${absoluteRoot}`)
  }
  const absolutePath = resolveArtifactPath(absoluteRoot, path)
  const parentPath = relative(absoluteRoot, dirname(absolutePath))
  let current = absoluteRoot
  for (const component of parentPath === '' ? [] : parentPath.split(sep)) {
    current = join(current, component)
    let entry
    try {
      entry = await lstat(current)
    } catch (error) {
      if (!hasErrorCode(error, 'ENOENT')) throw error
      try {
        await mkdir(current)
      } catch (mkdirError) {
        if (!hasErrorCode(mkdirError, 'EEXIST')) throw mkdirError
      }
      entry = await lstat(current)
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`client artifact parent is not a real directory: ${current}`)
    }
  }
  return absolutePath
}

/** Capture every byte covered by the complete client build record. */
async function snapshotClientArtifacts(root: string): Promise<ReadonlyMap<string, Buffer>> {
  return new Map(await Promise.all(clientArtifactPaths(root).map(async (path) => {
    const absolutePath = await prepareArtifactParent(root, path)
    const entry = await lstat(absolutePath)
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw new Error(`client artifact is not a real file: ${absolutePath}`)
    }
    return [path, await readFile(absolutePath)] as const
  })))
}

/** Restore the recorded artifact set and remove files created by the watch build. */
async function restoreClientArtifacts(root: string, snapshot: ReadonlyMap<string, Buffer>): Promise<void> {
  const failures: unknown[] = []
  let additions: string[] = []
  try {
    additions = clientArtifactPaths(root).filter(path => !snapshot.has(path))
  } catch (error) {
    failures.push(error)
  }
  await Promise.all(additions.map(async (path) => {
    try {
      await unlink(await prepareArtifactParent(root, path))
    } catch (error) {
      failures.push(error)
    }
  }))
  await Promise.all([...snapshot].map(async ([path, content]) => {
    try {
      const absolutePath = await prepareArtifactParent(root, path)
      try {
        const entry = await lstat(absolutePath)
        if (entry.isSymbolicLink()) await unlink(absolutePath)
        else if (!entry.isFile()) throw new Error(`client artifact destination is not a real file: ${absolutePath}`)
      } catch (error) {
        if (!hasErrorCode(error, 'ENOENT')) throw error
      }
      await writeFile(absolutePath, content)
    } catch (error) {
      failures.push(error)
    }
  }))
  if (failures.length > 0) throw new AggregateError(failures, 'client artifact cleanup failed')
}

/** Prove cleanup preserved the record and restored the artifact bytes it binds. */
async function verifyClientArtifacts(root: string, originalRecord: Buffer): Promise<void> {
  const currentRecord = await readFile(join(root, CLIENT_BUILD_RECORD_PATH))
  if (!currentRecord.equals(originalRecord)) throw new Error('HMR browser test changed the client build record')
  readClientBuildRecord(root)
}

it('hot-reloads a real client-plugin source edit without refreshing the page', async () => {
  const world = await mkdtemp(join(tmpdir(), 'dsh-web-hmr-world-'))
  const sourcePath = join(REPO_ROOT, 'packages/client/ui-conversation/src/client/locales.ts')
  const binPath = join(REPO_ROOT, 'apps/cli/lib/bin.js')
  if (!existsSync(binPath)) throw new Error('HMR browser test needs the built dsh bin; run pnpm run build first')
  const clientBuildEnvironment = readClientBuildRecord(REPO_ROOT).environment
  const originalBuildRecord = await readFile(join(REPO_ROOT, CLIENT_BUILD_RECORD_PATH))
  const originalClientArtifacts = await snapshotClientArtifacts(REPO_ROOT)
  const originalSource = await readFile(sourcePath)
  const cleanupProbeRepositoryPath = `apps/web/dist/assets/dsh-hmr-cleanup-probe-${randomUUID()}.js`
  const cleanupProbePath = join(REPO_ROOT, cleanupProbeRepositoryPath)
  const oldText = 'Into the Unknown'
  const sourceNeedle = "'hero.headline': 'Into the Unknown'"
  const newText = `HMR UPDATED ${'x'.repeat(80)}`
  const updatedSource = originalSource.toString().replace(sourceNeedle, `'hero.headline': '${newText}'`)
  if (updatedSource === originalSource.toString()) throw new Error(`HMR source lacks ${JSON.stringify(sourceNeedle)}`)

  const subprocessCtx = new Context()
  let subprocessFiber: Fiber | undefined
  let watcher: SubprocessHandle | undefined
  let host: SubprocessHandle | undefined
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined
  const failures: unknown[] = []
  try {
    subprocessFiber = await subprocessCtx.plugin(LocalSubprocessRuntime)
    watcher = subprocessCtx.subprocess.spawn(spawnSpec(
      ['pnpm', 'run', 'dev:web'],
      REPO_ROOT,
      { ...clientBuildEnvironment },
    ))
    await waitForOutput(watcher, /dev-web: watching/, 'pnpm run dev:web')
    host = subprocessCtx.subprocess.spawn(spawnSpec(
      [process.execPath, binPath, 'web', '--no-open', '--port', '0'],
      world,
      {
        DEEPSEEK_API_KEY: 'keyless-hmr-no-call',
        DSH_HOME: join(world, '.dsh'),
      },
    ))
    const baseUrl = await waitForOutput(host, /dsh web: (http:\/\/[^\s]+)/, 'built dsh web')
    browser = await chromium.launch()
    const page = await browser.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', error => pageErrors.push(String(error)))
    await page.goto(baseUrl, { waitUntil: 'load' })
    await page.getByText(oldText, { exact: true }).waitFor({ timeout: 15_000 })
    const pageIdentity = await page.evaluate(() => {
      // In-page code: an import would not survive serialization, and the page
      // entropy source available in every context is getRandomValues.
      const identity = Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => byte.toString(16).padStart(2, '0')).join('')
      Object.defineProperty(window, '__dshHmrPageIdentity', { value: identity })
      return identity
    })

    await writeFile(sourcePath, updatedSource)
    await page.getByText(newText, { exact: true }).waitFor({ timeout: 30_000 })
    expect(await page.evaluate(() => (window as Window & { __dshHmrPageIdentity?: string }).__dshHmrPageIdentity))
      .toBe(pageIdentity)
    expect(pageErrors).toEqual([])
  } catch (error) {
    failures.push(error)
  } finally {
    let writerQuiescent = watcher === undefined
    if (watcher !== undefined) {
      try {
        await stopTree(watcher)
        writerQuiescent = true
      } catch (error) {
        failures.push(error)
      }
    }
    if (host !== undefined) await stopTree(host).catch((error: unknown) => failures.push(error))
    if (subprocessFiber !== undefined) {
      try {
        await subprocessFiber.dispose()
        writerQuiescent = true
      } catch (error) {
        failures.push(error)
      }
    }
    if (!writerQuiescent && watcher !== undefined) {
      try {
        writerQuiescent = await watcher.waitForExit(AbortSignal.timeout(15_000))
      } catch (error) {
        failures.push(error)
      }
    }
    await browser?.close().catch((error: unknown) => failures.push(error))
    await writeFile(sourcePath, originalSource).catch((error: unknown) => failures.push(error))
    if (writerQuiescent) {
      try {
        const safeProbePath = await prepareArtifactParent(REPO_ROOT, cleanupProbeRepositoryPath)
        await writeFile(safeProbePath, 'HMR cleanup probe\n', { flag: 'wx' })
      } catch (error) {
        failures.push(error)
      }
      await restoreClientArtifacts(REPO_ROOT, originalClientArtifacts).catch((error: unknown) => failures.push(error))
      if (existsSync(cleanupProbePath)) failures.push(new Error('HMR cleanup left its added client artifact behind'))
      await verifyClientArtifacts(REPO_ROOT, originalBuildRecord).catch((error: unknown) => failures.push(error))
    } else {
      failures.push(new Error(
        'HMR watcher did not quiesce; client artifacts were not restored. Run a complete pnpm run build before consuming them.',
      ))
    }
    await rm(world, { recursive: true, force: true }).catch((error: unknown) => failures.push(error))
  }
  if (failures.length > 0) throw new AggregateError(failures, 'HMR browser test or cleanup failed')
}, 120_000)
