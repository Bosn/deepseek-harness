import { describe, expect, it } from 'vitest'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import {
  estimateContentBytes,
  estimateHeaderBytes,
  estimateMessageBytes,
} from '@deepseek-ai/dsh-token-meter'
import { createMessage, createUserMessage, CallId } from '@deepseek-ai/dsh-llm'
import type { Message } from '@deepseek-ai/dsh-llm'

function serializedBytes(value: object): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

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
  it('prices text blocks through their escaped JSON representation', () => {
    const ascii = textMessage('quotes " slash \\ newline\n')
    expect(estimateMessageBytes(ascii)).toBe(serializedBytes(ascii))
    expect(estimateMessageBytes(textMessage('中文文本'))).toBe(serializedBytes(textMessage('中文文本')))
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
    expect(estimateMessageBytes(message)).toBe(serializedBytes(message))

    const argumentsText = JSON.stringify({ quoted: '"'.repeat(2_000), path: '\\'.repeat(2_000) })
    const escapedArguments = createMessage({
      role: 'assistant',
      content: [{
        type: 'tool-call',
        id: CallId('c2'),
        name: 'work',
        arguments: argumentsText,
      }],
      source: { kind: 'model', provider: 'mock', model: 'mock' },
    })
    expect(estimateMessageBytes(escapedArguments)).toBe(serializedBytes(escapedArguments))
    expect(estimateMessageBytes(escapedArguments))
      .toBeGreaterThan(Buffer.byteLength(argumentsText, 'utf8'))
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
    expect(estimateMessageBytes(message)).toBe(serializedBytes(message) + Math.ceil(900 / 3) * 4)
  })

  it('prices unknowns conservatively through serialized JSON bytes', () => {
    const unknown = { type: 'exotic', payload: '中' } as unknown as Parameters<typeof estimateContentBytes>[0][number]
    expect(estimateContentBytes([unknown])).toBe(serializedBytes([unknown]))
  })

  it('prices the request header as system and tool-schema bytes', () => {
    expect(estimateHeaderBytes({ config: { provider: 'mock', model: 'mock' }, system: '中文' }))
      .toBe(serializedBytes({ system: '中文' }))
    expect(estimateHeaderBytes({
      config: { provider: 'mock', model: 'mock' },
      tools: [{ name: 'work', description: 'x', parameters: {} }],
    })).toBe(serializedBytes({ tools: [{ name: 'work', description: 'x', parameters: {} }] }))
    expect(estimateHeaderBytes({ config: { provider: 'mock', model: 'mock' } })).toBe(0)
    expect(estimateHeaderBytes(undefined)).toBe(0)
  })
})
