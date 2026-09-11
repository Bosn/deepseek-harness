/** Private atomic delivery records; no session history replay. */
import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Persisted delivery state independent of the business turn outcome. */
export interface DeliveryRecord {
  /** Stable exact-turn sender idempotency key. */
  key: string
  /** Originating top-level session identifier. */
  sessionId: string
  /** Originating terminal turn number. */
  turn: number
  /** Bounded owner-visible notice; empty only before a title exists. */
  message: string
  /** Delivery outcome independent of the business turn. */
  state: 'pending' | 'queued' | 'sending' | 'retry' | 'sent' | 'unknown' | 'failed'
  /** Number of durably admitted sender attempts. */
  attempts: number
  /** Earliest send time in Unix milliseconds. */
  nextAttemptAt: number
  /** Monotonic admission order used for bounded retention. */
  retainedAt: number
  /** Payload-free failure category. */
  code?: string
  /** Message identifier from a verified successful receipt. */
  messageId?: string
}

const STATES = new Set(['pending', 'queued', 'sending', 'retry', 'sent', 'unknown', 'failed'])
const MAX_BYTES = 8 * 1024 * 1024

/** One process owns an outbox; interrupted sends never become automatic retries. */
export class DeliveryOutbox {
  /** Admitted notices and bounded terminal delivery evidence. */
  readonly records: DeliveryRecord[] = []
  private readonly lock: string
  private closed = false

  /**
   * Acquire the private file and recover only previously admitted notices.
   * @param file - Absolute owner-only outbox file.
   * @param route - Hash binding the delivery channel, account and target.
   */
  constructor(private readonly file: string, private readonly route: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    this.lock = `${file}.lock`
    try {
      const pid = Number(readFileSync(this.lock, 'utf8'))
      if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid lock')
      try { process.kill(pid, 0) } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
        rmSync(this.lock)
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('turn-notify-wechat: outbox lock unavailable')
      }
    }
    try { writeFileSync(this.lock, String(process.pid), { flag: 'wx', mode: 0o600 }) } catch {
      throw new Error('turn-notify-wechat: outbox already owned')
    }
    try {
      let raw: string
      try {
        if (statSync(file).size > MAX_BYTES) throw new Error('oversized outbox')
        raw = readFileSync(file, 'utf8')
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        this.save()
        return
      }
      const value: unknown = JSON.parse(raw)
      if (typeof value !== 'object' || value === null) throw new Error('invalid outbox')
      const data = value as Record<string, unknown>
      if (data.version !== 1 || data.route !== route || !Array.isArray(data.records) || data.records.length > 1024) {
        throw new Error('outbox format or route mismatch')
      }
      const keys = new Set<string>()
      for (const candidate of data.records) {
        if (typeof candidate !== 'object' || candidate === null) throw new Error('invalid record')
        const record = candidate as Record<string, unknown>
        if (typeof record.key !== 'string' || !/^dsh-turn-wechat\/v1\/[a-f0-9]{64}$/u.test(record.key)
          || keys.has(record.key) || typeof record.sessionId !== 'string' || record.sessionId.length > 256
          || typeof record.message !== 'string' || Buffer.byteLength(record.message) > 16 * 1024
          || record.message.includes('\0') || typeof record.state !== 'string' || !STATES.has(record.state)
          || ![record.turn, record.attempts, record.nextAttemptAt, record.retainedAt].every(value =>
            Number.isSafeInteger(value) && Number(value) >= 0)
          || (record.messageId !== undefined && (typeof record.messageId !== 'string'
            || record.messageId.length === 0 || record.messageId.length > 512))
          || (record.code !== undefined && (typeof record.code !== 'string' || !/^[a-z_]+$/u.test(record.code)))) {
          throw new Error('invalid record fields')
        }
        keys.add(record.key)
        const entry = record as unknown as DeliveryRecord
        if (entry.state === 'sending') {
          entry.state = 'unknown'
          entry.code = 'interrupted_send'
        }
        if (entry.state === 'pending') {
          entry.state = entry.message.length > 0 ? 'queued' : 'failed'
          if (entry.state === 'failed') entry.code = 'title_unavailable'
        }
        this.records.push(entry)
      }
      this.save()
    } catch {
      this.close()
      throw new Error('turn-notify-wechat: outbox unavailable or invalid; delivery stopped')
    }
  }

  /** Persist state before network activity and after its independently verified result. */
  save(): void {
    const terminal = this.records.filter(record => ['sent', 'unknown', 'failed'].includes(record.state))
    const expired = new Set(terminal.slice(0, Math.max(0, terminal.length - 256)))
    for (let index = this.records.length - 1; index >= 0; index -= 1) {
      const record = this.records[index]
      if (record !== undefined && expired.has(record)) this.records.splice(index, 1)
    }
    const temporary = `${this.file}.${randomUUID()}.tmp`
    try {
      const fd = openSync(temporary, 'wx', 0o600)
      try {
        writeFileSync(fd, JSON.stringify({ version: 1, route: this.route, records: this.records }) + '\n')
        fsyncSync(fd)
      } finally { closeSync(fd) }
      renameSync(temporary, this.file)
      if (process.platform !== 'win32') {
        const directory = openSync(dirname(this.file), 'r')
        try { fsyncSync(directory) } finally { closeSync(directory) }
      }
    } finally { rmSync(temporary, { force: true }) }
  }

  /** Release ownership only after sender subprocesses have settled. */
  close(): void {
    if (this.closed) return
    this.closed = true
    rmSync(this.lock, { force: true })
  }
}
