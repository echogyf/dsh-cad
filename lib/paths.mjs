// Resolve every path this package needs at runtime, from the package's own
// location plus a small JSON file under ~/.dsh. Nothing here is hardcoded to a
// particular machine: the defaults only pick a drive that exists.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { discoverPython } from "./python.mjs";

export const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));
export const PINS = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "lib", "upstream.json"), "utf8"));

export const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
export const CONFIG_FILE = path.join(DSH_HOME, "cad.json");

export function defaultBaseDir() {
  // D: first because that is where the kit has always put its runtime, then any
  // non-system drive, then the home directory.
  if (process.env.CAD_BASE) return process.env.CAD_BASE;
  if (process.platform === "win32") {
    for (const drive of ["D:", "E:", "F:"]) {
      try {
        if (fs.existsSync(drive + "\\")) return path.join(drive + "\\", "cad-agents");
      } catch {}
    }
  }
  return path.join(os.homedir(), "cad-agents");
}

export function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
  } catch {
    return null;
  }
}

export function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + "\n", "utf8");
}

export function resolveLayout(overrides = {}, options = {}) {
  const cfg = options.config ?? readConfig() ?? {};
  const env = options.env || process.env;
  const baseDir = path.resolve(overrides.baseDir || env.CAD_BASE || cfg.baseDir || defaultBaseDir());
  const defaultWork = process.platform === "win32" && exists("D:\\") ? "D:\\AutoCad" : path.join(baseDir, "drawings");
  const workDir = path.resolve(overrides.workDir || env.CAD_WORK_DIR || cfg.workDir || defaultWork);
  // Legacy configs often saved the literal "python", which is a Store alias on
  // fresh Windows installs. Treat that as automatic; an explicit override wins.
  const savedPython = ["python", "python3"].includes(cfg.python) ? undefined : cfg.python;
  const selected = (options.discover || discoverPython)({ requested: overrides.python || env.CAD_PYTHON || savedPython, env });
  const exe = process.platform === "win32" ? ".exe" : "";
  const layout = {
    baseDir,
    workDir,
    venvAcad: path.join(baseDir, "venv-autocad"),
    skillsDir: path.join(baseDir, "dsh-skills"),
    python: selected.executable,
    pythonSource: selected.source,
    pythonVersion: selected.version,
    pythonError: selected.error,
    backend: overrides.backend || env.AUTOCAD_MCP_BACKEND || cfg.backend || "com",
    progId: overrides.progId || env.CAD_PROGID || cfg.progId || "AutoCAD.Application",
    launchMode: overrides.launchMode || env.CAD_LAUNCH || cfg.launchMode || "never",
    stateDir: path.resolve(overrides.stateDir || env.CAD_STATE_DIR || cfg.stateDir || path.join(baseDir, "state")),
  };
  layout.pyAcad = path.join(layout.venvAcad, "Scripts", "python" + exe);
  layout.acadExe = path.join(layout.venvAcad, "Scripts", "autocad-mcp" + exe);
  layout.acadSkill = path.join(PKG_ROOT, "skills", "autocad-mcp-pro", "SKILL.md");
  return layout;
}

export function exists(p) {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

// What is missing before the server can start.
export function missingPieces(layout) {
  const missing = [];
  if (!exists(layout.pyAcad)) missing.push(layout.pyAcad);
  if (!exists(layout.acadExe)) missing.push(layout.acadExe);
  return missing;
}
