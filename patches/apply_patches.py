#!/usr/bin/env python
"""Apply the upstream AutoCAD fixes this bundle depends on, idempotently.

Both fixes are offered upstream as pull requests. Until those land (or if a user
installs a release that predates them), the installed copy is missing them, and
the symptoms are silent: a vertical dimension measures 0.0, and an angular
dimension's DXF sweep disagrees with its COM measurement.

Each patch is a list of (old, new) string replacements plus a marker. The marker
is checked first, so running this twice is safe, and a patch whose anchor has
moved is reported as "drift" instead of being applied blindly to the wrong code.

Exit code: 0 when every patch is applied or already present, 1 when any patch
could not be applied because the upstream text changed.
"""
import argparse
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


def resolve(base: Path, target):
    kind, rel = target
    if kind == "acad-site":
        return base / "venv-autocad" / "Lib" / "site-packages" / rel
    raise ValueError("unknown target kind: %s" % kind)


def apply_one(base: Path, patch, dry_run=False):
    path = resolve(base, patch["target"])
    if not path.is_file():
        return "missing", "not installed: %s" % path

    text = path.read_text(encoding="utf-8")
    if patch["marker"] in text:
        return "present", "already applied"

    applied = 0
    skipped = []
    for old, new in patch["edits"]:
        if new in text:
            continue
        if old in text:
            text = text.replace(old, new, 1)
            applied += 1
        else:
            skipped.append(old.strip().splitlines()[0][:60])

    if skipped:
        return "drift", "anchor not found: " + " | ".join(skipped)

    if applied == 0:
        return "present", "already applied"

    if not dry_run:
        path.write_text(text, encoding="utf-8", newline="\n")
    return "applied", "%d edit(s) in %s" % (applied, path.name)


def main():
    ap = argparse.ArgumentParser(description="Apply the upstream fixes this bundle depends on.")
    ap.add_argument("--base", default=r"D:\cad-agents", help="install root (default: D:\\cad-agents)")
    ap.add_argument("--dry-run", action="store_true", help="report only, do not write")
    ap.add_argument("--check", action="store_true", help="exit 1 if any patch is not applied yet")
    args = ap.parse_args()

    base = Path(args.base)
    worst = 0
    pending = 0
    for patch in PATCHES:
        state, detail = apply_one(base, patch, dry_run=args.dry_run or args.check)
        mark = {"applied": "PATCHED", "present": "OK     ", "missing": "SKIP   ", "drift": "DRIFT  "}[state]
        print("[%s] %-32s %s" % (mark, patch["id"], detail))
        if state == "drift":
            worst = 1
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
