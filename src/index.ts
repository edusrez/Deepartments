// dsh-deepartments — Cordis plugin (bundle scaffold, task 3).
// NO export default (pitfall 0001 — breaks `inject`).
import type { Context } from '@deepseek-ai/cordis'
import { applyOrg } from './org.js'
import type { Config } from './org.js'
import { applyInvoke } from './invoke.js'
import { applyWebFetch } from './webfetch.js'
import type { WebFetchConfig } from './webfetch.js'
export { Config } from './org.js'
export type { WebFetchConfig } from './webfetch.js'

export const name = 'deepartments'
// agents/subagents are resolved OPTIONALLY inside applyInvoke (ctx.get): the
// board-room core must keep working in minimal compositions (e.g. the
// hermetic real-Loader tests of batch 1.5 mount neither), while dept_invoke
// fails loud at call time when the continuation services are absent.
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

  // Task 5 (Batch 2): dept_invoke + board toolset + wake relay.
  applyInvoke(ctx, config)

  // Web-fetch provider: custom `ctx.web` fetch backend (URL rewrites to
  // API/JSON endpoints + WEB_BLOCKED detection). The web seam is resolved
  // OPTIONALLY, so this is a no-op in minimal compositions.
  applyWebFetch(ctx, config.webfetch ?? {})
}
