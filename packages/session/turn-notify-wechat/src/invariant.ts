/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-turn-notify-wechat`.
 * @module @deepseek-ai/dsh-turn-notify-wechat/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-turn-notify-wechat'

/** Cordis companion plugin name. */
export const name = 'turn-notify-wechat-invariant'

/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

// No runtime invariant: the plugin owns no durable or queryable state. Its one
// relationship crosses into an external channel process, so command receipt
// validation belongs in the real-composition test rather than a tree audit.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
