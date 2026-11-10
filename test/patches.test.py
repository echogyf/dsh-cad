"""Patch safety regression tests; only temporary fixture files are modified."""
import contextlib
import importlib.util
import io
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / "patches" / "apply_patches.py"
spec = importlib.util.spec_from_file_location("cad_patches", MODULE)
patcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patcher)


class PatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="dsh-cad-patch-tests-")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.target = self.base / "venv-autocad" / "Lib" / "site-packages" / "sample.py"
        self.target.parent.mkdir(parents=True)
        self.definition = {"id": "sample", "pr": "test", "marker": "MARK", "target": ("acad-site", "sample.py"), "edits": [("old_a", "new_a # MARK"), ("old_b", "new_b")]}

    def test_partial_marker_does_not_hide_remaining_edits(self):
        self.target.write_text("new_a # MARK\nold_b", encoding="utf-8")
        self.assertEqual(patcher.apply_one(self.base, self.definition)[0], "applied")
        self.assertIn("new_b", self.target.read_text(encoding="utf-8"))
        self.assertEqual(patcher.apply_one(self.base, self.definition)[0], "present")

    def test_dry_run_and_drift_never_write(self):
        original = "old_a\nold_b"
        self.target.write_text(original, encoding="utf-8")
        self.assertEqual(patcher.apply_one(self.base, self.definition, dry_run=True)[0], "applied")
        self.assertEqual(self.target.read_text(encoding="utf-8"), original)
        self.target.write_text("old_a\nunknown", encoding="utf-8")
        self.assertEqual(patcher.apply_one(self.base, self.definition)[0], "drift")
        self.assertEqual(self.target.read_text(encoding="utf-8"), "old_a\nunknown")

    def test_check_fails_when_target_is_missing(self):
        with patch.object(patcher, "PATCHES", [self.definition]), patch.object(sys, "argv", ["patch", "--base", str(self.base), "--check"]), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(patcher.main(), 1)


if __name__ == "__main__":
    unittest.main()
