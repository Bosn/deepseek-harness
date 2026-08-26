/**
 * Real-composition authorization for the trusted-host `host.openPath` grant.
 *
 * The SHIPPED Web surface (dsh-base + dsh-web-app bundle patches over an empty
 * preset root) boots through the Loader with a listening server, and a real
 * HTTP request whose `Host` names the declared authority must reach the
 * assembled API Proxy's desktop opener, while an undeclared authority is
 * refused by the same fence that guards every other `/api` method. The
 * hand-assembled connection suites assert only the local set-membership
 * guard, so a Loader-configuration or proxy-assembly regression could leave
 * remote file clicks broken while those tests stay green.
 */

import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { boot, healProfilesModuleFallback, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-host-webserver'

const CONFIG_DIR = fileURLToPath(new URL('../config/', import.meta.url))
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url))
/** The shipped Web surface: the dsh-base and dsh-web-app bundle patches over an empty preset root. */
const BASE_PATCH = join(REPO_ROOT, 'packages/bundle/base/cordis.patch.yml')
const WEB_PATCH = join(REPO_ROOT, 'packages/bundle/web-app/cordis.patch.yml')
/** The installation anchor whose dependency surface the preset module fallback mirrors. */
const INSTALL_ANCHOR = join(REPO_ROOT, 'apps/cli/package.json')

/**
 * Boot the shipped Web composition with the transport rows enabled: the
 * webserver binds an ephemeral port, the web runtime declares one
 * `trustedHosts` authority that the connection row propagates from, and the
 * API gateway stays the real assembled proxy. Everything that would touch the
 * network, write outside the test, or needs the browser roster stays off.
 */
async function bootServingWeb(settingsFile: string): Promise<Context> {
  const storageRoot = join(dirname(settingsFile), 'storages')
  const overrides: PatchOptions[] = [
    // The settings row defaults to `$DSH_HOME/settings.yaml`; pin it to a temp
    // file so the developer's own document cannot decide this boot.
    { id: 'settings', config: { path: settingsFile, watch: false } },
    // Same reasoning as the settings row: unpinned, storage-json writes the
    // developer's own `~/.dsh/storages/`.
    { id: 'storage-json', config: { root: storageRoot } },
    // A real URL to send real requests to; port 0 binds an ephemeral port.
    { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
    // The web runtime row propagates these values to the /api trust fence
    // through its provided service; no browser handoff or URL line in a test.
    {
      id: 'web-runtime',
      config: { openBrowser: false, printUrl: false, surfaceContext: false, trustedHosts: ['harness.example'] },
    },
    { id: 'session-telemetry-otel', disabled: true },
    // The browser roster and its served bundles are irrelevant to the host
    // transport under test; the reload chain waits for them.
    { id: 'modules', disabled: true },
    { id: 'client-hmr', disabled: true },
    // The -auto picker waits for a running host; the browse variant supplies
    // the `directoryPicker` service the API gateway injects.
    { id: 'directory-picker', disabled: true },
    { insert: [
      { id: 'directory-picker-browse', name: '@deepseek-ai/dsh-host-directory-picker-browse' },
      { id: 'ui-directory-picker-browse', name: '@deepseek-ai/dsh-client-ui-directory-picker-browse' },
    ] },
    // Only the shipped preset root, so a developer's own `~/.dsh/.preset`
    // cannot change this boot's outcome.
    {
      id: 'agent-presets',
      config: {
        default: 'standard',
        roots: [{ path: join(CONFIG_DIR, 'agent-presets'), trust: 'system' }],
        includeUserRoot: false,
      },
    },
  ]
  // The surface is patch layers over an empty preset root, so the root sits
  // outside this workspace and bare plugin names cannot resolve by Node's
  // upward walk. The flat fallback the preset boot maintains is what makes
  // them resolvable — the same mechanism, not a test-only shim.
  const home = dirname(settingsFile)
  healProfilesModuleFallback(INSTALL_ANCHOR, home)
  const profileDir = join(home, 'profiles', 'spec')
  await mkdir(profileDir, { recursive: true })
  const bundlePatches: PatchOptions[] = [
    ...loadOverlayPatches('dsh-test', BASE_PATCH),
    ...loadOverlayPatches('dsh-test', WEB_PATCH),
  ]
  const rootConfig = join(profileDir, 'cordis.yml')
  await writeFile(rootConfig, '[]\n')
  return await boot('dsh-test', rootConfig, [...bundlePatches, ...overrides], (bootCtx) => {
    provideCmdline(bootCtx, { args: [], exit: () => {} })
  })
}

interface RawResponse { status: number; body: string }

/** One real request; `authority` spoofs the Host header the way a LAN client's browser would send it. */
function postRpc(
  port: number, authority: string, rpcId: string, method: string, payload: unknown,
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ type: 'client-request', rpcId, method, payload })
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: `/api/${method}`,
        method: 'POST',
        headers: {
          host: authority,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        let text = ''
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => { text += chunk })
        response.on('end', () => { resolve({ status: response.statusCode ?? 0, body: text }) })
      },
    )
    request.on('error', reject)
    request.end(body)
  })
}

let ctx: Context
const tempRoots: string[] = []

beforeAll(async () => {
  const settingsFile = join(await mkdtemp(join(tmpdir(), 'dsh-web-openpath-')), 'settings.yaml')
  tempRoots.push(dirname(settingsFile))
  await writeFile(settingsFile, '{}\n')
  ctx = await bootServingWeb(settingsFile)
}, 120_000)

afterAll(async () => {
  await ctx.fiber.dispose()
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true })
})

describe('the shipped Web composition', () => {
  it('serves host.openPath to the declared trusted authority and refuses an undeclared one', async () => {
    const port = ctx.webServer.port
    // A path that never exists: the assembled proxy must reach the platform
    // opener, which rejects it on every desktop (observable as the opener's
    // own failure) — the alternative would spawn a real document viewer.
    const missingPath = join(tmpdir(), `dsh-openpath-no-such-file-${randomUUID()}.txt`)

    const declared = await postRpc(port, 'harness.example', 'rpc-open', 'host.openPath', { path: missingPath })
    expect(declared.status).toBe(200)
    const envelope = JSON.parse(declared.body) as {
      type: string
      rpcId: string
      result: { ok: boolean; value?: { opened: true }; error?: { code: string; message: string } }
    }
    expect(envelope).toMatchObject({ type: 'server-response', rpcId: 'rpc-open' })
    if (envelope.result.ok) {
      // A desktop whose opener accepted the handoff.
      expect(envelope.result.value).toEqual({ opened: true })
    } else {
      // Everywhere else the platform opener itself answered the rejection:
      // this is the opener's error, not the fence's.
      expect(envelope.result.error?.code).toBe('internal')
      expect(envelope.result.error?.message.startsWith('path open failed: ')).toBe(true)
    }

    const undeclared = await postRpc(port, 'outside.example', 'rpc-open', 'host.openPath', { path: missingPath })
    expect(undeclared.status).toBe(403)
    expect(undeclared.body).toBe('forbidden')
  }, 120_000)
})
