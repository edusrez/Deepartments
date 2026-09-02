// dshd-webfetch — the custom web-fetch provider tests (extracted package).
//
// Rule 5 (AGENTS.md): tests go through the REAL Cordis Loader. The web seam
// (@deepseek-ai/dsh-web) is the REAL service; the dshd-webfetch plugin
// registers its custom 'deepartments-fetch' provider into it. The
// classification / detection / URL-hygiene logic is also exercised PURELY
// (network-free), and the provider's actual fetch + WEB_BLOCKED detection is
// proven against a local loopback HTTP server (hermetic: no external network,
// no live DSH_HOME). Tests run against the compiled lib/ (pnpm build first).
import assert from 'node:assert/strict'
import http from 'node:http'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { WebError } from '@deepseek-ai/dsh-web'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  DeepartmentsFetchProvider,
  WEBFETCH_PROVIDER_ID,
  blockErrorMessage,
  classifyContentType,
  detectBlock,
  resolveWebFetchConfig
} from 'dshd-webfetch'

const REPO_ROOT = path.resolve(fileURLToPath(new URL('../', import.meta.url)))

// --- pure config / detection / message tests --------------------------------

test('resolveWebFetchConfig: applies defaults and honours overrides', () => {
  const defaults = resolveWebFetchConfig()
  assert.equal(defaults.maxUrlLength, 2048)
  assert.equal(defaults.timeoutMs, 30000)
  assert.equal(defaults.maxResponseBytes, 5000000)
  assert.equal(defaults.maxRedirects, 5)
  assert.match(defaults.userAgent, /deepartments\/0\.1\.0/)
  const overridden = resolveWebFetchConfig({ userAgent: 'x', maxUrlLength: 1, maxRedirects: 2 })
  assert.equal(overridden.userAgent, 'x')
  assert.equal(overridden.maxUrlLength, 1)
  assert.equal(overridden.maxRedirects, 2)
})

test('detectBlock: classifies 403/429 as blocking and everything else as non-blocking', () => {
  assert.equal(detectBlock(403), 'blocked')
  assert.equal(detectBlock(429), 'rate-limited')
  assert.equal(detectBlock(200), null)
  assert.equal(detectBlock(404), null)
  assert.equal(detectBlock(503), null)
})

test('blockErrorMessage: instructs API/JSON investigation and carries the kind + host', () => {
  const msg = blockErrorMessage('blocked', 'github.com')
  assert.match(msg, /blocked by github\.com/)
  assert.match(msg, /HTTP 403/)
  assert.match(msg, /Investigate whether github\.com exposes an API or JSON endpoint/i)
  const rate = blockErrorMessage('rate-limited', 'registry.npmjs.org')
  assert.match(rate, /rate-limited by registry\.npmjs\.org/)
  assert.match(rate, /HTTP 429/)
  assert.match(rate, /Investigate whether registry\.npmjs\.org exposes an API or JSON endpoint/i)
})

test('classifyContentType: parses only the first media type (malformed comma-joined Content-Type)', () => {
  // GitHub /readme echoes the whole Accept list into a malformed Content-Type;
  // only the leading media type is meaningful.
  assert.equal(classifyContentType('application/vnd.github.raw+json,application/json,text/markdown,text/html; charset=utf-8'), 'text')
  assert.equal(classifyContentType('text/html; charset=utf-8'), 'html')
  assert.equal(classifyContentType('application/json'), 'text')
  assert.equal(classifyContentType('application/xml; charset=utf-8'), 'text')
  assert.equal(classifyContentType('text/plain'), 'text')
  assert.equal(classifyContentType('application/xhtml+xml'), 'html')
  assert.equal(classifyContentType('application/octet-stream'), undefined)
  assert.equal(classifyContentType(null), undefined)
})

// --- provider fetch behaviour (hermetic loopback), pure block detection ------

/** Start a throwaway loopback HTTP server; returns { url, close }. */
function startServer(handler) {
  const server = http.createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({
        url: (path) => `http://127.0.0.1:${port}${path}`,
        close: () => new Promise((res) => server.close(res))
      })
    })
  })
}

