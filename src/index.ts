// dsh-deepartments — Cordis plugin (bundle scaffold, task 3).
// NO export default (pitfall 0001 — breaks `inject`).
import type { Context } from '@deepseek-ai/cordis'
import { applyOrg } from './org.js'
import type { Config } from './org.js'
export { Config } from './org.js'

export const name = 'deepartments'
export const inject = ['tools', 'sessions', 'sessionProjections']

export function apply(ctx: Context, config: Config) {
  ctx.logger.info('deepartments: online')
  // The cordis logger is exporter-based (consumed by the web UI console) and
  // never reaches stdout; journald only sees raw stdout, so also print the
  // boot line the way dsh-smooth-stream does (console.log with a prefix).
  console.log('[deepartments] online')

  // Task 4: the organization service — config schema, room projection, and
  // boot instantiation of the configured rooms (all registrations are
  // reversible effects on this plugin's fiber).
  applyOrg(ctx, config)
}
