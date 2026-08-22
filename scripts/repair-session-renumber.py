#!/usr/bin/env python3
"""
repair-session-renumber.py - offline repair of a DSH zstd JSONL session
artifact carrying a mid-log seq seam.

A DSH session artifact (*.jsonl.zstd) is a zstd-compressed JSONL log whose
first line is the session header record (type "session", no seq) followed by
event records. Every event record carries the session's monotonic counter
either directly (top-level "seq") or, for packed delta-chunk runs, as the
base of a storage row ("seq0"; member k of the run is seq0 + k, expanded by
the reader before the continuity check). The cold-read scanner
(dsh-session-persistence-jsonl "SessionLogScanner") requires every expanded
event's seq to equal its zero-based position in the log; the first violation
is reported as "corrupt session log: seq gap in committed region".

This script repairs a single discontinuity (the seam): it renumbers every
seq-carrying record in the tail so seqs continue contiguously from the seed
(the pre-seam region), preserving record order, ids, tool-call references,
timestamps and every other field. Records that carry no seq (session header,
and any hypothetical non-chunk record without a seq) pass through
byte-verbatim. The repair is streaming and memory-conscious: lines are read
one at a time from the decompressed stream and written to a temporary plain
JSONL, the temp is re-scanned under the scanner's exact continuity rule, then
compressed with zstd - preserving the DSH storage framing invariant (frame 1
= exactly the session header line; the body in ~512 KiB independent frames) -
to a second temp and atomically renamed over the artifact. A byte-identical
pre-repair backup is created before any rewrite (unless --no-backup).

Exit codes:
  0 success (either "already contiguous" or repaired), or a completed dry-run
  1 any failure (nothing was written; temp files are removed)

Usage:
  python3 scripts/repair-session-renumber.py <artifact.jsonl.zstd> [--backup-dir DIR] [--dry-run] [--no-backup]

Environment (codec): prefers the portable `zstandard` python module when
importable, otherwise shells out to the `zstd` CLI. At least one must be
available. The re-compressed artifact always matches the DSH writer's
encoding (dsh-session-persistence-jsonl `compressZstdFrame`): the FIRST zstd
frame is just the (re-written) session header line and every remaining
~512 KiB of plaintext is its own independently decodable, checksummed frame.
The cold-read scanner's `assertZstdHeaderFrame` (lib/index.js) requires the
first frame to decompress to exactly one newline-terminated line; body
frames may cut JSONL lines, which the scanner tolerates.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime
from typing import Any, Dict, Iterator, List, Optional, Tuple

ZSTD_SUFFIX = ".jsonl.zstd"
CHUNK_ROW_TAGS = ("text-chunks", "reasoning-chunks", "tool-call-chunks")
BACKUP_STAMP_FORMAT = "%Y%m%d-%H%M%S"
ZSTD_MAGIC = 4247762216  # 0xFD2FB528, little-endian magic of a zstd frame
ZSTD_CHUNK_PLAINTEXT = 512 * 1024  # body frames: ~512 KiB of plaintext each


class RepairError(Exception):
    """Fatal repair failure; the artifact is left untouched."""


# --------------------------------------------------------------------------
# Codec helpers: streaming decompression / compression, zstd CLI or module.
# --------------------------------------------------------------------------

def _compress_cmd() -> List[str]:
    return ["zstd"]


def decompressed_lines(path: str) -> Iterator[bytes]:
    """Yield raw JSONL lines (bytes, newline-terminated) of a zstd artifact.

    Streaming: the process never holds more than one line plus the zstd
    pipe buffer in memory. Handles multi-frame artifacts (the append writer
    emits a frame per batch) - both the CLI and the module treat a sequence
    of frames as one stream.
    """
    try:
        import zstandard  # type: ignore
    except ImportError:
        proc = subprocess.Popen(
            [_compress_cmd()[0], "-d", "-c", "--", path],
            stdout=subprocess.PIPE,
        )
        try:
            assert proc.stdout is not None
            yield from proc.stdout
        finally:
            if proc.stdout is not None:
                proc.stdout.close()
            rc = proc.wait()
            if rc != 0:
                raise RepairError(
                    f"zstd decompression failed (rc={rc}) for {path} - "
                    "the artifact is not a valid Zstandard stream"
                )
    else:
        with open(path, "rb") as fh:
            reader = zstandard.ZstdDecompressor().stream_reader(
                fh, read_across_frames=True
            )
            try:
                yield from reader
            finally:
                reader.close()


def _plaintext_frames(src: str, chunk_size: int) -> Iterator[bytes]:
    """Yield the plaintext of `src` as frame payloads for compression.

    Frame 1 is exactly the first line (the session header record, ensured
    newline-terminated); frames 2..N are `chunk_size`-sized slices of the
    remaining bytes (they may cut JSONL lines - the dsh scanner tolerates
    that). Streaming: only one frame payload is in memory at a time.
    """
    with open(src, "rb") as fin:
        header = fin.readline()
        if not header.endswith(b"\n"):
            raise RepairError(
                "session log has no header line ending in a newline - "
                "cannot build the frame-1 header frame"
            )
        if b"\n" in header[:-1]:
            raise RepairError(
                "session log header line contains an embedded newline - "
                "frame 1 would not be exactly one header line"
            )
        yield header
        while True:
            chunk = fin.read(chunk_size)
            if not chunk:
                break
            yield chunk


def _compress_frames_cli(frame_iter: Iterator[bytes], dst: str) -> None:
    """Compress each frame payload with the `zstd` CLI as an own frame.

    `--check` adds the XXH64 content checksum (default-on in zstd 1.5.5,
    matching the dsh writer's checksummed frames; the `--checksum` spelling
    is NOT accepted by the 1.5.5 binary, so `--check` is used instead). One
    subprocess per frame - the CLI has no concatenated-frame flag.
    """
    with open(dst, "wb") as fout:
        for frame in frame_iter:
            proc = subprocess.run(
                ["zstd", "-q", "-f", "--check", "-c"],
                input=frame,
                capture_output=True,
            )
            if proc.returncode != 0:
                raise RepairError(
                    f"zstd frame compression failed (rc={proc.returncode}): "
                    f"{proc.stderr.decode('utf-8', 'replace').strip()}"
                )
            fout.write(proc.stdout)


def _compress_frames_module(frame_iter: Iterator[bytes], dst: str) -> None:
    """Compress each frame payload with the `zstandard` module as an own frame."""
    try:
        import zstandard  # type: ignore
    except ImportError:
        raise RepairError("zstandard module is not importable")
    try:
        cctx = zstandard.ZstdCompressor(level=3, write_checksum=True)
    except TypeError:
        # Older bindings predate the write_checksum kwarg: compress without a
        # per-frame checksum (documented; the dsh writer emits checksums, but
        # a missing checksum frame bit is not a scanner failure).
        cctx = zstandard.ZstdCompressor(level=3)
    with open(dst, "wb") as fout:
        for frame in frame_iter:
            fout.write(cctx.compress(frame))


def compress_log_file(src: str, dst: str, chunk_size: int = ZSTD_CHUNK_PLAINTEXT) -> None:
    """Compress a plain JSONL log preserving the DSH storage framing invariant.

    Frame 1 = exactly the (re-written) session header line, newline-terminated;
    frames 2..N = the remaining plaintext in `chunk_size` chunks, each an
    independently decodable, checksummed zstd frame. `assertZstdHeaderFrame`
    in dsh-session-persistence-jsonl requires frame 1 to decompress to exactly
    one newline-terminated line; the dsh reader stitches frames together and
    tolerates body frames that cut lines.
    """
    frame_iter = _plaintext_frames(src, chunk_size)
    try:
        import zstandard  # type: ignore
    except ImportError:
        _compress_frames_cli(frame_iter, dst)
    else:
        _compress_frames_module(frame_iter, dst)


def _decompress_frame_bytes(data: bytes) -> bytes:
    """Decompress exactly one complete zstd frame (CLI fallback or module)."""
    try:
        import zstandard  # type: ignore
    except ImportError:
        proc = subprocess.run(["zstd", "-q", "-d", "-c"], input=data, capture_output=True)
        if proc.returncode != 0:
            raise RepairError(
                f"zstd frame decompression failed (rc={proc.returncode}) "
                f"for a {len(data)}-byte frame"
            )
        return proc.stdout
    else:
        return zstandard.ZstdDecompressor().decompress(data)


def scan_zstd_frame_ranges(path: str) -> List[Tuple[int, int]]:
    """Port of dsh-session-persistence-jsonl `scanZstdFrames`.

    Structurally locate every complete zstd frame in `path` (frame magic,
    descriptor, blocks, checksum) WITHOUT decompressing payloads - streaming
    via file seeks, so memory use is O(1) for arbitrarily large logs. Returns
    (start, end) byte ranges; raises RepairError on corrupt structure.
    """
    frames: List[Tuple[int, int]] = []
    fsize = os.path.getsize(path)
    offset = 0
    with open(path, "rb") as fh:
        while offset < fsize:
            start = offset
            if fsize - offset < 4:
                raise RepairError(
                    f"corrupt Zstandard session log: truncated frame header at byte {offset}"
                )
            fh.seek(offset)
            if int.from_bytes(fh.read(4), "little") != ZSTD_MAGIC:
                raise RepairError(
                    f"corrupt Zstandard session log: invalid frame magic at byte {offset}"
                )
            offset += 4
            descriptor = fh.read(1)[0]
            offset += 1
            if (descriptor & 24) != 0:
                raise RepairError(
                    f"corrupt Zstandard session log: reserved frame-header bit at byte {offset - 1}"
                )
            content_size_flag = descriptor >> 6
            single_segment = (descriptor & 32) != 0
            checksum = (descriptor & 4) != 0
            dictionary_flag = descriptor & 3
            dictionary_bytes = 4 if dictionary_flag == 3 else dictionary_flag
            content_size_bytes = (
                0 if content_size_flag == 0 else 1 << content_size_flag
            )
            if content_size_flag == 0 and single_segment:
                content_size_bytes = 1
            remaining_header_bytes = (
                (0 if single_segment else 1) + dictionary_bytes + content_size_bytes
            )
            if fsize - offset < remaining_header_bytes:
                raise RepairError(
                    f"corrupt Zstandard session log: truncated frame header at byte {offset}"
                )
            offset += remaining_header_bytes
            # Each iteration advances offset by >= 3 bytes, so a valid or
            # malformed frame always terminates (truncated input -> raise).
            for _ in range(fsize - offset):
                if fsize - offset < 3:
                    raise RepairError(
                        f"corrupt Zstandard session log: truncated block header at byte {offset}"
                    )
                fh.seek(offset)
                block_header = int.from_bytes(fh.read(3), "little")
                offset += 3
                last_block = (block_header & 1) != 0
                block_type = (block_header >> 1) & 3
                block_size = block_header >> 3
                if block_type == 3:
                    raise RepairError(
                        f"corrupt Zstandard session log: reserved block type at byte {offset - 3}"
                    )
                payload_bytes = 1 if block_type == 1 else block_size
                if fsize - offset < payload_bytes:
                    raise RepairError(
                        f"corrupt Zstandard session log: truncated block payload at byte {offset}"
                    )
                offset += payload_bytes
                if last_block:
                    break
            if checksum:
                if fsize - offset < 4:
                    raise RepairError(
                        f"corrupt Zstandard session log: truncated content checksum at byte {offset}"
                    )
                offset += 4
            frames.append((start, offset))
    return frames


def assert_first_frame_is_header(zstd_path: str) -> bytes:
    """Port of dsh-session-persistence-jsonl `assertZstdHeaderFrame`.

    The first frame must decompress to exactly one newline-terminated line
    (length > 0 and the first 0x0A is the LAST byte), and that line must parse
    to a JSON object with type == "session". Returns the raw header line.
    """
    frames = scan_zstd_frame_ranges(zstd_path)
    if not frames:
        raise RepairError(
            "corrupt Zstandard session log: no complete frames found"
        )
    start, end = frames[0]
    with open(zstd_path, "rb") as fh:
        fh.seek(start)
        plaintext = _decompress_frame_bytes(fh.read(end - start))
    if len(plaintext) == 0 or plaintext.find(b"\n") != len(plaintext) - 1:
        raise RepairError(
            "corrupt Zstandard session log: first frame is not exactly one "
            "header line (the pre-2026-08-22 single-frame output bug: the "
            "whole log was re-compressed as ONE zstd frame)"
        )
    header_line = plaintext[:-1]
    try:
        header = json.loads(header_line.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RepairError(
            f"first frame does not parse as a session header record ({exc})"
        )
    if not isinstance(header, dict) or header.get("type") != "session":
        raise RepairError(
            "first frame is not a session header record (type='session')"
        )
    return header_line


def verify_artifact_framing(zstd_path: str, expected_line_count: int) -> None:
    """Gate over the FINAL compressed artifact, run before the atomic replace.

    (a) port of `assertZstdHeaderFrame`: frame 1 == exactly one session
        header line (length > 0, first 0x0A is the last byte, type="session");
        when the log has more than one line, the artifact must contain at
        least two frames (header frame + body) - the single-frame shape is
        the incident bug;
    (b) re-run the strict expanded-event continuity scan over the FINAL
        artifact's decompressed stream (must equal the verified plaintext);
    (c) any violation raises RepairError here - the artifact is REPLACED only
        after this gate passes.
    """
    assert_first_frame_is_header(zstd_path)
    frames = scan_zstd_frame_ranges(zstd_path)
    if expected_line_count > 1 and len(frames) < 2:
        raise RepairError(
            f"corrupt Zstandard session log: artifact has {len(frames)} frame(s) "
            f"but {expected_line_count} lines - the body is not framed "
            "(single-frame output would stall the cold-read scanner)"
        )
    line_count, _ = verify_strict_lines(decompressed_lines(zstd_path))
    if line_count != expected_line_count:
        raise RepairError(
            f"final artifact re-scan lost records: {line_count} lines, "
            f"expected {expected_line_count}"
        )


def stream_sha256(path: str) -> str:
    """Streaming SHA-256 of a file (memory-conscious for huge logs)."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def verify_zstd_roundtrip(zstd_path: str, expected_sha256: str) -> None:
    """Decompress `zstd_path` and assert the bytes equal the temp we made.

    Doubles as both a zstd integrity check and a proof that the compressed
    artifact is exactly the verified renumbered stream.
    """
    h = hashlib.sha256()
    try:
        for line in decompressed_lines(zstd_path):
            h.update(line)
    except RepairError as exc:
        raise RepairError(f"integrity check failed on {zstd_path}: {exc}")
    got = h.hexdigest()
    if got != expected_sha256:
        raise RepairError(
            f"integrity check failed on {zstd_path}: decompressed bytes do not "
            f"round-trip to the verified renumbered stream"
        )


