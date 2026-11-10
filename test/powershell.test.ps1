# Read-only smoke tests: no venv creation, pip install, profile edits, or CAD.
# Run with powershell.exe -NoProfile -ExecutionPolicy Bypass -File test/powershell.test.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
foreach ($relative in @('lib\python.ps1', 'install.ps1', 'bootstrap.ps1')) {
    $tokens = $null; $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root $relative), [ref]$tokens, [ref]$errors) | Out-Null
    if ($errors.Count) { throw "Parse failed for ${relative}: $errors" }
    Write-Output "PASS parse $relative"
}
. (Join-Path $root 'lib\python.ps1')
$pin = Get-CadPinnedVersion -PackageRoot $root
if ($pin -ne '1.8.0') { throw "Unexpected pin: $pin" }
Write-Output "PASS pin $pin"
$rejected = $false
try { Reset-CadVenv -BaseDir (Join-Path $root 'unused-test-base') -VenvPath (Join-Path $root 'never-delete-this') } catch { $rejected = $true }
if (-not $rejected) { throw 'Unsafe deletion target was accepted' }
Write-Output 'PASS rejects unexpected deletion target before touching filesystem'
$python = Find-CadPython
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Selected interpreter is missing' }
Write-Output "PASS selected Python: $python"
$explicit = Find-CadPython -Python $python
if ($explicit -ne $python) { throw 'Explicit interpreter not honored' }
Write-Output 'PASS explicit interpreter'
$rejected = $false
try { Find-CadPython -Python 'Z:\__missing_cad_python__\python.exe' | Out-Null } catch { $rejected = $true }
if (-not $rejected) { throw 'Explicit invalid interpreter silently fell back' }
Write-Output 'PASS explicit invalid interpreter fails without fallback'
$saved = $env:CAD_PYTHON
try {
    $env:CAD_PYTHON = $python
    if ((Find-CadPython) -ne $python) { throw 'CAD_PYTHON not honored' }
    Write-Output 'PASS CAD_PYTHON override'
} finally { $env:CAD_PYTHON = $saved }
Write-Output 'All read-only PowerShell tests passed.'
