// dsh-deepartments — Cordis plugin (bundle scaffold, task 3).
// NO export default (pitfall 0001 — breaks `inject`).
import type { Context } from '@deepseek-ai/cordis'

export const name = 'deepartments'
export const inject = ['tools', 'sessions']

export function apply(ctx: Context) {
  ctx.logger.info('deepartments: online')
  // The cordis logger is exporter-based (consumed by the web UI console) and
  // never reaches stdout; journald only sees raw stdout, so also print the
  // boot line the way dsh-smooth-stream does (console.log with a prefix).
  console.log('[deepartments] online')

  // Reversible effect: every registration must be a reversible effect (rule 4),
  // so the callback returns the cleanup disposer. No real resources yet —
  // task 4 adds tools/sessions/posts; the disposer is a no-op for now.
  ctx.effect(() => {
    return () => {}
  }, 'deepartments: resources')
}
