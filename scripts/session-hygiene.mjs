#!/usr/bin/env node
/**
 * session-hygiene.mjs — reusable dead-session hygiene for a DSH state home.
 *
 * Purpose (ROADMAP late-9 debt "higiene sesiones muertas m-162", LOW): a safe,
 * repeatable vehicle for the dec4 owner policy ("NO borrar, COMPRIMIR" — keep
 * the FULL history, compress the cold tier, decompress on demand, no
 * destructive GC) plus a read-only census of dead sessions and orphaned
 * atomic-write scratch files.
 *
 * DEC4 ARCHIVE POLICY implemented here
 *   - hot  = the newest N rotation artifacts PER SESSION (default 3) stay
 *            untouched/uncompressed (fast on-demand access).
 *   - cold = every OLDER rotation artifact of that session is compressed with
 *            zstd to `<file>.zstd`; the uncompressed original is removed ONLY
 *            with --apply. The complete history is always preserved
 *            (compressed), never deleted.
 *   - One-way: cold compression is the ONLY mutation. The "hot" tier is a
 *            no-op when the artifacts are already compressed; nothing is ever
 *            decompressed by this script.
 *
 * DEAD-SESSION census (report / m-162 metric — no deletes)
 *   A session dir under the sessions base is DEAD when BOTH hold:
 *     (1) its last recorded turn (last event `time` in the session log,
 *         falling back to file mtime) is older than --stale-days (default 14)
 *         and
 *     (2) its id is NOT referenced by a LIVE (non-retired) entry of
 *         `hosts.json` / `posts.json` in the state-dir.
 *   Dead sessions are REPORTED with their byte footprint; this script never
 *   deletes or moves session logs — sidebar-archiving dead sessions is the
 *   sanctioned one-off job (the hygiene-archive-* script family) and stays
 *   out of here.
 *
 * SAFETY
 *   - DRY-RUN by default: nothing is written, moved or deleted unless
 *     `--apply` is given (the only mutation switch).
 *   - `zstd` missing (or --zstd pointing at nothing): cold compression is
 *     REPORTED but skipped, and last-turn reads of compressed logs fall back
 *     to file mtime. Exit still 0 — the report says what was skipped.
 *   - The STABLE profile (/opt/dsh/.dsh) is out of scope: --apply refuses
 *     when any core directory resolves under /opt/dsh/.dsh (the dev home
 *     /opt/dsh/.dsh-dev is fine).
 *   - `deepartments-room-*` dirs are ROOM logs, not agent sessions — never
 *     scanned as sessions.
 *
 * LAYOUT UNDERSTOOD (mirrors the plugin's on-disk model)
 *   <state-home>/sessions/<workspace>/<session-id>/session.jsonl[.zstd]
 *   <state-home>/archive/session-<id>-pre-(rotation|cleanup)-<stamp>.jsonl[.zstd]
 *   <state-home>/storages/*.tmp                       (atomic-write scratch)
 *   <state-dir>/hosts.json, <state-dir>/posts.json    (durable registries)
 *   state-home = dirname(sessionsBase). The Deepartments stateDir may be
 *   relocated by a deployment (e.g. the dev box: state home
 *   /opt/dsh/.dsh-dev, stateDir /.deepartments) — pass both explicitly then.
 *
 * DIRECTORY RESOLUTION (the defaults vs the dev deployment)
 *   WITHOUT --state-dir, the stateDir resolves to $DSH_HOME/.deepartments
 *   (fallback ~/.dsh/.deepartments) — the HARNESS home's Deepartments
 *   stateDir. That is NOT the dev deployment stateDir: on the dev box run with
 *   the core dirs explicit:
 *     --state-dir /.deepartments --sessions-dir /opt/dsh/.dsh-dev/sessions
 *   (verified on-disk: hosts.json/posts.json at /.deepartments, session dirs
 *   under /opt/dsh/.dsh-dev/sessions, rotation archive at
 *   /opt/dsh/.dsh-dev/archive). The STABLE profile /opt/dsh/.dsh is excluded
 *   by the guard (--apply refuses); the dev home /opt/dsh/.dsh-dev is fine
 *   (dry-run only reads it).
 *
 * BOUNDED SCAN (a dry-run against a live state home must finish, not hang)
 *   The census is bounded: --scan-limit (default 2000) caps how many
 *   unreferenced candidates the last-turn scan processes; --max-scan-ms
 *   (default 30000) is a global soft deadline after which the census stops and
 *   the report completes with what was scanned; --tail-timeout-ms (default
 *   4000) is a per-file zstd tail timeout (on expiry the session last turn is
 *   reported as "unknown-last-turn (timeout)" and the mtime fallback covers);
 *   --scan-concurrency (default 8) is the in-process promise pool for zstd
 *   tail reads (same thread, no worker_threads, no new deps). Truncation
 *   (limit or deadline) is always WARNED and reported. Progress lines are
 *   written to stderr ("scanned i/N (k dead so far)") so the run never looks
 *   hung; --no-progress silences them. readZstdTail streams and keeps ONLY the
 *   last 256 KiB of decompressed output in memory (never the whole log);
 *   because zstd solid frames cannot be seeked, the child must decompress the
 *   whole stream to REACH the tail — the per-file TIMEOUT is what bounds that
 *   time.
 *
 * USAGE
 *   node scripts/session-hygiene.mjs [options]
 *
 *   --state-dir <dir>      Deepartments state dir (hosts.json/posts.json).
 *                          Default: $DSH_HOME/.deepartments, else ~/.dsh/.deepartments.
 *   --sessions-dir <dir>   Sessions base (the dir holding workspace dirs).
 *                          Default: <state-dir>/../sessions (plugin fallback).
 *   --archive-dir <dir>    Rotation archive dir. Default: <sessions-base>/../archive.
 *   --state-home <dir>     State home (tmp scan base). Default: <sessions-base>/..
 *   --tmp-dir <dir>        *.tmp scan dir. Default: <state-home>/storages.
 *   --stale-days <n>       Dead-session staleness window in days (default 14).
 *   --hot-rotations <n>    dec4 hot tier: newest N rotation artifacts per
 *                          session stay untouched (default 3).
 *   --tmp                  ALSO scan *.tmp orphans (default: skipped).
 *   --tmp-stale-days <n>   A *.tmp older than N days = orphan ("older than one
 *                          boot cycle"; default 1).
 *   --zstd <path>          zstd binary (default: `zstd` via PATH).
 *   --now <epoch-ms>       Clock override for tests (default: Date.now()).
 *   --apply                EXECUTE mutations (compress cold + remove originals,
 *                          delete orphan *.tmp). WITHOUT it: dry-run only.
 *   --help                 This usage text.
 *
 * EXIT: 0 = ran (including "nothing to do" / skipped due to missing zstd);
 * 1 = usage error; 2 = real error (missing explicit core dir, malformed
 * registry, apply-time compression failure). The report is human-legible on
 * stdout; warnings on stderr.
 */
