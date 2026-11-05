# Takes Ovis for Windows (app/windows, the one-file setup app) off the PC once the desktop app that
# replaces it is installed; installer.nsh runs it. That app has no uninstaller, and its Remove button
# also takes the Ovis server off the PC, so it is never run. What it leaves (app/windows/src/LoginItem.cs)
# is its copy at %LOCALAPPDATA%\Programs\Ovis\Ovis.exe, a Start menu Ovis.lnk to that copy, and an HKCU
# Run value "Ovis" that starts the copy with --start. Only those go; herdr, the Ovis server it installed
# and their state stay. Anything that is not provably that app's is left alone.
param([Parameter(Mandatory = $true)][string]$NewExe)
$ErrorActionPreference = 'Stop'

$dir = Join-Path $env:LOCALAPPDATA 'Programs\Ovis'
$exe = Join-Path $dir 'Ovis.exe'
if ([IO.Path]::GetFullPath($NewExe) -ieq [IO.Path]::GetFullPath($exe)) { exit 0 }

# the sign-in start that app writes, word for word; a value the user pointed elsewhere is theirs
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$value = (Get-ItemProperty -Path $runKey -Name Ovis -ErrorAction SilentlyContinue).Ovis
if ($value -ieq ('"' + $exe + '" --start')) {
    Remove-ItemProperty -Path $runKey -Name Ovis
    Write-Output 'removed its sign-in start'
}

$present = Test-Path -LiteralPath $exe -PathType Leaf
if ($present) {
    # its build names itself so (app/windows/Ovis.csproj; the 0.4.22 release reads Ovis, Ovis, Ovis
    # contributors, Ovis.exe): another program at that path is not touched
    $info = (Get-Item -LiteralPath $exe).VersionInfo
    if ($info.CompanyName -ne 'Ovis' -or $info.ProductName -ne 'Ovis' -or $info.LegalCopyright -ne 'Ovis contributors' -or $info.OriginalFilename -ne 'Ovis.exe') {
        Write-Output "left $exe alone: it is not Ovis for Windows ($($info.CompanyName) / $($info.ProductName) / $($info.LegalCopyright))"
        exit 0
    }
}

# its shortcuts (the Start menu one, and any the user copied to the desktop); this app's own are left
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Desktop'))) {
    foreach ($file in @(Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -File -ErrorAction SilentlyContinue)) {
        if ($shell.CreateShortcut($file.FullName).TargetPath -ieq $exe) {
            Remove-Item -LiteralPath $file.FullName -Force
            Write-Output "removed its shortcut $($file.FullName)"
        }
    }
}

if (-not $present) { exit 0 }
# an open window holds the file, and could set its shortcut and sign-in start up again: it is closed.
# It only drives herdr and the Ovis server, which run on their own and keep running.
foreach ($process in @(Get-CimInstance Win32_Process -Filter "Name = 'Ovis.exe'" | Where-Object { $_.ExecutablePath -ieq $exe })) {
    Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $process.ProcessId -Timeout 10 -ErrorAction SilentlyContinue
    Write-Output "closed its window (pid $($process.ProcessId))"
}
Remove-Item -LiteralPath $exe -Force
Write-Output "removed $exe"
# only when nothing else is in the folder
if (-not (Get-ChildItem -LiteralPath $dir -Force)) { Remove-Item -LiteralPath $dir -Force }
