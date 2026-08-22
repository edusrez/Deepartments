#!/usr/bin/env python3
"""
test-repair-renumber.py - regression tests for scripts/repair-session-renumber.py

Covers the 2026-08-22 framing incident: the old compressor re-compressed the
renumbered log as ONE zstd frame, but dsh-session-persistence-jsonl requires
the FIRST frame to decompress to exactly one newline-terminated session header
line (assertZstdHeaderFrame, lib/index.js:741) - a single-frame artifact
blocked dev boot for ~12h in a crash-loop. The tests assert:

  1. the new framing compressor emits frame 1 = exactly the header line and
     >= 2 frames whenever the log has events (>= 2 lines);
  2. the verify gate (port of assertZstdHeaderFrame + strict re-scan over the
     FINAL artifact) REJECTS the old single-frame incident shape;
  3. a full repair run produces a compliant artifact, a byte-identical
     `.pre-repair-` backup, strict continuity and rc=0;
  4. --dry-run detects the seam without writing anything;
  5. no temp files are left behind.

Run directly:  python3 scripts/test-repair-renumber.py
Dependencies: stdlib only. The `zstandard` module (optional) is exercised
when installed and its tests skip cleanly otherwise - the CLI zstd fallback
is the primary codec on the deployed server.
"""

from __future__ import annotations

import glob
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from typing import Any, Dict, List, Optional, Tuple

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(SCRIPT_DIR, "repair-session-renumber.py")
MODULE_NAME = "repair_session_renumber"


def load_module() -> Any:
    spec = importlib.util.spec_from_file_location(MODULE_NAME, SCRIPT)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


rsr = load_module()  # module under test (functions shared with the CLI)


def has_zstandard() -> bool:
    try:
        import zstandard  # noqa: F401
        return True
    except ImportError:
        return False


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def header_line() -> Dict[str, Any]:
    return {"type": "session", "id": "sess-test-1", "data": {"startedAt": 1}}


def dump(obj: Dict[str, Any]) -> str:
    return json.dumps(obj, separators=(",", ":"))


def seed_events(n: int) -> List[Dict[str, Any]]:
    return [
        {"type": "user" if i % 2 == 0 else "assistant", "seq": i, "data": {"text": chr(97 + i)}}
        for i in range(n)
    ]


def tail_events(start: int, count: int) -> List[Dict[str, Any]]:
    return [
        {"type": "user" if (start + i) % 2 == 0 else "assistant",
         "seq": start + i, "data": {"text": f"tail-{i}"}}
        for i in range(count)
    ]


def seam_plaintext(seed: int = 4, jump: int = 100, tail: int = 3) -> bytes:
    """Header + `seed` contiguous events + `tail` events resumed at `jump`."""
    lines = [dump(header_line())]
    lines += [dump(r) for r in seed_events(seed)]
    lines += [dump(r) for r in tail_events(jump, tail)]
    return ("\n".join(lines) + "\n").encode("utf-8")


def chunk_row_plaintext() -> bytes:
    """Header + seed 0..3 + a packed text-chunks row at seq0=100 + an event."""
    lines = [dump(header_line())]
    lines += [dump(r) for r in seed_events(4)]
    lines.append(dump({"type": "text-chunks",
                       "seq0": 100,
                       "data": {"texts": ["chunk-A", "chunk-B"]}}))
    lines.append(dump({"type": "assistant", "seq": 102, "data": {"text": "after"}}))
    return ("\n".join(lines) + "\n").encode("utf-8")


def compress_single_frame(plaintext: bytes, out_path: str) -> None:
    """The INCIDENT shape: the whole log re-compressed as ONE zstd frame
    (what the pre-2026-08-22 compress_file produced)."""
    proc = subprocess.run(["zstd", "-q", "-f", "--check", "-c"],
                          input=plaintext, capture_output=True)
    if proc.returncode != 0:
        raise RuntimeError(f"zstd compress failed: {proc.stderr.decode()}")
    with open(out_path, "wb") as fh:
        fh.write(proc.stdout)


