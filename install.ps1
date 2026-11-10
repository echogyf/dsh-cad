#requires -Version 5.1
<#
.SYNOPSIS
  Install the AutoCAD agent MCP server for dsh / Codex.
  ALL runtime artifacts go to -BaseDir (default D:\cad-agents, keeps C: free).
.DESCRIPTION
  - Creates a venv under -BaseDir (base interpreter may stay on C:)
  - Installs autocad-mcp-pro[full]
  - Creates a directory junction  ~/.dsh/skills -> <BaseDir>\dsh-skills
    so dsh auto-discovers the skill from its default scan path while the
    files physically live on the data drive
    (2 meta-tools instead of 242: ~365 tokens idle instead of ~83.7k)
  - Copies this package to <BaseDir>\dsh-cad and registers it as a bundle in
    a dsh profile (<profile>/package.json: dependencies + dsh.profile.bundles),
    then runs pnpm install there. The plugin registers the MCP server
    itself when dsh loads it, so no cordis.patch.yml edit is needed.
    Earlier versions wrote those rows into ~/.dsh/cordis.patch.yml, which the
    desktop profile never reads - that is why the plugin stayed invisible.
  Does NOT touch AutoCAD, the registry, or ~/.codex/config.toml.
  NOTE: Kept ASCII-only so it runs unchanged on Windows PowerShell 5.1 and on
  PowerShell 7. Written against 7, but nothing here requires it.
.PARAMETER Python
  Python interpreter used as the venv base. Must be >= 3.11.
  Default: "python" resolved from PATH.
.PARAMETER BaseDir
  Root directory for all runtime artifacts. Default: D:\cad-agents.
.PARAMETER WorkDir
  AutoCAD working directory, also used as the MCP ALLOWED_PATHS whitelist.
  Default: D:\AutoCad.
.PARAMETER Force
  Recreate the venv if it already exists.
.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\install.ps1
.EXAMPLE
  .\install.ps1 -Python "D:\somewhere\python.exe" -BaseDir "E:\cad" -Force
#>
param(
    [string]$Python = "python",
    [string]$BaseDir = "D:\cad-agents",
    [string]$WorkDir = "D:\AutoCad",
    [switch]$Force,
    # Skip registering the bundle in the dsh profile, for people who manage
    # their profile themselves (e.g. dsh plugin add by hand).
    [switch]$SkipDshPatch,
    # dsh profile to register into. Profiles live in ~/.dsh/profiles/<name>.
    [string]$DshProfile = "desktop",
    # Pinned upstream version. Defaults match lib/upstream.json, which is the
    # release this bundle was validated against; changing it is deliberate.
    [string]$AutocadVersion = "1.6.0"
)

$ErrorActionPreference = "Stop"

# ---- everything heavy lives on the data drive ----
$VenvAcad  = Join-Path $BaseDir "venv-autocad"
$SkillsDir = Join-Path $BaseDir "dsh-skills"                    # physical location
$Junction  = Join-Path $env:USERPROFILE ".dsh\skills"          # logical path dsh scans
$DshHome   = Join-Path $env:USERPROFILE ".dsh"

function Say($msg) { Write-Host "==> $msg" }

# ---------- 1. Python check ----------
Say "[1/6] Checking Python (need >= 3.11 for autocad-mcp-pro)..."
if (-not (Test-Path -LiteralPath $Python)) {
    $cmd = Get-Command $Python -ErrorAction SilentlyContinue
    if ($cmd) { $Python = $cmd.Source } else { throw "Python not found: $Python" }
}
$ver = & $Python -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
if ($LASTEXITCODE -ne 0) { throw "Cannot run Python via '$Python'." }
$p = $ver.Split(".")
if ([int]$p[0] -lt 3 -or ([int]$p[0] -eq 3 -and [int]$p[1] -lt 11)) {
    throw "Python $ver too old; autocad-mcp-pro requires >= 3.11."
}
Write-Host "    Python $ver OK  (base: $Python)"

# ---------- 2. data dirs ----------
Say "[2/6] Creating $BaseDir and $WorkDir ..."
New-Item -ItemType Directory -Force -Path $BaseDir | Out-Null
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null   # MCP ALLOWED_PATHS target
$env:PIP_CACHE_DIR = Join-Path $BaseDir "pip_cache"   # keep pip cache off C: too

