param(
    [Parameter(Mandatory = $true)][string]$CurrentExe,
    [Parameter(Mandatory = $true)][string]$StagedExe,
    [Parameter(Mandatory = $true)][ValidatePattern('^[A-Fa-f0-9]{64}$')][string]$ExpectedHash,
    [Parameter(Mandatory = $true)][ValidatePattern('^\d+(\.\d+){1,3}$')][string]$ExpectedVersion,
    [Parameter(Mandatory = $true)][int]$ParentPid
)

$ErrorActionPreference = 'Stop'
$backupExe = "$CurrentExe.backup"
$logPath = Join-Path ([IO.Path]::GetTempPath()) 'AfterspaceUpdate.log'

function Write-UpdateLog([string]$Message) {
    Add-Content -LiteralPath $logPath -Value "$(Get-Date -Format o) $Message" -Encoding UTF8
}

function Normalize-Version([string]$Value) {
    $match = [regex]::Match($Value, '(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?')
    if (-not $match.Success) { return $null }
    $parts = 1..4 | ForEach-Object {
        if ($match.Groups[$_].Success -and $match.Groups[$_].Value) { [int]$match.Groups[$_].Value } else { 0 }
    }
    return [version]::new($parts[0], $parts[1], $parts[2], $parts[3])
}

try {
    Write-UpdateLog "Waiting for Afterspace process $ParentPid to exit."
    $parentProcess = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
    if ($parentProcess) { $parentProcess.WaitForExit(30000) | Out-Null }
    Start-Sleep -Milliseconds 700

    if (-not (Test-Path -LiteralPath $StagedExe -PathType Leaf)) { throw 'Staged update is missing.' }
    $actualHash = (Get-FileHash -LiteralPath $StagedExe -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $ExpectedHash.ToLowerInvariant()) { throw 'Staged update hash does not match.' }

    $info = (Get-Item -LiteralPath $StagedExe).VersionInfo
    $actualVersion = Normalize-Version ([string]$info.ProductVersion)
    $wantedVersion = Normalize-Version $ExpectedVersion
    if ($info.ProductName -notlike 'Afterspace*' -or -not $actualVersion -or $actualVersion -ne $wantedVersion) {
        throw 'Staged EXE metadata does not match the release.'
    }

    if (Test-Path -LiteralPath $backupExe) { Remove-Item -LiteralPath $backupExe -Force }
    Copy-Item -LiteralPath $CurrentExe -Destination $backupExe -Force
    try {
        Copy-Item -LiteralPath $StagedExe -Destination $CurrentExe -Force
        $installedHash = (Get-FileHash -LiteralPath $CurrentExe -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($installedHash -ne $ExpectedHash.ToLowerInvariant()) { throw 'Installed EXE verification failed.' }
    } catch {
        Copy-Item -LiteralPath $backupExe -Destination $CurrentExe -Force
        throw
    }

    Write-UpdateLog "Installed Afterspace $ExpectedVersion successfully."
    Start-Process -FilePath $CurrentExe
} catch {
    Write-UpdateLog "Update failed: $($_.Exception.Message)"
    if (-not (Test-Path -LiteralPath $CurrentExe) -and (Test-Path -LiteralPath $backupExe)) {
        Copy-Item -LiteralPath $backupExe -Destination $CurrentExe -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $CurrentExe) { Start-Process -FilePath $CurrentExe -ErrorAction SilentlyContinue }
} finally {
    $stagingDirectory = Split-Path -Parent $StagedExe
    if ($stagingDirectory -and $stagingDirectory.StartsWith([IO.Path]::GetTempPath(), [StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $stagingDirectory -Recurse -Force -ErrorAction SilentlyContinue
    }
}
