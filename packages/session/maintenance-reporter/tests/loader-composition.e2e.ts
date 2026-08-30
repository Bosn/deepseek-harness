/**
 * REAL-composition tier: boot the maintenance reporter through the ordinary
 * Loader/app path, use real Session, AgentRegistry, and ShellEnv services, and
 * mock only the deployment-owned BOCC Unix command socket.
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/cordis.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))
const ownerSocketHost = process.platform !== 'win32' && process.getuid?.() === 1000

interface FixtureOutput {
  environment: Record<string, string>
  commands: Record<string, unknown>[]
}

describe.runIf(ownerSocketHost)('maintenance-reporter through a real headless cordis.yml', () => {
  it('composes managed identity, lease lifecycle, and teardown coverage around the real services', async () => {
    let output!: FixtureOutput
    const { stderr } = await runLoaderSmoke({
      label: 'maintenance-reporter loader smoke',
      tempDirPrefix: 'maintenance-reporter-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      inspect: async (cwd) => {
        output = JSON.parse(await readFile(`${cwd}/maintenance-captures.json`, 'utf8')) as FixtureOutput
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(output.environment).toMatchObject({
      DSH_MAINTENANCE_TOP_LEVEL: '1',
      DSH_MAINTENANCE_TURN_ID: '1',
      DSH_MAINTENANCE_REPORTER_ID: 'dsh-maintenance-reporter-e2e',
      DSH_SESSION_ID: 'session-one',
    })
    expect(output.environment.DSH_MAINTENANCE_RUNTIME_GENERATION).toMatch(/^sha256:[a-f0-9]{64}$/u)

    const heartbeat = output.commands.find(command => command.operation === 'heartbeat')
    expect(heartbeat?.lease).toEqual({
      leaseId: 'lease:session-one',
      generation: 1,
      expectedHolderRevision: 1,
    })
    expect(heartbeat?.requestId).toMatch(/^maintenance:heartbeat:[a-f0-9]{64}$/u)

    const release = output.commands.find(command => command.operation === 'release')
    expect(release?.releaseReason).toBe('failed')
    expect(release?.requestId).toMatch(/^maintenance:release:[a-f0-9]{64}$/u)

    const coverages = output.commands
      .filter(command => command.operation === 'report-coverage')
      .map(command => (command.coverage as { state?: string }).state)
    expect(coverages).toContain('complete')
    expect(coverages.at(-1)).toBe('unavailable')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
