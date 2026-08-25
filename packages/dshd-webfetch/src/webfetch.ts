// dsh-deepartments — custom `ctx.web` fetch provider (ROADMAP: web-fetch).
//
// Registers a WebFetchProvider (`id: 'deepartments-fetch'`) into the
// @deepseek-ai/dsh-web seam. It reuses native `fetch` (undici), mirroring the
// default `http` provider's URL hygiene (http/https only, no credentials,
// bounded URL length, same-origin-only redirects) so we never degrade the
// SSRF/redirect safeguards, and ADDS two things the default cannot:
//
//   1. BLOCKING DETECTION — HTTP 403 (Cloudflare) / 429 (rate-limit) surface as
//      a `WebError` with code `WEB_BLOCKED` whose message instructs the caller
//      (the model) to investigate whether the host exposes an API/JSON endpoint
//      or mirror and retry that URL directly.
//
// The web seam is resolved OPTIONALLY (`ctx.get('web')`), exactly like the
// subagents/agents services: this bundle must keep loading in minimal
// compositions (the hermetic real-Loader tests mount no web service), while a
// real boot wires the provider into the seam.
//
// NO export default (pitfall 0001 — breaks `inject`).
import type { Context } from '@deepseek-ai/cordis'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'

/**
 * Provider id. Selection is `fetchProvider: 'deepartments-fetch'` (config) or
 * `$DSH_WEB_FETCH_PROVIDER=deepartments-fetch` (env) — the SAME seam field.
 */
export const WEBFETCH_PROVIDER_ID = 'deepartments-fetch'

/** Default User-Agent: an explicit, honest product agent, never a browser disguise. */
export const DEFAULT_USER_AGENT = 'deepartments/0.1.0 (DeepSeek Harness plugin; +https://github.com/esuarez/deepartments)'

/**
 * Default Accept string. One configurable string (the seam offers no per-host
 * hook, and we cannot always control per-host headers). `application/json`
 * leads so the npm registry serves JSON natively and GitHub's /readme returns
 * base64 JSON `content` (the caller base64-decodes); text/markdown and
 * text/html follow as a fallback for ordinary hosts. We deliberately avoid a
 * multi-value vendor media type (e.g. `application/vnd.github.raw+json`) in
 * the default: GitHub's /readme endpoint echoes a comma-joined Accept list
 * back as a malformed Content-Type.
 */
export const DEFAULT_ACCEPT = 'application/json, text/markdown;q=0.9, text/html;q=0.5'

/** The provider configuration (nested under the `webfetch` config key). */
export interface WebFetchConfig {
  /** Master switch. Default true. */
  enabled?: boolean
  /** User-Agent header. */
  userAgent?: string
  /** Accept header. */
  accept?: string
  /** Upper bound on URL length (inclusive). Default 2048, matches the default provider. */
  maxUrlLength?: number
  /** Single-fetch timeout in ms. Default 30000. */
  timeoutMs?: number
  /** Byte cap on a response body. Default 5000000. */
  maxResponseBytes?: number
  /** Same-origin redirect hop cap. Default 5. */
  maxRedirects?: number
}

/**
 * Resolved (non-optional) provider configuration — what the provider binds at
 * registration. `resolveWebFetchConfig` fills defaults from {@link WebFetchConfig}.
 */
export interface ResolvedWebFetchConfig {
  userAgent: string
  accept: string
  maxUrlLength: number
  timeoutMs: number
  maxResponseBytes: number
  maxRedirects: number
}

/** Fill defaults; expose a stable, fully-populated config for the provider. */
export function resolveWebFetchConfig(config: WebFetchConfig = {}): ResolvedWebFetchConfig {
  return {
    userAgent: config.userAgent ?? DEFAULT_USER_AGENT,
    accept: config.accept ?? DEFAULT_ACCEPT,
    maxUrlLength: config.maxUrlLength ?? 2048,
    timeoutMs: config.timeoutMs ?? 30000,
    maxResponseBytes: config.maxResponseBytes ?? 5000000,
    maxRedirects: config.maxRedirects ?? 5
  }
}

