// Discover an existing interpreter; never install packages into the base Python.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const PROBE = "import sys,json,importlib.util; print(json.dumps({'version':list(sys.version_info[:3]),'venv':importlib.util.find_spec('venv') is not None,'pip':importlib.util.find_spec('pip') is not None}))";

export function pythonCandidates({ requested, env = process.env, home = os.homedir(), platform = process.platform, readDir = fs.readdirSync } = {}) {
  const win = platform === "win32";
  const exe = win ? "python.exe" : "python3";
  const candidates = [];
  const add = (executable, source) => {
    if (executable && !candidates.some((c) => c.executable === executable)) candidates.push({ executable, source });
  };
  const fromPath = (name, source) => {
    if (path.isAbsolute(name) || /[\\/]/.test(name)) return add(name, source);
    for (const dir of (env.PATH || env.Path || "").split(win ? ";" : ":")) {
      if (dir) add(path.join(dir.replace(/^"|"$/g, ""), win && !name.toLowerCase().endsWith(".exe") ? `${name}.exe` : name), source);
    }
  };
  if (requested) {
    fromPath(requested, "explicit");
    return candidates;
  }
  const dshHome = env.DSH_HOME || path.join(home, ".dsh");
  const runtimes = path.join(dshHome, "dsh-runtimes");
  add(path.join(runtimes, "dsh-primary-runtime", "dependencies", "python", exe), "dsh-runtime");
  try {
    for (const entry of readDir(runtimes, { withFileTypes: true })) {
      if (entry.isDirectory()) add(path.join(runtimes, entry.name, "dependencies", "python", exe), "dsh-runtime");
    }
  } catch { /* DSH may not be installed on a standalone CLI machine. */ }
  if (env.VIRTUAL_ENV) add(path.join(env.VIRTUAL_ENV, win ? "Scripts" : "bin", exe), "virtual-env");
  if (env.CONDA_PREFIX) add(path.join(env.CONDA_PREFIX, win ? exe : `bin/${exe}`), "conda");
  for (const name of win ? ["python", "python3"] : ["python3", "python"]) fromPath(name, "PATH");
  return candidates;
}

export function discoverPython(options = {}) {
  const { run = spawnSync, exists = fs.existsSync, env = process.env } = options;
  const failures = [];
  for (const candidate of pythonCandidates(options)) {
    if (/[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(candidate.executable)) {
      failures.push(`${candidate.executable}: Windows Store execution alias skipped`);
      continue;
    }
    if (!exists(candidate.executable)) continue;
    try {
      const result = run(candidate.executable, ["-c", PROBE], { encoding: "utf8", timeout: 10000, windowsHide: true, env });
      if (result.error || result.status !== 0) throw new Error(result.error?.message || `exit ${result.status}`);
      const details = JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
      const [major, minor] = details.version || [];
      if (!(major > 3 || (major === 3 && minor >= 11))) throw new Error("Python >= 3.11 required");
      if (!details.venv || !details.pip) throw new Error("venv and pip are required");
      return { ...candidate, version: details.version.join("."), error: null };
    } catch (error) {
      failures.push(`${candidate.executable}: ${error.message}`);
    }
  }
  return {
    executable: null, source: null, version: null,
    error: `No usable Python >= 3.11 with venv/pip. Set CAD_PYTHON or pass --python <absolute path>.${failures.length ? ` ${failures.join("; ")}` : ""}`,
  };
}
