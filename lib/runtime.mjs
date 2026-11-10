import { spawnSync } from "node:child_process";
import path from "node:path";
import { PINS, PKG_ROOT, exists, missingPieces } from "./paths.mjs";

export function inspectRuntime(layout, { run = spawnSync } = {}) {
  const issues = missingPieces(layout);
  if (issues.length) return { ok: false, issues };
  try {
    const code = "import json,importlib.metadata as m,importlib.util as u; print(json.dumps({'version':m.version('autocad-mcp-pro'),'missing':[x for x in ['mcp','win32com','pythoncom','ezdxf'] if u.find_spec(x) is None]}))";
    const result = run(layout.pyAcad, ["-c", code], { encoding: "utf8", timeout: 15000, windowsHide: true });
    if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr?.trim() || `exit ${result.status}`);
    const info = JSON.parse(result.stdout.trim().split(/\r?\n/).pop());
    if (info.version !== PINS.autocadMcp.version) issues.push(`autocad-mcp-pro ${info.version}; expected ${PINS.autocadMcp.version}`);
    for (const name of info.missing) issues.push(`Python module ${name}`);
    return { ok: issues.length === 0, issues, version: info.version };
  } catch (error) {
    return { ok: false, issues: [`Cannot use ${layout.pyAcad}: ${error.message}`] };
  }
}

export function powershell() {
  const exe = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return exists(exe) ? exe : "powershell";
}

export function installerArgs(layout, { check = false, force = false, dshPatch = false, withCodex = false } = {}) {
  if (!layout.python) throw new Error(layout.pythonError || "No usable Python; set CAD_PYTHON to an existing interpreter.");
  const args = ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(PKG_ROOT, "bootstrap.ps1"),
    "-BaseDir", layout.baseDir, "-WorkDir", layout.workDir, "-Python", layout.python,
    "-AutocadVersion", PINS.autocadMcp.version];
  if (!dshPatch && !withCodex) args.push("-RuntimeOnly");
  if (!dshPatch) args.push("-NoDshPatch");
  if (!withCodex) args.push("-SkipCodex");
  if (check) args.push("-Check");
  if (force) args.push("-Force");
  return args;
}

export function autocadConfig(layout) {
  return {
    serverName: "autocad", transport: "stdio", command: layout.pyAcad, args: ["-m", "server"], cwd: layout.workDir,
    env: {
      AUTOCAD_MCP_BACKEND: layout.backend,
      CAD_PROGID: layout.progId,
      TOOL_PROFILE: "full", TOOL_PACKS: "all", DISCOVERY_MODE: "search",
      ALLOWED_PATHS: layout.workDir,
      PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8",
    },
    toolCallTimeoutMs: 180000, failOnStartupError: true,
    reconnect: { enabled: true, initialDelayMs: 500, maxDelayMs: 30000, maxAttempts: 10 },
  };
}