import { spawn, spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, openSync, readSync, closeSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const DAY_MS = 86400e3;
const STABLE_PREFIX = "/opt/dsh/.dsh";
const ROTATION_RE = /^session-(.+?)-pre-(?:rotation|cleanup)-\d{8}-\d{6}\.jsonl(\.zstd)?$/;
const SESSION_LOG_NAMES = ["session.jsonl.zstd", "session.jsonl"];

// ---------------------------------------------------------------------------
// tiny helpers
// ---------------------------------------------------------------------------

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function usage(stream = process.stdout) {
  const text = `Usage: node scripts/session-hygiene.mjs [options]

  --state-dir <dir>      Deepartments state dir (hosts.json/posts.json).
                        Default: $DSH_HOME/.deepartments, else ~/.dsh/.deepartments.
  --sessions-dir <dir>   Sessions base. Default: <state-dir>/../sessions.
  --archive-dir <dir>    Rotation archive dir. Default: <sessions-base>/../archive.
  --state-home <dir>     State home (tmp scan base). Default: <sessions-base>/..
  --tmp-dir <dir>        *.tmp scan dir. Default: <state-home>/storages.
  --stale-days <n>       Dead-session staleness window in days (default 14).
  --hot-rotations <n>    dec4 hot tier per session, newest first (default 3).
  --tmp                  Also scan *.tmp orphans (default: skipped).
  --tmp-stale-days <n>   *.tmp older than N days = orphan (default 1).
  --zstd <path>          zstd binary (default: \`zstd\` via PATH).
  --now <epoch-ms>       Clock override for tests.
  --scan-limit <n>       Census cap: max unreferenced session candidates the
                        last-turn scan processes (default 2000; when hit the
                        census is truncated — warned and reported).
  --max-scan-ms <n>      Census soft deadline, ms (default 30000: stop early,
                        complete the report with what was scanned).
  --tail-timeout-ms <n>  Per-file zstd tail read timeout, ms (default 4000;
                        timeout → "unknown-last-turn (timeout)" + mtime).
  --scan-concurrency <n> In-process promise pool for zstd tail reads
                        (default 8; no worker threads).
  --no-progress          Silence the stderr progress lines.
  --apply                EXECUTE mutations. WITHOUT it: dry-run only.
  --help                 This text.

Policy (dec4): hot = newest N rotation artifacts per session stay untouched;
cold = older ones are zstd-compressed to <file>.zstd and the original is
removed ONLY with --apply. No destructive GC: the full history is preserved
compressed. Default run is a dry-run that writes nothing.`;
  stream.write(`${text}\n`);
}

function parseArgs(argv) {
  const opts = {
    stateDir: process.env.DSH_HOME ? join(process.env.DSH_HOME, ".deepartments") : join(homedir(), ".dsh", ".deepartments"),
    sessionsDir: null, archiveDir: null, stateHome: null, tmpDir: null,
    staleDays: 14, hotRotations: 3, tmp: false, tmpStaleDays: 1,
    scanLimit: 2000, maxScanMs: 30000, tailTimeoutMs: 4000, scanConcurrency: 8,
    noProgress: false,
    zstd: "zstd", now: Date.now(), apply: false, help: false,
  };
  const readInt = (name, raw, min = 1) => {
    if (!/^\d+$/.test(raw)) throw new Error(`--${name} expects a positive integer, got "${raw}"`);
    const n = Number(raw);
    if (n < min) throw new Error(`--${name} must be >= ${min}`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`--${arg.replace(/^--/, "")} requires a value`);
      return argv[i];
    };
    switch (arg) {
      case "--help": opts.help = true; break;
      case "--apply": opts.apply = true; break;
      case "--tmp": opts.tmp = true; break;
      case "--state-dir": opts.stateDir = resolve(next()); break;
      case "--sessions-dir": opts.sessionsDir = resolve(next()); break;
      case "--archive-dir": opts.archiveDir = resolve(next()); break;
      case "--state-home": opts.stateHome = resolve(next()); break;
      case "--tmp-dir": opts.tmpDir = resolve(next()); break;
      case "--stale-days": opts.staleDays = readInt("stale-days", next()); break;
      case "--hot-rotations": opts.hotRotations = readInt("hot-rotations", next()); break;
      case "--tmp-stale-days": opts.tmpStaleDays = readInt("tmp-stale-days", next()); break;
      case "--scan-limit": opts.scanLimit = readInt("scan-limit", next()); break;
      case "--max-scan-ms": opts.maxScanMs = readInt("max-scan-ms", next()); break;
      case "--tail-timeout-ms": opts.tailTimeoutMs = readInt("tail-timeout-ms", next()); break;
      case "--scan-concurrency": opts.scanConcurrency = readInt("scan-concurrency", next()); break;
      case "--no-progress": opts.noProgress = true; break;
      case "--zstd": opts.zstd = next(); break;
      case "--now": opts.now = readInt("now", next(), 0); break;
      default: throw new Error(`unknown option "${arg}"`);
    }
  }
  opts.sessionsDir ??= resolve(opts.stateDir, "..", "sessions");
  opts.stateHome ??= resolve(opts.sessionsDir, "..");
  opts.archiveDir ??= join(opts.stateHome, "archive");
  opts.tmpDir ??= join(opts.stateHome, "storages");
  return opts;
}

