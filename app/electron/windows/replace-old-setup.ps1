# Takes Ovis for Windows (app/windows, the one-file setup app) off the PC once the desktop app that
# replaces it is installed; installer.nsh runs it. That app has no uninstaller, and its Remove button
# also takes the Ovis server off the PC, so it is never run. What it leaves (app/windows/src/LoginItem.cs)
# is its copy at %LOCALAPPDATA%\Programs\Ovis\Ovis.exe, a Start menu Ovis.lnk to that copy, and an HKCU
# Run value "Ovis" that starts the copy with --start. Only those go; herdr, the Ovis server it installed
# and their state stay. Anything that is not provably that app's is left alone. Each step runs even when
# one before it failed; the exit code says whether any did.
param([Parameter(Mandatory = $true)][string]$NewExe)
$ErrorActionPreference = 'Stop'
$failed = 0
function Step([string]$What, [scriptblock]$Body) {
    try { & $Body } catch { Write-Output "could not $What`: $($_.Exception.Message)"; $script:failed++ }
}

$dir = Join-Path $env:LOCALAPPDATA 'Programs\Ovis'
$exe = Join-Path $dir 'Ovis.exe'
$newPath = [IO.Path]::GetFullPath($NewExe)
if ($newPath -ieq [IO.Path]::GetFullPath($exe)) { exit 0 }

# that app's build names itself so (app/windows/Ovis.csproj; the 0.4.22 release reads Ovis, Ovis,
# Ovis contributors, Ovis.exe); this app's own exe says otherwise, and is never matched by path either
function IsOldSetup([string]$Path) {
    if (-not $Path -or [IO.Path]::GetFullPath($Path) -ieq $newPath -or -not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $info = (Get-Item -LiteralPath $Path).VersionInfo
    return $info.CompanyName -eq 'Ovis' -and $info.ProductName -eq 'Ovis' -and $info.LegalCopyright -eq 'Ovis contributors' -and $info.OriginalFilename -eq 'Ovis.exe'
}

$present = Test-Path -LiteralPath $exe -PathType Leaf
if ($present -and -not (IsOldSetup $exe)) {
    Write-Output "left $exe alone: it is not Ovis for Windows"
    exit 0
}

# every open window of it, the installed copy's or one opened from a download: an open one could set
# its shortcut and sign-in start up again, or run its Remove. It only drives herdr and the Ovis server,
# which run on their own and keep running.
Step 'close its windows' {
    foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'Ovis.exe'")) {
        if (IsOldSetup $process.ExecutablePath) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
            Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
            Write-Output "closed its window $($process.ExecutablePath) (pid $($process.ProcessId))"
        }
    }
}

# the sign-in start it writes, word for word (also when its copy is already gone); a value the user
# pointed elsewhere is theirs
Step 'remove its sign-in start' {
    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    $value = (Get-ItemProperty -Path $runKey -Name Ovis -ErrorAction SilentlyContinue).Ovis
    if ($value -ieq ('"' + $exe + '" --start')) {
        Remove-ItemProperty -Path $runKey -Name Ovis
        Write-Output 'removed its sign-in start'
    }
}

# its shortcuts (the Start menu one, and any the user copied to the desktop); this app's own are left
Step 'remove its shortcuts' {
    $shell = New-Object -ComObject WScript.Shell
    foreach ($folder in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
        foreach ($file in @(Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -File -ErrorAction SilentlyContinue)) {
            if ($shell.CreateShortcut($file.FullName).TargetPath -ieq $exe) {
                Remove-Item -LiteralPath $file.FullName -Force
                Write-Output "removed its shortcut $($file.FullName)"
            }
        }
    }
}

if ($present) {
    Step "remove $exe" {
        Remove-Item -LiteralPath $exe -Force
        Write-Output "removed $exe"
        # only when nothing else is in the folder
        if (-not (Get-ChildItem -LiteralPath $dir -Force)) { Remove-Item -LiteralPath $dir -Force }
    }
}
exit $failed
