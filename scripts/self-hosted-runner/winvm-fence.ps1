# winvm-fence.ps1: keeps the other repositories' runners in winvm (services kept in its snapshot) from taking a job.
# Stops every such runner service that is not in a job, and leaves one that is in a job to finish it. Prints
# "FENCE <runner services not stopped> <their Runner.Worker processes>": "FENCE 0 0" means none can take or run a job
# until the next reset starts them again. Used by winvm-job-started.ps1 before this runner's job and, over ssh, by
# winvm-runner.sh before a reset. A service's worker can only appear between the process read and its Stop-Service,
# milliseconds apart; a worker seen at all keeps its service running.
$ErrorActionPreference = 'Stop'
$own = 'C:\actions-runners\ovis-win\*'
$workers = { @(Get-Process -Name Runner.Worker -ErrorAction SilentlyContinue | Where-Object { $_.Path -notlike $own }) }
$services = { @(Get-CimInstance Win32_Service -Filter "Name LIKE 'actions.runner.%' AND State <> 'Stopped'") }
$busy = @(& $workers | ForEach-Object { Split-Path (Split-Path $_.Path) })
foreach ($service in & $services) {
    if ($busy -notcontains (Split-Path (Split-Path $service.PathName.Trim('"')))) {
        Stop-Service -Name $service.Name
        Write-Output "Stopped $($service.Name)"
    }
}
'FENCE {0} {1}' -f (& $services).Count, (& $workers).Count
