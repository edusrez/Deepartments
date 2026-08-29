// dshd-pooler — the provider-adapter BOOT-CHECK helpers (the dshd-pooler phase
// of the modular Cordis split). A PURE LIBRARY package: it owns the PURE
// provider-adapter machinery behind the pooler re-wire (QD NO_ADAPTER alerting,
// FIX-2) — the endpoint-drift detector (providerAdapterEndpointDrift +
// LOCAL_ENDPOINT_RE), the PURE boot-findings resolver
// (resolveProviderAdapterBootFindings + ProviderAdapterBootFinding/
// ProviderAdapterBootInput/ProviderAdapterEndpointDriftDeps), the synthetic
// finding postId (PROVIDER_ADAPTER_CHECK_POST_ID) and the bounded-retry window
// constants (PROVIDER_ADAPTER_RETRY_WINDOW_MS/PROVIDER_ADAPTER_RETRY_MS), plus
// the DEPENDENCY-FREE `settings.yaml` reader/parser
// (readLlmPiAiProviderSettings/parseLlmPiAiProviderSettings/unquoteYamlScalar).
// These were MOVED verbatim from the bundle (src/invoke.ts) so the helper
// surface is fs-pure and re-usable; the bundle consumes them through the
// drop-in bridge `src/core/pooler.ts` (`export * from 'dshd-pooler'`).
// [P1 — 2026-08-29]: the package now ALSO exposes a thin Cordis plugin surface
// (name/inject/apply, bottom of this file) providing the `deepartments.pooler`
// service (the provider-adapter boot check with binder-injected deps). The
// bundle's inline runProviderAdapterBootCheck stays (R6) until the DECOUPLING
// hito rewires it to the composed service.
//
// fb-9 (QH MEDIA — the 400 `reasoning_content must be passed back` class): the
// settings reader is ALSO the surface for the DISPATCH PRE-FLIGHT — the parser
// additionally resolves, per provider, the reasoning surface
// (`reasoningEffort` scalar, the union of the model-level `reasoningEfforts`
// map KEYS) and the openai-completions reasoning-content echo flag
// (`requiresReasoningContentOnAssistantMessages` — resolved ONLY from the
// provider's `compat:` block, the schema-correct compatProfile path
// dsh-llm-pi-ai actually reads; a provider-level key is a DEAD path the adapter
// ignores, and the reader deliberately does NOT resolve it so the pre-flight
// fails loudly instead of passing with green false), and the package owns the
// PURE guard (`resolveReasoningContentPreflight`) the bundle wires BEFORE any
// worker materialization. Additive only: absent keys stay absent (the pre-fb-9
// `{baseURL?, maxRetries?}` surface is byte-identical for profiles without the
// new keys).
//
// The helpers are pure fs modules (NO cordis dependencies — just `node:fs` +
// `node:path`), same shape as dshd-jobs/dshd-feedback: the ONLY impure surface
// is the `readFileSync` inside readLlmPiAiProviderSettings — the settings.yaml
// path is passed BY PARAMETER (stateDir), so the reader stays deterministic and
// testable. The BOOT CHECK itself (`runProviderAdapterBootCheck`, the bounded
// retry + the appendPostError alert) STAYS in the bundle (it closes over the
// live apply fiber: config/org/ctx/post-errors), exactly like the scheduler
// daemon stays in the bundle for dshd-jobs. There is NO provider-adapter
// daemon — the boot check is the only caller, and its LOGIC is untouched here.
//
// SPLIT BOUNDARY (what MOVED vs what STAYED in the bundle — documented so a
// future reader knows the seam):
//   - MOVED: the four helper exports + the two support types + the constants
//     + the private unquoteYamlScalar/LOCAL_ENDPOINT_RE.
//   - STAYED in src/invoke.ts: runProviderAdapterBootCheck (the apply-fiber
//     closure with the bounded retry loop + the appendPostError alert wiring),
//     the `org.poolerBaseURL` config schema (src/org.ts + cordis.patch.yml
//     rows), anything health-daemon related.
//
// NO export default (pitfall 0001 — breaks `inject`).
import { readFileSync } from 'node:fs'
import path from 'node:path'