// ---------------------------------------------------------------------------
// URL hygiene (mirrors @deepseek-ai/dsh-web-fetch-http `validateFetchUrl`).
// ---------------------------------------------------------------------------

function validateFetchUrl(input: string, maxUrlLength: number): URL {
  if (input.length > maxUrlLength) throw new WebError(`URL exceeds the maximum length of ${maxUrlLength}`, 'WEB_INVALID_URL')
  let url: URL
  try {
    url = new URL(input)
  } catch (error) {
    throw new WebError(`invalid URL: ${input}`, 'WEB_INVALID_URL', { cause: error })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new WebError(`unsupported URL scheme "${url.protocol}" (only http and https are allowed)`, 'WEB_INVALID_URL')
  if (url.username.length > 0 || url.password.length > 0) throw new WebError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL')
  return url
}

function isSameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && a.hostname === b.hostname && a.port === b.port
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

// ---------------------------------------------------------------------------
// Blocking detection (pure, network-free — unit-testable).
// ---------------------------------------------------------------------------

/**
 * Classify a response HTTP status for blocking. Returns the blocking kind
 * (`rate-limited` for 429, `blocked` for 403/Cloudflare), or `null` when the
 * status is not a blocking signal. Pure — no network, no WebError thrown here;
 * the provider composes it into the `WEB_BLOCKED` `WebError`.
 */
export function detectBlock(status: number): 'blocked' | 'rate-limited' | null {
  if (status === 429) return 'rate-limited'
  if (status === 403) return 'blocked'
  return null
}

/**
 * Build the `WEB_BLOCKED` message for a blocked response. `host` is the
 * hostname that blocked us. The message instructs the caller (the model) to
 * investigate whether the host exposes an API/JSON endpoint or mirror, rather
 * than suggesting any host-specific URL. Kept pure so the message shape is
 * assertable without a live fetch.
 */
export function blockErrorMessage(kind: 'blocked' | 'rate-limited', host: string): string {
  const code = kind === 'rate-limited' ? 429 : 403
  return `web fetch ${kind === 'rate-limited' ? 'rate-limited' : 'blocked'} by ${host} (HTTP ${code}). This may be anti-bot protection or rate-limiting against a datacenter IP. Investigate whether ${host} exposes an API or JSON endpoint (e.g. a registry/API host, a raw content URL, or a CDN mirror) and retry that URL directly instead.`
}

// ---------------------------------------------------------------------------
// Provider.
// ---------------------------------------------------------------------------

/** Classify a response Content-Type into a decodable `WebFetchBody` kind. */
export function classifyContentType(contentType: string | null): 'html' | 'text' | undefined {
  // Parse ONLY the first media type (before the first `,` or `;`, whichever
  // comes first): GitHub's /readme endpoint echoes a comma-joined Accept list
  // into a malformed Content-Type, and only the leading type is meaningful.
  const mime = (contentType ?? '').split(/[,;]/)[0].trim().toLowerCase()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/')) return 'text'
  if (mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')) return 'text'
  return undefined
}

/**
 * The custom fetch provider: native fetch (same-origin redirects, signal +
 * timeout honoured) → block/response decoding.
 */
export class DeepartmentsFetchProvider implements WebFetchProvider {
  readonly id = WEBFETCH_PROVIDER_ID

  constructor(private readonly limits: ResolvedWebFetchConfig) {}

  /** No credentials to check — always usable locally (no network). */
  available(): boolean {
    return true
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')

    // 1. Validate + fetch with a timeout composed over the incoming signal. The
    //    timeout signal is a reusable resource: dispose() clears its timer and
    //    removes the upstream listener on EVERY path (success, abort, throw).
    const validated = validateFetchUrl(request.url, this.limits.maxUrlLength)
    const timeout = withTimeout(signal, this.limits.timeoutMs)
    const timeoutSignal = timeout.signal
    try {
      let response: Response
      try {
        response = await this.requestOnce(validated, timeoutSignal, signal)
      } catch (error) {
        throw translateAbortOrNetwork(error, timeoutSignal)
      }

      // 3. Same-origin redirect following (mirrors the default provider; no
      //    cross-origin hop is followed automatically).
      let currentUrl = validated
      let redirectsFollowed = 0
      while (isRedirectStatus(response.status)) {
        if (redirectsFollowed >= this.limits.maxRedirects) {
          await response.body?.cancel()
          throw new WebError(`exceeded the maximum of ${this.limits.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED')
        }
        const location = response.headers.get('location')
        if (location === null) {
          await response.body?.cancel()
          throw new WebError(`redirect response (HTTP ${response.status}) without a Location header`, 'WEB_PROVIDER_ERROR')
        }
        let target: URL
        try {
          target = new URL(location, currentUrl)
        } catch (error) {
          await response.body?.cancel()
          throw new WebError('invalid redirect Location header', 'WEB_INVALID_URL', { cause: error })
        }
        if (!isSameOrigin(target, currentUrl)) {
          await response.body?.cancel()
          throw new WebError(`cross-origin redirect to ${target.origin} is not followed automatically; retry against that URL directly`, 'WEB_REDIRECT_BLOCKED')
        }
        await response.body?.cancel()
        currentUrl = target
        redirectsFollowed++
        try {
          response = await this.requestOnce(currentUrl, timeoutSignal, signal)
        } catch (error) {
          throw translateAbortOrNetwork(error, timeoutSignal)
        }
      }

      // 4. Blocking detection: Cloudflare 403 or a 429 rate-limit.
      const blocked = detectBlock(response.status)
      if (blocked !== null) {
        await response.body?.cancel()
        throw new WebError(blockErrorMessage(blocked, currentUrl.hostname), 'WEB_BLOCKED')
      }

      // 5. Decode the body.
      return await this.readBody(response, currentUrl, timeoutSignal, signal)
    } finally {
      timeout.dispose()
    }
  }

  private async requestOnce(url: URL, timeoutSignal: AbortSignal, signal?: AbortSignal): Promise<Response> {
    if (signal?.aborted) throw new DomAbortError()
    return fetch(url, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        'user-agent': this.limits.userAgent,
        accept: this.limits.accept
      },
      signal: timeoutSignal
    })
  }

  private async readBody(response: Response, finalUrl: URL, timeoutSignal: AbortSignal, signal?: AbortSignal): Promise<WebFetchResult> {
    const contentType = response.headers.get('content-type')
    const kind = classifyContentType(contentType)
    if (kind === undefined) {
      await response.body?.cancel()
      throw new WebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }
    const { bytes, truncatedByBytes } = await this.readCapped(response, timeoutSignal)
    const decoded = new TextDecoder('utf-8').decode(bytes)
    const body = kind === 'html' ? { kind: 'html' as const, content: decoded } : { kind: 'text' as const, content: decoded }
    return {
      url: finalUrl.toString(),
      statusCode: response.status,
      body,
      truncated: truncatedByBytes
    }
  }

  private async readCapped(response: Response, timeoutSignal: AbortSignal): Promise<{ bytes: Uint8Array; truncatedByBytes: boolean }> {
    const declared = response.headers.get('content-length')
    if (declared !== null) {
      const length = Number(declared)
      if (Number.isFinite(length) && length > this.limits.maxResponseBytes) {
        await response.body?.cancel()
        throw new WebError(`response exceeds the maximum of ${this.limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
      }
    }
    if (response.body === null) return { bytes: new Uint8Array(0), truncatedByBytes: false }
    const chunks: Uint8Array[] = []
    let total = 0
    let truncatedByBytes = false
    const reader = response.body.getReader()
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const remaining = this.limits.maxResponseBytes - total
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining))
          total += remaining
          truncatedByBytes = true
          break
        }
        chunks.push(value)
        total += value.byteLength
      }
    } catch (error) {
      throw translateAbortOrNetwork(error, timeoutSignal)
    } finally {
      await reader.cancel().catch(() => {})
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, truncatedByBytes }
  }
}

