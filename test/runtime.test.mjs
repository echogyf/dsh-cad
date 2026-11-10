import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspectRuntime, installerArgs } from "../lib/runtime.mjs";
import { PINS } from "../lib/paths.mjs";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-cad-tests-runtime-"));
const layout = { baseDir: base, workDir: base, python: process.execPath, pyAcad: path.join(base, "python.exe"), acadExe: path.join(base, "autocad-mcp.exe") };

test("presence of only an entry point is not a healthy runtime", () => {
  fs.writeFileSync(layout.acadExe, "");
  const result = inspectRuntime(layout, { run: () => { throw new Error("must not launch missing Python"); } });
  assert.equal(result.ok, false);
  assert.ok(result.issues.includes(layout.pyAcad));
});

test("runtime validates the pinned version and required modules", () => {
  fs.writeFileSync(layout.pyAcad, "");
  const run = (version, missing = []) => () => ({ status: 0, stdout: JSON.stringify({ version, missing }) });
  assert.equal(inspectRuntime(layout, { run: run(PINS.autocadMcp.version) }).ok, true);
  assert.equal(inspectRuntime(layout, { run: run("0.0.0") }).ok, false);
  assert.equal(inspectRuntime(layout, { run: run(PINS.autocadMcp.version, ["win32com"]) }).ok, false);
});

test("normal installer never changes client config, explicit options opt in", () => {
  const args = installerArgs(layout);
  assert.ok(args.includes("-RuntimeOnly"));
  assert.ok(args.includes("-NoDshPatch"));
  assert.ok(args.includes("-SkipCodex"));
  assert.equal(args[args.indexOf("-AutocadVersion") + 1], PINS.autocadMcp.version);
  assert.ok(!installerArgs(layout, { dshPatch: true }).includes("-RuntimeOnly"));
  assert.ok(!installerArgs(layout, { withCodex: true }).includes("-SkipCodex"));
});

test("missing base interpreter has an actionable error", () => {
  assert.throws(() => installerArgs({ ...layout, python: null, pythonError: "Set CAD_PYTHON" }), /CAD_PYTHON/);
});

test.after(() => {
  assert.ok(path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep + "dsh-cad-tests-runtime-"));
  fs.rmSync(base, { recursive: true, force: true });
});
