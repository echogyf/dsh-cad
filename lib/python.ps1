# Shared interpreter discovery. Never installs into the base interpreter.
function Find-CadPython {
    param([string]$Python = "", [string]$DshHome = "")
    if (-not $DshHome) { $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $env:USERPROFILE '.dsh' } }
    $explicit = if ($Python) { $Python } elseif ($env:CAD_PYTHON) { $env:CAD_PYTHON } else { $null }
    $candidates = @()
    if ($explicit) { $candidates += $explicit }
    else {
        $runtimes = Join-Path $DshHome 'dsh-runtimes'
        $candidates += Join-Path $runtimes 'dsh-primary-runtime\dependencies\python\python.exe'
        if (Test-Path -LiteralPath $runtimes) {
            foreach ($runtime in Get-ChildItem -LiteralPath $runtimes -Directory | Sort-Object Name) { $candidates += Join-Path $runtime.FullName 'dependencies\python\python.exe' }
        }
        foreach ($name in @('python', 'python3')) {
            foreach ($cmd in @(Get-Command $name -CommandType Application -All -ErrorAction SilentlyContinue)) { $candidates += $cmd.Source }
        }
    }
    $probe = 'import sys, venv, ensurepip; assert sys.version_info >= (3,11); assert ensurepip.version(); print(sys.executable)'
    $errors = @()
    foreach ($candidate in @($candidates | Select-Object -Unique)) {
        if ($candidate -match '(?i)[\\/]WindowsApps[\\/]') { $errors += "$candidate (WindowsApps alias excluded)"; continue }
        $resolved = $candidate
        if (-not (Test-Path -LiteralPath $resolved -PathType Leaf)) {
            $cmd = Get-Command $candidate -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
            if (-not $cmd) { $errors += "$candidate (not found)"; continue }
            $resolved = $cmd.Source
        }
        if ($resolved -match '(?i)[\\/]WindowsApps[\\/]') { $errors += "$resolved (WindowsApps alias excluded)"; continue }
        try {
            $result = & $resolved -B -c $probe 2>$null
            if ($LASTEXITCODE -eq 0 -and $result) { return (Resolve-Path -LiteralPath $resolved).Path }
        } catch { }
        $errors += "$resolved (requires Python >= 3.11 with venv and bundled pip)"
    }
    throw "No usable CAD Python interpreter. Set CAD_PYTHON or pass -Python. Checked: $($errors -join '; ')"
}

function Get-CadPinnedVersion {
    param([string]$PackageRoot)
    $pins = Get-Content -LiteralPath (Join-Path $PackageRoot 'lib\upstream.json') -Raw | ConvertFrom-Json
    return [string]$pins.autocadMcp.version
}

function Reset-CadVenv {
    param([string]$BaseDir, [string]$VenvPath)
    $baseFull = [System.IO.Path]::GetFullPath($BaseDir)
    $expected = [System.IO.Path]::GetFullPath((Join-Path $baseFull 'venv-autocad'))
    $actual = [System.IO.Path]::GetFullPath($VenvPath)
    if (-not [System.IO.Path]::IsPathRooted($VenvPath) -or $actual -ne $expected -or $actual -eq $baseFull) { throw "Refusing to remove unexpected venv path: $VenvPath (expected $expected)" }
    if (Test-Path -LiteralPath $actual) {
        $item = Get-Item -LiteralPath $actual -Force
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "Refusing to remove a junction/symlink venv: $actual" }
        Remove-Item -Recurse -Force -LiteralPath $actual
    }
}

function Invoke-CadPatch {
    param([string]$Python, [string]$PackageRoot, [string]$BaseDir, [switch]$Check)
    $script = Join-Path $PackageRoot 'patches\apply_patches.py'
    if (-not (Test-Path -LiteralPath $script)) { throw "Missing patch script: $script" }
    $argsList = @($script, '--base', $BaseDir)
    if ($Check) { $argsList += '--check' }
    & $Python -B @argsList
    if ($LASTEXITCODE -ne 0) { throw "Upstream patch check/application failed; inspect patches/README.md." }
}

function Install-CadRuntime {
    param([string]$Python, [string]$BaseDir, [string]$WorkDir, [string]$Version, [string]$PackageRoot, [switch]$Force)
    $BaseDir = [System.IO.Path]::GetFullPath($BaseDir)
    $venvPath = Join-Path $BaseDir 'venv-autocad'
    New-Item -ItemType Directory -Force -Path $BaseDir | Out-Null
    New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
    if ($Force) { Reset-CadVenv -BaseDir $BaseDir -VenvPath $venvPath }
    if (-not (Test-Path -LiteralPath $venvPath)) {
        & $Python -B -m venv $venvPath
        if ($LASTEXITCODE -ne 0) { throw "venv creation failed: $venvPath" }
    }
    $venvPython = Join-Path $venvPath 'Scripts\python.exe'
    $oldCache = $env:PIP_CACHE_DIR
    try {
        $env:PIP_CACHE_DIR = Join-Path $BaseDir 'pip_cache'
        & $venvPython -B -m pip install "autocad-mcp-pro[full]==$Version" --quiet
        if ($LASTEXITCODE -ne 0) { throw "pip install failed in $venvPath" }
        $actual = & $venvPython -B -c "import importlib.metadata; print(importlib.metadata.version('autocad-mcp-pro'))"
        if ($LASTEXITCODE -ne 0 -or "$actual".Trim() -ne $Version) { throw "Upstream version mismatch: expected $Version, got $actual" }
        Invoke-CadPatch -Python $venvPython -PackageRoot $PackageRoot -BaseDir $BaseDir
    } finally { $env:PIP_CACHE_DIR = $oldCache }
}