// ---------------------------------------------------------------------------
// Timeout + abort translation helpers (mirror the default provider's contract).
// ---------------------------------------------------------------------------

class DomAbortError extends Error {
  readonly name = 'AbortError'
  constructor() {
    super('The operation was aborted')
  }
}

/**
 * Compose a timeout onto `signal`: returns a derived signal that aborts after
 * `timeoutMs` OR when the upstream `signal` aborts, whichever comes first, plus
 * a `dispose()` that releases the underlying timer + listener. Our own timeout
 * aborts with a `WebError` carrying `WEB_FETCH_TIMEOUT`; an upstream abort
 * aborts with the upstream `reason` (or a bare AbortError). The reason is the
 * stable clock `translateAbortOrNetwork` reads to classify the throw.
 *
 * The returned `dispose()` is idempotent and MUST be called on every path
 * (success, abort, throw) so no timer stays pending after a successful fetch —
 * mirroring the default provider's `deadline(...)` disposable contract.
 */
function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const source = signal ?? new AbortController().signal
  const timer = setTimeout(
    () => controller.abort(new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT')),
    timeoutMs
  )
  const relay = () => {
    clearTimeout(timer)
    if (controller.signal.aborted) return
    controller.abort(source.reason ?? new DomAbortError())
  }
  source.addEventListener('abort', relay, { once: true })
  let disposed = false
  const dispose = () => {
    if (disposed) return
    disposed = true
    clearTimeout(timer)
    source.removeEventListener('abort', relay)
  }
  return { signal: controller.signal, dispose }
}

