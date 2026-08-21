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
// hermetic real-Loader tests of batch 1.5 mount neither), while the host-plane
// board tools and wake relay fail loud at use when the services are absent.
//
// NOTE (Task T1, deliberate deviation from the owner's literal "inject both
// 'sessionPersistence' AND 'sessionQuery'" directive — see the builder report):
// sessionPersistence/sessionQuery are NOT added to this inject array. Cordis
// `inject` entries are a HARD service-availability gate: the plugin `apply` does
// not run until every injected service is present, so adding 'sessionQuery'
// here would prevent the bundle from booting in any composition that lacks it
// (e.g. the org/head-presets/webfetch hermetic harnesses → 4 suite tests fail).
// The spec's §Risks explicitly requires the opposite — "Service absence:
// sessionPersistence may be absent → capture must stub + warn, never throw
// (test 4)" — and its §Service-injection paragraph prescribes "the existing
// optional ctx.get(...) discipline (resolve at use...)". Both the archive
// session-log capture (captureSessionLog) and the board core therefore resolve
// the session services OPTIONALLY via `ctx.get('sessionPersistence')` /
// `ctx.get('sessionQuery')` at use, degrading to the stub form when absent.
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

  // Task 5 (Batch A): the board-as-bus backbone — host identity registry,
  // host-plane board tools (dept_room_read/write/who/whereami registered
  // globally so the host and every agent can use the bus) + the wake relay
  // (wakes addressed posts through the live parent and hosts via the raw
  // agent path). dept_invoke/fork is retired.
  applyInvoke(ctx, config)

  // Web-fetch provider: custom `ctx.web` fetch backend (blocking detection
  // WEB_BLOCKED + investigate hint). The web seam is resolved OPTIONALLY,
  // so this is a no-op in minimal compositions.
  applyWebFetch(ctx, config.webfetch ?? {})
}
