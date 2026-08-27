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

/** FIX-2 — parse a minimal `settings.yaml` surface for the pi-ai provider
 * profiles: `llm-pi-ai.providers.<provider>.baseURL` / `.maxRetries`. This is a
 * bounded, DEPENDENCY-FREE line scan (the plugin loads in hermetic/minimal
 * profiles with no yaml package), so a parse failure or a non-matching structure
 * degrades to an empty map → the drift half of fix-2 is a NO-OP (the
 * missing-adapter half still fires). Never throws. */
export function parseLlmPiAiProviderSettings(text: string): Record<string, { baseURL?: string; maxRetries?: number }> {
  const out: Record<string, { baseURL?: string; maxRetries?: number }> = {}
  const indentOf = (value: string): number => {
    const m = /^\s*/.exec(value)
    return m ? m[0].length : 0
  }
  let mode: 'none' | 'llm-pi-ai' | 'providers' = 'none'
  let providersIndent = -1
  let providerIndent = -1
  let current: { baseURL?: string; maxRetries?: number } | undefined
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed === '---') continue
    const indent = indentOf(line)
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
    /* mode === 'providers' */
    if (indent <= providersIndent) {
      mode = 'none'
      current = undefined
      continue
    }
    const isProviderKey = /^[A-Za-z0-9_.-]+\s*:\s*$/.test(trimmed)
    if (isProviderKey && (current === undefined || indent === providerIndent)) {
      const name = trimmed.replace(/:\s*$/, '').trim()
      current = { baseURL: undefined, maxRetries: undefined }
      out[name] = current
      providerIndent = indent
      continue
    }
    if (current === undefined) continue
    const baseMatch = /^baseURL\s*:\s*(.+)$/i.exec(trimmed)
    if (baseMatch) {
      current.baseURL = unquoteYamlScalar(baseMatch[1])
      continue
    }
    const retryMatch = /^maxRetries\s*:\s*(.+)$/i.exec(trimmed)
    if (retryMatch) {
      const parsed = Number(unquoteYamlScalar(retryMatch[1]))
      current.maxRetries = Number.isFinite(parsed) ? parsed : undefined
    }
  }
  return out
}

/** FIX-2 — read the pi-ai provider endpoint surface from `<stateDir>/settings.yaml`
 * (best-effort: absent/unreadable/malformed → {}, never throws). The plugin's own
 * stateDir is the DSH runtime state dir that carries settings.yaml. */
export function readLlmPiAiProviderSettings(stateDir: string): Record<string, { baseURL?: string; maxRetries?: number }> {
  try {
    const text = readFileSync(path.join(stateDir, 'settings.yaml'), 'utf8')
    return parseLlmPiAiProviderSettings(text)
  } catch {
    return {}
  }
}