/** FIX-2 (QD NO_ADAPTER alerting) — the synthetic postId under which a BOOT
 * provider-adapter-registration/endpoint finding is written. It is a NON-post
 * id (a postId the registry never mints), so it can never collide with a real
 * post, and the W6 daemon's `scanPostErrorFindings` surfaces it as a
 * `post-error` finding → the host is ALERTED from the break even with NO agent
 * spawned in the window (the QH acceptance "boot check that fires a finding
 * independent of any spawned agent"). */
export const PROVIDER_ADAPTER_CHECK_POST_ID = 'provider-adapter-check'

/** FIX-2 race-tolerance — the boot provider-adapter check is RACE-TOLERANT: it
 * waits (within a bounded window) for an ASYNC provider-adapter registration
 * (`ctx.llm.registerAdapter` in the dsh-llm-pi-ai apply) to settle before it
 * decides. The check is fired in the boot `.then` block (microseconds after
 * plugin boot) but the adapter registration is ASYNC — so the naive first read
 * of `llm.listProviders()` can FALSE-POSITIVE on a healthy-but-still-registering
 * boot ("provider adapter not registered for ..." even though the adapter IS
 * registered for live calls). A DELAYED registration is NOT an alert; only a
 * provider STILL MISSING after the window elapses is a GENUINE outage (the HARD
 * NO_ADAPTER alert). Mirrors the `HOST_ATTACH_REPAIR_*` bounded-retry discipline
 * (invoke.ts:5224). Both knobs are injectable/testable via
 * `health.providerAdapterRetryWindowMs` / `health.providerAdapterRetryMs` (the
 * health daemon config), defaulting to these code-level constants. */
export const PROVIDER_ADAPTER_RETRY_WINDOW_MS = 5_000
export const PROVIDER_ADAPTER_RETRY_MS = 250

/** ONE provider-adapter boot finding: a configured provider route that is either
 * (a) NOT registered as a live adapter (the NO_ADAPTER class — configured but the
 * pi-ai adapter was never registered, the exact condition that produces a silent
 * first-call NO_ADAPTER), or (b) registered but with a drifted/stale endpoint
 * surface (a baseURL to a local/proxy endpoint or a `maxRetries: 0` profile — the
 * QD config-hygiene signal). */
export interface ProviderAdapterBootFinding {
  postId: string
  error: string
}

/** FIX-2 — the PURE provider-adapter boot-check inputs. */
export interface ProviderAdapterBootInput {
  /** The configured provider routes (worker route, host route, coordinators). */
  configuredProviders: readonly string[]
  /** The provider routes CURRENTLY registered as adapters (llm.listProviders():
   * [{id, name}], NO endpoint stored — the trace crux for the drift half). */
  registeredProviders: readonly { id: string; name: string }[]
  /** Optional per-provider endpoint surface (llm-pi-ai.providers.<p>.baseURL /
   * .maxRetries). Absent → the drift half is a no-op (the missing-adapter half
   * still fires), exactly the graceful degradation production needs. */
  providerSettings?: Readonly<Record<string, { baseURL?: string; maxRetries?: number }>>
  /** P1 rewire-pooler: the config `org.poolerBaseURL` — the pooler (dsh-key-pooler)
   * baseURL, a LEGITIMATE local/proxy LLM route. When a configured provider's
   * baseURL EXACTLY equals this value, the endpoint-drift rule treats it as a
   * healthy route (NOT drift) — so the boot check does not false-alert on the
   * pooler. Absent (undefined) → NO exemption (every local/proxy baseURL is still
   * drift). The `maxRetries: 0` stale-profile signal is NEVER exempted. */
  poolerBaseURL?: string
}

