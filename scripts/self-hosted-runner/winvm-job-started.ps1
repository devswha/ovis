# Runner-side guard (ACTIONS_RUNNER_HOOK_JOB_STARTED) of winvm's ephemeral runner (winvm-runner.sh), the Windows
# counterpart of job-started.sh: it runs before every job, outside anything a workflow controls. A pull request's run
# executes its own workflow files and route script, so a fork could name this runner's label; every job whose code
# comes from another repository is refused before a step runs.
#
# Fail closed: any error before the job is allowed refuses it. A failed hook only fails its step (a fork's always()
# steps would still run), so a refusal ends the job's Runner.Worker: the nearest ancestor of that name that started
# before this hook. While that worker is not found, the hook kills nothing and blocks, trying again every 5 s, so no
# other step starts.
#
# An allowed job then has the VM to itself: the VM's other runner services (other repositories' runners kept in the
# snapshot) are stopped while idle, and a job one of them already runs is waited for, three minutes at most; the reset
# after this job starts them again.
$ErrorActionPreference = 'Stop'
$own = 'C:\actions-runners\ovis-win\*'

function Find-Worker {
    $me = Get-CimInstance Win32_Process -Filter "ProcessId = $PID"
    $id = $me.ParentProcessId
    for ($depth = 0; $depth -lt 4; $depth++) {
        $p = Get-CimInstance Win32_Process -Filter "ProcessId = $id"
        if (-not $p -or $p.CreationDate -gt $me.CreationDate) { return $null }
        if ($p.Name -eq 'Runner.Worker.exe') { return $p.ProcessId }
        $id = $p.ParentProcessId
    }
    $null
}

function Deny([string]$why) {
    $ErrorActionPreference = 'Continue'
    Write-Output "::error::winvm's runner only runs code from $env:GITHUB_REPOSITORY; refusing this $env:GITHUB_EVENT_NAME job: $why."
    $said = $false
    while ($true) {
        $problem = try {
            $worker = Find-Worker
            if ($worker) {
                Stop-Process -Id $worker -Force -ErrorAction Stop
                exit 1
            }
            "the job's Runner.Worker is not found"
        } catch {
            "ending the job's Runner.Worker failed ($_)"
        }
        if (-not $said) { Write-Output "Nothing was killed: $problem; this hook blocks (pid $PID), trying again every 5 s."; $said = $true }
        Start-Sleep -Seconds 5
    }
}

try {
    $repository = $env:GITHUB_REPOSITORY
    $eventName = $env:GITHUB_EVENT_NAME
    if (-not $repository -or -not $eventName) { throw 'GITHUB_REPOSITORY and GITHUB_EVENT_NAME are required' }
    $payload = Get-Content -Raw -LiteralPath $env:GITHUB_EVENT_PATH | ConvertFrom-Json
    $head = if ($eventName -like 'pull_request*' -or $payload.pull_request) { $payload.pull_request.head.repo.full_name }
    elseif ($eventName -eq 'workflow_run' -or $payload.workflow_run) { $payload.workflow_run.head_repository.full_name }
    elseif ($eventName -eq 'issue_comment') { if ($payload.issue -and $payload.comment) { $repository } }
    else { $repository }
    if ($head -ne $repository) {
        Deny $(if ($head) { "its code comes from $head" } else { 'its code comes from an unknown repository' })
    }
} catch {
    Deny "the guard failed: $_"
}
Write-Output "Runner guard: $eventName from $repository"

$foreign = { @(Get-Process -Name Runner.Worker -ErrorAction SilentlyContinue | Where-Object { $_.Path -notlike $own }) }
$busy = @(& $foreign | ForEach-Object { Split-Path (Split-Path $_.Path) })
Get-CimInstance Win32_Service -Filter "Name LIKE 'actions.runner.%' AND State = 'Running'" | ForEach-Object {
    if ($busy -notcontains (Split-Path (Split-Path $_.PathName.Trim('"')))) {
        Stop-Service -Name $_.Name
        Write-Output "Stopped $($_.Name) for this job"
    }
}
$deadline = (Get-Date).AddMinutes(3)
while ((& $foreign).Count -gt 0) {
    if ((Get-Date) -gt $deadline) {
        Write-Output "::error::Another repository's runner in winvm is still in a job after 3 minutes. Re-run all jobs of this run: winvm is not offered while it is busy, so the new route takes windows-latest (re-running this job alone keeps winvm's label)."
        exit 1
    }
    Write-Output "Another repository's runner in winvm is in a job; waiting for it"
    Start-Sleep -Seconds 15
}
