// The dsh plugin entry point.
//
// This is a real plugin, not a patch that spawns a binary: dsh imports this
// module by package name, so nothing has to be on PATH. Every path is resolved
// here, at load time, from this file's own location plus ~/.dsh/cad.json.
//
// Two things happen in apply():
//   1. make sure the pinned upstream server is installed (installing it
//      here, once, if it is not), and throw with an actionable message when
//      that is impossible;
//   2. register the AutoCAD MCP client with absolute paths.
//
// Registering only after the check is what keeps a missing upstream from
// turning into a silent no-tool session.
import { spawnSync } from "node:child_process";
import path from "node:path";

import * as McpClient from "@deepseek-ai/dsh-mcp-client";

import { PKG, PKG_ROOT, exists, missingPieces, resolveLayout } from "./paths.mjs";

export const name = "dsh-cad";
// Wait for the same services the MCP client needs.
export const inject = McpClient.inject;

const LOG_PREFIX = "[dsh-cad]";

function say(msg) {
  process.stderr.write(`${LOG_PREFIX} ${msg}\n`);
}

function powershell() {
  const ps = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  return exists(ps) ? ps : "powershell";
}

function installerArgs(layout) {
  return [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", path.join(PKG_ROOT, "bootstrap.ps1"),
    "-BaseDir", layout.baseDir,
    "-WorkDir", layout.workDir,
    "-Python", layout.python,
    "-NoDshPatch",
  ];
}

function installPinned(layout) {
  if (process.platform !== "win32") {
    throw new Error(
      `${LOG_PREFIX} this bundle only runs on Windows (AutoCAD is a COM server).`,
    );
  }
  const script = path.join(PKG_ROOT, "bootstrap.ps1");
  if (!exists(script)) {
    throw new Error(`${LOG_PREFIX} bootstrap.ps1 is missing from the package at ${script}`);
  }
  say("the upstream server is not installed yet; installing the pinned version now.");
  say("this runs once and takes a few minutes.");
  const res = spawnSync(powershell(), installerArgs(layout), { stdio: "inherit" });
  if (res.error) {
    throw new Error(`${LOG_PREFIX} could not run the installer: ${res.error.message}`);
  }
  if (res.status !== 0) {
    throw new Error(
      `${LOG_PREFIX} installing the upstream server failed (exit ${res.status}).\n` +
        `Re-run it by hand to see the full output:\n  node "${path.join(PKG_ROOT, "bin", "dsh-cad.mjs")}" install`,
    );
  }
}

// Ask the registry whether the AutoCAD COM server is registered. This is the
// authoritative check: without a ProgID, COM automation cannot start the
// application wherever its files live. It does not launch the application.
function detectCad(python) {
  const script = path.join(PKG_ROOT, "lib", "probe.py");
  if (!exists(script)) return null;
  let res;
  try {
    res = spawnSync(python, [script], { encoding: "utf8", timeout: 20000 });
  } catch {
    return null;
  }
  if (res.status !== 0 || !res.stdout) return null;
  try {
    return JSON.parse(res.stdout.trim().split("\n").pop());
  } catch {
    return null;
  }
}

function listEnv(name) {
  return (process.env[name] || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

function chooseTargets(layout) {
  const disabled = listEnv("CAD_DISABLE");
  // CAD_ASSUME forces the side on when the registry probe cannot see it — for
  // a machine where the ProgID lookup is blocked, and for tests that must not
  // depend on what is installed on the host.
  const assumed = listEnv("CAD_ASSUME");
  const present = detectCad(exists(layout.pyAcad) ? layout.pyAcad : layout.python);
  const out = [];
  for (const name of ["autocad"]) {
    if (disabled.includes(name)) {
      say(`${name}: skipped, listed in CAD_DISABLE`);
      continue;
    }
    const detected = present && present[name];
    if (!detected && !assumed.includes(name)) {
      say(`${name}: no COM server registered on this machine, not registering it`);
      continue;
    }
    if (!detected) say(`${name}: forced on by CAD_ASSUME`);
    out.push(name);
  }
  if (out.length === 0) {
    throw new Error(
      `${LOG_PREFIX} AutoCAD is not installed, so there is nothing to drive.\n` +
        `Install it, or set CAD_ASSUME=autocad if the registry probe is wrong.`,
    );
  }
  return out;
}

function ensureUpstream(layout) {
  let missing = missingPieces(layout);
  if (missing.length === 0) return;

  if (process.env.CAD_NO_AUTO_INSTALL === "1") {
    throw new Error(
      `${LOG_PREFIX} upstream missing (${missing.join(", ")}) and CAD_NO_AUTO_INSTALL=1 is set, ` +
        `so nothing was installed. Unset it, or run:\n` +
        `  node "${path.join(PKG_ROOT, "bin", "dsh-cad.mjs")}" install`,
    );
  }

  installPinned(layout);

  missing = missingPieces(layout);
  if (missing.length > 0) {
    throw new Error(
      `${LOG_PREFIX} still missing after install: ${missing.join(", ")}\n` +
        `Run "node "${path.join(PKG_ROOT, "bin", "dsh-cad.mjs")}" doctor" for a per-item report.`,
    );
  }
}

function autocadConfig(layout) {
  return {
    serverName: "autocad",
    transport: "stdio",
    command: layout.acadExe,
    args: [],
    env: {
      AUTOCAD_MCP_BACKEND: "auto",
      TOOL_PROFILE: "full",
      TOOL_PACKS: "all",
      DISCOVERY_MODE: "search",
      ALLOWED_PATHS: layout.workDir,
    },
    toolCallTimeoutMs: 180000,
    // A server that cannot start should say so, not retry in silence.
    failOnStartupError: true,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
  };
}

export function apply(ctx) {
  const layout = resolveLayout();

  if (PKG.os && !PKG.os.includes(process.platform)) {
    throw new Error(`${LOG_PREFIX} this bundle only runs on ${PKG.os.join(", ")}.`);
  }

  ensureUpstream(layout);

  // Only register the side that actually has a CAD application to drive.
  // Registering it without AutoCAD would hand the model tools that can only fail.
  const targets = chooseTargets(layout);
  const configs = {
    autocad: autocadConfig(layout),
  };
  for (const name of targets) {
    ctx.plugin(McpClient, configs[name]);
  }

  say(
    `registered ${targets.join(" + ")} (base ${layout.baseDir}, upstream pinned in lib/upstream.json)`,
  );
}