/** P1 rewire-pooler — optional endpoint-drift exemption deps. `poolerBaseURL` is
 * the pooler (dsh-key-pooler) LLM route: a LEGITIMATE local/proxy endpoint that
 * must NOT be flagged as drift. An EXACT match only — never a blind localhost
 * hardcode — so a random 127.0.0.1 that is not the configured pooler STAYS drift. */
export interface ProviderAdapterEndpointDriftDeps {
  poolerBaseURL?: string
}

/** A baseURL that points at a LOCAL/PROXY surface rather than the remote provider
 * endpoint — the value the outage's stale settings carried (the QD re-wire
 * http://127.0.0.1:4097/v1 → https://opencode.ai/zen/go/v1). */
const LOCAL_ENDPOINT_RE = /(?:127\.0\.0\.1|localhost|0\.0\.0\.0)(?::|\/|$)/i

/** Detect a provider ENDPOINT DRIFT (the QD config-hygiene signal): a baseURL
 * pointing at a local/proxy surface (127.0.0.1 / localhost / 0.0.0.0) or a
 * `maxRetries: 0` profile. Returns a human-readable drift error, or undefined
 * when the endpoint surface is healthy. Pure, never throws. `deps.poolerBaseURL`
 * (the P1 rewire-pooler config `org.poolerBaseURL`) is an EXACT-MATCH exemption:
 * a baseURL EQUAL to it is a LEGITIMATE local/proxy LLM route (not drift), while
 * ANY OTHER local/proxy baseURL STAYS a drift. The `maxRetries: 0` stale-profile
 * signal is NEVER exempted. */
export function providerAdapterEndpointDrift(provider: string, settings: { baseURL?: string; maxRetries?: number }, deps?: ProviderAdapterEndpointDriftDeps): string | undefined {
  const baseURL = (settings.baseURL ?? '').trim()
  if (baseURL !== '') {
    const poolerBaseURL = (deps?.poolerBaseURL ?? '').trim()
    const isExemptPooler = poolerBaseURL !== '' && baseURL === poolerBaseURL
    if (!isExemptPooler && LOCAL_ENDPOINT_RE.test(baseURL)) {
      return `provider endpoint drift for "${provider}": baseURL "${baseURL}" is a local/proxy endpoint, not the remote provider surface`
    }
  }
  if (settings.maxRetries === 0) {
    return `provider endpoint drift for "${provider}": maxRetries is 0 (the QD outage's stale-profile signal)`
  }
  return undefined
}

/** FIX-2 — PURE provider-adapter boot check. Returns ONE finding per configured
 * provider that is either (a) NOT registered as a live adapter (the NO_ADAPTER
 * class — the provider is configured but its adapter was never registered, the
 * condition that produced the silent ~49-min outage), or (b) registered but with a
 * drifted/stale endpoint surface. Never throws. */
export function resolveProviderAdapterBootFindings(input: ProviderAdapterBootInput): ProviderAdapterBootFinding[] {
  const registered = new Set<string>((input.registeredProviders ?? []).map((p) => p.id))
  const findings: ProviderAdapterBootFinding[] = []
  for (const provider of input.configuredProviders ?? []) {
    if (provider === undefined || provider === '') continue
    if (!registered.has(provider)) {
      findings.push({ postId: PROVIDER_ADAPTER_CHECK_POST_ID, error: `provider adapter not registered for "${provider}"` })
      continue
    }
    const settings = input.providerSettings?.[provider]
    if (settings !== undefined) {
      const drift = providerAdapterEndpointDrift(provider, settings, { poolerBaseURL: input.poolerBaseURL })
      if (drift !== undefined) findings.push({ postId: PROVIDER_ADAPTER_CHECK_POST_ID, error: drift })
    }
  }
  return findings
}

/** Strip surrounding single/double quotes from a YAML scalar (best-effort). */
function unquoteYamlScalar(value: string): string {
  const v = value.trim()
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))) return v.slice(1, -1)
  return v
}

/** fb-9 — one `llm-pi-ai.providers.<p>` profile as the reader resolves it. The
 * pre-fb-9 surface (baseURL/maxRetries) is unchanged; the fb-9 fields are set
 * ONLY when the settings declare them (absent ≠ empty, so the pre-fb-9
 * `{baseURL?, maxRetries?}` deep-equal assertions stay green). */