# --------------------------------------------------------------------------
# Record model: which records carry seqs, and how many expanded events each.
# --------------------------------------------------------------------------

def expand_record(value: Any) -> Tuple[int, Optional[int]]:
    """Return (expanded_event_count, base_seq) for a parsed JSONL record.

    * packed chunk rows (text-chunks / reasoning-chunks / tool-call-chunks)
      store a run of `assistant/chunk` events; member k has seq = seq0 + k,
      so the record is seq-carrying with base seq0 and count = payload size.
      A malformed row (missing/non-integer seq0) is corrupt storage - refuse.
    * every other record stores exactly one event; it is seq-carrying iff it
      has an integer top-level "seq", else non-carrying (header, seq-less).
    """
    if isinstance(value, dict) and value.get("type") in CHUNK_ROW_TAGS:
        data = value.get("data")
        if not isinstance(data, dict):
            raise RepairError(
                f"malformed {value.get('type')} storage row: data must be an object"
            )
        payload = data.get("texts") if value["type"] != "tool-call-chunks" else data.get("args")
        if not isinstance(payload, list) or not payload:
            raise RepairError(
                f"malformed {value.get('type')} storage row: payload must be a non-empty array"
            )
        seq0 = value.get("seq0")
        if not isinstance(seq0, int) or isinstance(seq0, bool):
            raise RepairError(
                f"malformed {value.get('type')} storage row: seq0 must be an integer"
            )
        return len(payload), seq0
    if isinstance(value, dict):
        seq = value.get("seq")
        if seq is not None and not isinstance(seq, int):
            raise RepairError(
                f"record with non-integer seq at top level (type={value.get('type')!r})"
            )
        return 1, seq
    return 1, None


