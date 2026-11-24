# It replaces an installed Ovis and leaves the one it installed. A herdr server it or the installer
# had to start is stopped again; one that was already running is left alone.
# -HerdrStopped: herdr must not be running before the install, so this commit's installer has to start it (CI's Native
# Windows install, whose runner may have herdr installed).
param(
    [string]$Installer = (Join-Path $PSScriptRoot '..\install.ps1'),
    [string]$Ref = '',
    [switch]$Update,
    [switch]$Fresh,
    [switch]$HerdrStopped
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:OVIS_NO_OPEN = '1'
$origin = 'http://127.0.0.1:7317'
$pluginId = 'devswha.ovis'
# where the official installers put both tools; a terminal opened before them has neither on PATH
$env:PATH = "$env:USERPROFILE\.bun\bin;$env:LOCALAPPDATA\Programs\Herdr\bin;$env:PATH"

function Assert([bool]$Condition, [string]$Message) { if (-not $Condition) { throw $Message } }
function Get-Json([string]$Path) { (Invoke-WebRequest "$origin$Path" -UseBasicParsing -TimeoutSec 5).Content | ConvertFrom-Json }
# The app and herdr report their state only when asked; an unanswered question is asked again.
function Wait-Until([scriptblock]$Test, [int]$Seconds, [string]$What) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    do {
        try { $value = & $Test; if ($value) { return $value } } catch { }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw "Timed out after $Seconds s: $What"
}
function Test-Herdr { [bool](Get-Command herdr -ErrorAction SilentlyContinue) }
function Test-ServerRunning { (Test-Herdr) -and [bool](herdr status server --json | ConvertFrom-Json).running }
function Find-Plugin {
    if (-not (Test-Herdr)) { return $null }
    (herdr plugin list --json | ConvertFrom-Json).result.plugins | Where-Object { $_.plugin_id -eq $pluginId } | Select-Object -First 1
}
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
# herdr's server: the herdr process that started first (a command's herdr comes and goes)
function Get-HerdrServer { Get-Process herdr -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1 }
# what the installer leaves where it started herdr: its own sign-in start (the Run value Ovis, its launcher) and no task
function Assert-SignInStart([string]$After) {
    $signIn = "$((Get-ItemProperty $runKey -Name Ovis -ErrorAction SilentlyContinue).Ovis)"
    Assert ($signIn -like '*\ovis\start-herdr.ps1"') "After $After herdr must start at sign-in with the installer's launcher, not: $signIn"
    Assert (-not (Get-ScheduledTask -TaskName 'Ovis herdr start*' -ErrorAction SilentlyContinue)) "After $After the task that started herdr must be gone"
}
# The installer as it runs over SSH, in session 0 outside this desktop: a process WMI creates (Win32_Process.Create) as this
# account, with this run's environment, its output in a file. What it said, and whether it threw.
function Invoke-InSession0([string]$Arguments) {
    $dir = Join-Path ([IO.Path]::GetTempPath()) ('ovis-e2e-' + [Guid]::NewGuid().ToString('N').Substring(0, 8))
    New-Item -ItemType Directory -Path $dir | Out-Null
    $log = Join-Path $dir 'out.log'; $done = Join-Path $dir 'exit.txt'; $runner = Join-Path $dir 'run.ps1'
    Set-Content -LiteralPath $runner -Encoding UTF8 -Value @"
`$ProgressPreference = 'SilentlyContinue'
"session `$([Diagnostics.Process]::GetCurrentProcess().SessionId)" | Out-File -LiteralPath '$log' -Encoding utf8
try { & '$Installer' $Arguments *>&1 | Out-File -Append -LiteralPath '$log' -Encoding utf8 -Width 4096; `$code = 0 }
catch { `$_ | Out-String -Width 4096 | Out-File -Append -LiteralPath '$log' -Encoding utf8; `$code = 1 }
Set-Content -LiteralPath '$done' -Value `$code
"@
    $environment = [string[]]@(Get-ChildItem Env: | Where-Object { $_.Name -notmatch '[=\r\n\0]' -and "$($_.Value)" -notmatch '[\r\n\0]' } | ForEach-Object { "$($_.Name)=$($_.Value)" })
    $startup = New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; EnvironmentVariables = $environment }
    $made = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = "`"$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe`" -NoProfile -ExecutionPolicy Bypass -File `"$runner`""; CurrentDirectory = $HOME; ProcessStartupInformation = $startup }
    Assert ($made.ReturnValue -eq 0) "WMI did not start the installer ($($made.ReturnValue))"
    Wait-Until { Test-Path -LiteralPath $done } 300 'the installer run in session 0 to end' | Out-Null
    $result = @{ Said = (Get-Content -Raw -LiteralPath $log); Threw = (Get-Content -Raw -LiteralPath $done).Trim() -ne '0' }
    Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue
    $result
}
function Get-ReleaseTags {
    $tags = @(git ls-remote --tags --refs 'https://github.com/devswha/ovis.git' 'v*' |
        ForEach-Object { if ($_ -match 'refs/tags/(v\d+\.\d+\.\d+)$') { $Matches[1] } } |
        Sort-Object { [version]$_.Substring(1) })
    Assert ($tags.Count -ge 2) 'Could not read the release tags from GitHub'
    $tags
}
function Invoke-Installer([string]$InstallRef) {
    if ($Installer -match '^https://') {
        $env:OVIS_REF = $InstallRef
        try { Invoke-RestMethod $Installer | Invoke-Expression }
        finally { Remove-Item Env:\OVIS_REF -ErrorAction SilentlyContinue }
    } else { & $Installer -Ref $InstallRef }
}
function Assert-App([string]$Expected) {
    $health = Wait-Until { $answer = Get-Json '/api/health'; if ($answer.ok) { $answer } } 60 'the app to answer'
    $updates = Get-Json '/api/updates'
    if ($Expected -match '^[0-9a-f]{40}$') {
        Assert ($health.web_ui.revision -eq $Expected) "The app runs $($health.web_ui.revision), not $Expected"
    } else {
        Assert ("v$($updates.current_version)" -eq $Expected) "The app runs $($updates.current_version), not $Expected"
    }
    $page = Invoke-WebRequest "$origin/" -UseBasicParsing -TimeoutSec 10
    $bundle = [regex]::Match($page.Content, 'assets/index-[^"]+\.js').Value
    Assert ($page.StatusCode -eq 200 -and $bundle) 'The app page is not the built app'
    Assert ((Invoke-WebRequest "$origin/$bundle" -UseBasicParsing -TimeoutSec 30).StatusCode -eq 200) 'The app page cannot load its script'
    $session = Get-Json '/api/session'
    Assert ([bool]$session.snapshot.version) 'The app does not reach herdr'
    Write-Host "PASS Ovis $($updates.current_version) ($($health.web_ui.revision)) runs with herdr $($session.snapshot.version)"
}

if ($HerdrStopped) { Assert (-not (Test-ServerRunning)) '-HerdrStopped: herdr is running already' }
if ($Fresh) {
    Assert (-not (Test-Herdr)) '-Fresh: herdr is already installed'
    Assert (-not (Get-Command bun -ErrorAction SilentlyContinue)) '-Fresh: Bun is already installed'
}
$tags = Get-ReleaseTags
$latest = $tags[-1]
if ($Update -and -not $Ref) { $Ref = $tags[-2] }
$expected = if ($Ref) { $Ref } else { $latest }
$startedServer = $false
try {
    $plugin = Find-Plugin
    if ($plugin) {
        Write-Host "e2e: removing the installed Ovis $($plugin.version)"
        if (Test-ServerRunning) { herdr plugin action invoke "$pluginId.stop-windows" | Out-Null }
        Wait-Until { -not (Get-NetTCPConnection -LocalPort 7317 -State Listen -ErrorAction SilentlyContinue) } 30 'the installed app to stop' | Out-Null
        herdr plugin uninstall $pluginId | Out-Null
        Assert ($LASTEXITCODE -eq 0) 'herdr plugin uninstall failed'
    }

    Write-Host "e2e: installing $expected with $Installer"
    $herdrRan = Test-ServerRunning
    Invoke-Installer $Ref
    if ($Installer -notmatch '^https://' -and -not $herdrRan) {
        # this commit's installer, where herdr was not running: it leaves herdr running, and Ovis answering, set to start at
        # sign-in, and no task behind (INSTALL.md)
        $startedServer = Test-ServerRunning
        Assert $startedServer 'The installer must leave herdr running where it was not'
        Assert-SignInStart 'the install line'
        Wait-Until { (Get-Json '/api/health').ok } 60 'the app to answer after the install line' | Out-Null
        # over SSH (session 0) with this account signed in at the desktop, as here: herdr starts in the desktop session
        Write-Host 'e2e: installing again from session 0, as over SSH, with herdr stopped'
        herdr plugin action invoke "$pluginId.stop-windows" | Out-Null
        herdr server stop | Out-Null
        Wait-Until { -not (Test-ServerRunning) } 30 'herdr to stop' | Out-Null
        $run = Invoke-InSession0 "-Ref '$Ref'"
        Assert (-not $run.Threw -and $run.Said -match '^\W*session 0' -and $run.Said -match 'herdr was started in your desktop' -and $run.Said -notmatch 'Task Scheduler did not') "From session 0 the installer must start herdr in the desktop through its task: $($run.Said)"
        $server = Get-HerdrServer
        Assert ((Test-ServerRunning) -and $server -and $server.SessionId -ne 0) "herdr started from session 0 must run in the desktop session, not $($server.SessionId)"
        Assert-SignInStart 'the install line from session 0'
        Wait-Until { (Get-Json '/api/health').ok } 60 'the app to answer after the install line from session 0' | Out-Null
        # -NoService takes the sign-in start away again, and leaves the herdr that runs as it is
        Write-Host 'e2e: installing again with -NoService'
        & $Installer -Ref $Ref -NoService
        Assert ($null -eq (Get-ItemProperty $runKey -Name Ovis -ErrorAction SilentlyContinue)) '-NoService must remove the sign-in start an earlier run set up'
        Assert ((Test-ServerRunning) -and (Get-Process -Id $server.Id -ErrorAction SilentlyContinue)) "-NoService must leave the herdr that runs as it is (pid $($server.Id))"
        # -Account of another shape is refused before anything is installed or started; with no account service the add
        # cannot run, says so itself, and the install fails
        $refused = ''
        try { & $Installer -Ref $Ref -Account '-not-an-id' } catch { $refused = $_.Exception.Message }
        Assert ($refused -match "^-Account \(or OVIS_ADD_ACCOUNT\) takes your Ovis account's id") "-Account of another shape must be refused at once: $refused"
        $said = New-Object Collections.Generic.List[string]; $failed = ''
        $env:OVIS_ACCOUNT_SERVICE_URL = 'off'
        try { & $Installer -Ref $Ref -NoService -Account 'acct_e2e' *>&1 | ForEach-Object { $said.Add("$_") } }
        catch { $failed = $_.Exception.Message } finally { Remove-Item Env:\OVIS_ACCOUNT_SERVICE_URL }
        Assert ($failed -match 'was not added to your Ovis account' -and ($said -join "`n") -match 'The account service is off on this PC') "-Account must fail the install with the add's own words when the add cannot run: $failed $($said -join ' / ')"
    }
    if (-not (Test-ServerRunning)) {
        Write-Host 'e2e: starting herdr'
        Start-Process -FilePath (Get-Command herdr).Source -ArgumentList 'server' -WindowStyle Hidden
        $startedServer = $true
        Wait-Until { Test-ServerRunning } 30 'herdr to start' | Out-Null
        Wait-Until { (Get-Json '/api/health').ok } 60 'the app to start with herdr' | Out-Null
        Invoke-Installer $Ref
    }
    Assert-App $expected

    if ($Update) {
        $found = Wait-Until { $status = Get-Json '/api/updates'; if ($status.latest_version) { $status } } 90 'the app to find the latest release'
        Assert ($found.available -and "v$($found.latest_version)" -eq $latest) "The app offers $($found.latest_version) (available: $($found.available)), not $latest"
        Write-Host "e2e: updating $expected to $latest"
        # an install names the release it was offered, as the app's Update does; a release older
        # than that contract ignores the body
        $install = @{ expected_revision = $found.latest_revision } | ConvertTo-Json -Compress
        Invoke-WebRequest "$origin/api/updates/install" -Method POST -Headers @{ 'x-herdr-update' = '1' } -ContentType 'application/json' -Body $install -UseBasicParsing -TimeoutSec 30 | Out-Null
        # the app restarts in the middle of this, so some of these questions go unanswered
        $after = Wait-Until {
            $status = Get-Json '/api/updates'
            if ($status.phase -eq 'error' -or ($status.phase -eq 'idle' -and "v$($status.current_version)" -eq $latest)) { $status }
        } 600 "the update to $latest"
        Assert ($after.phase -ne 'error') "The update failed: $($after.error)"
        Assert ((Get-Json '/api/health').web_ui.revision -eq $found.latest_revision) 'The updated app does not run the latest release'
        Assert-App $latest
    }
} catch {
    Write-Host "FAIL $($_.Exception.Message)"
    if (Test-Herdr) { herdr plugin log list | Out-String | Write-Host }
    $logs = @("$env:APPDATA\herdr\herdr-server.log") + @(Get-ChildItem "$env:APPDATA\herdr", "$env:LOCALAPPDATA\herdr" -Recurse -Filter server.log -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    foreach ($log in $logs) {
        if (Test-Path -LiteralPath $log) { Write-Host "--- $log"; Get-Content -LiteralPath $log -Tail 40 | Out-String | Write-Host }
    }
    throw
} finally {
    if ($startedServer) {
        herdr plugin action invoke "$pluginId.stop-windows" | Out-Null
        herdr server stop | Out-Null
    }
}