def run_script(artifact: str, *extra: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, SCRIPT, artifact, *extra],
        capture_output=True, text=True,
    )


class RepairFramingTest(unittest.TestCase):
    """Regression tests for the 2026-08-22 single-frame framing incident."""

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="test-repair-renum-")
        self.addCleanup(self._tmp.cleanup)
        self.dir = self._tmp.name

    def _artifact(self, plaintext: bytes, name: str = "session.jsonl.zstd") -> str:
        path = os.path.join(self.dir, name)
        compress_single_frame(plaintext, path)
        return path

    def _renumbered_plain(self, plaintext: bytes) -> Tuple[str, int, int]:
        """Run the real renumber pipeline on a seam fixture and return the
        contiguous renumbered plaintext (path, line_count, event_count)."""
        art = os.path.join(self.dir, "seed.jsonl.zstd")
        compress_single_frame(plaintext, art)
        res = rsr.scan(rsr.decompressed_lines(art))
        assert res.first_seam is not None, "fixture must contain a seam"
        out = os.path.join(self.dir, "renumbered.jsonl")
        rsr.renumber(art, res.first_seam[0], out)
        line_count, event_count = rsr.verify_strict(out)
        return out, line_count, event_count

    # ------------------------------------------------------------------ scan

    def test_scan_finds_seam_at_expected_position(self) -> None:
        plain = seam_plaintext()
        art = self._artifact(plain)
        res = rsr.scan(rsr.decompressed_lines(art))
        self.assertFalse(res.contiguous)
        self.assertIsNotNone(res.first_seam)
        line, expected, got, jump = res.first_seam
        # header + 4 seed rows -> first violated event is line 6, index 4.
        self.assertEqual((line, expected, got, jump), (6, 4, 100, 96))
        self.assertEqual(res.header_type, "session")

    def test_renumbered_plaintext_is_strictly_contiguous(self) -> None:
        plain = seam_plaintext()
        art = self._artifact(plain)
        res = rsr.scan(rsr.decompressed_lines(art))
        assert res.first_seam is not None
        out = os.path.join(self.dir, "renumbered.jsonl")
        rsr.renumber(art, res.first_seam[0], out)
        line_count, event_count = rsr.verify_strict(out)
        self.assertEqual(line_count, 8)       # header + 4 seed + 3 tail
        self.assertEqual(event_count, 7)
        # every expanded event now carries seq == zero-based index.
        seen = []
        for lineno, raw in enumerate(rsr._plain_lines(out), 1):
            if lineno == 1:
                continue
            v = json.loads(raw.decode("utf-8"))
            n, seq = rsr.expand_record(v)
            seen.append((seq, n))
        self.assertEqual([s for s, _ in seen], [0, 1, 2, 3, 4, 5, 6])

    def test_chunk_rows_renumbered_through_seq0(self) -> None:
        plain = chunk_row_plaintext()
        art = self._artifact(plain)
        res = rsr.scan(rsr.decompressed_lines(art))
        assert res.first_seam is not None
        out = os.path.join(self.dir, "renumbered.jsonl")
        rsr.renumber(art, res.first_seam[0], out)
        line_count, event_count = rsr.verify_strict(out)  # 7 lines, 7 events
        self.assertEqual((line_count, event_count), (7, 7))
        lines = list(rsr._plain_lines(out))
        row = json.loads(lines[5].decode("utf-8"))  # text-chunks row now seq0=4
        self.assertEqual(row["type"], "text-chunks")
        self.assertEqual(row["seq0"], 4)  # members 4..5, then event 6
        last = json.loads(lines[6].decode("utf-8"))
        self.assertEqual(last["seq"], 6)

    # ------------------------------------------------------------------ gate

    def test_gate_rejects_incident_single_frame_artifact(self) -> None:
        """The exact incident shape (one frame for the whole log) must fail
        the header-frame invariant AND the verify_artifact_framing gate."""
        plain = seam_plaintext()
        art = self._artifact(plain)  # compress_single_frame = ONE frame
        frames = rsr.scan_zstd_frame_ranges(art)
        self.assertEqual(len(frames), 1, "fixture must be single-frame")
        with self.assertRaises(rsr.RepairError) as ctx:
            rsr.assert_first_frame_is_header(art)
        self.assertIn("first frame is not exactly one header line", str(ctx.exception))
        with self.assertRaises(rsr.RepairError):
            rsr.verify_artifact_framing(art, 8)

    def test_new_compressor_never_emits_single_frame_for_multiline_log(self) -> None:
        """compress_log_file must produce frame 1 = header alone and >= 2
        frames for a repaired log (the old compress_file emitted 1 frame
        containing the whole renumbered log - the incident bug)."""
        plain_path, line_count, _ = self._renumbered_plain(seam_plaintext())
        out = os.path.join(self.dir, "framed.jsonl.zstd")
        rsr.compress_log_file(plain_path, out)
        frames = rsr.scan_zstd_frame_ranges(out)
        self.assertGreaterEqual(len(frames), 2)
        self.assertEqual(rsr.assert_first_frame_is_header(out),
                         dump(header_line()).encode("utf-8"))
        # The gate (header-frame + strict re-scan over the final artifact)
        # passes on the framed output of the renumbered log.
        rsr.verify_artifact_framing(out, line_count)

    def test_gate_passes_framed_artifact_and_rescans_final(self) -> None:
        "Gate passes frame-1 invariant + strict re-scan equality on the FINAL artifact."
        plain_path, line_count, event_count = self._renumbered_plain(seam_plaintext())
        self.assertEqual((line_count, event_count), (8, 7))
        out = os.path.join(self.dir, "framed.jsonl.zstd")
        rsr.compress_log_file(plain_path, out)
        rsr.verify_zstd_roundtrip(out, sha256_file(plain_path))  # sha over stream
        rsr.verify_artifact_framing(out, line_count)  # no raise == pass
        # strict rescan of the artifact's own decompressed stream == plaintext.
        lc2, ec2 = rsr.verify_strict_lines(rsr.decompressed_lines(out))
        self.assertEqual((lc2, ec2), (line_count, event_count))

    # ------------------------------------------------------------------ CLI

    def test_dry_run_detects_seam_without_writing(self) -> None:
        art = self._artifact(seam_plaintext())
        proc = run_script(art, "--dry-run")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertIn("seam line: 6", proc.stdout)
        self.assertIn("no files were written", proc.stdout)
        # nothing in the directory besides the fixture artifact.
        self.assertEqual(glob.glob(os.path.join(self.dir, "*")), [art])

    def test_full_repair_produces_compliant_artifact_and_backup(self) -> None:
        plain = seam_plaintext()
        art = self._artifact(plain)
        original_sha = sha256_file(art)
        proc = run_script(art)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("repair complete", proc.stdout)
        # 1) final artifact: frame 1 == exactly the header line, >= 2 frames.
        frames = rsr.scan_zstd_frame_ranges(art)
        self.assertGreaterEqual(len(frames), 2)
        self.assertEqual(rsr.assert_first_frame_is_header(art),
                         dump(header_line()).encode("utf-8"))
        # 2) gate over the FINAL artifact passes.
        rsr.verify_artifact_framing(art, 8)
        # 3) strict continuity of the deployed artifact.
        line_count, event_count = rsr.verify_strict_lines(rsr.decompressed_lines(art))
        self.assertEqual((line_count, event_count), (8, 7))
        # 4) backup: exactly one, byte-identical to the original artifact.
        backups = glob.glob(os.path.join(self.dir, "*.pre-repair-*"))
        self.assertEqual(len(backups), 1)
        self.assertEqual(sha256_file(backups[0]), original_sha)
        # 5) the repaired artifact differs from the original (seqs rewritten).
        self.assertNotEqual(sha256_file(art), original_sha)
        # 6) no temp files left behind.
        self.assertEqual(glob.glob(os.path.join(self.dir, ".session-repair-*")), [])
        # 7) idempotent: re-run reports already contiguous, rc 0, no 2nd backup.
        proc2 = run_script(art)
        self.assertEqual(proc2.returncode, 0, proc2.stderr)
        self.assertIn("already contiguous", proc2.stdout)
        self.assertEqual(len(glob.glob(os.path.join(self.dir, "*.pre-repair-*"))), 1)

    def test_repair_leaves_artifact_untouched_when_unfixable(self) -> None:
        """A seam log that also carries a non-carrying record must abort:
        dry-run rc=1 with a NOT REPAIRABLE verdict, full run rc=1 with the
        artifact bytes unchanged and no temp leftovers (never publish
        unverified)."""
        lines = [dump(header_line())]
        lines += [dump(r) for r in seed_events(4)]
        lines.append(json.dumps({"type": "note", "text": "no seq"}))  # non-carrying
        lines += [dump(r) for r in tail_events(100, 2)]
        plain = ("\n".join(lines) + "\n").encode()
        art = self._artifact(plain)
        before = sha256_file(art)
        proc = run_script(art, "--dry-run")
        self.assertEqual(proc.returncode, 1)
        self.assertIn("NOT REPAIRABLE", proc.stdout)
        proc2 = run_script(art)
        self.assertEqual(proc2.returncode, 1)
        self.assertEqual(sha256_file(art), before)  # never replaced
        self.assertEqual(glob.glob(os.path.join(self.dir, ".session-repair-*")), [])