# ---------- 3. venv on D: ----------
Say "[3/6] Creating venv on D: ..."
if ((Test-Path -LiteralPath $VenvAcad) -and $Force) { Remove-Item -Recurse -Force -LiteralPath $VenvAcad }
if (-not (Test-Path -LiteralPath $VenvAcad)) {
    & $Python -m venv $VenvAcad
    if ($LASTEXITCODE -ne 0) { throw "venv creation failed: $VenvAcad" }
}
& (Join-Path $VenvAcad "Scripts\python.exe") -m pip install --upgrade pip --quiet
if ($LASTEXITCODE -ne 0) { throw "pip self-upgrade failed in $VenvAcad" }

# ---------- 4. junction ~/.dsh/skills -> <BaseDir>\dsh-skills ----------
Say "[4/6] Linking ~/.dsh/skills -> $SkillsDir (junction)..."
New-Item -ItemType Directory -Force -Path $SkillsDir | Out-Null
if (Test-Path -LiteralPath $Junction) {
    Write-Host "    ~/.dsh/skills already exists, skipping (fine if it is already a junction)"
}
else {
    New-Item -ItemType Junction -Path $Junction -Target $SkillsDir | Out-Null
    if (-not (Test-Path -LiteralPath $Junction)) { throw "junction creation failed (run as your normal user; no admin needed)" }
    Write-Host "    junction created"
}

# ---------- 5. Python package ----------
Say "[5/6] Installing autocad-mcp-pro (pip cache -> $BaseDir\pip_cache)..."
$pyAcad = Join-Path $VenvAcad "Scripts\python.exe"

& $pyAcad -m pip install "autocad-mcp-pro[full]==$AutocadVersion" --quiet
if ($LASTEXITCODE -ne 0) { throw "pip install autocad-mcp-pro[full]==$AutocadVersion failed" }

# ---------- 5b. upstream fixes this bundle depends on ----------
Say "[5b] Applying the upstream fixes this bundle depends on..."
$patchScript = Join-Path $PSScriptRoot "patches\apply_patches.py"
if (Test-Path -LiteralPath $patchScript) {
    & $pyAcad $patchScript --base $BaseDir
    if ($LASTEXITCODE -ne 0) {
        Write-Host "    one or more patches no longer match the installed upstream."
        Write-Host "    Check whether upstream shipped the fix; see patches/README.md for the PR links."
    }
}
else {
    Write-Host "    patches/apply_patches.py not found, skipping"
}

# ---------- 6. register the bundle in the active dsh profile ----------
Say "[6/6] Registering the dsh bundle in profile '$DshProfile'..."
$kitDir = $PSScriptRoot

# The AutoCAD skill is authored in this kit (upstream has none); install if missing
$acadSkillDir = Join-Path $SkillsDir "autocad-mcp-pro"
$acadSkillSrc = Join-Path $kitDir "skills\autocad-mcp-pro\SKILL.md"
if (-not (Test-Path -LiteralPath (Join-Path $acadSkillDir "SKILL.md"))) {
    New-Item -ItemType Directory -Force -Path $acadSkillDir | Out-Null
    if (Test-Path -LiteralPath $acadSkillSrc) {
        Copy-Item -LiteralPath $acadSkillSrc -Destination (Join-Path $acadSkillDir "SKILL.md") -Force
        Write-Host "    autocad-mcp-pro skill installed"
    }
}

$ProfileDir = Join-Path $DshHome (Join-Path "profiles" $DshProfile)
$ProfilePkg = Join-Path $ProfileDir "package.json"
if (-not (Test-Path -LiteralPath $ProfilePkg)) {
    $profilesRoot = Join-Path $DshHome "profiles"
    $available = @()
    if (Test-Path -LiteralPath $profilesRoot) {
        $available = Get-ChildItem -LiteralPath $profilesRoot -Directory |
            Where-Object { $_.Name -ne "node_modules" } |
            Select-Object -ExpandProperty Name
    }
    throw "dsh profile '$DshProfile' not found under $profilesRoot. Available: $($available -join ', '). Pass -DshProfile <name>."
}

