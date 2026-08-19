// dsh-deepartments — Deepartments settings namespace (ROADMAP: settings tab).
//
// Registers the `deepartments` settings namespace so the owner can toggle the
// main-agents sidebar (the `sidebar.workspaces` shadow + the injected `<style>`)
// from the DSH Settings UI, persisted server-side to `<harness home>/settings.yaml`
// by the `@deepseek-ai/dsh-settings` provider.
//
// The settings service is resolved OPTIONALLY via `ctx.get('settings')`, exactly
// like `agents`/`subagents`/`connection` in this repo: a host without the
// settings provider (minimal/headless compositions) logs one `[deepartments]`
// info line and this becomes a no-op, while a real boot registers the namespace.
// The registration rides `ctx.effect` so it is torn down on unload (AGENTS.md
// rule 4) — the provider's own `register` is itself a fiber-scoped effect that
// removes the namespace + observers when disposed.
//
// NO export default (pitfall 0001 — breaks `inject`).
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Config } from './org.js'

/** Namespace key the client `settings.section` and `settingsScope` bind to. */
export const DEEPARTMENTS_SETTINGS_NS = 'deepartments'

/** Schema resolving the `deepartments` settings namespace. */
export const DeepartmentsSettings = z.object({
  sidebarEnabled: z.boolean().default(true)
})

/** Minimal structural face of the settings service we rely on (host). */
interface SettingsLike {
  register(ns: string, schema: unknown, options?: { base?: unknown }): unknown
}

/**
 * Wire the `deepartments` settings namespace into the host settings service.
 *
 * Returns a disposer when the service is present, or `undefined` when no
 * settings service is mounted (a no-op). The registration itself is a
 * reversible `ctx.effect`: disposing the plugin fiber removes the namespace.
 *
 * @param ctx - the plugin context owning the wiring.
 * @param _config - the plugin config (accepted for a uniform apply signature;
 *   the namespace schema carries its own defaults, so no config is consumed).
 */
export function applySettings(ctx: Context, _config: Config): (() => void) | undefined {
  const settings = ctx.get('settings') as SettingsLike | undefined
  if (!settings) {
    ctx.logger.info('[deepartments] settings service absent — settings tab disabled')
    return undefined
  }
  ctx.effect(() => {
    settings.register(DEEPARTMENTS_SETTINGS_NS, DeepartmentsSettings)
    return () => {
      // Registration is also fiber-scoped inside the provider; nothing further
      // to tear down here beyond dropping our own reference.
      void settings
    }
  }, 'deepartments: settings namespace')
  return undefined
}