def renumbered_plain_into(tmpdir: str, plaintext: bytes) -> Tuple[str, int, int]:
    """Renumber a seam fixture into `tmpdir` exactly like the script's run()
    pipeline; returns (renumbered plain path, line_count, event_count)."""
    art = os.path.join(tmpdir, "seed.jsonl.zstd")
    compress_single_frame(plaintext, art)
    res = rsr.scan(rsr.decompressed_lines(art))
    assert res.first_seam is not None, "fixture must contain a seam"
    out = os.path.join(tmpdir, "renumbered.jsonl")
    rsr.renumber(art, res.first_seam[0], out)
    line_count, event_count = rsr.verify_strict(out)
    return out, line_count, event_count


@unittest.skipUnless(has_zstandard(), "zstandard module not installed; CLI path tested above")
class ZstandardModuleFramingTest(unittest.TestCase):
    """The real `zstandard` module compressor path (clean skip when unavailable)."""

    def test_module_compressor_produces_compliant_framing(self) -> None:
        with tempfile.TemporaryDirectory(prefix="test-repair-renum-zstd-") as d:
            plain_path, line_count, _ = renumbered_plain_into(d, seam_plaintext())
            out = os.path.join(d, "framed.jsonl.zstd")
            rsr.compress_log_file(plain_path, out)  # module branch
            frames = rsr.scan_zstd_frame_ranges(out)
            self.assertGreaterEqual(len(frames), 2)
            self.assertEqual(rsr.assert_first_frame_is_header(out),
                             dump(header_line()).encode("utf-8"))
            rsr.verify_artifact_framing(out, line_count)