$BundleLink = $null
if ($SkipDshPatch) {
    Write-Host "    skipping profile registration (-SkipDshPatch)"
}
else {
    # Copy the package rather than junction it: a junction into wherever this
    # kit happened to live breaks the moment that directory is moved or cleaned.
    $PkgDest = Join-Path $BaseDir "dsh-cad"
    $sameDir = $false
    if (Test-Path -LiteralPath $PkgDest) {
        $sameDir = ((Resolve-Path -LiteralPath $kitDir).Path -eq (Resolve-Path -LiteralPath $PkgDest).Path)
    }
    if ($sameDir) {
        Write-Host "    package already at $PkgDest"
    }
    else {
        New-Item -ItemType Directory -Force -Path $PkgDest | Out-Null
        & robocopy $kitDir $PkgDest /E /XD ".git" "node_modules" /NFL /NDL /NJH /NJS /NP | Out-Null
        if ($LASTEXITCODE -gt 7) { throw "robocopy failed with exit code $LASTEXITCODE" }
        Write-Host "    copied package -> $PkgDest"
    }

    $bak = "$ProfilePkg.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')"
    Copy-Item -LiteralPath $ProfilePkg -Destination $bak -Force
    Write-Host "    backup: $bak"

    # The profile nests bundles under dsh.profile; editing that with
    # PSCustomObject is easy to get wrong, so let node do the JSON.
    $BundleLink = "link:" + ($PkgDest -replace '\\', '/')
    $helper = Join-Path $env:TEMP "dsh-cad-register.js"
    $helperSrc = @'
const fs = require("fs");
const pkgPath = process.argv[2];
const linkSpec = process.argv[3];
const name = process.argv[4];
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.dependencies = pkg.dependencies || {};
pkg.dependencies[name] = linkSpec;
pkg.dsh = pkg.dsh || {};
pkg.dsh.profile = pkg.dsh.profile || {};
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles || [];
if (pkg.dsh.profile.bundles.indexOf(name) === -1) { pkg.dsh.profile.bundles.push(name); }
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
console.log("registered " + name + " -> " + linkSpec);
'@
    [System.IO.File]::WriteAllText($helper, $helperSrc, (New-Object System.Text.UTF8Encoding($false)))
    & node $helper $ProfilePkg $BundleLink "dsh-cad"
    if ($LASTEXITCODE -ne 0) { throw "failed to register the bundle in $ProfilePkg" }

    Push-Location -LiteralPath $ProfileDir
    try {
        & pnpm install
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed in $ProfileDir" }
    }
    finally {
        Pop-Location
    }
    Write-Host "    pnpm install done"
}

# ---------- verify ----------
$acadExe = Join-Path $VenvAcad "Scripts\autocad-mcp.exe"
$acadSkillVisible = Join-Path $Junction "autocad-mcp-pro\SKILL.md"
$mustExist = @($acadExe, $acadSkillVisible)
if ($BundleLink) {
    $mustExist += (Join-Path $ProfileDir "node_modules\dsh-cad\package.json")
}
foreach ($f in $mustExist) {
    if (-not (Test-Path -LiteralPath $f)) { throw "verify failed, missing: $f" }
}

Write-Host ""
Write-Host "=================================================="
Write-Host " Install complete. Everything heavy is on $BaseDir."
Write-Host "   Skill (on-demand entry):"
Write-Host "     - autocad-mcp-pro        (MCP discovery mode, any COM-capable AutoCAD)"
Write-Host "   AutoCAD MCP : $acadExe   (2 meta-tools, ~365 tokens idle)"
if ($BundleLink) {
    Write-Host "   dsh profile : $DshProfile  (bundle dsh-cad -> $BundleLink)"
    Write-Host "                 The plugin adds the MCP server when dsh loads it."
    Write-Host ""
    Write-Host " RESTART dsh now. The bundle is read at startup, so the plugin list and"
    Write-Host " the MCP server only appear after a restart."
}
else {
    Write-Host "   dsh profile : not registered (-SkipDshPatch)"
}
Write-Host ""
Write-Host " Verify:"
Write-Host "   dsh --profile $DshProfile --dump-config"
Write-Host ""
Write-Host " Discovery is upstream's now; nothing to rebuild after a skill update."
Write-Host ""
Write-Host " Reminder: start AutoCAD first (detected by COM, not by version),"
Write-Host " and run dsh/Codex as the SAME Windows user and integrity level as AutoCAD."
Write-Host "=================================================="