test('provider.fetch: 403 Cloudflare → WEB_BLOCKED', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(403, { 'content-type': 'text/html' })
    res.end('<html>cf blocked</html>')
  })
  try {
    const provider = new DeepartmentsFetchProvider(resolveWebFetchConfig())
    await assert.rejects(
      provider.fetch({ url: server.url('/a/b') }),
      (error) => {
        assert.ok(error instanceof WebError, 'throws a WebError')
        assert.equal(error.code, 'WEB_BLOCKED')
        assert.match(error.message, /HTTP 403/)
        assert.match(error.message, /Investigate/i)
        return true
      }
    )
  } finally {
    await server.close()
  }
})

test('provider.fetch: 429 rate-limit → WEB_BLOCKED', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(429, { 'content-type': 'text/html' })
    res.end('rate limited')
  })
  try {
    const provider = new DeepartmentsFetchProvider(resolveWebFetchConfig())
    await assert.rejects(
      provider.fetch({ url: server.url('/rate') }),
      (error) => error instanceof WebError && error.code === 'WEB_BLOCKED' && /rate-limited/.test(error.message)
    )
  } finally {
    await server.close()
  }
})

test('provider.fetch: 200 JSON decodes as text and preserves the final URL', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end('{"ok":true}')
  })
  try {
    const provider = new DeepartmentsFetchProvider(resolveWebFetchConfig())
    const result = await provider.fetch({ url: server.url('/repo') })
    assert.equal(result.statusCode, 200)
    assert.equal(result.body.kind, 'text')
    assert.equal(result.body.content, '{"ok":true}')
    assert.equal(result.url, server.url('/repo'))
  } finally {
    await server.close()
  }
})

test('provider.fetch: URL hygiene — non-http(s) scheme and credentials are rejected', async () => {
  const provider = new DeepartmentsFetchProvider(resolveWebFetchConfig())
  await assert.rejects(
    provider.fetch({ url: 'ftp://example.com/x' }),
    (error) => error instanceof WebError && error.code === 'WEB_INVALID_URL'
  )
  await assert.rejects(
    provider.fetch({ url: 'https://user:pass@example.com/x' }),
    (error) => error instanceof WebError && error.code === 'WEB_BLOCKED_URL'
  )
})

test('provider.fetch: redirect hop cap (maxRedirects) → WEB_REDIRECT_BLOCKED', async () => {
  // A server that always 302s to itself: the provider must stop after
  // maxRedirects hops (2 here) with WEB_REDIRECT_BLOCKED, never hang.
  let redirects = 0
  const server = await startServer((req, res) => {
    redirects++
    res.writeHead(302, { location: '/loop' })
    res.end()
  })
  try {
    const provider = new DeepartmentsFetchProvider(resolveWebFetchConfig({ maxRedirects: 2 }))
    await assert.rejects(
      provider.fetch({ url: server.url('/loop') }),
      (error) => {
        assert.ok(error instanceof WebError)
        assert.equal(error.code, 'WEB_REDIRECT_BLOCKED')
        assert.match(error.message, /exceeded the maximum of 2 redirects/)
        return true
      }
    )
    assert.equal(redirects, 3, 'one initial fetch + maxRedirects (2) redirect hops')
  } finally {
    await server.close()
  }
})

test('provider.fetch: malformed redirect Location → WebError WEB_INVALID_URL (not a raw TypeError)', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(302, { location: 'http://[' })
    res.end()
  })
  try {
    const provider = new DeepartmentsFetchProvider(resolveWebFetchConfig())
    await assert.rejects(
      provider.fetch({ url: server.url('/start') }),
      (error) => {
        assert.ok(error instanceof WebError)
        assert.equal(error.code, 'WEB_INVALID_URL')
        assert.match(error.message, /invalid redirect Location/)
        return true
      }
    )
  } finally {
    await server.close()
  }
})

// --- registration through the REAL Loader -------------------------------------

/**
 * Boot the REAL Cordis Loader with the REAL dsh services the bundle injects
 * (sessions, sessionProjections, tools) PLUS the REAL web seam
 * (@deepseek-ai/dsh-web) and the dshd-webfetch plugin (which registers the
 * provider). Asserts the custom provider is registered and selectable as the
 * default fetch provider.
 */
