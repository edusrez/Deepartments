// dsh-deepartments — Cordis plugin (bundle scaffold, task 3).
// NO export default (pitfall 0001 — breaks `inject`).
import type { Context } from '@deepseek-ai/cordis'
import type { Config } from './org.js'
import { applyInvoke } from './invoke.js'
export { Config } from './org.js'

export const name = 'deepartments'
// agents/subagents are resolved OPTIONALLY inside applyInvoke (ctx.get): the
// agent-messaging core must keep working in minimal compositions (e.g. the
// hermetic real-Loader tests of batch 1.5 mount neither), while the bus tools
// fail loud at use when the services are absent.
//
// NOTE (Task T1, deliberate deviation from the owner's literal "inject both
// 'sessionPersistence' AND 'sessionQuery'" directive — see the builder report):
// sessionPersistence/sessionQuery are NOT added to this inject array. Cordis
// `inject` entries are a HARD service-availability gate: the plugin `apply` does
// not run until every injected service is present, so adding 'sessionQuery'
// here would prevent the bundle from booting in any composition that lacks it
// (e.g. the org/head-presets hermetic harnesses → 4 suite tests fail).
// The spec's §Risks explicitly requires the opposite — "Service absence:
// sessionPersistence may be absent → capture must stub + warn, never throw
// (test 4)" — and its §Service-injection paragraph prescribes "the existing
// optional ctx.get(...) discipline (resolve at use...)". Both the archive
// session-log capture (captureSessionLog) and the board core therefore resolve
// the session services OPTIONALLY via `ctx.get('sessionPersistence')` /
// `ctx.get('sessionQuery')` at use, degrading to the stub form when absent.
export const inject = ['tools', 'sessions']

export function apply(ctx: Context, config: Config) {
  ctx.logger.info('deepartments: online')
  // The cordis logger is exporter-based (consumed by the web UI console) and
  // never reaches stdout; journald only sees raw stdout, so also print the
  // boot line the way dsh-smooth-stream does (console.log with a prefix).
  console.log('[deepartments] online')

  // Task 4: the organization config (schema + department/agent catalog) lives
  // in ./org.ts — a pure configuration module since the board cutover (Batch
  // B3, spec 003 §7.1); its runtime consumers are the agent-messaging service
  // (applyInvoke, below) and the RPC/sidebar rows (src/agents.ts).

  // Task 5: the agent messaging service — host identity registry (hosts.json),
  // the agent→agent BUS tools (send_message/agent_messages/dept_who) + the
  // department lifecycle (dept_memo_write/dept_sleep/dept_post_create/
  // dept_post_retire). dept_invoke/fork and the board are retired.
  applyInvoke(ctx, config)
}
