// dsh-deepartments — P2 HYGIENE A (m-423 SNAPSHOT CANDIDATE): the pre-rotation
// snapshot anchor. The S2.7 evidence copy (copyOldArtifactToArchive) runs
// MID-TURN (the dept_sleep turn is still executing), so the old session's final
// `turn/end` lands in the artifact AFTER the copy — every rotated-host snapshot
// audit (QD family m-423: 3-4 lines short, 13496 vs 13500) found the archive
// cut at the mid-turn state. The fix anchors the snapshot at the REAL turn/end:
// finalizePreRotationSnapshot re-copies the SETTLED artifact onto the S2.7
// backup once the old handle's dispose completes (driver idle ⇒ the concluding
// turn's events are written), chained fire-and-forget via chainSnapshotFinalize.
//
// P2 DISCIPLINE: 0 commits — these tests exercise the SOURCE directly via
// Node's native type-stripping (node --test over src, self-registered
// ts-src-loader hook, the lane-② pattern). The session-rotation graph imports
// relative `.js` specifiers (NodeNext) whose `.ts` siblings the hook rewrites —
// the DEEP import MUST be dynamic (link-time static imports resolve BEFORE the
// top-of-file register() runs, so the rewrite would not be active yet).
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register(new URL('./ts-src-loader.mjs', import.meta.url), { parentURL: import.meta.url })

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
const { finalizePreRotationSnapshot, chainSnapshotFinalize } = await import('../packages/dshd-core/src/session-rotation.ts')

/** The artifact layout findSessionArtifact scans: <sessionsRoot>/<project>/<sessionId>/session.jsonl[.zstd]. */
async function withSessionDir(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'p2-snapshot-'))
  try {
    const sessionsRoot = path.join(root, 'sessions')
    const project = path.join(sessionsRoot, '--root--')
    const sessionDir = path.join(project, 'session-test-1')
    await mkdir(sessionDir, { recursive: true })
    const artifactPath = path.join(sessionDir, 'session.jsonl')
    await writeFile(artifactPath, 'line1\nline2\n', 'utf8')
    return await fn({ root, sessionsRoot, artifactPath })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

test('m-423 snapshot anchor: finalizePreRotationSnapshot overwrites the S2.7 backup with the SETTLED artifact (ends at the real final event)', async () => {
  await withSessionDir(async ({ root, sessionsRoot, artifactPath }) => {
    const backupPath = path.join(root, 'archive', 'session-session-test-1-pre-rotation-x.jsonl.zstd')
    await mkdir(path.dirname(backupPath), { recursive: true })
    // The S2.7 mid-turn copy: shorter than the final artifact (the m-423 3-4 line gap).
    await writeFile(backupPath, 'line1\n', 'utf8')
    // The concluding turn lands AFTER the copy.
    await writeFile(artifactPath, 'line1\nline2\nturn/end {seq:2}\n', 'utf8')

    const result = await finalizePreRotationSnapshot({ sessionsRoot, oldSessionId: 'session-test-1', backupPath })
    assert.equal(result.ok, true, 'the finalize resolves ok')
    assert.equal(result.path, backupPath)
    const backupNow = await readFile(backupPath, 'utf8')
    assert.equal(backupNow, 'line1\nline2\nturn/end {seq:2}\n', 'the backup now ends at the REAL final event')
  })
})

test('m-423 snapshot anchor: finalizePreRotationSnapshot is never-throwing (missing artifact → {ok:false} without a throw)', async () => {
  await withSessionDir(async ({ root, sessionsRoot }) => {
    const backupPath = path.join(root, 'archive', 'none.jsonl.zstd')
    await mkdir(path.dirname(backupPath), { recursive: true })
    const result = await finalizePreRotationSnapshot({ sessionsRoot, oldSessionId: 'session-missing', backupPath })
    assert.equal(result.ok, false)
    assert.match(result.reason, /no stored artifact for session-missing/)
  })
})

test('m-423 snapshot anchor: chainSnapshotFinalize runs the finalize AFTER the dispose settles (the turn/end seam)', async () => {
  await withSessionDir(async ({ root, sessionsRoot, artifactPath }) => {
    const backupPath = path.join(root, 'archive', 'session-session-test-1-pre-rotation-y.jsonl.zstd')
    await mkdir(path.dirname(backupPath), { recursive: true })
    await writeFile(backupPath, 'stale', 'utf8')
    // The REAL ordering: the harness dispose awaits whenIdle, i.e. resolves only
    // after the current turn concludes and its events are written. Simulate it:
    // the dispose settles, THEN the final turn/end appears, then resolve? No —
    // the dispose is the SEAM: teardown completion implies the events ARE
    // written, so the artifact is ALREADY settled when dispose resolves.
    await writeFile(artifactPath, 'line1\nline2\nturn/end {seq:5}\n', 'utf8')
    let disposed = false
    chainSnapshotFinalize(async () => { disposed = true }, { sessionsRoot, oldSessionId: 'session-test-1', backupPath })
    // The chain is fire-and-forget: wait a tick for the copy to land.
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(disposed, true, 'the dispose seam was invoked')
    const backupNow = await readFile(backupPath, 'utf8')
    assert.equal(backupNow, 'line1\nline2\nturn/end {seq:5}\n', 'the chained finalize copied the settled artifact onto the backup')
  })
})

test('m-423 snapshot anchor: chainSnapshotFinalize skips the finalize without a backup path and swallows a rejecting dispose', async () => {
  await withSessionDir(async ({ root, sessionsRoot }) => {
    const backupPath = path.join(root, 'archive', 'never.jsonl.zstd')
    await mkdir(path.dirname(backupPath), { recursive: true })
    await writeFile(backupPath, 'stale', 'utf8')
    // No backup path (the S2.7 copy failed) → the chain must not write.
    chainSnapshotFinalize(() => Promise.resolve(), { sessionsRoot, oldSessionId: 'session-test-1' })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(await readFile(backupPath, 'utf8'), 'stale', 'no backup path → no finalize write')
    // A rejecting dispose must not surface an unhandled rejection.
    chainSnapshotFinalize(() => Promise.reject(new Error('dispose aborted')), { sessionsRoot, oldSessionId: 'session-test-1', backupPath })
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(await readFile(backupPath, 'utf8'), 'stale', 'a rejecting dispose leaves the backup untouched (the S2.7 copy remains the belt)')
  })
})