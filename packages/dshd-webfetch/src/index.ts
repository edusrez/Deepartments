// dshd-webfetch — the deepartments custom `ctx.web` fetch provider, extracted
// from the dsh-deepartments bundle into its own Cordis plugin package (the
// Fase-1 modular Cordis split). Behavior-neutral: the provider id
// ('deepartments-fetch') and its registration/blocking semantics are UNCHANGED.
//
// NO export default (pitfall 0001 — breaks `inject`).
import type { Context } from '@deepseek-ai/cordis'
import { applyWebFetch } from './webfetch.js'
import type { WebFetchConfig } from './webfetch.js'

// Re-export the whole public surface of the provider module so consumers and
// tests import everything from the package entry (they previously imported
// from the bundle's lib/webfetch.js).
export * from './webfetch.js'

export const name = 'dshd-webfetch'
// This plugin is the web-fetch provider registration: it MUST apply AFTER the
// web seam's `web` service is available, so it injects 'web' (the Cordis
// guarantee) and then resolves it (ctx.get('web')) inside applyWebFetch. The
// original bundle wired the provider from its own apply (inject ['tools',
// 'sessions']); a standalone web-only plugin correctly depends on the seam.
export const inject = ['web']

export function apply(ctx: Context, config: WebFetchConfig) {
  applyWebFetch(ctx, config)
}
