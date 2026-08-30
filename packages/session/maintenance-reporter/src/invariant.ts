/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-maintenance-reporter`.
 * @module @deepseek-ai/dsh-maintenance-reporter/invariant
 */

import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-maintenance-reporter'

/** Cordis companion plugin name. */
export const name = 'maintenance-reporter-invariant'

/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

// No runtime invariant: the authoritative holder and coverage relationships
// live behind the external typed command transport. The real-composition test
// owns lifecycle, identity, and teardown verification.
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
