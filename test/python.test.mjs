import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { discoverPython, pythonCandidates } from "../lib/python.mjs";
import { resolveLayout } from "../lib/paths.mjs";

const env = { DSH_HOME: path.resolve("fake-dsh-home"), PATH: path.resolve("fake-path") };
const baseOptions = { env, readDir: () => [], exists: () => true };
const response = (version = [3, 12, 14], more = {}) => ({ status: 0, stdout: JSON.stringify({ version, venv: true, pip: true, ...more }) });

test("DSH runtime is preferred over PATH and reported", () => {
  const selected = discoverPython({ ...baseOptions, run: () => response() });
  assert.equal(selected.source, "dsh-runtime");
  assert.equal(selected.version, "3.12.14");
  assert.ok(selected.executable.includes("dsh-primary-runtime"));
});

test("explicit interpreter wins and an invalid explicit path never falls back", () => {
  const requested = path.resolve("explicit python", "python.exe");
  const selected = discoverPython({ ...baseOptions, requested, run: () => response() });
  assert.equal(selected.executable, requested);
  const invalid = discoverPython({ ...baseOptions, requested, exists: () => false, run: () => { throw new Error("must not run"); } });
  assert.equal(invalid.executable, null);
  assert.match(invalid.error, /CAD_PYTHON/);
});

test("old, malformed and incomplete interpreters are rejected", () => {
  for (const result of [response([3, 10, 9]), response([3, 12, 1], { pip: false }), { status: 0, stdout: "not json" }, { status: 1, stdout: "" }]) {
    const selected = discoverPython({ ...baseOptions, requested: path.resolve("python.exe"), run: () => result });
    assert.equal(selected.executable, null);
  }
});

test("Windows Store aliases are never executed", () => {
  const alias = path.resolve("Microsoft", "WindowsApps", "python.exe");
  const selected = discoverPython({ ...baseOptions, requested: alias, run: () => { throw new Error("Store alias must not execute"); } });
  assert.equal(selected.executable, null);
  assert.match(selected.error, /alias skipped/);
});

test("another DSH runtime is considered when primary is unavailable", () => {
  const entries = [{ name: "another-runtime", isDirectory: () => true }];
  const selected = discoverPython({ ...baseOptions, readDir: () => entries, exists: (p) => p.includes("another-runtime"), run: () => response() });
  assert.ok(selected.executable.includes("another-runtime"));
});

test("DSH_HOME controls interpreter discovery", () => {
  const candidates = pythonCandidates({ env, readDir: () => [] });
  assert.ok(candidates[0].executable.startsWith(env.DSH_HOME));
});

test("override beats CAD_PYTHON and stale config; legacy python means automatic", () => {
  let requested;
  const discover = (options) => { requested = options.requested; return { executable: path.resolve("chosen-python.exe"), source: "explicit", version: "3.12.14", error: null }; };
  resolveLayout({ python: "override.exe" }, { config: { python: "old.exe" }, env: { CAD_PYTHON: "environment.exe" }, discover });
  assert.equal(requested, "override.exe");
  resolveLayout({}, { config: { python: "old.exe" }, env: { CAD_PYTHON: "environment.exe" }, discover });
  assert.equal(requested, "environment.exe");
  const layout = resolveLayout({}, { config: { python: "python" }, env: {}, discover });
  assert.equal(requested, undefined);
  assert.equal(layout.backend, "com");
});