/** Translate a throw into the right `WebError` (timeout vs abort vs network). */
function translateAbortOrNetwork(error: unknown, signal: AbortSignal): WebError {
  if (error instanceof WebError && error.code === 'WEB_FETCH_TIMEOUT') return error
  if (error instanceof WebError && error.code === 'WEB_ABORTED') return error
  if (signal.aborted) {
    const reason = signal.reason
    if (reason instanceof WebError && reason.code === 'WEB_FETCH_TIMEOUT') {
      return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: reason })
    }
    return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
  }
  const message = error instanceof Error ? error.message : String(error)
  if (/timed out|timeout/i.test(message)) return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: error })
  return new WebError(`web fetch failed: ${message}`, 'WEB_PROVIDER_ERROR', { cause: error })
}

// ---------------------------------------------------------------------------
// Registration (reversible effect).
// ---------------------------------------------------------------------------

/**
 * Register the custom fetch provider into the web seam. The seam is resolved
 * OPTIONALLY (like subagents/agents): when `ctx.web` is absent (minimal
 * compositions), this is a no-op — the provider becomes available on any real
 * boot that mounts @deepseek-ai/dsh-web. When present, registration is a
 * reversible effect on this plugin's fiber (the seam returns a disposer).
 *
 * Selection: config `fetchProvider: 'deepartments-fetch'` (or env
 * `$DSH_WEB_FETCH_PROVIDER=deepartments-fetch`). Without an explicit pin, the
 * seam auto-selects only when this is the single usable provider.
 */
export function applyWebFetch(ctx: Context, config: WebFetchConfig): void {
  if (config.enabled === false) {
    ctx.logger.info('[deepartments] web-fetch provider disabled by config')
    return
  }
  const web = ctx.get('web') as { registerFetchProvider(provider: WebFetchProvider): () => void } | undefined
  if (web === undefined) {
    // The web seam is optional: the board core keeps working in minimal
    // compositions; a real boot mounts the seam and wires this provider in.
    ctx.logger.info('[deepartments] web seam absent — skipping fetch provider registration')
    return
  }
  const resolved = resolveWebFetchConfig(config)
  const provider = new DeepartmentsFetchProvider(resolved)
  const disposer = web.registerFetchProvider(provider)
  ctx.effect(() => disposer, 'deepartments: web-fetch provider')
  ctx.logger.info('[deepartments] web-fetch provider registered (id: deepartments-fetch)')
}
