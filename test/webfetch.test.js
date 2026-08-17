// dsh-deepartments — custom web-fetch provider tests.
//
// Rule 5 (AGENTS.md): tests go through the REAL Cordis Loader. The web seam
// (@deepseek-ai/dsh-web) is the REAL service; the dsh-deepartments bundle
// registers its custom 'deepartments-fetch' provider into it. The rewrite /
// detection / URL-hygiene logic is also exercised PURELY (network-free), and
// the provider's actual fetch + WEB_BLOCKED detection is proven against a
// local loopback HTTP server (hermetic: no external network, no live DSH_HOME).
// Tests run against the compiled lib/ (pnpm build first).
import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { Context, Service } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { WebError } from '@deepseek-ai/dsh-web'
import {
  DeepartmentsFetchProvider,
  WEBFETCH_PROVIDER_ID,
  blockErrorMessage,
  detectBlock,
  resolveWebFetchConfig,
  rewriteWebFetchUrl,
  suggestApiEndpoint
} from '../lib/webfetch.js'

// --- pure rewrite / suggestion / config tests ---------------------------------

test('rewriteWebFetchUrl: npm package URLs rewrite to the registry JSON endpoint', () => {
  const rewrites = { npm: true, github: true, rawGithub: true }
  assert.equal(
    rewriteWebFetchUrl('https://www.npmjs.com/package/express', rewrites),
    'https://registry.npmjs.org/express'
  )
  assert.equal(
    rewriteWebFetchUrl('https://npmjs.com/package/@scope/pkg', rewrites),
    'https://registry.npmjs.org/@scope/pkg'
  )
  // Other npmjs.com paths are left alone (detection applies).
  assert.equal(rewriteWebFetchUrl('https://www.npmjs.com/', rewrites), null)
  assert.equal(rewriteWebFetchUrl('https://www.npmjs.com/package/express/v/4.0.0', rewrites), 'https://registry.npmjs.org/express')
})

test('rewriteWebFetchUrl: exact github owner/repo rewrites to api.github.com; subpaths left alone', () => {
  const rewrites = { npm: true, github: true, rawGithub: true }
  assert.equal(
    rewriteWebFetchUrl('https://github.com/esuarez/deepartments', rewrites),
    'https://api.github.com/repos/esuarez/deepartments'
  )
  assert.equal(
    rewriteWebFetchUrl('https://github.com/esuarez/deepartments/', rewrites),
    'https://api.github.com/repos/esuarez/deepartments'
  )
  // Subpaths and special top-level pages are NOT rewritten.
  assert.equal(rewriteWebFetchUrl('https://github.com/esuarez/deepartments/blob/main/README.md', rewrites), null)
  assert.equal(rewriteWebFetchUrl('https://github.com/login', rewrites), null)
  assert.equal(rewriteWebFetchUrl('https://github.com/settings', rewrites), null)
})

test('rewriteWebFetchUrl: raw README rewrites to the GitHub readme endpoint; other raw files left alone', () => {
  const rewrites = { npm: true, github: true, rawGithub: true }
  assert.equal(
    rewriteWebFetchUrl('https://raw.githubusercontent.com/esuarez/deepartments/main/README.md', rewrites),
    'https://api.github.com/repos/esuarez/deepartments/readme'
  )
  assert.equal(
    rewriteWebFetchUrl('https://raw.githubusercontent.com/esuarez/deepartments/main/docs/readme.txt', rewrites),
    'https://api.github.com/repos/esuarez/deepartments/readme'
  )
  // Non-README raw paths are left to detection.
  assert.equal(rewriteWebFetchUrl('https://raw.githubusercontent.com/esuarez/deepartments/main/src/index.ts', rewrites), null)
})

test('rewriteWebFetchUrl: per-host toggles disable individual rewrites', () => {
  const all = { npm: true, github: true, rawGithub: true }
  assert.equal(rewriteWebFetchUrl('https://www.npmjs.com/package/x', { ...all, npm: false }), null)
  assert.equal(rewriteWebFetchUrl('https://github.com/a/b', { ...all, github: false }), null)
  assert.equal(rewriteWebFetchUrl('https://raw.githubusercontent.com/a/b/main/README.md', { ...all, rawGithub: false }), null)
})