export interface LlmPiAiProviderSettings {
  baseURL?: string
  maxRetries?: number
  /** fb-9: a provider-level reasoning-effort scalar. 'off' → reasoning
   * disabled; any other value → enabled. Absent → no provider-level pin. */
  reasoningEffort?: string
  /** fb-9: the UNION of the provider's model-level `reasoningEfforts` map KEYS
   * (e.g. ['off','low','high','max']). All-'off' → reasoning disabled; any
   * non-off key → enabled; absent → the profile declares NO reasoning surface
   * (no signal — the conservative guard passes). */
  reasoningEfforts?: string[]
  /** fb-9: the openai-completions reasoning-content echo flag — the 400
   * `reasoning_content must be passed back` guard. Resolved ONLY from the
   * provider's `compat:` block (the adapter's compatProfile schema at
   * `providers.<id>.compat.requiresReasoningContentOnAssistantMessages` — the
   * path dsh-llm-pi-ai resolveProfiles actually reads); a provider-TOP-LEVEL
   * key is a DEAD path and stays undefined, so the preflight DETECTS the
   * misconfiguration (the m-603 green-false case) instead of passing. Set only
   * when the key is present in compat (true | false). */
  requiresReasoningContentOnAssistantMessages?: boolean
}

/** fb-9 — the synthetic postId under which the boot-assert writes ONE drift
 * post-error row when the ACTIVE worker route has reasoning enabled but its
 * provider profile lacks `compat.requiresReasoningContentOnAssistantMessages: true`
 * (the schema-correct nested path — a provider-level flag is dead and is
 * detected as missing, never a green false).
 * A NON-post id (never minted by the registry) — the W6 daemon surfaces it as
 * a post-error finding (drift detection even when nobody dispatches). */
export const REASONING_CONTENT_PREFLIGHT_POST_ID = 'preflight-reasoning-content'

/** Collect the keys of a (possibly multi-line) `reasoningEfforts` map into the
 * current provider's union. `text` is the raw map content (inline braces, or
 * the accumulated brace block) — every `key:` token is a map key. */
function collectReasoningEffortKeys(current: LlmPiAiProviderSettings | undefined, text: string): void {
  if (current === undefined) return
  const keys: string[] = []
  for (const m of text.matchAll(/([A-Za-z0-9_.-]+)\s*:/g)) keys.push(m[1])
  if (keys.length === 0) return
  const seen = new Set(current.reasoningEfforts ?? [])
  for (const k of keys) {
    if (seen.has(k)) continue
    seen.add(k)
    current.reasoningEfforts = [...(current.reasoningEfforts ?? []), k]
  }
}

/** FIX-2 + fb-9 — parse a minimal `settings.yaml` surface for the pi-ai
 * provider profiles: `llm-pi-ai.providers.<provider>.baseURL` / `.maxRetries`
 * (FIX-2) plus the fb-9 reasoning surface per provider
 * (`reasoningEffort` scalar, `requiresReasoningContentOnAssistantMessages`
 * flag — resolved ONLY from the provider's `compat:` block, the
 * schema-correct compatProfile path the adapter reads (a provider-TOP-LEVEL
 * flag is a DEAD key and is NOT resolved, so the pre-flight detects the
 * m-603 green-false case) — and the union of the model-level
 * `reasoningEfforts` map keys — inline `{ ... }` or a multi-line brace
 * block). This is a bounded, DEPENDENCY-FREE
 * line scan (the plugin loads in hermetic/minimal profiles with no yaml
 * package), so a parse failure or a non-matching structure degrades to an
 * empty map → the drift half of fix-2 is a NO-OP and the fb-9 guard passes
 * (conservative). Never throws. */
