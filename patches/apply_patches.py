#!/usr/bin/env python
"""Version-gated AutoCAD fixes: legacy 1.6.0 and reviewed 1.8.0 compatibility.

The target version comes only from --base/venv-autocad/Lib/site-packages.
Unknown or malformed metadata fails closed. No upstream module is imported.
Exit 0 means the supported target satisfies the checks (or a 1.6.0 dry run
could apply); exit 1 means missing, unsupported, pending --check, or drift.
"""
import argparse
import ast
from email.parser import Parser
import re
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# autocad-mcp-pro: dimension rotation and angular minor angle
# ---------------------------------------------------------------------------
ACAD_HELPERS = '''
def _auto_linear_rotation(x1, y1, x2, y2) -> float:
    """Rotation for AddDimRotated when the caller did not pin one, in radians.

    AddDimRotated measures the projection of the two points onto its dimension
    line. A vertical pair (same X) with rotation 0 therefore measures 0.0, and
    AutoCAD still creates the entity without complaint - the failure is silent
    in the drawing, not in the API.
    """
    return math.pi / 2 if abs(y2 - y1) > abs(x2 - x1) else 0.0


def _ray_sweep(vx, vy, x1, y1, x2, y2) -> float:
    """Counter-clockwise sweep from ray 1 to ray 2, in radians, within [0, 2pi).

    AddDimAngular stores this sweep in the DXF: the entity's COM Measurement
    always reports the minor angle, but a consumer reading the DXF back gets the
    reflex angle when the rays are handed over the other way round.
    """
    a1 = math.atan2(y1 - vy, x1 - vx)
    a2 = math.atan2(y2 - vy, x2 - vx)
    return (a2 - a1) % (2.0 * math.pi)


'''

ACAD_COM = {
    "id": "acad-dimension-rotation",
    "title": "autocad-mcp-pro: linear dimension rotation follows the points",
    "pr": "https://github.com/U-C4N/Autocad-MCP/pull/16",
    "target": ("acad-site", "backends/com_backend.py"),
    "marker": "_auto_linear_rotation",
    "edits": [
        (
            '''class ComBackend(AutoCADBackend):''',
            ACAD_HELPERS.lstrip("\n") + '''class ComBackend(AutoCADBackend):''',
        ),
        (
            '''        dim_x,
        dim_y,
        rotation=0.0,
        layer=None,
        tol_upper=None,''',
            '''        dim_x,
        dim_y,
        rotation=None,
        layer=None,
        tol_upper=None,''',
        ),
        (
            '''            dim = mspace.AddDimRotated(
                _apoint(x1, y1),
                _apoint(x2, y2),
                _apoint(dim_x, dim_y),
                deg2rad(rotation),
            )''',
            '''            angle = (
                _auto_linear_rotation(x1, y1, x2, y2)
                if rotation is None
                else deg2rad(rotation)
            )
            dim = mspace.AddDimRotated(
                _apoint(x1, y1),
                _apoint(x2, y2),
                _apoint(dim_x, dim_y),
                angle,
            )''',
        ),
        (
            '''        tx,
        ty,
        layer=None,
    ) -> EntityInfo:
        def _sync():
            mspace = _msp()
            dim = mspace.AddDimAngular(
                _apoint(vx, vy),
                _apoint(x1, y1),
                _apoint(x2, y2),
                _apoint(tx, ty),
            )''',
            '''        tx,
        ty,
        layer=None,
        minor_angle=True,
    ) -> EntityInfo:
        def _sync():
            mspace = _msp()
            rx1, ry1, rx2, ry2 = x1, y1, x2, y2
            if minor_angle and _ray_sweep(vx, vy, rx1, ry1, rx2, ry2) > math.pi:
                # Swap before creating: the sweep is what lands in the DXF, and
                # COM Measurement always reports the minor angle either way.
                rx1, ry1, rx2, ry2 = rx2, ry2, rx1, ry1
            dim = mspace.AddDimAngular(
                _apoint(vx, vy),
                _apoint(rx1, ry1),
                _apoint(rx2, ry2),
                _apoint(tx, ty),
            )''',
        ),
    ],
}

