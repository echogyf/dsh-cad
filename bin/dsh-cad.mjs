#!/usr/bin/env node
// dsh-cad -- one entry point for the AutoCAD MCP server this bundle installs.
//
//   dsh-cad serve autocad       stdio MCP server for AutoCAD (used by dsh)
//   dsh-cad install             install the upstream server (idempotent)
//   dsh-cad doctor              report what is present or missing, change nothing
//   dsh-cad where               print the resolved paths
//
// `serve` is what the cordis patch calls. It resolves paths from this package's
// own location plus ~/.dsh/cad.json, so the patch itself carries no absolute
// path and the same bundle works on any machine.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { autocadConfig, inspectRuntime, installerArgs, powershell } from "../lib/runtime.mjs";

import {
  CONFIG_FILE,
  PKG,
  PKG_ROOT,
  PINS,
  exists,
  readConfig,
  resolveLayout,
  writeConfig,
} from "../lib/paths.mjs";

const HELP = `dsh-cad ${PKG.version}

  serve autocad                run the AutoCAD MCP server over stdio (called by dsh)
  install [--base <dir>] [--work <dir>] [--python <exe>] [--force] [--with-dsh-patch] [--with-codex]
                               install the upstream AutoCAD MCP; only the missing
                               parts are touched
  doctor                       report present/missing pieces, change nothing
  where                        print the resolved paths
  version                      print the version

Environment:
  CAD_BASE              base directory (default: first of D:/E:/F: then ~)
  CAD_NO_AUTO_INSTALL   set to 1 to stop "serve" from installing on demand
`;

function log(msg) {
  process.stderr.write(`[dsh-cad] ${msg}\n`);
}

function die(msg, code = 1) {
  log(msg);
  process.exit(code);
}

function runInstaller(layout, options = {}) {
  const script = path.join(PKG_ROOT, "bootstrap.ps1");
  if (!exists(script)) die(`bootstrap.ps1 is missing from the package at ${script}`);
  try {
    return spawnSync(powershell(), installerArgs(layout, options), { stdio: "inherit" });
  } catch (error) {
    die(error.message);
  }
}

// ---------------------------------------------------------------- commands

function cmdServe(target) {
  if (target !== "autocad") {
    die(`serve needs a target: autocad (got ${target || "nothing"})`);
  }
  const layout = resolveLayout();
  const missing = inspectRuntime(layout).issues;

  if (missing.length && process.env.CAD_NO_AUTO_INSTALL !== "1") {
    log(`${target} needs ${missing.length} missing piece(s); installing them once.`);
    log("set CAD_NO_AUTO_INSTALL=1 to disable this.");
    const res = runInstaller(layout, { check: false, force: false, dshPatch: false });
    if (res.status !== 0) {
      log("install failed; the server will not start.");
      log(`run "dsh-cad install" by hand to see the full output.`);
      process.exit(1);
    }
    const still = inspectRuntime(layout).issues;
    if (still.length) {
      log(`still missing after install: ${still.join(", ")}`);
      process.exit(1);
    }
  } else if (missing.length) {
    log(`cannot start ${target}, missing: ${missing.join(", ")}`);
    log(`run "dsh-cad install" first.`);
    process.exit(1);
  }

  serveAutocad(layout);
}

function serveAutocad(layout) {
  const config = autocadConfig(layout);
  const env = { ...process.env, ...config.env };
  relay(spawn(config.command, config.args, { cwd: config.cwd, env, stdio: "inherit" }), "autocad");
}

function relay(child, name) {
  child.on("error", (err) => die(`${name} failed to start: ${err.message}`));
  child.on("exit", (code, signal) => {
    if (signal) log(`${name} exited on ${signal}`);
    process.exit(code ?? 1);
  });
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      try {
        child.kill(sig);
      } catch {}
    });
  }
}

function cmdInstall(argv) {
  const layout = resolveLayout(parseFlags(argv));
  log(`base ${layout.baseDir}`);
  log(`work ${layout.workDir}`);
  const res = runInstaller(layout, {
    check: false,
    force: argv.includes("--force"),
    dshPatch: argv.includes("--with-dsh-patch"),
    withCodex: argv.includes("--with-codex"),
  });
  if (res.status !== 0) {
    die(`installer exited with ${res.status}; see the output above.`);
  }
  writeConfig({
    ...(readConfig() || {}),
    baseDir: layout.baseDir,
    workDir: layout.workDir,
    python: layout.python,
    backend: layout.backend,
    progId: layout.progId,
    launchMode: layout.launchMode,
    installedAt: new Date().toISOString(),
    version: PKG.version,
  });
  log(`wrote ${CONFIG_FILE}`);
  log("done. dsh picks the server up from the bundle patch (dsh plugin add).");
  log("installed without `dsh plugin add`? rerun with --with-dsh-patch.");
}

function cmdDoctor() {
  const layout = resolveLayout();
  log(`package  ${PKG_ROOT} (v${PKG.version})`);
  log(`pinned   autocad-mcp-pro ${PINS.autocadMcp.version}`);

  // Which side actually has a CAD application to drive. It is only
  // registered when the COM server is present; otherwise it is skipped.
  const probe = path.join(PKG_ROOT, "lib", "probe.py");
  const py = exists(layout.pyAcad) ? layout.pyAcad : layout.python;
  if (exists(probe) && py) {
    const r = spawnSync(py, [probe], { encoding: "utf8", timeout: 20000 });
    let cad = null;
    try {
      cad = JSON.parse((r.stdout || "").trim().split("\n").pop());
    } catch {}
    if (cad) {
      log(`cad apps  autocad: ${cad.autocad ? "registered" : "not found"}`);
      if (!cad.autocad) {
        log(`          AutoCAD is not installed; the plugin will not register any MCP row`);
      }
    } else {
      log(`cad apps  probe failed`);
    }
  }
  log(`config   ${exists(CONFIG_FILE) ? CONFIG_FILE : "(none yet)"}`);
  const res = runInstaller(layout, { check: true, force: false });
  process.exit(res.status === 0 ? 0 : 1);
}

function cmdWhere() {
  const layout = resolveLayout();
  const rows = {
    baseDir: layout.baseDir,
    workDir: layout.workDir,
    "base Python": layout.python || "(not found)",
    "autocad Python": layout.pyAcad,
    "autocad exe": layout.acadExe,
  };
  for (const [k, v] of Object.entries(rows)) {
    console.log(`${exists(v) ? "ok  " : "--  "} ${k.padEnd(18)} ${v}`);
  }
  console.log(`info ${"Python source".padEnd(18)} ${layout.pythonSource || layout.pythonError}`);
}

function parseFlags(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--base") out.baseDir = argv[++i];
    else if (a === "--work") out.workDir = argv[++i];
    else if (a === "--python") out.python = argv[++i];
  }
  return out;
}

// ---------------------------------------------------------------- dispatch

const [cmd, ...rest] = process.argv.slice(2);
switch (cmd) {
  case "serve":
    cmdServe(rest[0]);
    break;
  case "install":
    cmdInstall(rest);
    break;
  case "doctor":
    cmdDoctor();
    break;
  case "where":
    cmdWhere();
    break;
  case "version":
  case "--version":
  case "-v":
    console.log(PKG.version);
    break;
  case undefined:
  case "help":
  case "--help":
  case "-h":
    process.stdout.write(HELP);
    break;
  default:
    die(`unknown command: ${cmd}\n\n${HELP}`);
}