# --------------------------------------------------------------------------
# Seam detection / continuity accounting (one streaming pass).
# --------------------------------------------------------------------------

class ScanResult:
    def __init__(self) -> None:
        self.line_count = 0
        self.event_count = 0          # total expanded events (after the header)
        self.header_type: Optional[str] = None
        self.first_seam: Optional[Tuple[int, int, int, int]] = None  # (line, expected, got, jump)
        self.raw_anomalies: List[Tuple[int, int, int, int]] = []     # (line, got, shifted, expected)
        self.seqless_lines: List[int] = []                           # non-carrying non-header lines
        self.max_seq: Optional[int] = None                           # largest raw seq in the file

    @property
    def contiguous(self) -> bool:
        return self.first_seam is None


def scan(iter_lines: Iterator[bytes]) -> ScanResult:
    """One streaming pass over the artifact, mirroring the JS scanner.

    The seam is the FIRST expanded event whose raw seq differs from its
    zero-based index. After the seam the raw seqs are meaningless garbage
    (they were resumed from a stale in-memory counter), so they are tracked
    only as diagnostics, never as a repair blocker: the repair rewrites them
    by position, which always yields strict continuity unless an unfixable
    record (a non-carrying non-header record, which the cold-read scanner
    would still reject, or a malformed storage row) is present.
    """
    res = ScanResult()
    idx = 0
    delta: Optional[int] = None
    for lineno, raw in enumerate(iter_lines, 1):
        res.line_count = lineno
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RepairError(f"line {lineno}: unparsable JSON ({exc})")
        if lineno == 1:
            if not isinstance(value, dict) or value.get("type") != "session":
                raise RepairError(
                    f"line 1 is not a session header record (type='session'); "
                    "refusing to repair a non-session artifact"
                )
            res.header_type = value.get("type")
            continue
        n, seq = expand_record(value)
        if seq is None:
            res.seqless_lines.append(lineno)
        elif delta is None:
            if seq != idx:
                res.first_seam = (lineno, idx, seq, seq - idx)
                delta = idx - seq
            res.max_seq = seq if res.max_seq is None else max(res.max_seq, seq)
        else:
            shifted = seq + delta
            if shifted != idx:
                res.raw_anomalies.append((lineno, seq, shifted, idx))
            res.max_seq = seq if res.max_seq is None else max(res.max_seq, seq)
        idx += n
        res.event_count = idx
    return res


