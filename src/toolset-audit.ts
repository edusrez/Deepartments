// dsh-deepartments — the M2.3 diagnostics channel for the SECRETARY toolset
// derivation. The deepartments warns do NOT reach the harness stdout (the M2.2
// live finding), so the only GUARANTEED channel for the M2.3 waypoints is a
// stateDir file: `<stateDir>/toolset-audit.jsonl`, append-only, bounded to the
// most-recent TOOLSET_AUDIT_MAX_LINES rows (the same cap discipline as the
// dshd-health jsonl files), one line per materialization. A
// `DEEPARTMENTS_TOOLSET_AUDIT=0` env flag disables the channel (the hermetic
// suite / CI sets it); anything else (including absent) enables it.
//
// The stateDir is resolved the SAME way every other org config is (FASE 2.6
// BATCH A — the `deepartments.org` shared config source provided by dshd-core
// in the full composition, with the bundle's own `config.stateDir` as the
// in-bundle fallback). invoke.ts passes its resolved `stateDir` directly;
// subagent.ts (whose standing ctx has no bundle config) resolves it via
// `ctx.get('deepartments.org')`.
//
// Synchronous on purpose: the subagent `apply()` is synchronous and the
// postSetup waypoints run inside an awaited setup; a sync bounded write keeps
// the audit deterministic for the resume test without racing the file.
//
// NO export default (pitfall 0001 — breaks `inject`).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/** The audit filename under the runtime stateDir. */
export const TOOLSET_AUDIT_FILE = 'toolset-audit.jsonl'
/** The bounded record cap of toolset-audit.jsonl (the oldest lines are trimmed
 * on append — mirrors POST_ERRORS_MAX_LINES / HEALTH_ALERTS_MAX_LINES). */
export const TOOLSET_AUDIT_MAX_LINES = 500
/** The env flag name: a literal '0' disables the channel (hermetic/CI). */
export const TOOLSET_AUDIT_FLAG_ENV = 'DEEPARTMENTS_TOOLSET_AUDIT'

/** Resolve the audit stateDir from a plugin ctx the same way the bundle does:
 * the `deepartments.org` shared config source first (dshd-core when composed),
 * then nothing — the caller (invoke.ts) passes its OWN resolved stateDir, so
 * this helper is the subagent.ts path only. Absent → undefined (no-op write). */
export function auditStateDir(ctx: Context): string | undefined {
  const org = ctx.get('deepartments.org') as { stateDir?: string } | undefined
  return org?.stateDir
}

/** Append ONE audit line to `<stateDir>/toolset-audit.jsonl` and keep the file
 * BOUNDED: rows OLDER than the cap are trimmed on append (read + append +
 * slice-most-recent on write). `stateDir` may be undefined (the org service not
 * composed / the audit dir unresolvable): the write is then a silent no-op.
 * mkdir -p the dir first; a malformed/nonexistent file degrades to empty (the
 * append still lands). Never throws — callers fold a failure into nothing (a
 * diagnostics channel must never break a materialization). */
export function appendToolsetAudit(stateDir: string | undefined, entry: Record<string, unknown>): void {
  if (stateDir === undefined || stateDir === '') return
  if (process.env[TOOLSET_AUDIT_FLAG_ENV] === '0') return
  try {
    const filePath = path.join(stateDir, TOOLSET_AUDIT_FILE)
    mkdirSync(path.dirname(filePath), { recursive: true })
    const lines: string[] = []
    try {
      const existing = readFileSync(filePath, 'utf8')
      lines.push(...existing.split('\n').filter((line) => line.trim() !== ''))
    } catch {
      /* ENOENT or unreadable → a cold start; lines stays [] */
    }
    lines.push(JSON.stringify({ ts: Date.now(), ...entry }))
    const bounded = lines.slice(-TOOLSET_AUDIT_MAX_LINES)
    writeFileSync(filePath, bounded.join('\n') + '\n', 'utf8')
  } catch {
    /* best-effort: never throws */
  }
}