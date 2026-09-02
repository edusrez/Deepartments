// dsh-deepartments — P7 GROWTH-WITHOUT-FORK FIXTURE (LANE 0.2.3; P7 = "crecer =
// añadir plugins, sin fork"). A test plugin that ADDS a NEW service/role to the
// composition WITHOUT touching the bundle or any existing consumer:
//   - `deepartments.deptRoles` — a service key that does NOT exist anywhere in
//     the bundle/core/orchestration surfaces (pure addition); its
//     `roleTemplateFor(roleId)` resolves a MATERIALIZABLE role descriptor for
//     the NEW role 'security-auditor' by REUSING an EXISTING repo role template
//     (presets/departments/quality/quality-inspector.md — reuse, never fork),
//     so the declared role is a real, spawnable department role (P7 at the
//     department level — the department-as-plugin pattern).
// Composed BETWEEN dshd-orchestration and the bundle in p7-feature-plugin.test.js
// as a loader row — the exact "mount a plugin by patch" shape the P7 criterion
// demands (declarative composition, zero bundle edits).
//
// NO export default (pitfall 0001 — breaks `inject`).
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export const name = 'deepartments-p7-feature-plugin'
export const inject = []

/** The EXISTING repo role template the plugin's NEW role materializes from
 * (reuse the repo presets — the plugin grows the org, never forks the code). */
const REUSED_TEMPLATE = fileURLToPath(new URL('../../presets/departments/quality/quality-inspector.md', import.meta.url))

export function apply(ctx) {
  ctx.provide('deepartments.deptRoles', {
    /**
     * Resolve a MATERIALIZABLE role descriptor for a plugin-declared role.
     * 'security-auditor' is the NEW role this plugin adds; any other role is
     * undefined (the plugin does not shadow existing roles). LAZY: reads the
     * reused template at resolution time (the functional assert point).
     */
    roleTemplateFor(roleId) {
      if (roleId !== 'security-auditor') return undefined
      if (!existsSync(REUSED_TEMPLATE)) return undefined
      const text = readFileSync(REUSED_TEMPLATE, 'utf8')
      return {
        id: roleId,
        title: 'Security Auditor',
        persona: text,
        tools: ['read', 'glob', 'grep'],
        path: REUSED_TEMPLATE,
        role: 'quality-inspector'
      }
    }
  })
}