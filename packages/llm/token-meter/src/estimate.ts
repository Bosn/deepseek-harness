/**
 * Fixed-density heuristic token pricing shared by the meter service and the
 * pure context-breakdown projection, so both surfaces price identical content
 * to identical numbers.
 *
 * @module @deepseek-ai/dsh-token-meter/estimate
 */

import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { EpochHeader } from '@deepseek-ai/dsh-session'

/** Fixed text-density estimate used until exact tokenization is needed. */
const CHARS_PER_TOKEN = 4

/** Per-block structural overhead for JSON framing and type tags. */
const BLOCK_OVERHEAD = 4

/** Role-field framing overhead added to every priced message. */
export const ROLE_OVERHEAD = 4

/**
 * Structural JSON price of one block outside the typed pricing arms: the
 * fixed heuristic for merge-extended blocks and for image references, whose
 * request price is route-owned rather than fixed.
 * @param block - block to price without mutation.
 * @returns heuristic tokens for the block's JSON structure.
 */
export function estimateStructuralBlock(block: ContentBlock): number {
  return BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
}

/**
 * Price content blocks recursively under the fixed density heuristic.
 * @param blocks - content blocks to price without mutation.
 * @returns heuristic tokens including per-block structural overhead.
 */
export function estimateContent(blocks: readonly ContentBlock[]): number {
  let tokens = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil(block.text.length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += Math.ceil(block.name.length / CHARS_PER_TOKEN)
          + Math.ceil(block.arguments.length / CHARS_PER_TOKEN)
          + BLOCK_OVERHEAD
        break
      case 'tool-result':
        tokens += estimateContent(block.content) + BLOCK_OVERHEAD
        break
      default:
        // ContentBlockMap is merge-extensible; unknown blocks (and image
        // references, whose request price is route-owned) retain a
        // conservative structural JSON price under the fixed heuristic.
        tokens += estimateStructuralBlock(block)
    }
  }
  return tokens
}

/**
 * Heuristically price one model-visible message.
 * @param message - message to price without mutation.
 * @returns content and role-framing tokens under the fixed heuristic.
 */
export function estimateMessage(message: Message): number {
  return estimateContent(message.content) + ROLE_OVERHEAD
}

/**
 * Price the system-prompt part of a canonical request envelope.
 * @param header - canonical envelope, or undefined before any request.
 * @returns heuristic system-prompt tokens; 0 when absent.
 */
export function estimateSystemTokens(header: EpochHeader | undefined): number {
  if (header?.system === undefined) return 0
  return Math.ceil(header.system.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD
}

/**
 * Price the tool-schema part of a canonical request envelope.
 * @param header - canonical envelope, or undefined before any request.
 * @returns heuristic tool-schema tokens; 0 when absent or empty.
 */
export function estimateToolsTokens(header: EpochHeader | undefined): number {
  if (header?.tools === undefined || header.tools.length === 0) return 0
  return Math.ceil(JSON.stringify(header.tools).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

/**
 * Price the complete non-surface request envelope.
 * @param header - canonical envelope, or undefined before any request.
 * @returns heuristic system plus tool tokens.
 */
export function estimateHeader(header: EpochHeader | undefined): number {
  return estimateSystemTokens(header) + estimateToolsTokens(header)
}

/** Deterministic UTF-8 wire length for a JavaScript string. */
function utf8Length(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/** UTF-8 bytes in one JSON-serialized model-facing value. */
function serializedBytes(value: object): number {
  return utf8Length(JSON.stringify(value))
}

/**
 * Price content blocks under the fixed byte heuristic: a conservative JSON
 * serialization of model-visible content. Built-in strings include JSON
 * escaping and field framing. Image blocks add their real base64 payload to
 * the serialized durable reference. This approximates the number an HTTP
 * gateway caps with its request-size limit (the 413 family), which token
 * pressure alone cannot predict.
 * @param blocks - content blocks to price without mutation.
 * @returns heuristic wire bytes including per-block structural overhead.
 */
export function estimateContentBytes(blocks: readonly ContentBlock[]): number {
  let bytes = 2 // surrounding JSON array brackets
  for (const [index, block] of blocks.entries()) {
    if (index > 0) bytes += 1 // separating comma
    switch (block.type) {
      case 'text':
      case 'reasoning':
      case 'tool-call':
        bytes += serializedBytes(block)
        break
      case 'tool-result': {
        const emptyContent = serializedBytes({ ...block, content: [] })
        bytes += emptyContent - 2 + estimateContentBytes(block.content)
        break
      }
      case 'image':
        bytes += serializedBytes(block) + Math.ceil(block.attachment.bytes / 3) * 4
        break
      default:
        // ContentBlockMap is merge-extensible; unknown blocks retain a
        // conservative serialized JSON price.
        bytes += serializedBytes(block)
    }
  }
  return bytes
}

/**
 * Heuristically price one model-visible message in estimated wire bytes.
 * @param message - message to price without mutation.
 * @returns content and role-framing bytes under the fixed heuristic.
 */
export function estimateMessageBytes(message: Message): number {
  const emptyContent = serializedBytes({ ...message, content: [] })
  return emptyContent - 2 + estimateContentBytes(message.content)
}

/**
 * Price the complete non-surface request envelope in estimated wire bytes.
 * @param header - canonical envelope, or undefined before any request.
 * @returns heuristic system plus tool-schema bytes.
 */
export function estimateHeaderBytes(header: EpochHeader | undefined): number {
  if (header === undefined) return 0
  const content = {
    ...header.system === undefined ? {} : { system: header.system },
    ...header.tools === undefined || header.tools.length === 0 ? {} : { tools: header.tools },
  }
  return Object.keys(content).length === 0 ? 0 : serializedBytes(content)
}
