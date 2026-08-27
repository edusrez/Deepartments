// dsh-deepartments — D3 core-service test (subagent/gui/pooler phase): the
// dispatch-time transient-subagent role registry, promoted from the bundle's
// module-global Map into the `deepartments.subagentRoles` CORE service
// (dshd-core, ONE per-process store). Exercises the service surface DIRECTLY
// (set / get / delete / entries + the `generic` default + the single-instance
// guarantee) through the drop-in bridge (lib/role-orient.js → dshd-core) — the
// exact R6 surface the bundle (src/subagent.ts writer, src/invoke.ts reader)
// and the Task T4 tests consume. The single per-process store kept the writer
// and reader on one registry; a per-apply Map would split them and silently
// degrade every subagent to `generic`.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createSubagentRolesService,
  forgetRole,
  normalizeRole,
  rememberRole,
  roleForSession,
  roleRegistry
} from '../lib/role-orient.js'

test('D3: the subagent-roles service is ONE per-process registry — set/get/delete/entries, generic default, eviction and the compat fns all share the SAME store', async () => {
  // Fresh process (node --test runs each file in its own worker): the singleton
  // store starts EMPTY — bounded by in-flight children by construction.
  assert.equal(roleRegistry.size, 0, 'the per-process registry starts empty')

  // SINGLE INSTANCE: every createSubagentRolesService() call returns the SAME
  // facade over the one store (the «no double-register» guarantee — a Map per
  // plugin/apply would let the bundle writer and the core reader diverge).
  const svc = createSubagentRolesService()
  assert.equal(createSubagentRolesService(), svc, 'createSubagentRolesService is a per-process singleton')

  // set → get roundtrip (the rememberRole semantics at dispatch). M2 (owner
  // decision 2026-08-28): the ONE transient contract is 'secretary' — the
  // pre-M2 role names (reviewer here, builder below) R6-unify into it at write
  // time via normalizeRole.
  svc.set('child-a', 'reviewer')
  assert.equal(svc.get('child-a'), 'secretary', 'set records the dispatch-time role (deprecated reviewer R6-unifies into secretary)')

  // set NORMALIZES unknown values (rememberRole semantics — an arbitrary role
  // falls back to generic at write time, never later at read time).
  svc.set('child-b', 'totally-unknown')
  assert.equal(svc.get('child-b'), 'generic', 'set normalizes an unknown role to generic')
  assert.equal(normalizeRole('bogus'), 'generic', 'normalizeRole is the authoritative normalizer')

  // get on an absent key → undefined; roleForSession applies the generic default.
  assert.equal(svc.get('missing'), undefined, 'get returns undefined for a never-recorded session')
  assert.equal(roleForSession('missing'), 'generic', 'roleForSession defaults unknown sessions to generic')

  // entries reflects the LIVE store.
  assert.deepEqual([...svc.entries()].sort(), [['child-a', 'secretary'], ['child-b', 'generic']], 'entries iterates the live registry')

  // delete EVICTS at settlement (forgetRole semantics — silent no-op when missing).
  svc.delete('child-a')
  assert.equal(svc.get('child-a'), undefined, 'delete evicts the role at settlement')
  assert.equal(roleForSession('child-b'), 'generic', 'a surviving entry still resolves')
  svc.delete('never-seeded')
  assert.equal(roleRegistry.size, 1, 'deleting a missing key is a silent no-op — the store stays intact')

  // R6 drop-in: the compat functions the bundle/test surface imports are the
  // SAME channel as the service — a role written via rememberRole is readable
  // via the service and vice versa (one store, never two registries).
  rememberRole('child-c', 'builder')
  assert.equal(svc.get('child-c'), 'secretary', 'rememberRole writes into the SAME service store (deprecated builder R6-unifies into secretary)')
  forgetRole('child-c')
  assert.equal(svc.get('child-c'), undefined, 'forgetRole evicts from the SAME service store')
  assert.equal(roleRegistry.size, 1, 'the eviction left only the seeded child-b entry')

  // Cleanup: leave the per-process store empty (bounded by in-flight children).
  svc.delete('child-b')
  assert.equal(roleRegistry.size, 0, 'every entry evicted — the registry is bounded again')
})