export function parseLlmPiAiProviderSettings(text: string): Record<string, LlmPiAiProviderSettings> {
  const out: Record<string, LlmPiAiProviderSettings> = {}
  const indentOf = (value: string): number => {
    const m = /^\s*/.exec(value)
    return m ? m[0].length : 0
  }
  let mode: 'none' | 'llm-pi-ai' | 'providers' | 'models' | 'compat' = 'none'
  let providersIndent = -1
  let providerIndent = -1
  let current: LlmPiAiProviderSettings | undefined
  let modelsIndent = -1
  let modelIndent = -1
  /** fb-9: the indent of the provider-level `compat:` key — the compat block
   * extends while lines stay MORE indented than it. */
  let compatIndent = -1
  /** fb-9: a multi-line `reasoningEfforts: { ... }` brace block being
   * accumulated ('' = awaiting the opening '{'). */
  let braceAcc: string | undefined
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed === '---') continue
    const indent = indentOf(line)
    if (braceAcc !== undefined) {
      braceAcc += '\n' + trimmed
      if (trimmed.includes('}')) {
        collectReasoningEffortKeys(current, braceAcc)
        braceAcc = undefined
      }
      continue
    }
    if (mode === 'none') {
      if (indent === 0 && /^llm-pi-ai\s*:/.test(trimmed)) mode = 'llm-pi-ai'
      continue
    }
    if (mode === 'llm-pi-ai') {
      if (indent === 0) break /* the llm-pi-ai block ended */
      if (/^providers\s*:/.test(trimmed)) {
        mode = 'providers'
        providersIndent = indent
      }
      continue
    }
    if (mode === 'models') {
      if (indent <= modelsIndent) {
        /* the models block ended — process this line as a provider-surface line */
        mode = 'providers'
      } else {
        const listMatch = /^-\s+(.+)$/.exec(trimmed)
        if (listMatch && (modelIndent < 0 || indent === modelIndent)) {
          modelIndent = indent
          continue /* a model list item — its reasoningEfforts feed the provider union */
        }
        const effortsMatch = /^reasoningEfforts\s*:\s*(.*)$/.exec(trimmed)
        if (effortsMatch) {
          const rest = (effortsMatch[1] ?? '').trim()
          if (rest !== '') {
            collectReasoningEffortKeys(current, rest)
          } else {
            braceAcc = '' /* multi-line brace block follows */
          }
        }
        continue
      }
    }
    if (mode === 'compat') {
      if (indent <= compatIndent) {
        /* the compat block ended — process this line as a provider-surface line */
        mode = 'providers'
      } else {
        /* fb-9 REALIGNMENT: the reasoning-content echo flag is ONLY valid inside
         * the provider's `compat:` block (the compatProfile schema the adapter
         * resolves — dsh-llm-pi-ai resolveProfiles reads `source.compat`, NEVER
         * a provider-level key). A flag written OUTSIDE compat is the DEAD path
         * that produced the m-603 green false: it never reaches pi-ai, so the
         * reader does NOT resolve it here either. */
        const compatFlagMatch = /^requiresReasoningContentOnAssistantMessages\s*:\s*(.+)$/i.exec(trimmed)
        if (compatFlagMatch && current !== undefined) {
          current.requiresReasoningContentOnAssistantMessages = unquoteYamlScalar(compatFlagMatch[1]).toLowerCase() === 'true'
        }
        continue
      }
    }
    /* mode === 'providers' */
    if (indent <= providersIndent) {
      mode = 'none'
      current = undefined
      modelIndent = -1
      compatIndent = -1
      continue
    }
    const isProviderKey = /^[A-Za-z0-9_.-]+\s*:\s*$/.test(trimmed)
    if (isProviderKey && (current === undefined || indent === providerIndent)) {
      const name = trimmed.replace(/:\s*$/, '').trim()
      current = {}
      out[name] = current
      providerIndent = indent
      modelIndent = -1
      compatIndent = -1
      continue
    }
    if (current === undefined) continue
    if (/^models\s*:\s*$/.test(trimmed)) {
      mode = 'models'
      modelsIndent = indent
      modelIndent = -1
      continue
    }
    /* fb-9: the provider-level `compat:` key (the compatProfile block — the
     * schema-correct HOME of requiresReasoningContentOnAssistantMessages). */
    if (/^compat\s*:\s*$/.test(trimmed)) {
      mode = 'compat'
      compatIndent = indent
      continue
    }
    const baseMatch = /^baseURL\s*:\s*(.+)$/i.exec(trimmed)
    if (baseMatch) {
      current.baseURL = unquoteYamlScalar(baseMatch[1])
      continue
    }
    const retryMatch = /^maxRetries\s*:\s*(.+)$/i.exec(trimmed)
    if (retryMatch) {
      const parsed = Number(unquoteYamlScalar(retryMatch[1]))
      current.maxRetries = Number.isFinite(parsed) ? parsed : undefined
      continue
    }
    /* fb-9: provider-level reasoning pins — anchored so the PLURAL map key
     * (`reasoningEfforts:` — handled in the models mode above) never matches.
     * NOTE: `requiresReasoningContentOnAssistantMessages` is deliberately NOT
     * read at this level — a provider-top-level flag is the DEAD path the
     * adapter ignores (it only reads the `compat:` block), and resolving it
     * here would keep the fb-9 pre-flight passing with GREEN FALSE. */
    const effortMatch = /^reasoningEffort(?!s)\s*:\s*(.+)$/i.exec(trimmed)
    if (effortMatch) {
      current.reasoningEffort = unquoteYamlScalar(effortMatch[1])
      continue
    }
  }
  return out
}