ACAD_SERVER = {
    "id": "acad-dimension-tool-defaults",
    "title": "autocad-mcp-pro: tool layer accepts an omitted rotation and minor_angle",
    "pr": "https://github.com/U-C4N/Autocad-MCP/pull/16",
    "target": ("acad-site", "server.py"),
    "marker": '"Angle of the measured dimension in degrees',
    "edits": [
        (
            '''    rotation: Annotated[float, "Angle of the measured dimension (0=horizontal, 90=vertical)"] = 0.0,''',
            '''    rotation: Annotated[
        float | None,
        "Angle of the measured dimension in degrees (0=horizontal, 90=vertical). "
        "Omit to let it follow the two points, which is what a vertical pair needs.",
    ] = None,''',
        ),
        (
            '''    angle = math.radians(rotation)''',
            '''    if rotation is None:
        rotation = 90.0 if abs(y2 - y1) > abs(x2 - x1) else 0.0
    angle = math.radians(rotation)''',
        ),
        (
            '''    text_x: Annotated[float, "Dimension text position X"],
    text_y: Annotated[float, "Dimension text position Y"],
    layer: Annotated[str | None, "Layer name"] = None,
    ctx: Context = None,
) -> dict:
    """Create an angular dimension measuring the angle between two lines from a vertex."""
    result = await _backend(ctx).dimension_angular(
        vertex_x, vertex_y, x1, y1, x2, y2, text_x, text_y, layer
    )''',
            '''    text_x: Annotated[float, "Dimension text position X"],
    text_y: Annotated[float, "Dimension text position Y"],
    layer: Annotated[str | None, "Layer name"] = None,
    minor_angle: Annotated[
        bool,
        "Measure the angle below 180 degrees. Set false to keep whichever angle "
        "the ray order produces (the reflex angle above 180).",
    ] = True,
    ctx: Context = None,
) -> dict:
    """Create an angular dimension measuring the angle between two lines from a vertex."""
    result = await _backend(ctx).dimension_angular(
        vertex_x, vertex_y, x1, y1, x2, y2, text_x, text_y, layer, minor_angle
    )''',
        ),
    ],
}

PATCHES = [ACAD_COM, ACAD_SERVER]

# 1.8.0 introduced ComCheckpoints; never reuse the 1.6.0 class anchor.
ACAD_COM_180 = dict(ACAD_COM, edits=[(
    "class ComBackend(ComCheckpoints, AutoCADBackend):",
    ACAD_HELPERS.lstrip("\n") + "class ComBackend(ComCheckpoints, AutoCADBackend):",
), *ACAD_COM["edits"][1:]])
PATCHES_180 = [ACAD_COM_180, ACAD_SERVER]


def resolve(base: Path, target):
    kind, rel = target
    if kind == "acad-site":
        return base / "venv-autocad" / "Lib" / "site-packages" / rel
    raise ValueError("unknown target kind: %s" % kind)


def prepare_one(base: Path, patch):
    """Prepare all edits in memory; a drifted file is never partially written."""
    path = resolve(base, patch["target"])
    if not path.is_file():
        return "missing", "not installed: %s" % path, None

    text = path.read_text(encoding="utf-8")
    # A marker alone can survive a partially applied patch. Verify every edit
    # below before calling the whole patch present.
    applied = 0
    skipped = []
    for old, new in patch["edits"]:
        if text.count(new) == 1 and text.count(old) == new.count(old):
            continue
        if text.count(old) == 1 and new not in text:
            text = text.replace(old, new, 1)
            applied += 1
        else:
            skipped.append(old.strip().splitlines()[0][:60])

    if skipped:
        return "drift", "anchor not found or ambiguous: " + " | ".join(skipped), None

    if applied == 0:
        return "present", "already applied", text
    return "applied", "%d edit(s) in %s" % (applied, path.name), text


def apply_one(base: Path, patch, dry_run=False):
    state, detail, text = prepare_one(base, patch)
    if state == "applied" and not dry_run:
        resolve(base, patch["target"]).write_text(text, encoding="utf-8", newline="\n")
    return state, detail


def target_version(base: Path):
    """Read only the target environment's distribution metadata, never sys.path."""
    site = resolve(base, ("acad-site", "server.py")).parent
    normalize = lambda name: re.sub(r"[-_.]+", "-", name).lower()
    candidates = []
    for directory in site.glob("*.dist-info"):
        named_target = normalize(directory.name).startswith("autocad-mcp-pro-")
        metadata = directory / "METADATA"
        if not metadata.is_file():
            if named_target:
                raise ValueError("missing target METADATA: %s" % metadata)
            continue
        message = Parser().parsestr(metadata.read_text(encoding="utf-8"))
        names = message.get_all("Name", [])
        if named_target or any(normalize(name) == "autocad-mcp-pro" for name in names):
            versions = message.get_all("Version", [])
            if (message.defects or len(names) != 1 or normalize(names[0]) != "autocad-mcp-pro"
                    or len(versions) != 1 or versions[0] not in ("1.6.0", "1.8.0")):
                raise ValueError("unsupported or malformed target metadata: %s (Name=%r, Version=%r)"
                                 % (metadata, names, versions))
            version = versions[0]
            if normalize(directory.name) != normalize("autocad_mcp_pro-%s.dist-info" % version):
                raise ValueError("target metadata directory/version mismatch: %s" % directory)
            candidates.append(version)
    if len(candidates) != 1:
        raise ValueError("expected exactly one autocad-mcp-pro distribution under %s; found %d"
                         % (site, len(candidates)))
    return candidates[0]


