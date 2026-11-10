// What the plugin registers, and what it refuses to register.
//
// Runs anywhere with Node: it imports the real MCP client when it is installed
// (npm test installs it as a devDependency) and skips when it is not, so the
// check never blocks on an environment that cannot resolve the peer.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, "..");

let peer = null;
try {
  peer = await import("@deepseek-ai/dsh-mcp-client");
} catch {
  // A developer without devDependencies can skip; CI cannot — a skipped test
  // that exits 0 is a green run that verified nothing.
  if (process.env.CI) {
    console.error("FAIL: @deepseek-ai/dsh-mcp-client missing in CI; run npm install first");
    process.exit(1);
  }
  console.log("SKIP: @deepseek-ai/dsh-mcp-client is not installed (npm install)");
  process.exit(0);
}

// A throwaway install root: the plugin only needs the entry point to exist for
// the registration cases. This keeps the test independent of the host and stops
// it from triggering a real install.
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "cad-test-home-"));
const fakeBase = fs.mkdtempSync(path.join(os.tmpdir(), "cad-test-base-"));
const fakeExe = process.platform === "win32" ? ".exe" : "";
const fakeScripts = path.join(fakeBase, "venv-autocad", "Scripts");
fs.mkdirSync(fakeScripts, { recursive: true });
fs.writeFileSync(path.join(fakeScripts, "autocad-mcp" + fakeExe), "");

const plugin = await import(pathToFileURL(path.join(pkgRoot, "lib", "index.js")).href);

assert.equal(plugin.name, "dsh-cad", "the plugin must be loadable by package name");
assert.equal(typeof plugin.apply, "function", "apply must be a function");
assert.deepEqual(plugin.inject, peer.inject, "inject must match the MCP client's");

function attempt(env) {
  const saved = {};
  const full = {
    CAD_BASE: fakeBase,
    DSH_HOME: fakeHome,
    CAD_NO_AUTO_INSTALL: "1",
    ...env,
  };
  for (const k of Object.keys(full)) {
    saved[k] = process.env[k];
    if (full[k] === undefined) delete process.env[k];
    else process.env[k] = full[k];
  }
  const registered = [];
  const ctx = { plugin: (mod, cfg) => registered.push({ mod, cfg }) };
  let err = null;
  try {
    plugin.apply(ctx);
  } catch (e) {
    err = e;
  }
  Object.assign(process.env, saved);
  return { registered, err };
}

try {
  // --- AutoCAD present ------------------------------------------------------
  // CAD_ASSUME makes the expected result independent of what this machine has
  // installed: CI runners have no AutoCAD.
  const present = attempt({ CAD_DISABLE: undefined, CAD_ASSUME: "autocad" });
  assert.equal(present.registered.length, 1, "must register exactly the AutoCAD row");
  for (const r of present.registered) {
    assert.equal(r.mod, peer, "must register the MCP client itself");
    assert.ok(path.isAbsolute(r.cfg.command), "command must be absolute, not a PATH name");
    assert.equal(r.cfg.transport, "stdio");
    assert.equal(r.cfg.failOnStartupError, true, "a server that cannot start must say so");
  }
  assert.deepEqual(present.registered.map((r) => r.cfg.serverName), ["autocad"]);
  const acad = present.registered[0].cfg;
  assert.equal(acad.env.AUTOCAD_MCP_BACKEND, "auto", "AutoCAD backend selection must be unchanged");
  assert.equal(acad.env.TOOL_PROFILE, "full", "the full tool catalog must stay searchable");
  assert.equal(acad.env.TOOL_PACKS, "all", "all tool packs must stay searchable");
  assert.equal(acad.env.DISCOVERY_MODE, "search", "upstream discovery mode must stay on");
  assert.equal(acad.toolCallTimeoutMs, 180000, "the AutoCAD timeout must be unchanged");
  assert.equal(acad.reconnect.enabled, true, "reconnect must stay enabled");
  console.log("autocad present ->", present.registered.map((r) => r.cfg.serverName).join(", "));

  // --- explicitly disabled: throw, do not register rows that cannot work ---
  const none = attempt({ CAD_DISABLE: "autocad", CAD_ASSUME: "autocad" });
  assert.equal(none.registered.length, 0, "must not register rows that cannot start");
  assert.ok(none.err, "must throw when nothing is left to drive");
  assert.match(none.err.message, /AutoCAD is not installed/i);
  console.log("autocad off     -> throws, registers nothing");

  // Detection path: with nothing assumed and nothing registered, refuse rather
  // than register a row that cannot start. Skipped on a machine that has CAD.
  const bare = attempt({ CAD_DISABLE: undefined, CAD_ASSUME: undefined });
  if (bare.registered.length === 0) {
    assert.ok(bare.err, "must throw when nothing is detected");
    console.log("nothing detected -> throws, registers nothing");
  } else {
    console.log("nothing detected -> skipped (this machine has AutoCAD installed)");
  }

  // --- a machine with no upstream installed is an error, not a silent skip --
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "cad-test-empty-"));
  try {
    const registered = [];
    const ctx = { plugin: (m, c) => registered.push(c) };
    let err = null;
    const saved = process.env.CAD_BASE;
    process.env.CAD_BASE = empty;
    process.env.CAD_NO_AUTO_INSTALL = "1";
    try {
      plugin.apply(ctx);
    } catch (e) {
      err = e;
    }
    assert.equal(registered.length, 0, "must not register anything when the upstream is missing");
    assert.ok(err, "must throw when the upstream is missing and auto-install is off");
    assert.match(err.message, /upstream missing/i);
    console.log("no upstream     -> throws, registers nothing");
    if (saved === undefined) delete process.env.CAD_BASE;
    else process.env.CAD_BASE = saved;
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }

  console.log("\nall cases behave as intended");
} finally {
  fs.rmSync(fakeBase, { recursive: true, force: true });
  fs.rmSync(fakeHome, { recursive: true, force: true });
}
