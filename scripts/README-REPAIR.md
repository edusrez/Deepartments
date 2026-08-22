# README-REPAIR — fixing a mid-log seq seam in a DSH session artifact

**Script:** `scripts/repair-session-renumber.py`
**Scope:** offline repair of a DSH session artifact (`*.jsonl.zstd`) whose
tail records carry a stale seq counter after a truncation, producing a
mid-log seq seam. The cold-read scanner
(`dsh-session-persistence-jsonl` `SessionLogScanner`) rejects such a log as
"corrupt session log: seq gap in committed region" and can only read the
seed prefix (header + seq 0..3).

## When to run

- DSH service is STOPPED (maintenance window). The script rewrites the
  artifact in place with an atomic rename; never run it against a live
  session.
- You have verified (dry-run) that the seam is the ONLY problem and the
  planned renumber makes the log contiguous.

## Usage

```
python3 scripts/repair-session-renumber.py <artifact.jsonl.zstd> [--backup-dir DIR] [--dry-run] [--no-backup]
```

- `--dry-run` — print the seam line, the seam jump, the planned renumber
  range and the resulting continuity verdict. Writes nothing.
- `--backup-dir DIR` — put the pre-repair backup in `DIR` instead of next to
  the artifact.
- `--no-backup` — skip the pre-repair backup (not recommended).
- Exit codes: `0` success (already contiguous, repaired, or dry-run
  reported); `1` any failure — the artifact is left untouched and temp files
  are removed.

Default backup: `<artifact>.pre-repair-<YYYYMMDD-HHmmss>.jsonl.zstd`,
a byte-identical copy of the original taken before any rewrite.

## What it does

1. Streams the artifact through `zstd` (CLI, or the `zstandard` module when
   importable) line by line — memory-conscious even for large logs.
2. Finds the FIRST expanded event whose `seq` differs from its zero-based
   index ("the seam") and validates the file is otherwise well-formed.
3. Renumbers every seq-carrying record from the seam onward by position:
   - plain event records get `seq = running index`;
   - packed delta-chunk storage rows (`text-chunks`, `reasoning-chunks`,
     `tool-call-chunks`) get `seq0 = running index`; member k of the run is
     `seq0 + k`, exactly as the reader expands them;
   - the session header and any record without a seq pass through
     **byte-verbatim** (ids, tool-call references, headers, timestamps are
     never rewritten).
4. Re-scans the renumbered stream under the scanner's exact continuity rule
   (every expanded event: `seq == index`, starting from 0 after the header)
   before anything is committed.
5. Compresses at the zstd default level, verifies the compressed bytes
   round-trip to the verified stream, then atomically replaces the artifact.

## Output format (zstd framing)

The repaired artifact preserves the DSH storage generation encoding
(`dsh-session-persistence-jsonl`, `compressZstdFrame`):

- **Frame 1 is exactly the session header line** (re-written, terminated in
  `\n`), compressed as its own independently decodable frame. This is the
  `assertZstdHeaderFrame` invariant (`lib/index.js:741`): the first frame
  must decompress to exactly one newline-terminated line — before
  2026-08-22 the script re-compressed the whole renumbered log as ONE zstd
  frame, which failed that check on boot (dev crash-loop, ~12 h downtime).
- **Frames 2..N hold the remaining plaintext in ~512 KiB chunks**, each an
  independent zstd frame. Body frames may cut JSONL lines — the dsh reader
  stitches consecutive frames into one stream and tolerates that.
- Checksums: the `zstandard` module path uses `write_checksum` when the
  binding supports it (documented fallback otherwise); the CLI path uses
  `--check` (default-on in zstd 1.5.5; the `--checksum` spelling is not
  accepted by that binary).
- **Verification gate** (runs before the atomic replace, on the FINAL
  artifact): (a) port of `assertZstdHeaderFrame` — frame 1 is one
  newline-terminated session-header line; (b) the artifact contains ≥ 2
  frames whenever it has events (the single-frame shape is the incident
  bug); (c) the scanner's strict expanded-event continuity rule is re-run
  over the artifact's own decompressed stream. Any failure aborts with
  exit 1 and the original artifact is left untouched.

## Recommended verification after a full run

```bash
zstd -t <artifact.jsonl.zstd>                                  # integrity
zstd -d -c <artifact.jsonl.zstd> | wc -l                       # line count unchanged
zstd -d -c <artifact.jsonl.zstd | python3 -c '
import sys, json
idx = 0
for n, raw in enumerate(sys.stdin.buffer, 1):
    v = json.loads(raw)
    if n == 1:
        continue
    t = v.get("type")
    if t in ("text-chunks", "reasoning-chunks", "tool-call-chunks"):
        payload = v["data"]["texts"] if t != "tool-call-chunks" else v["data"]["args"]
        assert v["seq0"] == idx, (n, idx, v["seq0"])
        idx += len(payload)
    else:
        assert v["seq"] == idx, (n, idx, v["seq"])
        idx += 1
print("continuity OK:", idx, "expanded events")
'                                                                   # 0 gaps
cmp <original backup> <the live backup>                        # backups byte-identical
```

## Notes

- The seam jump is reported as `previous seq -> got` with the expected
  index; e.g. `previous seq 3 -> got 430449` is the signature of the
  truncation bug (seed renumbered to 0-3, appends resumed at 430449).
- Raw seq values in the tail after the seam are meaningless (they were
  resumed from a stale in-memory counter); the repair rewrites them by
  position, which always restores scanner continuity unless a truly
  unfixable record is present (a non-carrying record outside the header, or
  a malformed storage row) — in that case the script aborts without touching
  the artifact.
- Running the script again on a repaired file reports
  `already contiguous` and exits 0 without writing a backup.