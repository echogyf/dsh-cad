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
        self.site = self.target.parent
        self.metadata = self.site / "autocad_mcp_pro-1.6.0.dist-info" / "METADATA"
        self.metadata.parent.mkdir()
        self.metadata.write_text("Name: autocad-mcp-pro\nVersion: 1.6.0\n", encoding="utf-8")
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

    def run_main(self, *options):
        output = io.StringIO()
        with patch.object(sys, "argv", ["patch", "--base", str(self.base), *options]), contextlib.redirect_stdout(output):
            result = patcher.main()
        return result, output.getvalue()

    def set_version(self, version):
        # The old directory is retained with another name only in temporary fixtures.
        self.metadata.unlink()
        self.metadata.parent.rmdir()
        self.metadata = self.site / ("autocad_mcp_pro-%s.dist-info" % version) / "METADATA"
        self.metadata.parent.mkdir()
        self.metadata.write_text("Name: autocad-mcp-pro\nVersion: %s\n" % version, encoding="utf-8")

    def write_sources(self, native=True):
        com = self.site / "backends" / "com_backend.py"
        com.parent.mkdir(exist_ok=True)
        if native:
            backend = patcher.ACAD_HELPERS + '''class ComBackend(AutoCADBackend):
    async def dimension_linear(self, x1, y1, x2, y2, dim_x, dim_y,
                               rotation=None, layer=None):
        def _sync():
            mspace = _msp()
            angle = (_auto_linear_rotation(x1, y1, x2, y2)
                     if rotation is None else deg2rad(rotation))
            dim = mspace.AddDimRotated(_apoint(x1, y1), _apoint(x2, y2),
                                      _apoint(dim_x, dim_y), angle)
        return await self._run(_sync)

    async def dimension_angular(self, vx, vy, x1, y1, x2, y2, tx, ty,
                                layer=None, minor_angle=True):
        def _sync():
            mspace = _msp()
            rx1, ry1, rx2, ry2 = x1, y1, x2, y2
            if minor_angle and _ray_sweep(vx, vy, rx1, ry1, rx2, ry2) > math.pi:
                rx1, ry1, rx2, ry2 = rx2, ry2, rx1, ry1
            dim = mspace.AddDimAngular(_apoint(vx, vy), _apoint(rx1, ry1),
                                      _apoint(rx2, ry2), _apoint(tx, ty))
        return await self._run(_sync)
'''
            server = '''async def dimension_linear(x1, y1, x2, y2, dim_x, dim_y,
                           rotation=None, layer=None, ctx=None):
    if rotation is None:
        rotation = 90.0 if abs(y2 - y1) > abs(x2 - x1) else 0.0
    angle = math.radians(rotation)
    nominal = abs((x2 - x1) * math.cos(angle) + (y2 - y1) * math.sin(angle))
    return await _backend(ctx).dimension_linear(x1, y1, x2, y2, dim_x, dim_y, rotation, layer)

async def dimension_angular(vertex_x, vertex_y, x1, y1, x2, y2,
                            text_x, text_y, layer=None, minor_angle=True, ctx=None):
    return await _backend(ctx).dimension_angular(
        vertex_x, vertex_y, x1, y1, x2, y2, text_x, text_y, layer, minor_angle)
'''
        else:
            # Real 1.8.0 shape: xdata preparation and the GH issue #3 comment.
            # The reviewed 1.6.0 anchors remain identical; no upstream imports.
            backend = '''class ComBackend(AutoCADBackend):
    async def dimension_linear(
        self,
        x1, y1, x2, y2,
''' + patcher.ACAD_COM["edits"][1][0] + '''
        tol_lower=None,
        tol_mode="none",
        text_override=None,
        xdata=None,
    ) -> EntityInfo:
        prepared = prepare_xdata(xdata)
        def _sync():
            mspace = _msp()
            # The ActiveX API has no AddDimLinear — rotated linear dims are
            # created with AddDimRotated (GH issue #3).
''' + patcher.ACAD_COM["edits"][2][0] + '''
            _attach_xdata(dim, prepared)
            return _entity_info(dim)
        return await self._run(_sync)

    async def dimension_angular(
        self,
        vx, vy, x1, y1, x2, y2,
''' + patcher.ACAD_COM["edits"][3][0] + '''
            return _entity_info(dim)
        return await self._run(_sync)
'''
            server = '''async def dimension_linear(
    x1, y1, x2, y2, dim_x, dim_y,
''' + patcher.ACAD_SERVER["edits"][0][0] + '''
    layer=None, ctx=None,
):
''' + patcher.ACAD_SERVER["edits"][1][0] + '''
    nominal = abs((x2 - x1) * math.cos(angle) + (y2 - y1) * math.sin(angle))
    return await _backend(ctx).dimension_linear(
        x1, y1, x2, y2, dim_x, dim_y, rotation, layer)

async def dimension_angular(
    vertex_x, vertex_y, x1, y1, x2, y2,
''' + patcher.ACAD_SERVER["edits"][2][0] + '''
    return _dc(result)
'''
        if not native and self.metadata.parent.name == "autocad_mcp_pro-1.8.0.dist-info":
            backend = backend.replace("class ComBackend(AutoCADBackend):",
                                      "class ComBackend(ComCheckpoints, AutoCADBackend):")
        com.write_text(backend, encoding="utf-8")
        (self.site / "server.py").write_text(server, encoding="utf-8")
        return com, self.site / "server.py"

    def snapshot(self):
        return {path.relative_to(self.site): (path.read_bytes(), path.stat().st_mtime_ns)
                for path in self.site.rglob("*") if path.is_file()}

    def test_180_native_fix_is_verified_without_writes_in_all_modes(self):
        self.set_version("1.8.0")
        self.write_sources()
        before = self.snapshot()
        for options in ((), ("--check",), ("--dry-run",)):
            with self.subTest(options=options), patch.object(patcher, "apply_one", side_effect=AssertionError("legacy patch called")):
                result, output = self.run_main(*options)
                self.assertEqual(result, 0, output)
                self.assertIn("verified read-only", output)
                self.assertEqual(self.snapshot(), before)

    def test_180_missing_native_signatures_fails_without_writes(self):
        self.set_version("1.8.0")
        com, server = self.write_sources()
        for path, old, new in ((server, "rotation=None", "rotation=0.0"),
                               (com, "minor_angle=True", "legacy_flag=True")):
            original = path.read_text(encoding="utf-8")
            path.write_text(original.replace(old, new), encoding="utf-8")
            before = self.snapshot()
            with self.subTest(path=path):
                result, output = self.run_main()
                self.assertEqual(result, 1, output)
                self.assertIn("must default", output)
                self.assertEqual(self.snapshot(), before)
            path.write_text(original, encoding="utf-8")

    def test_180_signatures_alone_do_not_hide_missing_logic(self):
        self.set_version("1.8.0")
        com, server = self.write_sources()
        mutations = (
            (server, "rotation = 90.0 if", "rotation = 0.0 if"),
            (server, "layer, minor_angle)", "layer, True)"),
            (com, "_apoint(dim_x, dim_y), angle)", "_apoint(dim_x, dim_y), deg2rad(rotation))"),
            (com, "if minor_angle and", "if True and"),
            (com, "(a2 - a1) %", "(a1 - a2) %"),
        )
        for path, old, new in mutations:
            original = path.read_text(encoding="utf-8")
            self.assertIn(old, original)
            path.write_text(original.replace(old, new), encoding="utf-8")
            before = self.snapshot()
            with self.subTest(mutation=new):
                result, output = self.run_main("--check")
                self.assertEqual(result, 1, output)
                self.assertEqual(self.snapshot(), before)
            path.write_text(original, encoding="utf-8")

    def test_unknown_versions_fail_before_legacy_patching(self):
        self.write_sources(native=False)
        for version in ("1.7.0", "1.8.1", "1.8.0rc1", "1.9.0", "2.0.0"):
            self.set_version(version)
            before = self.snapshot()
            with self.subTest(version=version), patch.object(patcher, "apply_one", side_effect=AssertionError("legacy patch called")):
                result, output = self.run_main()
                self.assertEqual(result, 1, output)
                self.assertIn("unsupported or malformed", output)
                self.assertEqual(self.snapshot(), before)

    def test_missing_or_malformed_metadata_fails_closed(self):
        self.write_sources()
        for text in (None, "Name: autocad-mcp-pro\n", "Name: other\nVersion: 1.6.0\n",
                     "Name: autocad-mcp-pro\nVersion: 1.6.0\nVersion: 1.8.0\n",
                     "Name: autocad-mcp-pro\nVersion: 1.8.0\n",
                     "Name: autocad-mcp-pro\nVersion: 1.6.0\nmalformed header\n"):
            if text is None:
                self.metadata.unlink()
            else:
                self.metadata.write_text(text, encoding="utf-8")
            before = self.snapshot()
            with self.subTest(text=text):
                result, output = self.run_main()
                self.assertEqual(result, 1, output)
                self.assertIn("[FAIL", output)
                self.assertEqual(self.snapshot(), before)

    def test_multiple_target_distributions_fail_closed(self):
        self.write_sources()
        duplicate = self.site / "autocad_mcp_pro-1.8.0.dist-info" / "METADATA"
        duplicate.parent.mkdir()
        duplicate.write_text("Name: autocad-mcp-pro\nVersion: 1.8.0\n", encoding="utf-8")
        self.assertEqual(self.run_main()[0], 1)

    def test_target_metadata_not_interpreter_version_drives_selection(self):
        self.write_sources(native=False)
        # A host interpreter may have another release installed; sys.path must not matter.
        with patch.object(sys, "path", []):
            result, output = self.run_main("--check")
        self.assertEqual(result, 1, output)
        self.assertIn("autocad-mcp-pro 1.6.0", output)
        self.assertNotIn("native-dimension-fixes", output)

    def test_180_compatibility_patch_check_dry_run_and_idempotency(self):
        self.set_version("1.8.0")
        self.write_sources(native=False)
        before = self.snapshot()
        result, output = self.run_main("--check")
        self.assertEqual(result, 1, output)
        self.assertIn("NEEDS", output)
        result, output = self.run_main("--dry-run")
        self.assertEqual(result, 0, output)
        self.assertEqual(self.snapshot(), before)
        result, output = self.run_main()
        self.assertEqual(result, 0, output)
        patcher.verify_native(self.base)
        after = self.snapshot()
        self.assertNotEqual(after, before)
        self.assertEqual(self.run_main()[0], 0)
        self.assertEqual(self.run_main("--check")[0], 0)
        self.assertEqual(self.snapshot(), after)

    def test_180_drift_in_either_file_never_partially_patches(self):
        self.set_version("1.8.0")
        com, server = self.write_sources(native=False)
        for target, old in ((com, "class ComBackend(ComCheckpoints, AutoCADBackend):"),
                            (server, "    angle = math.radians(rotation)")):
            original = target.read_text(encoding="utf-8")
            self.assertIn(old, original)
            target.write_text(original.replace(old, "# missing reviewed anchor"), encoding="utf-8")
            before = self.snapshot()
            with self.subTest(target=target):
                result, output = self.run_main()
                self.assertEqual(result, 1, output)
                self.assertIn("anchor not found", output)
                self.assertEqual(self.snapshot(), before)
            target.write_text(original, encoding="utf-8")

    def test_180_duplicate_anchor_or_160_class_fails_without_writes(self):
        self.set_version("1.8.0")
        com, server = self.write_sources(native=False)
        for target, old, new in (
            (com, "class ComBackend(ComCheckpoints, AutoCADBackend):",
             "class ComBackend(AutoCADBackend):"),
            (server, "    angle = math.radians(rotation)",
             "    angle = math.radians(rotation)\n    angle = math.radians(rotation)"),
        ):
            original = target.read_text(encoding="utf-8")
            target.write_text(original.replace(old, new), encoding="utf-8")
            before = self.snapshot()
            with self.subTest(mutation=new):
                result, output = self.run_main()
                self.assertEqual(result, 1, output)
                self.assertIn("anchor not found or ambiguous", output)
                self.assertEqual(self.snapshot(), before)
            target.write_text(original, encoding="utf-8")

    def test_180_projected_ast_failure_prevents_all_writes(self):
        self.set_version("1.8.0")
        _, server = self.write_sources(native=False)
        text = server.read_text(encoding="utf-8")
        # Every replacement anchor still matches, but forwarding is broken.
        server.write_text(text.replace("dim_y, rotation, layer)", "dim_y, 0.0, layer)"), encoding="utf-8")
        before = self.snapshot()
        result, output = self.run_main()
        self.assertEqual(result, 1, output)
        self.assertIn("does not propagate", output)
        self.assertEqual(self.snapshot(), before)

    def test_160_legacy_patch_check_dry_run_and_idempotency(self):
        self.write_sources(native=False)
        before = self.snapshot()
        self.assertEqual(self.run_main("--check")[0], 1)
        self.assertEqual(self.run_main("--dry-run")[0], 0)
        self.assertEqual(self.snapshot(), before)
        result, output = self.run_main()
        self.assertEqual(result, 0, output)
        after = self.snapshot()
        self.assertNotEqual(after, before)
        self.assertEqual(self.run_main()[0], 0)
        self.assertEqual(self.run_main("--check")[0], 0)
        self.assertEqual(self.snapshot(), after)


if __name__ == "__main__":
    unittest.main()
