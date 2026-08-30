/** Listener binding, fencing, failure, and public-origin coverage. */
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertFilesPublicUrl,
  listenForWorkspaceFiles,
  workspaceFileAuthorities,
} from '../src/files-server.ts'
import { FILES_PATH } from '../src/workspace-files.ts'

function getWithHost(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path, method: 'GET', headers: { host } },
      (response) => {
        response.resume()
        response.on('end', () => { resolve(response.statusCode ?? 0) })
      },
    )
    request.on('error', reject)
    request.end()
  })
}

describe('workspace-file listener', () => {
  it.each([
    [new Error('store unavailable'), 'store unavailable'],
    ['plain string failure', 'plain string failure'],
  ])('answers 400 and reports a directory lookup failure', async (failure, message) => {
    const seen: Error[] = []
    const files = await listenForWorkspaceFiles(
      '127.0.0.1', 0, [], undefined, () => true,
      { cwdFor: () => Promise.reject(failure) },
      (error) => { seen.push(error) },
    )
    try {
      const response = await fetch(
        `http://127.0.0.1:${String(files.port)}${FILES_PATH}/s-1/a.txt`,
      )
      expect(response.status).toBe(400)
      expect(seen.map(error => error.message)).toEqual([message])
    } finally {
      await files.close()
    }
  })

  it('tears down a read failing after the status line without logging it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-files-server-'))
    try {
      await writeFile(join(root, 'unreadable.txt'), 'seed')
      await chmod(join(root, 'unreadable.txt'), 0o000)
      const seen: Error[] = []
      const files = await listenForWorkspaceFiles(
        '127.0.0.1', 0, [], undefined, () => true,
        { cwdFor: async () => root },
        (error) => { seen.push(error) },
      )
      try {
        await expect(fetch(
          `http://127.0.0.1:${String(files.port)}${FILES_PATH}/s-1/unreadable.txt`,
        )).rejects.toThrow()
        expect(seen).toEqual([])
      } finally {
        await files.close()
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('closes idempotently and stops answering', async () => {
    const files = await listenForWorkspaceFiles(
      '127.0.0.1', 0, [], undefined, () => true,
      { cwdFor: async () => undefined }, () => {},
    )
    const origin = `http://127.0.0.1:${String(files.port)}`
    expect((await fetch(`${origin}${FILES_PATH}/s-1/a.txt`)).status).toBe(404)
    await files.close()
    await files.close()
    await expect(fetch(`${origin}${FILES_PATH}/s-1/a.txt`)).rejects.toThrow()
  })

  it('fences authorities and accepts the declared public files origin', async () => {
    const publicOrigin = 'https://files.example:7443'
    const files = await listenForWorkspaceFiles(
      '127.0.0.1', 0, ['harness.example:3080'], publicOrigin, () => true,
      { cwdFor: async () => undefined },
      () => {},
    )
    try {
      expect(await getWithHost(files.port, `${FILES_PATH}/s-1/a.txt`, 'attacker.example')).toBe(403)
      expect(await getWithHost(files.port, `${FILES_PATH}/s-1/a.txt`, 'files.example:7443')).toBe(404)
    } finally {
      await files.close()
    }
  })

  it('requires an authenticated browser session after the Host fence', async () => {
    const files = await listenForWorkspaceFiles(
      '127.0.0.1', 0, [], undefined, () => false,
      { cwdFor: async () => undefined },
      () => {},
    )
    try {
      const response = await fetch(
        `http://127.0.0.1:${String(files.port)}${FILES_PATH}/s-1/a.txt`,
      )
      expect(response.status).toBe(401)
      expect(await response.text()).toBe('unauthorized')
    } finally {
      await files.close()
    }
  })

  it('re-ports exact app authorities when clients reach the listener directly', async () => {
    const files = await listenForWorkspaceFiles(
      '127.0.0.1', 0, ['harness.example:3080'], undefined, () => true,
      { cwdFor: async () => undefined },
      () => {},
    )
    try {
      expect(await getWithHost(
        files.port,
        `${FILES_PATH}/s-1/a.txt`,
        `harness.example:${String(files.port)}`,
      )).toBe(404)
    } finally {
      await files.close()
    }
  })

  it('serves only /f and only GET/HEAD', async () => {
    const files = await listenForWorkspaceFiles(
      '127.0.0.1', 0, [], undefined, () => true,
      { cwdFor: async () => undefined }, () => {},
    )
    try {
      const origin = `http://127.0.0.1:${String(files.port)}`
      expect((await fetch(`${origin}/`)).status).toBe(404)
      expect((await fetch(`${origin}/api/session.list`)).status).toBe(404)
      const write = await fetch(`${origin}${FILES_PATH}/s-1/a.txt`, { method: 'POST' })
      expect(write.status).toBe(405)
      expect(write.headers.get('allow')).toBe('GET, HEAD')
    } finally {
      await files.close()
    }
  })

  it('rejects a fixed port already in use', async () => {
    const first = await listenForWorkspaceFiles(
      '127.0.0.1', 0, [], undefined, () => true,
      { cwdFor: async () => undefined }, () => {},
    )
    try {
      await expect(listenForWorkspaceFiles(
        '127.0.0.1', first.port, [], undefined, () => true,
        { cwdFor: async () => undefined },
        () => {},
      )).rejects.toThrow()
    } finally {
      await first.close()
    }
  })
})

describe('workspace-file authorities', () => {
  it('keeps port-less authorities and adds only the effective files authority', () => {
    expect(workspaceFileAuthorities(['app.example'], 3082))
      .toEqual(['app.example'])
    expect(workspaceFileAuthorities(['app.example:3080'], 3082))
      .toEqual(['app.example:3080', 'app.example:3082'])
    expect(workspaceFileAuthorities(
      ['app.example:3080'], 3082, 'https://files.example:7443',
    )).toEqual(['app.example:3080', 'files.example:7443'])
  })
})

describe('assertFilesPublicUrl', () => {
  it('normalizes a bare origin and refuses rewritten forms', () => {
    expect(assertFilesPublicUrl('https://klaus-server.tailcdff9a.ts.net:3082'))
      .toBe('https://klaus-server.tailcdff9a.ts.net:3082')
    expect(assertFilesPublicUrl('http://127.0.0.1:3082/')).toBe('http://127.0.0.1:3082')
    for (const bad of [
      'not-a-url',
      'ftp://files.example',
      'https://files.example/f',
      'https://files.example?x=1',
      'https://files.example#frag',
      'https://user@files.example',
      'https://files.example:99999',
    ]) expect(() => assertFilesPublicUrl(bad)).toThrow(/files\.publicUrl/)
  })
})