function isStablePath(p) {
  return p === STABLE_PREFIX || p.startsWith(`${STABLE_PREFIX}/`);
}

function zstdAvailable(bin) {
  if (!bin) return false;
  try {
    return spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// last-turn detection
// ---------------------------------------------------------------------------

/**
 * Read ONLY the tail of a zstd (possibly concatenated-frame) file by streaming
 * the decompressed output and keeping the last `keep` bytes. Resolves with the
 * last non-empty line (may span the keep window → caller retries with a bigger
 * window before falling back to mtime). Resolves on BOTH 'error' and 'close'
 * (spawn failure never hangs the caller). The child is SIGKILLed after
 * `timeoutMs`; the promise then resolves with { failReason: "timeout",
 * timedOut: true } so the caller falls back to mtime. Memory stays bounded to
 * the keep window; the zstd child must decompress the whole stream to REACH
 * the tail (solid frames are not seekable) — the timeout bounds that time.
 */
function readZstdTail(bin, file, keep = 262144, timeoutMs = 4000) {
  return new Promise((done) => {
    const child = spawn(bin, ["-dcq", "--", file], { stdio: ["ignore", "pipe", "inherit"] });
    let buf = Buffer.alloc(0);
    let failReason = null;
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      failReason = "timeout";
      child.kill("SIGKILL");
      child.stdout.destroy(); // force the pipe closed so the timeout is authoritative
    }, timeoutMs);
    const settle = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const lines = buf.toString("utf8").split("\n").filter((l) => l.trim() !== "");
      done({ lastLine: lines.length > 0 ? lines[lines.length - 1] : null, failReason, timedOut });
    };
    child.stdout.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length > keep * 2) buf = buf.subarray(buf.length - keep);
    });
    child.on("error", (err) => { if (!timedOut) failReason = `zstd: ${err?.message ?? err}`; settle(); });
    child.on("close", (code) => {
      if (!timedOut && failReason === null && code !== 0) failReason = `zstd exit ${code}`;
      settle();
    });
  });
}