/** fb-9 (QH MEDIA — the class 400 `reasoning_content must be passed back` that
 * burned a whole mission): the DISPATCH PRE-FLIGHT for ONE provider route. The
 * active worker route (WORKER_AGENT_OPTIONS.provider) runs the
 * openai-completions API WITH reasoning → the profile MUST declare
 * `compat.requiresReasoningContentOnAssistantMessages: true` for that provider
 * (the schema-correct nested path the adapter reads; a provider-TOP-LEVEL flag
 * is DEAD and is NOT seen here — so a settings with only the dead key is
 * DETECTED as missing, never a green false), else
 * the first assistant turn 400s mid-mission (the reactive fix exists in
 * settings.yaml; this guard stops the dispatch BEFORE the cost). CONSERVATIVE
 * — the pre-flight is a GUARD, never a blocker: only a provider the profile
 * POSITIVELY declares reasoning-enabled AND that lacks the flag is BLOCKED;
 * flag present / reasoning off / profile absent-or-unreadable → pass. Pure. */
export function resolveReasoningContentPreflight(
  provider: string,
  settings: Record<string, LlmPiAiProviderSettings>,
  settingsLabel?: string
): { ok: true } | { ok: false; reason: string } {
  const profile = settings[provider]
  if (profile === undefined) return { ok: true } /* the profile is absent/unreadable — pass */
  const providerEffort = (profile.reasoningEffort ?? '').trim()
  const efforts = profile.reasoningEfforts ?? []
  // Reasoning is ENABLED only on a POSITIVE signal: a provider-level
  // reasoningEffort != off, or ≥1 model declaring a non-off reasoningEffort. No
  // signal (neither declared) → NOT enabled → pass (guard, not blocker).
  const reasoningEnabled = providerEffort !== ''
    ? providerEffort !== 'off'
    : efforts.some((e) => e !== 'off')
  if (!reasoningEnabled) return { ok: true } /* reasoning off / no signal — pass */
  if (profile.requiresReasoningContentOnAssistantMessages === true) return { ok: true } /* the flag is set — pass */
  const label = settingsLabel !== undefined && settingsLabel !== '' ? settingsLabel : 'unknown-profile'
  return {
    ok: false,
    reason: `preflight: provider «${provider}» has reasoning enabled but missing compat.requiresReasoningContentOnAssistantMessages=true (settings ${label}) — configure the flag in the provider's compat: block (a provider-level key is not read by pi-ai) before dispatching`
  }
}