class _FakeZstd:
    """Functional stand-in for the `zstandard` module, backed by the real zstd
    CLI: the API shape is faked but the compressed bytes are genuine zstd, so
    the script's MODULE branches get real execution even without the package."""

    class ZstdCompressor:
        def __init__(self, level: int = 3, **kw: Any) -> None:
            self.kw = kw

        def compress(self, data: bytes) -> bytes:
            proc = subprocess.run(["zstd", "-q", "-f", "--check", "-c"],
                                  input=data, capture_output=True)
            if proc.returncode != 0:
                raise RuntimeError(f"fake zstd compress failed: {proc.stderr.decode()}")
            return proc.stdout

    class LegacyZstdCompressor:  # pre-write_checksum binding shape
        def __init__(self, level: int = 3, **kw: Any) -> None:
            if "write_checksum" in kw:
                raise TypeError("write_checksum not supported by this binding")
            self.kw = kw

        def compress(self, data: bytes) -> bytes:
            return _FakeZstd.ZstdCompressor().compress(data)

    class ZstdDecompressor:
        def decompress(self, data: bytes) -> bytes:
            proc = subprocess.run(["zstd", "-q", "-d", "-c"],
                                  input=data, capture_output=True)
            if proc.returncode != 0:
                raise RuntimeError(f"fake zstd decompress failed: {proc.stderr.decode()}")
            return proc.stdout

        def stream_reader(self, fh: Any, read_across_frames: bool = True) -> Any:
            class Reader:
                def __init__(self) -> None:
                    self._proc = subprocess.Popen(
                        ["zstd", "-q", "-d", "-c"], stdin=fh, stdout=subprocess.PIPE)

                def __iter__(self) -> Iterator[bytes]:
                    assert self._proc.stdout is not None
                    yield from self._proc.stdout

                def close(self) -> None:
                    if self._proc.stdout is not None:
                        self._proc.stdout.close()
                    self._proc.wait()
            return Reader()