/** Last line of a plain (uncompressed) file — reads only the file tail. */
function readPlainTail(file, keep = 262144) {
  const fd = openSync(file, "r");
  try {
    const size = statSync(file).size;
    const start = Math.max(0, size - keep);
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString("utf8").split("\n").filter((l) => l.trim() !== "");
    return lines.length > 0 ? lines[lines.length - 1] : null;
  } finally {
    closeSync(fd);
  }
}

/** Last-turn epoch-ms of a session log: the last row's `time` (fallbacks:
 * `.ts`, `.timestamp`), else file mtime. Never throws. On a zstd tail read
 * timeout the source is "unknown-last-turn (timeout)" and mtime covers. */
async function lastTurnMs(file, plain, bin, timeoutMs = 4000) {
  const mtime = statSync(file).mtimeMs;
  const parseRow = (row) => {
    if (!row) return null;
    try {
      const obj = JSON.parse(row);
      const t = obj?.time ?? obj?.ts ?? obj?.timestamp;
      return typeof t === "number" && Number.isFinite(t) ? t : null;
    } catch {
      return null;
    }
  };
  if (plain) {
    const t = parseRow(readPlainTail(file));
    return t === null ? { ms: mtime, source: "mtime" } : { ms: t, source: "log" };
  }
  for (const keep of [262144, 4 * 262144]) {
    const { lastLine, failReason, timedOut } = await readZstdTail(bin, file, keep, timeoutMs);
    if (failReason !== null) {
      return timedOut
        ? { ms: mtime, source: "unknown-last-turn (timeout)" }
        : { ms: mtime, source: `mtime (${failReason})` };
    }
    const t = parseRow(lastLine);
    if (t !== null) return { ms: t, source: "log" };
  }
  return { ms: mtime, source: "mtime (unparseable log tail)" };
}

// ---------------------------------------------------------------------------
// scans
// ---------------------------------------------------------------------------

/** Live (non-retired) session ids from hosts.json/posts.json. Absent file →
 * empty set (noted). Malformed file → throws (real error: corrupt registry). */
function readLiveSessionIds(stateDir) {
  const live = new Set();
  const notes = [];
  for (const name of ["hosts.json", "posts.json"]) {
    const file = join(stateDir, name);
    if (!existsSync(file)) { notes.push(`${name}: absent → empty live set`); continue; }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(file, "utf8"));
    } catch (err) {
      throw new Error(`${file}: unreadable/malformed JSON (${err.message})`);
    }
    let entries = 0;
    let liveCount = 0;
    for (const [key, entry] of Object.entries(parsed)) {
      if (key === "schemaVersion" || typeof entry !== "object" || entry === null) continue;
      entries += 1;
      if (entry.retired !== true && typeof entry.sessionId === "string" && entry.sessionId !== "") {
        live.add(entry.sessionId);
        liveCount += 1;
      }
    }
    notes.push(`${name}: ${entries} entries, ${liveCount} live`);
  }
  return { live, notes };
}

/**
 * Collect session dirs under the sessions base: each workspace subdir, then
 * each child dir that directly holds session.jsonl[.zstd]. Deepartments rooms
 * (`deepartments-room-*`) are excluded by design.
 */