# --------------------------------------------------------------------------
# Renumbering writer (streaming decompress -> renumbered plain JSONL).
# --------------------------------------------------------------------------

def _dumps(record: Dict[str, Any]) -> bytes:
    """Compact, JS-style JSON (no spaces, raw UTF-8), strict about NaN/Inf."""
    return json.dumps(
        record,
        separators=(",", ":"),
        ensure_ascii=False,
        allow_nan=False,
    ).encode("utf-8")


def _ensure_newline(raw: bytes) -> bytes:
    return raw if raw.endswith(b"\n") else raw + b"\n"


def renumber(artifact: str, seam_line: int, out_path: str) -> Tuple[int, int]:
    """Stream the artifact into `out_path`, renumbering the tail from the seam.

    Pre-seam lines, the header and non-carrying records pass through with
    their exact original bytes; every seq-carrying record from the seam
    onward is re-emitted with seq/seq0 rewritten to the running index.
    Returns (lines_written, events_in_tail).
    """
    idx = 0
    lines_written = 0
    with open(out_path, "wb") as out:
        for lineno, raw in enumerate(decompressed_lines(artifact), 1):
            if lineno == 1:
                # Header: verbatim, no seq bookkeeping.
                out.write(_ensure_newline(raw))
                lines_written += 1
                continue
            value = json.loads(raw.decode("utf-8"))
            n, seq = expand_record(value)
            is_row = isinstance(value, dict) and value.get("type") in CHUNK_ROW_TAGS
            if lineno < seam_line:
                out.write(_ensure_newline(raw))
            elif seq is None:
                # Non-carrying record: verbatim (the scanner-index bookkeeping
                # is unaffected; such records do not advance the counter).
                out.write(_ensure_newline(raw))
            elif is_row:
                value["seq0"] = idx
                out.write(_dumps(value) + b"\n")
            else:
                value["seq"] = idx
                out.write(_dumps(value) + b"\n")
            idx += n
            lines_written += 1
        out.flush()
        os.fsync(out.fileno())
    return lines_written, idx


