/** Shared `/f` URL contract exercised from both browser and listener sides. */
import { describe, expect, it } from 'vitest'
import {
  FILES_PATH,
  parseWorkspaceFilePath,
  workspaceFileSegments,
  workspaceFileUrl,
} from '../src/workspace-files.ts'

describe('workspaceFileSegments', () => {
  it('normalizes relative, absolute, and Windows paths below the cwd', () => {
    expect(workspaceFileSegments('/w', 'out/index.html')).toEqual(['out', 'index.html'])
    expect(workspaceFileSegments(undefined, 'index.html')).toEqual(['index.html'])
    expect(workspaceFileSegments('/w', './a/./b.txt')).toEqual(['a', 'b.txt'])
    expect(workspaceFileSegments('/w', '/w/a/b.html')).toEqual(['a', 'b.html'])
    expect(workspaceFileSegments('/w/', '/w/a.html')).toEqual(['a.html'])
    expect(workspaceFileSegments('C:\\w', 'C:\\w\\a\\b.html')).toEqual(['a', 'b.html'])
    expect(workspaceFileSegments('C:/w', 'C:\\w\\a.html')).toEqual(['a.html'])
  })

  it('refuses outside, traversal, and directory-only targets', () => {
    for (const value of [
      workspaceFileSegments('/w', '/etc/hosts'),
      workspaceFileSegments('/w', '/workspace-other/a'),
      workspaceFileSegments(undefined, '/w/a.html'),
      workspaceFileSegments('', '/w/a.html'),
      workspaceFileSegments('/w', '../secret'),
      workspaceFileSegments('/w', 'a/../../secret'),
      workspaceFileSegments('/w', '/w'),
      workspaceFileSegments('/w', '.'),
    ]) expect(value).toBeUndefined()
  })
})

describe('workspaceFileUrl', () => {
  it('encodes names while retaining structural separators', () => {
    expect(workspaceFileUrl('s-1', ['out', 'a b.html']))
      .toBe(`${FILES_PATH}/s-1/out/a%20b.html`)
    expect(workspaceFileUrl('s/1', ['a#b.html']))
      .toBe(`${FILES_PATH}/s%2F1/a%23b.html`)
  })
})

describe('parseWorkspaceFilePath', () => {
  it('round-trips browser-built paths', () => {
    expect(parseWorkspaceFilePath(workspaceFileUrl('s-1', ['out', 'a b.html'])))
      .toEqual({ sessionId: 's-1', segments: ['out', 'a b.html'] })
  })

  it('refuses foreign, incomplete, malformed, and traversal shapes', () => {
    for (const pathname of [
      '/api/session.list',
      FILES_PATH,
      `${FILES_PATH}/s-1`,
      `${FILES_PATH}//a.html`,
      `${FILES_PATH}/s-1/../etc/hosts`,
      `${FILES_PATH}/s-1/a/./b`,
      `${FILES_PATH}/s-1/a//b`,
      `${FILES_PATH}/s-1/a%2F..%2Fb`,
      `${FILES_PATH}/s-1/a%5Cb`,
      `${FILES_PATH}/s-1/a%00b`,
      `${FILES_PATH}/s-1/a%zz`,
      `${FILES_PATH}/%zz/a.html`,
      `${FILES_PATH}//`,
    ]) expect(parseWorkspaceFilePath(pathname)).toBeUndefined()
  })
})