/** FIX-2 — read the pi-ai provider surface from `<stateDir>/settings.yaml`
 * (best-effort: absent/unreadable/malformed → {}, never throws). The plugin's
 * own stateDir is the DSH runtime state dir that carries settings.yaml. */
export function readLlmPiAiProviderSettings(stateDir: string): Record<string, LlmPiAiProviderSettings> {
  try {
    const text = readFileSync(path.join(stateDir, 'settings.yaml'), 'utf8')
    return parseLlmPiAiProviderSettings(text)
  } catch {
    return {}
  }
}

// ---------------------------------------------------------------------------
// P1 (MODULARIZACIÓN, 2026-08-29) — the dshd-pooler Cordis PLUGIN surface.
// Thin name/inject/apply (the dshd-core/dshd-webfetch pattern): the package
// now ALSO composes as a real plugin row (cordis.patch.yml) and provides
// `deepartments.pooler` — the provider-adapter BOOT CHECK the bundle runs
// INLINE today (invoke.ts `runProviderAdapterBootCheck`). The check is LAZY
// (runs on FIRST service use, never at apply time); deps are INJECTED via the
// FASE 2.6 seam, never imported from the bundle:
//   - stateDir + org (departments / poolerBaseURL) ← `deepartments.org`,
//   - the harness `llm` service ← `ctx.get('llm')` (optional — absent →
//     skipped with a warn, exactly like the bundle),
//   - the configured providers + the post-error append ← the `pooler` binder
//     bucket (the host/worker agentOptions are bundle constants; DECOUPLING
//     registers them here). The configured-provider set DEGRADES to the
//     org.departments coordinators when the bucket is absent; the append is
//     REQUIRED only when a finding materializes (FAIL LOUD R1, never a
//     silently-unbound alert path).
// The retry window honors the plugin's OWN `health.providerAdapterRetry*`
// config keys (absent → the CODE defaults PROVIDER_ADAPTER_RETRY_WINDOW_MS /
// PROVIDER_ADAPTER_RETRY_MS — the same values the bundle falls back to when
// its config.health lacks them). Nothing is removed (R6).
//
// NO export default (pitfall 0001 — breaks `inject`).
import type { Context } from '@deepseek-ai/cordis'

/** A minimal structural view of the post-error row the append writes. */
export interface PoolerPostErrorEntry {
  ts: number
  postId: string
  error: string
}

/** The FASE 2.6 binder bucket for the pooler service (STRUCTURAL — read from
 * `ctx.get('deepartments.binder')` widened; filled by the DECOUPLING bundle). */
export interface PoolerBinderDeps {
  /** The bundle's configured provider ids (worker + host agentOptions providers
   * PLUS every department coordinator's provider — the host/worker constants
   * are bundle-owned and cannot be derived by this package). */
  configuredProviders?: string[]
  /** The bundle-owned post-error append (`appendPostError(stateDir, entry)`,
   * writes `<stateDir>/post-errors.jsonl` so the health daemon alerts). */
  appendPostError?: (stateDir: string, entry: PoolerPostErrorEntry) => Promise<void>
}

/** The `deepartments.pooler` service surface — the boot check the bundle runs
 * inline today. */
export interface PoolerSurface {
  /** The provider-adapter boot check (bounded retry + NO_ADAPTER/endpoint
   * alert). NEVER throws — every failure folds to a warn (the bundle contract);
   * a MISSING INJECTED DEP on the alert path FAILS LOUD (R1). */
  runProviderAdapterBootCheck(): Promise<void>
}

/** The dshd-pooler plugin config (minimal — org/stateDir resolve from the
 * shared `deepartments.org` source; only the retry-window knobs are read here,
 * absent → code defaults). */
export interface PoolerConfig {
  health?: {
    /** `health.enabled === false` skips the check entirely (the same gate the
     * bundle's inline boot check honors). Absent → enabled (code default). */
    enabled?: boolean
    providerAdapterRetryWindowMs?: number
    providerAdapterRetryMs?: number
  }
}

