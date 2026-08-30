/** Real HTTP coverage for workspace confinement, typing, and streaming. */
import { createServer } from 'node:http'
import type { ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { Writable } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { FILES_PATH } from '../src/workspace-files.ts'
import { handleWorkspaceFile } from '../src/workspace-file-handler.ts'

const SESSION = 's-1'

let workspace: string
let outside: string
let origin: string
let close: () => Promise<void>
let root: string

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-files-'))
  workspace = join(root, 'workspace')
  outside = join(root, 'outside')
  await mkdir(join(workspace, 'out'), { recursive: true })
  await mkdir(outside, { recursive: true })
  await writeFile(join(workspace, 'index.html'), '<h1>产物</h1>')
  await writeFile(join(workspace, 'notes.txt'), 'plain')
  await writeFile(join(workspace, 'chart.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
  await writeFile(join(workspace, 'model.safetensors'), 'unknown extension')
  await writeFile(join(workspace, 'out', 'page.html'), '<p>nested</p>')
  await writeFile(join(outside, 'secret.html'), 'SECRET')
  await symlink(join(outside, 'secret.html'), join(workspace, 'escape.html'))

  const server = createServer((req, res) => {
    void handleWorkspaceFile(req, res, {
      cwdFor: async sessionId => sessionId === SESSION
        ? workspace
        : sessionId === 'rooted' ? sep : undefined,
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  close = () => new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error === undefined || error === null) resolve()
      else reject(error)
    })
  })
})

afterAll(async () => {
  await close()
  await rm(root, { recursive: true, force: true })
})

function get(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${origin}${path}`, init)
}

describe('workspace file reads', () => {
  it('serves active documents inline from the isolated origin', async () => {
    const response = await get(`${FILES_PATH}/${SESSION}/index.html`)
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('<h1>产物</h1>')
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(response.headers.get('content-security-policy')).toBeNull()
    expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    expect(response.headers.get('cache-control')).toBe('no-store')
    expect(response.headers.get('content-disposition')).toBe('inline')
  })

  it('types known media and unknown source files without sniffing', async () => {
    const svg = await get(`${FILES_PATH}/${SESSION}/chart.svg`)
    expect(svg.headers.get('content-type')).toBe('image/svg+xml')
    const text = await get(`${FILES_PATH}/${SESSION}/notes.txt`)
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    const unknown = await get(`${FILES_PATH}/${SESSION}/model.safetensors`)
    expect(unknown.headers.get('content-type')).toBe('text/plain; charset=utf-8')
  })

  it('handles a filesystem-root cwd and nested document siblings', async () => {
    const rooted = await get(
      `${FILES_PATH}/rooted${new URL(`file://${workspace}/notes.txt`).pathname}`,
    )
    expect(await rooted.text()).toBe('plain')
    const nested = await get(`${FILES_PATH}/${SESSION}/out/page.html`)
    expect(await nested.text()).toBe('<p>nested</p>')
  })

  it('answers HEAD with length and no body', async () => {
    const response = await get(`${FILES_PATH}/${SESSION}/notes.txt`, { method: 'HEAD' })
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe('5')
    expect(await response.text()).toBe('')
  })

  it('refuses a symlink escaping the workspace', async () => {
    const response = await get(`${FILES_PATH}/${SESSION}/escape.html`)
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('SECRET')
  })

  it('coalesces invalid, missing, directory, and unknown-session reads', async () => {
    for (const path of [
      `${FILES_PATH}/${SESSION}/nope.html`,
      `${FILES_PATH}/${SESSION}/out`,
      `${FILES_PATH}/${SESSION}/notes.txt/child`,
      `${FILES_PATH}/s-other/index.html`,
      `${FILES_PATH}/${SESSION}`,
    ]) expect((await get(path)).status).toBe(404)
  })
})

describe('workspace file streaming failures', () => {
  it('destroys a response whose body sink fails after headers', async () => {
    const sink = new Writable({
      write(_chunk, _encoding, callback) { callback(new Error('socket gone')) },
    })
    const response = Object.assign(sink, { writeHead: () => response }) as unknown as ServerResponse
    await expect(handleWorkspaceFile(
      { url: `${FILES_PATH}/${SESSION}/index.html`, method: 'GET', headers: {} } as never,
      response,
      { cwdFor: async () => workspace },
    )).resolves.toBeUndefined()
    expect(sink.destroyed).toBe(true)
  })
})
