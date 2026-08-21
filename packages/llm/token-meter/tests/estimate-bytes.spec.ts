import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import {
  estimateContentBytes,
  estimateHeaderBytes,
  estimateMessageBytes,
} from '@deepseek-ai/dsh-token-meter'
import { createMessage, createUserMessage, CallId } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'

const BLOCK_OVERHEAD = 4
const ROLE_OVERHEAD = 4

function textMessage(text: string, role: Message['role'] = 'user'): Message {
  return createMessage({
    role,
    content: [{ type: 'text', text }],
    source: role === 'assistant'
      ? { kind: 'model', provider: 'mock', model: 'mock' }
      : { kind: 'user' },
  })
}

describe('byte-priced estimation (gateway request-size pressure)', () => {
  it('prices text blocks as UTF-8 wire bytes with structural overhead', () => {
    expect(estimateMessageBytes(textMessage('abcd'))).toBe(4 + BLOCK_OVERHEAD + ROLE_OVERHEAD)
    // 4 Chinese characters encode to 12 UTF-8 bytes.
    expect(estimateMessageBytes(textMessage('中文文本'))).toBe(12 + BLOCK_OVERHEAD + ROLE_OVERHEAD)
  })

  it('prices tool-call blocks on name and arguments bytes plus nested results', () => {
    const message = createMessage({
      role: 'assistant',
      content: [
        { type: 'tool-call', id: CallId('c1'), name: 'work', arguments: '{"i":1}' },
        { type: 'tool-result', toolCallId: CallId('c1'), content: [{ type: 'text', text: '出' }], isError: false },
      ],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    })
    expect(estimateMessageBytes(message)).toBe(
      'work'.length + '{"i":1}'.length + BLOCK_OVERHEAD
      + 3 + BLOCK_OVERHEAD + BLOCK_OVERHEAD
      + ROLE_OVERHEAD,
    )
  })

  it('prices image blocks on their real base64 payload', () => {
    const message = createUserMessage({
      content: [{
        type: 'image',
        attachment: {
          attachmentId: AttachmentId(`sha256:${'a'.repeat(64)}`),
          mediaType: 'image/png',
          bytes: 900,
          width: 1000,
          height: 1000,
        },
      }],
      source: { kind: 'user' },
    })
    expect(estimateMessageBytes(message)).toBe(Math.ceil(900 / 3) * 4 + BLOCK_OVERHEAD + ROLE_OVERHEAD)
  })

  it('prices unknowns conservatively through serialized JSON bytes', () => {
    const unknown = { type: 'exotic', payload: '中' } as unknown as Parameters<typeof estimateContentBytes>[0][number]
    expect(estimateContentBytes([unknown]))
      .toBe(Buffer.byteLength(JSON.stringify(unknown), 'utf8') + BLOCK_OVERHEAD)
  })

  it('prices the request header as system and tool-schema bytes', () => {
    expect(estimateHeaderBytes({ config: { provider: 'mock', model: 'mock' }, system: '中文' }))
      .toBe(6 + ROLE_OVERHEAD)
    expect(estimateHeaderBytes({
      config: { provider: 'mock', model: 'mock' },
      tools: [{ name: 'work', description: 'x', parameters: {} }],
    })).toBe(Buffer.byteLength(
      JSON.stringify([{ name: 'work', description: 'x', parameters: {} }]),
      'utf8',
    ) + BLOCK_OVERHEAD)
    expect(estimateHeaderBytes(undefined)).toBe(0)
  })
})