function collectSessions(sessionsDir) {
  const found = [];
  for (const wsName of readdirSync(sessionsDir)) {
    if (wsName.startsWith(".")) continue;
    const wsPath = join(sessionsDir, wsName);
    let st;
    try { st = statSync(wsPath); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const childName of readdirSync(wsPath)) {
      if (childName.startsWith("deepartments-room-")) continue;
      const childPath = join(wsPath, childName);
      let cst;
      try { cst = statSync(childPath); } catch { continue; }
      if (!cst.isDirectory()) continue;
      let logFile = null;
      let plain = false;
      for (const nm of SESSION_LOG_NAMES) {
        const p = join(childPath, nm);
        if (existsSync(p)) { logFile = p; plain = nm === "session.jsonl"; break; }
      }
      if (logFile !== null) found.push({ dir: childPath, id: childName, logFile, plain });
    }
  }
  found.sort((a, b) => a.id.localeCompare(b.id));
  return found;
}

/** dec4 archive scan: group rotation artifacts per session, newest-first by
 * the embedded stamp; the newest N per session are HOT, the rest COLD. */
function scanRotations(archiveDir, hotN) {
  if (!existsSync(archiveDir)) return { exists: false, groups: [], rotations: 0 };
  const groups = new Map();
  for (const name of readdirSync(archiveDir)) {
    const m = ROTATION_RE.exec(name);
    if (!m) continue;
    const p = join(archiveDir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    const sessionId = m[1];
    const stamp = /pre-(?:rotation|cleanup)-(\d{8}-\d{6})/.exec(name)?.[1] ?? name; // sort key: embedded stamp
    const row = { name, file: p, sessionId, stamp, compressed: m[2] === ".zstd", bytes: st.size };
    if (!groups.has(sessionId)) groups.set(sessionId, []);
    groups.get(sessionId).push(row);
  }
  const out = [];
  let rotations = 0;
  for (const [sessionId, rows] of groups) {
    rows.sort((a, b) => (a.stamp < b.stamp ? 1 : a.stamp > b.stamp ? -1 : 0)); // stamp desc (newest first)
    rows.forEach((row, i) => { row.tier = i < hotN ? "hot" : "cold"; });
    rotations += rows.length;
    out.push({ sessionId, rows });
  }
  out.sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return { exists: true, groups: out, rotations };
}

function scanTmpFiles(tmpDir) {
  if (!existsSync(tmpDir)) return { exists: false, files: [] };
  const files = [];
  for (const name of readdirSync(tmpDir)) {
    if (!name.endsWith(".tmp")) continue;
    const p = join(tmpDir, name);
    let st;
    try { st = statSync(p); } catch { continue; }
    if (!st.isFile()) continue;
    files.push({ name, file: p, bytes: st.size, mtimeMs: st.mtimeMs });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return { exists: true, files };
}

/** stderr progress ("scanned i/N (k dead so far)"), throttled, TTY-aware. */
function makeProgress(opts, totalTasks) {
  if (opts.noProgress || totalTasks === 0) return { step() {}, finish() {} };
  const tty = Boolean(process.stderr.isTTY);
  let doneCount = 0;
  let deadSoFar = 0;
  let lastAt = 0;
  const step = (isDead) => {
    doneCount += 1;
    if (isDead) deadSoFar += 1;
    if (doneCount >= totalTasks || Date.now() - lastAt >= 100) {
      lastAt = Date.now();
      const line = `[session-hygiene] scanned ${doneCount}/${totalTasks} (${deadSoFar} dead so far)`;
      process.stderr.write(tty ? `\r${line}\x1b[K` : `${line}\n`);
    }
  };
  const finish = () => {
    if (tty && doneCount > 0) process.stderr.write("\n");
  };
  return { step, finish };
}

/**
 * Bounded last-turn census over unreferenced sessions: in-process promise pool
 * of --scan-concurrency, candidate cap of --scan-limit, per-file
 * --tail-timeout-ms (via lastTurnMs), global soft deadline --max-scan-ms,
 * stderr progress. Deterministic aggregate regardless of pool interleaving
 * (DEAD rows are re-sorted by the caller). Never throws for per-session
 * failures (lastTurnMs always resolves).
 */
async function censusLastTurns(sessions, liveIds, opts) {
  const cut = opts.now - opts.staleDays * DAY_MS;
  let referenced = 0;
  const candidates = [];
  for (const s of sessions) {
    if (liveIds.has(s.id)) { referenced += 1; continue; }
    candidates.push(s);
  }
  const toScan = candidates.slice(0, opts.scanLimit);
  let notScanned = candidates.length - toScan.length; // beyond the limit
  let truncated = notScanned > 0
    ? `--scan-limit ${opts.scanLimit} hit (${notScanned} unreferenced candidate(s) beyond the limit)`
    : null;
  const start = Date.now();
  const progress = makeProgress(opts, toScan.length);
  let fresh = 0;
  const dead = [];
  let scanned = 0;
  let stop = false;
  let next = 0;
  const runOne = async (s) => {
    const { ms, source } = await lastTurnMs(s.logFile, s.plain, opts.zstd, opts.tailTimeoutMs);
    scanned += 1;
    const isDead = ms < cut;
    if (isDead) dead.push({ ...s, lastMs: ms, source, bytes: statSync(s.logFile).size });
    else fresh += 1;
    progress.step(isDead);
    if (Date.now() - start >= opts.maxScanMs && !stop) {
      stop = true;
      truncated = truncated === null
        ? `--max-scan-ms ${opts.maxScanMs} soft deadline hit while scanning`
        : `${truncated}; --max-scan-ms ${opts.maxScanMs} soft deadline hit while scanning`;
    }
  };
  const workers = [];
  for (let w = 0; w < opts.scanConcurrency && w < toScan.length; w += 1) {
    workers.push((async () => {
      while (!stop) {
        const i = next;
        next += 1;
        if (i >= toScan.length) break;
        await runOne(toScan[i]);
      }
    })());
  }
  await Promise.all(workers);
  progress.finish();
  notScanned = candidates.length - scanned;
  return { referenced, candidates: candidates.length, scanned, notScanned, fresh, dead, truncated };
}

// ---------------------------------------------------------------------------
// mutations (ONLY invoked under --apply)
// ---------------------------------------------------------------------------

/** Compress one cold artifact: write <file>.zstd, verify, remove the original. */
function applyCompress(bin, row) {
  const out = `${row.file}.zstd`;
  const res = spawnSync(bin, ["-q", "-f", "-c", "--", row.file], { maxBuffer: 512 * 1024 * 1024 });
  if (res.status !== 0) {
    const why = String(res.stderr ?? "").slice(0, 200).trim();
    return { ok: false, reason: `zstd exit ${res.status ?? "?"}${why ? `: ${why}` : ""}` };
  }
  if (res.stdout.length === 0) return { ok: false, reason: "zstd produced empty output" };
  writeFileSync(out, res.stdout);
  // verify the artifact decodes BEFORE removing the original (no data loss on a bad write)
  const check = spawnSync(bin, ["-t", "--", out], { stdio: "ignore" });
  if (check.status !== 0) {
    unlinkSync(out); // never leave a corrupt artifact behind
    return { ok: false, reason: `verification of ${out} failed` };
  }
  unlinkSync(row.file);
  return { ok: true, oldBytes: row.bytes, newBytes: res.stdout.length };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`[session-hygiene] ${err.message}\n`);
    usage(process.stderr);
    process.exit(1);
  }
  if (opts.help) { usage(); process.exit(0); }

  const out = { mode: opts.apply ? "apply" : "dry-run" };
  const warnings = [];
  let hadError = false;

  // Stable-profile guard (--apply only; dry-run may still LOOK at dev state).
  const coreDirs = [opts.stateDir, opts.sessionsDir, opts.archiveDir, opts.stateHome, opts.tmpDir];
  if (opts.apply && coreDirs.some((d) => isStablePath(d))) {
    process.stderr.write(
      `[session-hygiene] REFUSED: --apply targets the stable profile (/opt/dsh/.dsh).\n` +
      `The STABLE instance is out of scope — point the core dirs at a dev/test state home.\n`
    );
    process.exit(2);
  }

  const report = [];
  const say = (s = "") => report.push(s);

  say(`[session-hygiene] ${out.mode.toUpperCase()} — writable mutations: ${opts.apply ? "YES" : "NO (dry-run)"}`);
  say(`  state-dir     ${opts.stateDir}`);
  say(`  sessions-dir  ${opts.sessionsDir}`);
  say(`  archive-dir   ${opts.archiveDir}`);
  say(`  state-home    ${opts.stateHome}`);
  say(`  tmp-dir       ${opts.tmpDir}`);
  say(`  stale-days    ${opts.staleDays}   hot-rotations ${opts.hotRotations}   tmp-stale-days ${opts.tmpStaleDays}`);
  say(`  scan bounds   limit ${opts.scanLimit}  concurrency ${opts.scanConcurrency}  tail-timeout ${opts.tailTimeoutMs}ms  max-scan ${opts.maxScanMs}ms  progress ${opts.noProgress ? "off" : "stderr"}`);
  const zstdOk = zstdAvailable(opts.zstd);
  say(`  zstd          ${opts.zstd} ${zstdOk ? "available" : "NOT available (compression skipped; mtime fallback for log tails)"}`);
  say("");

  // --- (1) live registries --------------------------------------------------
  let liveIds;
  try {
    liveIds = readLiveSessionIds(opts.stateDir);
  } catch (err) {
    process.stderr.write(`[session-hygiene] ${err.message}\n`);
    process.exit(2);
  }
  for (const n of liveIds.notes) say(`  registry: ${n}`);
  say(`  registry: live session ids referenced by hosts.json/posts.json: ${liveIds.live.size}`);

  // --- (2) session census ----------------------------------------------------
  if (!existsSync(opts.sessionsDir)) {
    process.stderr.write(
      `[session-hygiene] ERROR: sessions base ${opts.sessionsDir} does not exist.\n` +
      `Set --state-dir (or DSH_HOME) and/or --sessions-dir (dev box: --state-dir /.deepartments ` +
      `--sessions-dir /opt/dsh/.dsh-dev/sessions).\n`
    );
    process.exit(2);
  }
  const sessions = collectSessions(opts.sessionsDir);
  say("");
  say(`SESSIONS (base ${opts.sessionsDir})`);
  const census = await censusLastTurns(sessions, liveIds.live, opts);
  const dead = census.dead.sort((a, b) => a.lastMs - b.lastMs || a.id.localeCompare(b.id));
  const deadBytes = dead.reduce((acc, d) => acc + d.bytes, 0);
  say(`  total session dirs: ${sessions.length}`);
  say(`    referenced (live registry): ${census.referenced}`);
  say(`    unreferenced candidates:    ${census.candidates}  (last-turn scanned: ${census.scanned}${census.notScanned > 0 ? `, ${census.notScanned} NOT scanned` : ""})`);
  say(`    fresh (recent turn):        ${census.fresh}`);
  say(`    DEAD (stale + unreferenced): ${dead.length}  (log bytes ${fmtBytes(deadBytes)} — reported only, never deleted by this script)`);
  if (census.truncated !== null && census.notScanned > 0) {
    warnings.push(`census truncated (${census.truncated}): ${census.notScanned} unreferenced session(s) NOT scanned — dead/fresh counts may be understated; raise --scan-limit / --max-scan-ms for a full census.`);
    say(`    !! census TRUNCATED (${census.truncated}) — ${census.notScanned} unreferenced session(s) NOT scanned`);
  }
  for (const d of dead) {
    const ageDays = ((opts.now - d.lastMs) / DAY_MS).toFixed(1);
    say(`      - ${d.id}  last turn ${ageDays}d ago (${d.source}, ${fmtBytes(d.bytes)})`);
  }

  // --- (3) dec4 archive policy ------------------------------------------------
  let coldToCompress = 0;
  let coldBytes = 0;
  say("");
  say(`ARCHIVE dec4 (hot = newest ${opts.hotRotations} per session, cold = older → zstd)`);
  const rot = scanRotations(opts.archiveDir, opts.hotRotations);
  if (!rot.exists) {
    say(`  (no archive dir at ${opts.archiveDir} — rotation policy skipped)`);
  } else {
    say(`  rotation artifacts: ${rot.rotations} across ${rot.groups.length} session(s)`);
    let hot = 0;
    let coldAlready = 0;
    const candidates = [];
    for (const g of rot.groups) {
      for (const row of g.rows) {
        if (row.tier === "hot") { hot += 1; continue; }
        if (row.compressed) { coldAlready += 1; continue; }
        coldToCompress += 1;
        coldBytes += row.bytes;
        candidates.push(row);
      }
    }
    say(`    hot (untouched):              ${hot}`);
    say(`    cold — already compressed:    ${coldAlready}`);
    say(`    cold — to compress:           ${coldToCompress}  (raw ${fmtBytes(coldBytes)})`);
    for (const row of candidates) say(`      * ${row.name}`);
    if (coldToCompress > 0 && !zstdOk) {
      warnings.push(`zstd unavailable — ${coldToCompress} cold artifact(s) would compress with --apply, SKIPPED (report only)`);
      say(`    !! zstd unavailable: compression SKIPPED (dry report only)`);
    } else if (coldToCompress > 0) {
      say(`    --apply would: create ${coldToCompress} .zstd here, remove the originals (history preserved compressed)`);
      if (opts.apply) {
        let okCount = 0;
        let freed = 0;
        for (const row of candidates) {
          const r = applyCompress(opts.zstd, row);
          if (r.ok) {
            okCount += 1;
            freed += r.oldBytes;
            say(`      ok ${row.file} → ${row.file}.zstd (${fmtBytes(r.oldBytes)} → ${fmtBytes(r.newBytes)})`);
          } else {
            hadError = true;
            warnings.push(`${row.name}: ${r.reason}`);
            say(`      ! ${row.name}: FAILED (${r.reason})`);
          }
        }
        say(`    applied: ${okCount}/${coldToCompress} compressed, original bytes freed: ${fmtBytes(freed)}`);
      }
    }
  }

  // --- (4) tmp orphans ---------------------------------------------------------
  let orphanBytes = 0;
  let orphanCount = 0;
  if (opts.tmp) {
    say("");
    say(`TMP orphans (${opts.tmpDir}) — older than --tmp-stale-days ${opts.tmpStaleDays}d (≈ one boot cycle)`);
    const tp = scanTmpFiles(opts.tmpDir);
    if (!tp.exists) {
      say(`  (no tmp dir at ${opts.tmpDir} — scan skipped)`);
    } else {
      const orphanCut = opts.now - opts.tmpStaleDays * DAY_MS;
      const orphans = tp.files.filter((f) => f.mtimeMs < orphanCut);
      const kept = tp.files.filter((f) => f.mtimeMs >= orphanCut);
      orphanCount = orphans.length;
      orphanBytes = orphans.reduce((acc, f) => acc + f.bytes, 0);
      const keptBytes = kept.reduce((acc, f) => acc + f.bytes, 0);
      say(`  *.tmp files: ${tp.files.length} (${fmtBytes(tp.files.reduce((a, f) => a + f.bytes, 0))})`);
      say(`    orphans (> ${opts.tmpStaleDays}d old): ${orphanCount} (${fmtBytes(orphanBytes)}) — ${opts.apply ? "deleted" : "would delete with --apply"}`);
      for (const f of orphans) {
        const ageDays = ((opts.now - f.mtimeMs) / DAY_MS).toFixed(1);
        say(`      - ${f.name}  age ${ageDays}d (${fmtBytes(f.bytes)})`);
      }
      say(`    recent (kept): ${kept.length} (${fmtBytes(keptBytes)})`);
      if (opts.apply) {
        for (const f of orphans) unlinkSync(f.file);
        say(`  applied: ${orphanCount} orphan tmp file(s) removed (${fmtBytes(orphanBytes)})`);
      }
    }
  } else {
    say("");
    say(`TMP orphans: skipped (pass --tmp to scan *.tmp in ${opts.tmpDir})`);
  }

  // --- summary ------------------------------------------------------------------
  say("");
  const wouldFree = coldBytes + orphanBytes + deadBytes; // dead bytes are a REPORT metric only
  if (!opts.apply) {
    say(`SUMMARY (dry-run): 0 files changed, 0 bytes freed.`);
    say(`  --apply would: compress ${coldToCompress} cold artifact(s) (raw ${fmtBytes(coldBytes)})` +
        (orphanCount > 0 ? `; delete ${orphanCount} orphan tmp (${fmtBytes(orphanBytes)})` : "") +
        ` → raw candidate ${fmtBytes(coldBytes + orphanBytes)} freed.`);
    say(`  Dead sessions are a REPORT ONLY (${dead.length} found, ${fmtBytes(deadBytes)} of logs).`);
  } else {
    say(`SUMMARY (apply): mutations executed — see per-section applied counts above.`);
    say(`  Reported candidate footprint: ${fmtBytes(wouldFree)}.`);
  }
  if (warnings.length > 0) {
    say("");
    say("WARNINGS:");
    for (const w of warnings) say(`  - ${w}`);
  }

  process.stdout.write(`${report.join("\n")}\n`);
  process.exit(hadError ? 2 : 0);
}

main().catch((err) => {
  process.stderr.write(`[session-hygiene] FATAL: ${err?.stack ?? String(err)}\n`);
  process.exit(2);
});