export const name = 'dshd-pooler'
// Resolve everything via `ctx.get` at USE (inject EMPTY) so the plugin stays
// loadable in minimal compositions (the dshd-core discipline).
export const inject: string[] = []

export function apply(ctx: Context, config: PoolerConfig = {}) {
  // Derived service: the check itself is the surface; it resolves deps on
  // every run (never cached — the llm registry is live across the boot).
  ctx.provide('deepartments.pooler', {
    runProviderAdapterBootCheck: async (): Promise<void> => {
      if (config.health?.enabled === false) return
      try {
        const org = ctx.get('deepartments.org') as { stateDir?: string; org?: { departments?: Array<{ coordinator?: { agentOptions?: { provider?: string }; provider?: string } }>; poolerBaseURL?: string } } | undefined
        if (org?.stateDir === undefined) {
          ctx.logger.warn('[deepartments] provider-adapter boot check skipped — the shared deepartments.org service is absent (dshd-core not composed)')
          return
        }
        const stateDir = org.stateDir
        const llm = ctx.get('llm', false) as { listProviders?: () => Array<{ id: string; name: string }> } | undefined
        if (llm === undefined || typeof llm.listProviders !== 'function') {
          ctx.logger.warn('[deepartments] provider-adapter boot check skipped — the "llm" service is absent (headless/minimal profile)')
          return
        }
        const binder = ctx.get('deepartments.binder') as { get(): unknown } | undefined
        const bound = (binder?.get() ?? {}) as PoolerBinderDeps
        const configuredProviders = new Set<string>(bound.configuredProviders ?? [])
        for (const department of org.org?.departments ?? []) {
          const c = department.coordinator
          if (c?.agentOptions?.provider) configuredProviders.add(c.agentOptions.provider)
          else if (c?.provider) configuredProviders.add(c.provider)
        }
        const configuredProviderList = [...configuredProviders]
        if (configuredProviderList.length === 0) return

        // Bounded retry window (mirrors the bundle's discipline): the provider(s)
        // may legitimately still be REGISTERING (async ctx.llm.registerAdapter).
        const retryHealthCfg = config.health ?? {}
        const retryWindowMs = typeof retryHealthCfg.providerAdapterRetryWindowMs === 'number' && retryHealthCfg.providerAdapterRetryWindowMs > 0
          ? retryHealthCfg.providerAdapterRetryWindowMs
          : PROVIDER_ADAPTER_RETRY_WINDOW_MS
        const retryMs = typeof retryHealthCfg.providerAdapterRetryMs === 'number' && retryHealthCfg.providerAdapterRetryMs > 0
          ? retryHealthCfg.providerAdapterRetryMs
          : PROVIDER_ADAPTER_RETRY_MS
        const deadline = Date.now() + retryWindowMs
        for (;;) {
          const registeredProviders = (llm.listProviders() ?? [])
          const providerSettings = readLlmPiAiProviderSettings(stateDir)
          const findings = resolveProviderAdapterBootFindings({
            configuredProviders: configuredProviderList,
            registeredProviders,
            providerSettings,
            poolerBaseURL: org.org?.poolerBaseURL
          })
          if (findings.length === 0) return
          if (Date.now() >= deadline) {
            for (const finding of findings) {
              const appendPostError = bound.appendPostError
              if (appendPostError === undefined) {
                throw new Error('[deepartments] provider-adapter boot check: no post-error append closure — the bundle must register ctx.get("deepartments.binder").register({ pooler: { appendPostError } }) (DECOUPLING)')
              }
              await appendPostError(stateDir, { ts: Date.now(), postId: finding.postId, error: finding.error })
            }
            ctx.logger.warn(`[deepartments] provider-adapter boot check: ${findings.length} finding(s) → ${findings.map((f) => f.error).join('; ')}`)
            return
          }
          await new Promise((resolve) => setTimeout(resolve, retryMs))
        }
      } catch (error: unknown) {
        ctx.logger.warn(`[deepartments] provider-adapter boot check failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  })
}