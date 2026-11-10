# Patches

Two upstream AutoCAD defects are handled here. Both are **silent**: nothing
raises, nothing appears in the return value, and the damage only shows in the
drawing or in a file read back later.

The target version is read **only** from distribution `METADATA` inside
`--base/venv-autocad/Lib/site-packages`, never from the Python interpreter running
the script. Missing, duplicate, malformed, directory/version-mismatched or
unknown release metadata fails with exit code 1 before any patch is attempted.
Only the exact versions **1.6.0** and **1.8.0** are supported; no `>=` shortcut
assumes later upstream releases contain a fix.

- **1.6.0:** preserve the legacy, idempotent text patches below.
- **1.8.0:** first verify both the server and `ComBackend` using AST, without
  importing upstream modules. If the complete dimension fixes are present,
  return success **read-only**. Otherwise use the explicitly reviewed 1.8.0
  compatibility plan: all replacement anchors in **both** files must match
  uniquely, and the projected source must pass the same AST checks **before
  either file is written**. Drift or incomplete capability fails closed.

The inspected upstream 1.8.0 installation still defaulted linear rotation to
`0.0` and did not expose `minor_angle` in either layer. Therefore 1.8.0 is **not**
claimed to have these fixes natively. Its class declaration adds `ComCheckpoints`,
so the 1.8.0 plan uses a **different helper-insertion anchor**. Its extra `xdata`
handling and COM comment do not alter the reviewed dimension-logic anchors;
only those individual replacements are shared with 1.6.0, never by version range.

A marker alone never proves success: all replacements are checked. For 1.8.0,
AST checks cover defaults, automatic vertical projection, the fit nominal,
rotation/minor-angle forwarding, and CCW sweep/ray swapping before COM creation.
These conservative checks recognize the reviewed implementation, not arbitrary
semantically equivalent code; a different upstream structure requires review.

```powershell
# inspect an explicit installation (exit 1 if a fix is pending or invalid)
python patches\apply_patches.py --base D:\cad-agents --check

# preview: all validation, no writes
python patches\apply_patches.py --base D:\cad-agents --dry-run

# apply only the exact supported release's reviewed plan
python patches\apply_patches.py --base D:\cad-agents
```

`install.ps1` runs it as step 5b, and `bootstrap.ps1` reports it as
`upstream-patches`, repairing it like any other missing item.

## acad-dimension-rotation

- **Target:** `venv-autocad/Lib/site-packages/backends/com_backend.py`
- **Upstream:** <https://github.com/U-C4N/Autocad-MCP/pull/16>
- **Symptom:** every vertical linear dimension measured **0.0**, with the entity
  created and no error reported.

`AddDimRotated` measures the projection of the two points onto the dimension
line. `rotation` defaulted to `0.0`, so a vertical pair (same X) projected to
nothing. Now `None` means "follow the points" — a mostly vertical pair gets 90°.
An explicit rotation is still honoured.

The patch also adds `minor_angle` to `dimension_angular`. `AddDimAngular` sweeps
counter-clockwise from ray 1 to ray 2 and that sweep is what lands in the DXF,
while the entity's COM `Measurement` always reports the minor angle — the same
geometry reads 30° on screen and 330° in the file. The rays are ordered before
the entity is created, so both views agree.

Verified on AutoCAD 2026: vertical 70 → 70.0000, horizontal 100 → 100.0000,
explicit `rotation=90` on horizontal points → 0.0000; a 200° sweep exports as
160° with `minor_angle=True` and 200° with `False`.

## acad-dimension-tool-defaults

- **Target:** `venv-autocad/Lib/site-packages/server.py`
- **Upstream:** same PR as above
- **Why separate:** the tool layer computes the nominal value used for fit
  tolerances from `rotation`. If only the backend learns about `None`, the
  tolerance text is computed at 0° while the dimension is drawn at 90°.

Changes the tool signature to `rotation: float | None = None`, resolves it the
same way the backend does before computing the nominal, and exposes
`minor_angle`.

## Validation and future releases

Exit code 0 means the supported installation passes, or `--dry-run` confirms
that its complete plan can be applied. `--check` never writes and returns 1 if
any fix is pending. Missing targets, metadata failures, unsupported versions,
anchor drift and failed AST checks return 1. Normal apply mode only writes when
validation succeeds. An already-fixed 1.8.0 installation remains byte-for-byte
unchanged in every mode.

Regression tests use temporary fixtures only; no package installation, CAD
startup or changes to an existing runtime are needed:

```powershell
python -B test\patches.test.py -v
```

When upstream ships a different release, inspect its source and metadata before
adding an exact supported version and regression fixtures. Do not remove the
1.6.0 fallback, widen a version comparison, or treat `minor_angle`/helper names
alone as proof that the implementation is complete. Static validation is not a
replacement for a separate AutoCAD/COM smoke test on a candidate installation.
