// dsh-deepartments — CUT-4 ZONE LOCK (asserted, content-anchored).
//
// THE GAP THIS CLOSES (measured 2026-09-14, IPD builder-339 / lane CUT-4-LOCK):
// the CUT-4 frozen zone of packages/dshd-orchestration/src/tools.ts was described
// in PROSE by .dsh/skills/departments-workflow/SKILL.md as
// `tools.ts:5616→7353, md5 c61523c4…`. The lane 4fb3af0 landed 33 net LOCs BELOW
// the span (226-1525), so the zone CONTENT did not move while the LINE NUMBERS
// slid: the prose cite became FALSE (the live span is 5649→7386) and NOTHING in
// the suite detected it. A zone's md5 is content-addressed and offset-independent;
// a line-number cite is neither. This test pins the CONTENT anchor and asserts the
// RELATIONSHIP between the two content sentinels, so:
//   (a) it FAILS if the CONTENT of the span changes (real DERIVA), and
//   (b) it does NOT fail on a pure OFFSET shift (DESLIZAMIENTO) — the 4fb3af0 class,
// which is exactly the distinction that could not be made without measuring by hand.
// This test therefore must NOT assert line numbers: pinning an offset would invert
// the property (b) it exists to provide.
//
// PATTERN COPIED (not reinvented) from test/p2-staleness-cap.test.js:156-162 —
// "locate both anchors by TEXT (findIndex over the split source), then assert the
// RELATION between them" instead of hardcoding line numbers. The md5 literal below
// is the SAME movement identity the freeze lock test/tools-factory.test.js:501 and
// scripts/zone-md5-manifest.json (zone cut4-tools-zone) carry: the three MUST move
// in the SAME commit (a re-freeze updates all of them together).
//
// NOTE: test/tools-factory.test.js already asserts this exact md5 against the same
// source file, and test/r6-tree-integrity.test.js already proves the manifest is
// byte-synced with it. This test is the explicit, SELF-DOCUMENTING two-sided
// proof of the deriva/deslizamiento distinction on the REAL source (not a
// fixture), so the property is asserted by name rather than only implied.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOOLS_TS = path.join(REPO_ROOT, 'packages', 'dshd-orchestration', 'src', 'tools.ts')

// The TWO content sentinels that DELIMIT the CUT-4 zone — the SAME pair as
// scripts/zone-md5-manifest.json (banner → close) and as r6-suite-guard.mjs's
// ZONE_BANNER/ZONE_CLOSE. Literal text, never line numbers.
const BANNER = "  // --- messaging bus TOOL DEFINITIONS (ONE body per tool; registered in the"
const CLOSE = "  }, 'deepartments: host-plane tools')"

// The FROZEN movement identity (all-hex, 32 chars). MUST equal
// test/tools-factory.test.js:501 and zone-md5-manifest.json cut4-tools-zone.md5.
const FROZEN_MD5 = 'c61523c4fa5a71b772441da05b2bcf58'

const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex')
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length

/** Slice the zone by its two CONTENT sentinels (never by offsets). `null` if absent. */
function sliceZoneByMarkers(src) {
  const first = src.indexOf(BANNER)
  const last = src.indexOf(CLOSE)
  if (first === -1 || last === -1 || last < first) return null
  return src.slice(first, last + CLOSE.length) + '\n'
}

test('cut4-zone-lock: the CUT-4 content-freeze lock is ASSERTED — the span md5 matches the frozen movement identity (the two sibling zones boot/presets have had theirs since de24de1)', () => {
  const src = readFileSync(TOOLS_TS, 'utf8')
  const zone = sliceZoneByMarkers(src)
  assert.ok(zone !== null, 'both CUT-4 sentinels resolve in tools.ts (banner → host-plane tools close)')
  assert.equal(md5(zone), FROZEN_MD5,
    `the CUT-4 zone CONTENT is byte-identical to the frozen movement identity ${FROZEN_MD5} — a REAL content drift of the span must move this pin WITH its evidence (re-freeze together with test/tools-factory.test.js:501 AND scripts/zone-md5-manifest.json cut4-tools-zone)`)
  // The pin must be a real 32-hex identity, not an empty-slice artifact.
  assert.match(FROZEN_MD5, /^[0-9a-f]{32}$/, 'the frozen identity is a 32-hex md5')
})