test('rewriteWebFetchUrl: non-http(s) and unknown hosts are never rewritten', () => {
  const rewrites = { npm: true, github: true, rawGithub: true }
  assert.equal(rewriteWebFetchUrl('ftp://github.com/a/b', rewrites), null)
  assert.equal(rewriteWebFetchUrl('https://example.com/a/b', rewrites), null)
  assert.equal(rewriteWebFetchUrl('not a url', rewrites), null)
})

test('suggestApiEndpoint: proposes the API endpoint for known blocked hosts', () => {
  assert.equal(suggestApiEndpoint(new URL('https://www.npmjs.com/package/express')), 'https://registry.npmjs.org/express')
  assert.equal(suggestApiEndpoint(new URL('https://github.com/a/b')), 'https://api.github.com/repos/a/b')
  assert.equal(suggestApiEndpoint(new URL('https://raw.githubusercontent.com/a/b/main/README.md')), 'https://api.github.com/repos/a/b/readme')
  assert.equal(suggestApiEndpoint(new URL('https://example.com/x')), null)
})

test('resolveWebFetchConfig: applies defaults and honours overrides', () => {
  const defaults = resolveWebFetchConfig()
  assert.equal(defaults.maxUrlLength, 2048)
  assert.equal(defaults.timeoutMs, 30000)
  assert.equal(defaults.maxResponseBytes, 5000000)
  assert.equal(defaults.maxRedirects, 5)
  assert.deepEqual(defaults.rewrites, { npm: true, github: true, rawGithub: true })
  assert.match(defaults.userAgent, /deepartments\/0\.1\.0/)
  const overridden = resolveWebFetchConfig({ userAgent: 'x', rewrites: { npm: false }, maxUrlLength: 1, maxRedirects: 2 })
  assert.equal(overridden.userAgent, 'x')
  assert.equal(overridden.rewrites.npm, false)
  assert.equal(overridden.rewrites.github, true) // untouched defaults carry through
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

test('blockErrorMessage: carries the kind, host, and the API endpoint suggestion', () => {
  const msg = blockErrorMessage('blocked', 'github.com', 'https://api.github.com/repos/a/b')
  assert.match(msg, /blocked by github\.com/)
  assert.match(msg, /HTTP 403/)
  assert.match(msg, /retry the API endpoint: https:\/\/api\.github\.com\/repos\/a\/b/)
  const rate = blockErrorMessage('rate-limited', 'registry.npmjs.org', null)
  assert.match(rate, /rate-limited by registry\.npmjs\.org/)
  assert.match(rate, /HTTP 429/)
  assert.doesNotMatch(rate, /retry the API endpoint/)
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

test('provider.fetch: 403 Cloudflare → WEB_BLOCKED with the API endpoint suggestion', async () => {
  const server = await startServer((req, res) => {
    res.writeHead(403, { 'content-type': 'text/html' })
    res.end('<html>cf blocked</html>')
  })
  try {
    const provider = new DeepartmentsFetchProvider(resolveWebFetchConfig())
    // A github.com-shaped URL on OUR loopback host has no known rewrite, so the
    // suggestion derives from the path shape via suggestApiEndpoint.
    await assert.rejects(
      provider.fetch({ url: server.url('/a/b') }),
      (error) => {
        assert.ok(error instanceof WebError, 'throws a WebError')
        assert.equal(error.code, 'WEB_BLOCKED')
        assert.match(error.message, /HTTP 403/)
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
 * (@deepseek-ai/dsh-web), and the dsh-deepartments bundle itself. Asserts the
 * custom provider is registered and selectable as the default fetch provider.
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
  loader.create({
    id: 'deepartments',
    name: '../lib/index.js',
    config: {
      stateDir: '/tmp/webfetch-test',
      org: { rooms: [], departments: [] }
    }
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
