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
  // ---------------------------------------------------------------------------
  // fb-2432 — THE MISSING SINK: make the bundle's `ctx.logger.error` line
  // REACHABLE (journald), so a diagnosis the code emits can actually be read.
  //
  // MEASURED (2026-09-22, HEAD 846cf40, dev profile), and this is the honest
  // discrimination the lane asked for — it is NONE of «level filter», «wrong
  // object» or «buffering»:
  //   * `ctx.logger` had NO durable sink AT ALL. The ONLY default exporter is
  //     cordis's own in-memory RING BUFFER (`LoggerService` ctor:
  //     `export: (message) => { self.buffer.push(message) … }`, `bufferSize =
  //     1e3`) — a GUI-console feed, never stdout/journald. Its default levels
  //     entry is `default: 1`, so a plain `warn` (level 2) is not even retained.
  //     Empirically proven: with no exporter registered, `ctx.logger.info(…)`
  //     AND `ctx.logger.error(…)` both emit ZERO bytes; `console.log` appears.
  //   * The TWO `[deepartments]` lines journald DOES show («online» + «channel
  //     mounted») are `console.log` — and from TWO DIFFERENT PACKAGES
  //     (src/index.ts:35 and packages/dshd-gui/src/index.ts:839), NOT from
  //     `ctx.logger`. So «the logger works at startup» was an artifact of
  //     attributing a `console.log` to the logger: the visible prefix is shared,
  //     the channel is not. This is why EVERY `ctx.logger.*` call site in the
  //     bundle (measured: 236, of which 4 `error`) was invisible — including
  //     `lifecycle.ts` «ROTATION could not run» and `delivery.ts`'s
  //     «HOST MUTE ANOMALY (fb-946)» backstop, a warning about a mute host
  //     delivered over a mute channel.
  //
  // THE FIX — the sink the logger's OWN contract documents
  // (`LoggerService.exporter(exporter)`: «the sink that receives structured log
  // messages»). It is deliberately `error`-ONLY via `levels.default: 0`
  // (`Logger._method` skips an exporter when
  // `(exporter.levels?.[name] ?? exporter.levels?.default ?? level) < level`):
  //   * `error` (level 0) → exported → journald.
  //   * `warn` (2) / `info` (1) / `debug` (3) → FILTERED OUT, so this adds NO
  //     stdout flood (the bundle has 236 `ctx.logger` call sites, 181 of them
  //     `warn`) and cannot regress stdout-sensitive surfaces.
  // `levels.default` is set for EVERY logger name (not a per-name key) on
  // purpose: the diagnosis must not depend on which sub-logger emitted it.
  // One line per message; `console.log` (not `.error`) matches how the other
  // plugins that ARE visible in journald write (`[key-pooler]`,
  // `[smart-restart]`, `[dsh-guard-toolpair]`).
  // SCOPE: this repairs the CHANNEL. Whether anything SCANS the durable
  // `registry-anomalies.jsonl` is the detector's decision and is NOT this lane
  // (declared, not silently closed).
  ctx.logger.exporter({
    levels: { default: 0 },
    colors: 0,
    export: (message) => {
      const args = (message as { args?: unknown[] }).args ?? []
      const text = args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' ')
      console.log(`[deepartments] ${text}`)
    }
  })

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
