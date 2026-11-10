// Unit-test registration logic with an explicit peer double. The real DSH peer
// is validated by the separately recorded desktop/AutoCAD integration test.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createPlugin } from "../lib/plugin.mjs";

const peer = { inject: ["tools"] };
const base = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-cad-tests-plugin-"));
const layout = {
  baseDir: base, workDir: path.join(base, "drawings"), python: path.join(base, "base-python.exe"),
  pythonSource: "dsh-runtime", pyAcad: path.join(base, "venv-autocad", "Scripts", "python.exe"),
  acadExe: path.join(base, "venv-autocad", "Scripts", "autocad-mcp.exe"), backend: "com", progId: "AutoCAD.Application.25.1",
};
const envKeys = ["CAD_DISABLE", "CAD_ASSUME", "CAD_NO_AUTO_INSTALL"];
function attempt({ env = {}, checkRuntime = () => ({ ok: true, issues: [] }), run = () => ({ status: 0, stdout: '{"autocad":true}' }), platform = "win32" } = {}) {
  const saved = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
  for (const key of envKeys) { if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key]; }
  const rows = [];
  const plugin = createPlugin(peer, { checkRuntime, run, resolveLayout: () => layout, platform });
  let error;
  try { plugin.apply({ plugin: (mod, config) => rows.push({ mod, config }) }); }
  catch (e) { error = e; }
  finally { for (const key of envKeys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } }
  return { rows, error, plugin };
}

test("registers exactly one real-client instance with COM and absolute Python", () => {
  const { rows, error, plugin } = attempt();
  assert.ifError(error);
  assert.equal(plugin.name, "dsh-cad");
  assert.deepEqual(plugin.inject, peer.inject);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].mod, peer);
  const cfg = rows[0].config;
  assert.equal(cfg.serverName, "autocad");
  assert.equal(cfg.transport, "stdio");
  assert.equal(cfg.command, layout.pyAcad);
  assert.deepEqual(cfg.args, ["-m", "server"]);
  assert.equal(cfg.env.AUTOCAD_MCP_BACKEND, "com");
  assert.equal(cfg.env.CAD_PROGID, layout.progId);
  assert.equal(cfg.env.DISCOVERY_MODE, "search");
  assert.equal(cfg.env.TOOL_PACKS, "all");
  assert.equal(cfg.env.ALLOWED_PATHS, layout.workDir);
  assert.equal(cfg.failOnStartupError, true);
  assert.equal(cfg.toolCallTimeoutMs, 180000);
  assert.equal(cfg.reconnect.enabled, true);
});

test("disabled means no installation or probe, even with CAD_ASSUME", () => {
  const result = attempt({ env: { CAD_DISABLE: "autocad", CAD_ASSUME: "autocad" }, checkRuntime: () => { throw new Error("must not inspect"); }, run: () => { throw new Error("must not spawn"); } });
  assert.equal(result.rows.length, 0);
  assert.match(result.error.message, /disabled/);
});

test("missing upstream with installation disabled never registers", () => {
  const result = attempt({ env: { CAD_NO_AUTO_INSTALL: "1" }, checkRuntime: () => ({ ok: false, issues: ["missing Python"] }), run: () => { throw new Error("must not spawn"); } });
  assert.match(result.error.message, /upstream missing/);
  assert.equal(result.rows.length, 0);
});

test("missing COM is refused instead of handing the agent broken tools", () => {
  const result = attempt({ run: () => ({ status: 0, stdout: '{"autocad":false}' }) });
  assert.equal(result.rows.length, 0);
  assert.match(result.error.message, /COM server/);
});

test("CAD_ASSUME is explicit and avoids the COM probe", () => {
  const result = attempt({ env: { CAD_ASSUME: "autocad" }, run: () => { throw new Error("probe must be skipped"); } });
  assert.ifError(result.error);
  assert.equal(result.rows.length, 1);
});

test("installer is runtime-only, carries pin, then health is rechecked", () => {
  let checks = 0;
  const calls = [];
  const result = attempt({ env: { CAD_ASSUME: "autocad" }, checkRuntime: () => ({ ok: ++checks > 1, issues: ["not installed"] }), run: (exe, args, options) => { calls.push({ exe, args, options }); return { status: 0 }; } });
  assert.ifError(result.error);
  assert.equal(checks, 2);
  assert.ok(calls[0].args.includes("-RuntimeOnly"));
  assert.ok(calls[0].args.includes("-SkipCodex"));
  assert.ok(calls[0].args.includes("-AutocadVersion"));
  assert.equal(calls[0].options.stdio, "inherit");
});

test("failed installer and non-Windows hosts register nothing", () => {
  const failed = attempt({ checkRuntime: () => ({ ok: false, issues: ["missing"] }), run: () => ({ status: 9 }) });
  assert.match(failed.error.message, /exit 9/);
  assert.equal(failed.rows.length, 0);
  const other = attempt({ platform: "linux" });
  assert.match(other.error.message, /Windows/);
  assert.equal(other.rows.length, 0);
});

test.after(() => {
  assert.ok(path.resolve(base).startsWith(path.resolve(os.tmpdir()) + path.sep + "dsh-cad-tests-plugin-"));
  fs.rmSync(base, { recursive: true, force: true });
});
