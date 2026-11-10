// Registration logic is independent of the MCP peer so unit tests never skip.
// lib/index.js is the real DSH entry point; only that entry imports the real peer.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { PKG, PKG_ROOT, exists, resolveLayout } from "./paths.mjs";
import { autocadConfig, inspectRuntime, installerArgs, powershell } from "./runtime.mjs";

const PREFIX = "[dsh-cad]";
const say = (message) => process.stderr.write(`${PREFIX} ${message}\n`);
const listEnv = (key) => (process.env[key] || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);

export function createPlugin(McpClient, dependencies = {}) {
  const run = dependencies.run || spawnSync;
  const checkRuntime = dependencies.checkRuntime || inspectRuntime;
  const getLayout = dependencies.resolveLayout || resolveLayout;
  const platform = dependencies.platform || process.platform;

  function ensureUpstream(layout) {
    let status = checkRuntime(layout);
    if (status.ok) return;
    if (process.env.CAD_NO_AUTO_INSTALL === "1") {
      throw new Error(`${PREFIX} upstream missing or unhealthy (${status.issues.join(", ")}) and CAD_NO_AUTO_INSTALL=1. Run dsh-cad install.`);
    }
    const args = installerArgs(layout);
    if (!exists(path.join(PKG_ROOT, "bootstrap.ps1"))) throw new Error(`${PREFIX} bootstrap.ps1 is missing`);
    say(`preparing AutoCAD MCP ${layout.pythonSource || "explicit"} Python: ${layout.python}`);
    const result = run(powershell(), args, { stdio: "inherit" });
    if (result.error || result.status !== 0) {
      throw new Error(`${PREFIX} upstream installer failed: ${result.error?.message || `exit ${result.status}`}. Run dsh-cad install to inspect the error.`);
    }
    status = checkRuntime(layout);
    if (!status.ok) throw new Error(`${PREFIX} upstream still unhealthy: ${status.issues.join(", ")}`);
  }

  function detectCad(layout) {
    const result = run(exists(layout.pyAcad) ? layout.pyAcad : layout.python,
      [path.join(PKG_ROOT, "lib", "probe.py"), layout.progId],
      { encoding: "utf8", timeout: 20000, windowsHide: true });
    if (result.error || result.status !== 0 || !result.stdout) return false;
    try { return Boolean(JSON.parse(result.stdout.trim().split(/\r?\n/).pop()).autocad); }
    catch { return false; }
  }

  function apply(ctx, config = {}) {
    if (PKG.os && !PKG.os.includes(platform)) throw new Error(`${PREFIX} Windows is required.`);
    // Check this before installation: explicitly disabled must have no side effects.
    if (listEnv("CAD_DISABLE").includes("autocad")) throw new Error(`${PREFIX} AutoCAD is disabled by CAD_DISABLE.`);
    const layout = getLayout(config);
    ensureUpstream(layout);
    if (!listEnv("CAD_ASSUME").includes("autocad") && !detectCad(layout)) {
      throw new Error(`${PREFIX} AutoCAD COM server ${layout.progId} was not detected. Install AutoCAD, check progId, or set CAD_ASSUME=autocad only if the probe is wrong.`);
    }
    fs.mkdirSync(layout.workDir, { recursive: true });
    ctx.plugin(McpClient, autocadConfig(layout));
    say(`registered autocad (backend ${layout.backend}, base ${layout.baseDir})`);
  }

  return { name: "dsh-cad", inject: McpClient.inject, apply };
}