def verify_strict_lines(iter_lines: Iterator[bytes]) -> Tuple[int, int]:
    """Verify an iterable of raw JSONL lines under the scanner's exact rule.

    Header first; then every expanded event's seq must equal its zero-based
    index. Any non-carrying record (other than the header) is a hard failure
    because the scanner would still reject the file. Returns
    (line_count, event_count).
    """
    event_count = 0
    line_count = 0
    for lineno, raw in enumerate(iter_lines, 1):
        line_count = lineno
        try:
            value = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RepairError(f"line {lineno}: unparsable JSON ({exc})")
        if lineno == 1:
            if not isinstance(value, dict) or value.get("type") != "session":
                raise RepairError(
                    f"line 1 is not a session header record (type='session')"
                )
            continue
        n, seq = expand_record(value)
        if not isinstance(seq, int):
            raise RepairError(
                f"line {lineno}: non-carrying record would still trip the "
                f"cold-read scanner (expected seq {event_count})"
            )
        if seq != event_count:
            raise RepairError(
                f"line {lineno}: seq gap in committed region (expected "
                f"{event_count}, got {seq})"
            )
        event_count += n
    if line_count == 0:
        raise RepairError("empty log: no session header record")
    return line_count, event_count


def verify_strict(path: str) -> Tuple[int, int]:
    """Verify a plain JSONL file under the scanner's exact continuity rule."""
    return verify_strict_lines(_plain_lines(path))