test('cut4-zone-lock: the span md5 is CONTENT-ADDRESSED and OFFSET-INDEPENDENT — a PURE line shift does NOT fail it (DERIVA vs DESLIZAMIENTO)', () => {
  const src = readFileSync(TOOLS_TS, 'utf8')
  const clean = sliceZoneByMarkers(src)
  assert.ok(clean !== null, 'the zone slices on the current source')

  // (a) RED face — a CONTENT change INSIDE the span moves the md5.
  // Mutate a token guaranteed to live INSIDE the span (count over the whole file
  // is 1 ⇒ its single occurrence is within the slice), so the probe cannot
  // accidentally land outside the zone and produce a false GREEN.
  const counts = {}
  for (const t of src.match(/[A-Za-z_]{6,}/g) ?? []) counts[t] = (counts[t] ?? 0) + 1
  const inner = src.slice(src.indexOf(BANNER), src.indexOf(CLOSE)).match(/[A-Za-z_]{6,}/g) ?? []
  const uniqueInside = [...new Set(inner)].filter((t) => counts[t] === 1)
  assert.ok(uniqueInside.length > 0, 'at least one token is unique to the span (the in-span mutation probe is well-founded)')
  const token = uniqueInside[0]
  const drifted = src.replace(token, token + 'X')
  assert.notEqual(drifted, src, 'the in-span mutation actually applied')
  const driftedZone = sliceZoneByMarkers(drifted)
  assert.notEqual(md5(driftedZone), FROZEN_MD5,
    `a CONTENT drift inside the span (token "${token}") moves the zone md5 ⇒ the lock is RED on real deriva`)

  // (b) GREEN face — the 4fb3af0 class: +33 lines ABOVE the banner, content untouched.
  const padCount = 33
  const pad = Array(padCount).fill('// pad-line-outside-the-span').join('\n') + '\n'
  const bannerIdx = src.indexOf(BANNER)
  const slid = src.slice(0, bannerIdx) + pad + src.slice(bannerIdx)
  assert.equal(slid.split('\n').length, src.split('\n').length + padCount,
    `the slide adds exactly ${padCount} lines (the measured 4fb3af0 net delta)`)
  const slidZone = sliceZoneByMarkers(slid)
  assert.equal(md5(slidZone), FROZEN_MD5,
    'a PURE offset shift leaves the zone md5 intact ⇒ the lock is GREEN on deslizamiento (it does NOT false-alarm on the line-number churn that made the prose cite false)')
  // ... and the LINE NUMBERS really did move, which is precisely why they are not pinned here.
  assert.notEqual(lineOf(slid, slid.indexOf(BANNER)), lineOf(src, src.indexOf(BANNER)),
    'the shifted window really lands on different line numbers (the deriva/deslizamiento distinction is non-vacuous)')
})

test('cut4-zone-lock: the CUT-4 sentinels bracket the in-span surfaces the risk register names (the dept_head_rotate body where fb-190/fb-735/fb-737 lived) — a sentinel that stopped bracketing them fails here first', () => {
  // SCOPE NOTE: this test deliberately reads tools.ts ONLY. It must NOT read
  // .dsh/skills/departments-workflow/SKILL.md to police the prose cite: that path
  // is gitignored (the native fs tools skip it) and is path-blocked in a worker's
  // execution scope, so a dependency on it would make this lock fail for a reason
  // unrelated to the zone — the one thing a freeze lock must never do. The prose
  // cite is aligned by the SKILL.md patch in this lane's report instead.
  const src = readFileSync(TOOLS_TS, 'utf8')
  const first = src.indexOf(BANNER)
  const last = src.indexOf(CLOSE)
  assert.ok(first !== -1 && last !== -1 && last > first, 'the sentinels resolve and are ordered')

  // The span is non-trivial (it carries the messaging-bus tool definitions).
  const zoneLines = src.slice(first, last).split('\n').length
  assert.ok(zoneLines > 1000, `the CUT-4 span is a large body of tool definitions (${zoneLines} lines) — the lock guards real surface`)

  // fb-190 / fb-735 / fb-737 lived in the dept_head_rotate body: it must sit INSIDE.
  let insideRotate = false
  for (let from = 0; ; ) {
    const i = src.indexOf('dept_head_rotate', from)
    if (i === -1) break
    if (i > first && i < last) insideRotate = true
    from = i + 1
  }
  assert.ok(insideRotate, 'the dept_head_rotate body sits INSIDE the frozen span (the fb-190/fb-735/fb-737 surface the risk register flags)')

  // The whole tracked file must still contain the banner exactly once: a SECOND
  // sentinel (e.g. a duplicated banner from a bad merge) would make indexOf pick
  // an arbitrary one and silently mis-scope the lock.
  assert.equal(src.split(BANNER).length - 1, 1, 'the CUT-4 banner appears EXACTLY ONCE (no duplicate sentinel can mis-scope the slice)')
  assert.equal(src.split(CLOSE).length - 1, 1, 'the CUT-4 close sentinel appears EXACTLY ONCE (no duplicate sentinel can mis-scope the slice)')
})