async function bootWithWebSeam() {
  const root = new Context()
  const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
  const loader = root.loader
  loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
  loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
  loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
  loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })
  // The REAL web seam (its `fetchProvider` config selects our provider).
  loader.create({ id: 'web', name: '@deepseek-ai/dsh-web', config: { fetchProvider: WEBFETCH_PROVIDER_ID } })
  // The extracted dshd-webfetch plugin registers the deepartments-fetch provider
  // into the (already-created) web seam.
  loader.create({
    id: 'dshd-webfetch',
    name: 'dshd-webfetch',
    config: { enabled: true, maxUrlLength: 2048, timeoutMs: 30000, maxResponseBytes: 5000000, maxRedirects: 5 }
  })
  await loader.await()
  return { root, dispose: () => loaderFiber.dispose() }
}

test('boot through the real Loader: the deepartments-fetch provider is registered and selectable', async () => {
  const { root, dispose } = await bootWithWebSeam()
  try {
    // The web seam is live and ours is the configured provider: a local fetch of
    // a well-formed URL selects it (proving registration + availability + the
    // configured-id resolution path).
    assert.ok(root.web, 'web seam is mounted')
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello')
    })
    try {
      const result = await root.web.fetch({ url: server.url('/hi') })
      assert.equal(result.statusCode, 200)
      assert.equal(result.body.content, 'hello')
    } finally {
      await server.close()
    }
  } finally {
    await dispose()
  }
})

// --- LANE 0.2.3c (P7b — TOTAL MODULARITY closure): plugin-complete surface ------
//
// The package is now a FULL plugin: its OWN cordis.patch.yml declares the
// `web` selection row (`fetchProvider: deepartments-fetch` as DEFAULT inside
// the package), so mounting dshd-webfetch IS the complete web-fetch feature —
// no dev-profile pin required. These tests lock that surface:
//
// 1. patch resolution in real composition (the policy-substitution/P7 pattern):
//    the package's OWN cordis.patch.yml carries the selection row, and a real
//    Loader composition registering BOTH deepartments-fetch AND a second
//    provider (the http provider the dev profile also mounts) resolves the
//    seam to OUR provider through the package-declared `fetchProvider` —
//    WEB_PROVIDER_AMBIGUOUS never fires (the pre-0.2.3c profile-only pin was
//    the ONLY thing preventing it; now the package row does that job).
// 2. provider selection — package DEFAULT vs override: the same composition
//    keeps working when a LATER `web` row (profile layer, composeProfile
//    last-write-wins) overrides `fetchProvider` to another registered provider
//    — the override wins and our provider stays registered (the override seam).

/** Return the `web` row's `fetchProvider` declared in the PACKAGE's OWN
 * cordis.patch.yml (the 0.2.3c DEFAULT). Plain-text scan — no YAML parser
 * (the org-config-parity discipline). */
function packagePatchFetchProvider() {
  const patch = readFileSync(path.join(REPO_ROOT, 'packages', 'dshd-webfetch', 'cordis.patch.yml'), 'utf8')
  const lines = patch.split('\n')
  const row = lines.findIndex((line) => line.trim() === '- id: web')
  assert.ok(row !== -1, 'the package cordis.patch.yml declares a `web` row (selection row)')
  const config = lines.slice(row + 1).find((line) => line.trim().startsWith('config:'))
  assert.ok(config !== undefined, 'the package `web` row has a config block')
  const fetchIndex = lines.slice(row + 1).findIndex((line) => line.trim().startsWith('fetchProvider:'))
  assert.ok(fetchIndex !== -1, 'the package `web` row config declares fetchProvider')
  return lines.slice(row + 1)[fetchIndex].split(':').slice(1).join(':').trim()
}

/** Boot the real Loader with the REAL web seam + the dshd-webfetch plugin +
 * a SECOND provider registered into the seam (the `http` sibling the dev
 * profile mounts). `webConfig` is the seam's composed config (the package
 * DEFAULT from its own patch, or a profile-style override). */