def _same(node, source):
    return ast.dump(node) == ast.dump(ast.parse(source).body[0])


def _contains(node, source):
    return any(_same(child, source) for child in ast.walk(node))


def _function(scope, name):
    matches = [node for node in scope.body
               if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == name]
    if len(matches) != 1:
        raise ValueError("expected one %s function" % name)
    return matches[0]


def _default(function, name, value):
    args = function.args
    defaults = dict(zip([arg.arg for arg in args.posonlyargs + args.args][-len(args.defaults):],
                        args.defaults)) if args.defaults else {}
    defaults.update(zip([arg.arg for arg in args.kwonlyargs], args.kw_defaults))
    node = defaults.get(name)
    return isinstance(node, ast.Constant) and node.value is value


def _forwards(function, method, parameter, position):
    for node in ast.walk(function):
        if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
            continue
        if node.func.attr != method:
            continue
        values = [kw.value for kw in node.keywords if kw.arg == parameter]
        if len(node.args) > position:
            values.append(node.args[position])
        if any(isinstance(value, ast.Name) and value.id == parameter for value in values):
            return True
    return False


def verify_native(base: Path, sources=None):
    """Check a reviewed AST contract, without importing or writing target code.

    Deliberately conservative: a differently implemented fix needs review, not
    a version comparison or a marker that can hide a partial implementation.
    """
    def parse(relative):
        text = sources[relative] if sources is not None else resolve(base, ("acad-site", relative)).read_text(encoding="utf-8-sig")
        return ast.parse(text)

    server = parse("server.py")
    backend = parse("backends/com_backend.py")
    classes = [node for node in backend.body if isinstance(node, ast.ClassDef) and node.name == "ComBackend"]
    if len(classes) != 1:
        raise ValueError("expected one ComBackend class")
    linear = _function(server, "dimension_linear")
    angular = _function(server, "dimension_angular")
    com_linear = _function(classes[0], "dimension_linear")
    com_angular = _function(classes[0], "dimension_angular")
    for label, function, parameter, value in (
        ("server.dimension_linear", linear, "rotation", None),
        ("ComBackend.dimension_linear", com_linear, "rotation", None),
        ("server.dimension_angular", angular, "minor_angle", True),
        ("ComBackend.dimension_angular", com_angular, "minor_angle", True),
    ):
        if not _default(function, parameter, value):
            raise ValueError("%s must default %s to %r" % (label, parameter, value))

    auto_rotation = "90.0 if abs(y2 - y1) > abs(x2 - x1) else 0.0"
    server_auto = "if rotation is None:\n    rotation = " + auto_rotation
    if not _contains(linear, server_auto):
        raise ValueError("server.dimension_linear lacks automatic vertical rotation")
    # The nominal used for fit tolerances must use the resolved rotation too.
    auto = next(node for node in ast.walk(linear) if _same(node, server_auto))
    radians = [node for node in ast.walk(linear) if _same(node, "angle = math.radians(rotation)")]
    nominal = "nominal = abs((x2 - x1) * math.cos(angle) + (y2 - y1) * math.sin(angle))"
    nominals = [node for node in ast.walk(linear) if _same(node, nominal)]
    if (not radians or not nominals or not auto.end_lineno < radians[0].lineno < nominals[0].lineno
            or not _forwards(linear, "dimension_linear", "rotation", 6)):
        raise ValueError("server.dimension_linear does not propagate resolved rotation/nominal")
    if not _forwards(angular, "dimension_angular", "minor_angle", 9):
        raise ValueError("server.dimension_angular does not forward minor_angle")

    helper = _function(backend, "_auto_linear_rotation")
    if not _contains(helper, "return math.pi / 2 if abs(y2 - y1) > abs(x2 - x1) else 0.0"):
        raise ValueError("backend automatic rotation helper lacks vertical projection logic")
    angle = "angle = _auto_linear_rotation(x1, y1, x2, y2) if rotation is None else deg2rad(rotation)"
    rotated = "dim = mspace.AddDimRotated(_apoint(x1, y1), _apoint(x2, y2), _apoint(dim_x, dim_y), angle)"
    if not _contains(com_linear, angle) or not _contains(com_linear, rotated):
        raise ValueError("ComBackend.dimension_linear does not use automatic rotation")
    sweep = _function(backend, "_ray_sweep")
    for statement in ("a1 = math.atan2(y1 - vy, x1 - vx)",
                      "a2 = math.atan2(y2 - vy, x2 - vx)",
                      "return (a2 - a1) % (2.0 * math.pi)"):
        if not _contains(sweep, statement):
            raise ValueError("backend angular sweep helper lacks CCW sweep logic")
    swap = ("if minor_angle and _ray_sweep(vx, vy, rx1, ry1, rx2, ry2) > math.pi:\n"
            "    rx1, ry1, rx2, ry2 = rx2, ry2, rx1, ry1")
    angular_call = "dim = mspace.AddDimAngular(_apoint(vx, vy), _apoint(rx1, ry1), _apoint(rx2, ry2), _apoint(tx, ty))"
    for statement in ("rx1, ry1, rx2, ry2 = x1, y1, x2, y2", swap, angular_call):
        if not _contains(com_angular, statement):
            raise ValueError("ComBackend.dimension_angular lacks minor-angle ray ordering")