def _plain_lines(path: str) -> Iterator[bytes]:
    with open(path, "rb") as fh:
        for raw in fh:
            yield raw


# --------------------------------------------------------------------------
# Backup + atomic replace.
# --------------------------------------------------------------------------

def backup_path_for(artifact: str, backup_dir: Optional[str]) -> str:
    stamp = datetime.now().strftime(BACKUP_STAMP_FORMAT)
    name = os.path.basename(artifact) + f".pre-repair-{stamp}.jsonl.zstd"
    if backup_dir is not None:
        return os.path.join(backup_dir, name)
    return os.path.join(os.path.dirname(os.path.abspath(artifact)), name)


def make_backup(artifact: str, backup_dir: Optional[str]) -> str:
    """Byte-identical copy of the ORIGINAL artifact before any rewrite."""
    dst = backup_path_for(artifact, backup_dir)
    if os.path.exists(dst):
        raise RepairError(f"backup path already exists: {dst} - refusing to overwrite")
    parent = os.path.dirname(dst)
    if parent:
        os.makedirs(parent, exist_ok=True)
    shutil.copyfile(artifact, dst)
    src_sha = stream_sha256(artifact)
    dst_sha = stream_sha256(dst)
    if src_sha != dst_sha:
        raise RepairError(f"backup {dst} is not byte-identical to {artifact} - aborted")
    return dst


# --------------------------------------------------------------------------
# Reporting helpers.
# --------------------------------------------------------------------------

def plan_line(res: ScanResult) -> str:
    assert res.first_seam is not None
    seam_line, expected, got, jump = res.first_seam
    tail_start_event = expected
    last_event = res.event_count - 1
    max_seq = res.max_seq if res.max_seq is not None else got
    return (
        f"seam line: {seam_line}\n"
        f"seam jump: previous seq {expected - 1} -> got {got} "
        f"(expected index {expected}, jump {jump:+d})\n"
        f"planned renumber range: lines {seam_line}..{res.line_count} "
        f"(events {tail_start_event}..{last_event}; raw seqs {got}..{max_seq} "
        f"-> {tail_start_event}..{last_event})\n"
    )


def verdict_line(res: ScanResult) -> str:
    if res.first_seam is None:
        return "continuity verdict: ALREADY CONTIGUOUS - no seam found"
    if res.seqless_lines:
        return (
            f"continuity verdict: NOT REPAIRABLE - {len(res.seqless_lines)} "
            f"non-carrying record(s) outside the header (first at line "
            f"{res.seqless_lines[0]}) would still trip the cold-read scanner"
        )
    return (
        f"continuity verdict: CONTIGUOUS after planned renumber "
        f"({res.event_count} expanded events, seed + tail from 0)"
    )


# --------------------------------------------------------------------------
# Main flow.
# --------------------------------------------------------------------------