async function bootWithSecondProvider(webConfig) {
  const root = new Context()
  const loaderFiber = await root.plugin(Loader, { baseUrl: new URL('.', import.meta.url).href })
  const loader = root.loader
  loader.create({ id: 'sessions', name: '@deepseek-ai/dsh-session' })
  loader.create({ id: 'projections', name: '@deepseek-ai/dsh-session-projection' })
  loader.create({ id: 'systemPrompt', name: '@deepseek-ai/dsh-system-prompt' })
  loader.create({ id: 'tools', name: '@deepseek-ai/dsh-tools' })
  loader.create({ id: 'web', name: '@deepseek-ai/dsh-web', config: webConfig })
  loader.create({
    id: 'dshd-webfetch',
    name: 'dshd-webfetch',
    config: { enabled: true, maxUrlLength: 2048, timeoutMs: 30000, maxResponseBytes: 5000000, maxRedirects: 5 }
  })
  await loader.await()
  // The second provider: a minimal `http`-like fetch provider (no network) so
  // the seam sees TWO usable providers — only an explicit fetchProvider pin
  // (the package DEFAULT row) disambiguates.
  const other = {
    id: 'http',
    available() { return true },
    async fetch(request) {
      return { url: request.url, statusCode: 200, body: { kind: 'text', content: 'http-provider' }, truncated: false }
    }
  }
  const disposer = root.web.registerFetchProvider(other)
  return { root, other, dispose: () => { disposer(); loaderFiber.dispose() } }
}

test('LANE 0.2.3c (P7b): the package OWN cordis.patch.yml declares the `web` selection row with fetchProvider=deepartments-fetch as DEFAULT — a real composition with a second provider resolves the seam to OUR provider (no WEB_PROVIDER_AMBIGUOUS)', async () => {
  // 1. The package patch itself carries the selection (the plugin-complete
  //    surface: mounting dshd-webfetch = the complete web-fetch feature).
  assert.equal(packagePatchFetchProvider(), WEBFETCH_PROVIDER_ID, 'the package patch default fetchProvider is deepartments-fetch')
  // 2. Real composition: the web seam composed from the package DEFAULT row +
  //    the dshd-webfetch plugin + a SECOND registered provider. Two usable
  //    providers WITHOUT a pin would raise WEB_PROVIDER_AMBIGUOUS at fetch —
  //    the package-declared fetchProvider (what the bundle row now provides in
  //    minimal compositions) is the pin that resolves it.
  const { root, dispose } = await bootWithSecondProvider({
    searchProvider: 'deepseek-official',
    fetchProvider: WEBFETCH_PROVIDER_ID
  })
  try {
    const server = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello')
    })
    try {
      const result = await root.web.fetch({ url: server.url('/hi') })
      assert.equal(result.statusCode, 200)
      assert.equal(result.body.content, 'hello', 'the fetch is served by OUR provider (the package default selection wins over the second provider — not ambiguous)')
    } finally {
      await server.close()
    }
  } finally {
    await dispose()
  }
})

test('LANE 0.2.3c (P7b): provider selection — a LATER profile-style `web` row overriding fetchProvider to the second provider WINS (composeProfile last-write-wins), while deepartments-fetch stays registered (the override seam is preserved)', async () => {
  // The dev profile still carries its own `web` row (cordis.patch.yml:76-79);
  // composeProfile applies [bundlePatches, profile.patches, homePatches,
  // overlays] and rows.set(row.id, row) → a LATER profile row overrides the
  // package DEFAULT. Here the override points at the OTHER provider.
  const { root, other, dispose } = await bootWithSecondProvider({
    searchProvider: 'deepseek-official',
    fetchProvider: 'http'
  })
  try {
    const result = await root.web.fetch({ url: 'http://ignored.example/x' })
    assert.equal(result.body.content, 'http-provider', 'the override won: the second provider serves the fetch')
    // Our provider is STILL registered (the override changed the SELECTION,
    // not the registration): re-registering it raises WEB_DUPLICATE_PROVIDER.
    const provider = new DeepartmentsFetchProvider(resolveWebFetchConfig())
    assert.throws(
      () => root.web.registerFetchProvider(provider),
      (error) => error instanceof WebError && error.code === 'WEB_DUPLICATE_PROVIDER',
      'deepartments-fetch is still registered (the override only reselects)'
    )
    assert.equal(other.id, 'http', 'the second provider identity is http (the override target)')
  } finally {
    await dispose()
  }
})