def handle_180(base: Path, dry_run=False, check=False):
    """Exact 1.8.0 compatibility plan; never patch an unreviewed release."""
    try:
        verify_native(base)
    except (OSError, UnicodeError, ValueError, SyntaxError) as exc:
        print("[NEEDS  ] 1.8.0 dimension capabilities: %s" % exc)
    else:
        print("[OK     ] dimension-fixes                  1.8.0 implementation verified read-only; no additional patches applied")
        return 0

    # Reviewed against 1.8.0: use its ComCheckpoints class anchor and the shared
    # logic anchors. Preflight BOTH files before writes.
    prepared = [(patch, *prepare_one(base, patch)) for patch in PATCHES_180]
    for patch, state, detail, _ in prepared:
        if state in ("drift", "missing"):
            print("[FAIL   ] 1.8.0 compatibility %s: %s" % (patch["id"], detail))
    if any(state in ("drift", "missing") for _, state, _, _ in prepared):
        return 1
    sources = {patch["target"][1]: text for patch, _, _, text in prepared}
    # Anchors alone are not enough: verify the entire projected implementation.
    verify_native(base, sources)
    pending = False
    for patch, state, detail, text in prepared:
        if state == "applied":
            pending = True
            if not (dry_run or check):
                resolve(base, patch["target"]).write_text(text, encoding="utf-8", newline="\n")
        print("[%s] %-32s %s" % ("PATCHED" if state == "applied" else "OK     ", patch["id"], detail))
    return int(check and pending)


def main():
    ap = argparse.ArgumentParser(description="Apply the upstream fixes this bundle depends on.")
    ap.add_argument("--base", default=r"D:\cad-agents", help="install root (default: D:\\cad-agents)")
    ap.add_argument("--dry-run", action="store_true", help="report only, do not write")
    ap.add_argument("--check", action="store_true", help="exit 1 if any patch is not applied yet")
    args = ap.parse_args()

    base = Path(args.base)
    try:
        version = target_version(base)
        print("[VERSION] autocad-mcp-pro %s (target: %s)" % (version, base))
        if version == "1.8.0":
            return handle_180(base, dry_run=args.dry_run, check=args.check)
    except (OSError, UnicodeError, ValueError, SyntaxError) as exc:
        print("[FAIL   ] target validation: %s" % exc)
        return 1

    # Only the exact reviewed 1.6.0 target may reach the legacy text patches.
    worst = 0
    pending = 0
    for patch in PATCHES:
        state, detail = apply_one(base, patch, dry_run=args.dry_run or args.check)
        mark = {"applied": "PATCHED", "present": "OK     ", "missing": "SKIP   ", "drift": "DRIFT  "}[state]
        print("[%s] %-32s %s" % (mark, patch["id"], detail))
        if state in ("drift", "missing"):
            worst = 1
            if state == "drift":
                print("           upstream text moved; see %s" % patch["pr"])
        elif state == "applied":
            pending = 1

    if args.check:
        return worst or pending

    if worst:
        print()
        print("One or more patches no longer match. Check whether upstream shipped the fix:")
        for patch in PATCHES:
            print("  %s -> %s" % (patch["id"], patch["pr"]))
    return worst


if __name__ == "__main__":
    sys.exit(main())