class ZstandardModulePathStubTest(unittest.TestCase):
    """Exercises the script's zstandard-module branches via a CLI-backed stub
    (no third-party dependency; stdlib + the zstd CLI only)."""

    @classmethod
    def setUpClass(cls) -> None:
        assert "zstandard" not in sys.modules or True
        cls._real = sys.modules.get("zstandard")
        sys.modules["zstandard"] = _FakeZstd  # type: ignore[assignment]

    @classmethod
    def tearDownClass(cls) -> None:
        if cls._real is None:
            sys.modules.pop("zstandard", None)
        else:
            sys.modules["zstandard"] = cls._real

    def setUp(self) -> None:
        self._tmp = tempfile.TemporaryDirectory(prefix="test-repair-renum-stub-")
        self.addCleanup(self._tmp.cleanup)
        self.dir = self._tmp.name

    def test_stub_module_compressor_framing_and_gate(self) -> None:
        plain_path, line_count, _ = renumbered_plain_into(self.dir, seam_plaintext())
        out = os.path.join(self.dir, "framed.jsonl.zstd")
        rsr.compress_log_file(plain_path, out)  # module branch via stub
        frames = rsr.scan_zstd_frame_ranges(out)
        self.assertGreaterEqual(len(frames), 2)
        self.assertEqual(rsr.assert_first_frame_is_header(out),
                         dump(header_line()).encode("utf-8"))
        rsr.verify_artifact_framing(out, line_count)
        # decompressed_lines module branch (stream_reader) round-trips fully.
        self.assertEqual(list(rsr.decompressed_lines(out)),
                         list(rsr._plain_lines(plain_path)))

    def test_stub_typeerror_fallback_without_checksum_kwarg(self) -> None:
        """An old binding without write_checksum must fall back cleanly."""
        sys.modules["zstandard"] = type(
            "_FakeZstdLegacy",
            (),
            {"ZstdCompressor": _FakeZstd.LegacyZstdCompressor,
             "ZstdDecompressor": _FakeZstd.ZstdDecompressor},
        )  # type: ignore[assignment]
        plain_path, line_count, _ = renumbered_plain_into(self.dir, seam_plaintext())
        out = os.path.join(self.dir, "framed.jsonl.zstd")
        rsr.compress_log_file(plain_path, out)  # must not raise TypeError
        frames = rsr.scan_zstd_frame_ranges(out)
        self.assertGreaterEqual(len(frames), 2)
        rsr.verify_artifact_framing(out, line_count)


if __name__ == "__main__":
    unittest.main(verbosity=2)