def run(args: argparse.Namespace) -> int:
    artifact = args.artifact
    if not artifact.endswith(ZSTD_SUFFIX):
        raise RepairError(
            f"expected a {ZSTD_SUFFIX} artifact, got {artifact!r}"
        )
    if not os.path.isfile(artifact):
        raise RepairError(f"artifact not found: {artifact}")
    if os.path.getsize(artifact) == 0:
        raise RepairError(f"artifact is empty: {artifact}")

    res = scan(decompressed_lines(artifact))

    if res.first_seam is None:
        print("already contiguous: no seq seam found; nothing to repair")
        if not args.dry_run:
            print(f"  ({res.line_count} lines, {res.event_count} expanded events; no backup written)")
        return 0

    print(plan_line(res))
    print(verdict_line(res))
    if res.raw_anomalies:
        print(
            f"note: {len(res.raw_anomalies)} raw-seq anomal(ies) beyond the "
            f"seam (first at line {res.raw_anomalies[0][0]}); the repair "
            f"rewrites seqs by position, which resolves them"
        )
    if res.seqless_lines:
        print(
            f"note: {len(res.seqless_lines)} non-carrying record(s) would be "
            f"passed through verbatim (first at line {res.seqless_lines[0]})"
        )

    if args.dry_run:
        print("dry run: no files were written")
        return 0 if not res.seqless_lines else 1

    # 1) pre-repair backup (byte-identical copy of the original).
    backup = None
    if not args.no_backup:
        backup = make_backup(artifact, args.backup_dir)
        print(f"backup: {backup}")

    # 2) stream + renumber into a same-directory temp (atomic-replace ready).
    tmp_plain, tmp_zstd = _temp_path(artifact), _temp_path(artifact, ".zstd")
    written = None
    try:
        lines_written, _ = renumber(artifact, res.first_seam[0], tmp_plain)
        # 3) verify the actual renumbered stream under the scanner rule.
        line_count, event_count = verify_strict(tmp_plain)
        if line_count != res.line_count or event_count != res.event_count:
            raise RepairError(
                f"renumbered stream lost records: {line_count}/{res.line_count} "
                f"lines, {event_count}/{res.event_count} events"
            )
        # 4) compress (framing: frame 1 = header line alone, body in
        #    ~512 KiB frames) + integrity round-trip.
        compress_log_file(tmp_plain, tmp_zstd)
        verify_zstd_roundtrip(tmp_zstd, stream_sha256(tmp_plain))
        # 5) gate over the FINAL artifact: assertZstdHeaderFrame port (frame 1
        #    == exactly one session header line, multi-frame body) + strict
        #    continuity re-scan on the artifact's own decompressed stream.
        #    Any failure aborts HERE - os.replace never publishes unverified.
        verify_artifact_framing(tmp_zstd, line_count)
        # 6) atomic replacement.
        os.replace(tmp_zstd, artifact)
        written = tmp_zstd
        print(
            f"repair complete: {artifact}\n"
            f"  renumbered {lines_written - (res.first_seam[0] - 1)} tail lines "
            f"(events {res.first_seam[1]}..{event_count - 1}), "
            f"seed lines 1..{res.first_seam[0] - 1} untouched\n"
            f"  zstd re-compressed (header frame + ~512 KiB body frames); "
            f"integrity + framing verified"
        )
        return 0
    finally:
        for path in (tmp_plain, tmp_zstd):
            if path != written and os.path.exists(path):
                os.unlink(path)


def _temp_path(artifact: str, suffix: str = "") -> str:
    """Create a closed, pre-allocated temp path in the artifact's directory."""
    fd, path = tempfile.mkstemp(
        dir=os.path.dirname(os.path.abspath(artifact)),
        prefix=".session-repair-",
        suffix=suffix + ".tmp",
    )
    os.close(fd)
    return path


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="repair-session-renumber.py",
        description=(
            "Offline repair of a DSH session artifact (*.jsonl.zstd) with a "
            "mid-log seq seam: renumber the tail records so seqs continue "
            "contiguously from the seed, with byte-identical backup and "
            "strict continuity verification before an atomic replace."
        ),
    )
    parser.add_argument("artifact", metavar="<artifact.jsonl.zstd>",
                        help="session artifact to repair (service must be stopped)")
    parser.add_argument("--backup-dir", metavar="DIR",
                        help="directory for the pre-repair backup "
                             "(default: alongside the artifact)")
    parser.add_argument("--dry-run", action="store_true",
                        help="detect only: print the seam, the planned "
                             "renumber range and the resulting continuity "
                             "verdict; write nothing")
    parser.add_argument("--no-backup", action="store_true",
                        help="skip the pre-repair backup (not recommended)")
    args = parser.parse_args(argv)
    try:
        return run(args)
    except RepairError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    except OSError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())