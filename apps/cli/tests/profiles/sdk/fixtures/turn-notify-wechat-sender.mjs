#!/usr/bin/env node

import { renameSync, writeFileSync } from 'node:fs'

const args = process.argv.slice(2)
const valueAfter = flag => args[args.indexOf(flag) + 1]
const message = valueAfter('--message')
const channel = valueAfter('--channel')
if (args[0] !== 'message' || args[1] !== 'send' || typeof message !== 'string' || typeof channel !== 'string') {
  throw new Error('invalid snapshot delivery argv')
}
writeFileSync('wechat-notice.tmp', `${message}\n`, { mode: 0o600 })
renameSync('wechat-notice.tmp', 'wechat-notice.txt')
process.stdout.write(JSON.stringify({ action: 'send', channel, messageId: 'snapshot-wechat-1' }))
