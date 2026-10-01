param(
  [string]$ApiBaseUrl = "",
  [string]$PairingCode = "",
  [string]$RepoRoot = (Get-Location).Path,
  [string]$RunnerName = "Windows runner",
  [int]$Port = 8787,
  [int]$PollSeconds = 3,
  [string]$LocalToken = "",
  [string]$ExpectedRunnerRevision = "",
  [string]$CompletionRecoveryPath = "",
  [string]$LinuxToWindowsPacket = "",
  [string]$WindowsToLinuxPacket = "",
  [string]$CombinedPacket = "",
  [string]$WindowsInteropEndpoint = "",
  [string]$WindowsInteropSharedKey = "",
  [switch]$CompletionSmoke,
  [switch]$CompletionSmokeFailure,
  [switch]$CompletionRecoverySeed,
  [switch]$CompletionRecoveryReplay,
  [switch]$CompletionRecoveryRepeat,
  [switch]$CompletionRecoveryWriteSmoke,
  [switch]$NetworkWarningSmoke,
  [string]$CompletionSmokeEvidencePath = ""
)

$ErrorActionPreference = "Stop"
$script:WorkspaceLabNetworkWarningCounts = @{}
# Windows PowerShell 5.1 (the default on most Windows installs) targets an
# older .NET Framework that does not always negotiate TLS 1.2 by default when
# calling an HTTPS endpoint. When that negotiation fails partway through,
# Invoke-RestMethod's own error handling can throw a bare "Object reference
# not set to an instance of an object" instead of a clear TLS/connection
# error, on every single poll. Force TLS 1.2 up front so the real HTTPS
# handshake with the Replit-hosted API succeeds instead of failing silently
# inside the cmdlet. PowerShell 7+/.NET already defaults to TLS 1.2+, so this
# is a no-op there.
try {
  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.ServicePointManager]::SecurityProtocol -bor [System.Net.SecurityProtocolType]::Tls12
} catch {
  # Some minimal .NET builds do not expose Tls12 as an enum member; the
  # runner still works over whatever protocol is already negotiated.
}
$OutputTruncationMarker = "`n[output truncated by Workspace Lab]"
$MaxOutputLength = 120000 - $OutputTruncationMarker.Length
$RunnerRevision = "oait-file-median-v9-progress-setup-instance"
$script:MaxLocalRequestsPerPump = 8
$allowedSuites = @("oa-it-test", "iteration-benchmark", "windows-benchmark", "macos-benchmark", "cross-comp-interop", "windows-to-windows-interop", "resilience-stress")
$script:WorkspaceLabPnpmPath = $null

if (-not [string]::IsNullOrWhiteSpace($ExpectedRunnerRevision) -and $ExpectedRunnerRevision -ne $RunnerRevision) {
  throw "This Workspace Lab runner is revision $RunnerRevision, but the current command requires $ExpectedRunnerRevision. Download the current runner or update the repository checkout, then run the command again."
}

function Test-RepoRoot([string]$path) {
  if ([string]::IsNullOrWhiteSpace($path)) { return $false }
  try {
    if (-not (Test-Path -LiteralPath $path -PathType Container)) { return $false }
    return Test-Path -LiteralPath (Join-Path $path "pnpm-workspace.yaml")
  } catch {
    # Placeholder text (e.g. "<PATH-TO-YOUR-CLONED-REPO>") or any other value
    # with characters that are illegal in a filesystem path lands here. Treat
    # it as "not a valid repo root" instead of letting the script crash.
    return $false
  }
}

function Resolve-RepoRoot {
  if (Test-RepoRoot $RepoRoot) {
    return (Resolve-Path -LiteralPath $RepoRoot).Path
  }
  Write-Host ""
  Write-Host "Workspace Lab could not find the repository at '$RepoRoot'." -ForegroundColor Yellow
  Write-Host "Enter the folder where you cloned or extracted this repository on this computer (the one containing pnpm-workspace.yaml)."
  Write-Host ""
  Write-Host "Don't have the code on this computer yet? Press Ctrl+C now, then in the Replit project try one of:" -ForegroundColor Yellow
  Write-Host "  A. Files tool -> its three-dot (...) menu at the top -> 'Download as zip'. If you don't see a Files icon in the left toolbar, open 'All tools' or search 'Files' first."
  Write-Host "  B. No 'Download as zip' option? Open the Shell tool and run: __WORKSPACE_LAB_ZIP_FALLBACK_COMMAND__ then download project.zip from the Files panel. The .git, .cache, and .local exclusions matter -- none of that is your code, it is usually far larger than the code itself, and it is the most common reason a manually zipped download comes out corrupted or refuses to open. The leading 'rm -f' clears out any earlier attempt so it does not get zipped into itself."
  Write-Host "  C. Prefer git? Open the Git tool, connect a GitHub repo, push, then 'git clone <your-repo-url>' here."
  Write-Host "Extract/clone it to a short, simple path, e.g. C:\dev\workspace (avoid spaces or deeply nested folders), then re-run this command and enter that folder below."
  Write-Host ""
  $attempt = 0
  while ($true) {
    $entered = Read-Host "Repository folder"
    if (Test-RepoRoot $entered) { return (Resolve-Path -LiteralPath $entered).Path }
    $attempt++
    Write-Host "That folder does not look like the repository root (no pnpm-workspace.yaml found there)." -ForegroundColor Yellow
    if ($attempt -ge 2) {
      Write-Host "Still stuck? Confirm you extracted the zip (not just opened it) and enter the top-level folder that directly contains pnpm-workspace.yaml, package.json, and the artifacts\ folder." -ForegroundColor Yellow
    }
    Write-Host "Try again, or press Ctrl+C to cancel."
  }
}

function Invoke-FullSetupIfNeeded {
  # A completed marker, not just the presence of node_modules: a previous
  # attempt can fail partway through `pnpm install` (e.g. a lifecycle script
  # error) after node_modules already exists on disk, which would otherwise
  # make this function think setup is done and skip it on the next retry.
  $marker = Join-Path $RepoRoot ".workspace-lab-setup-ok"
  $pnpmPathFile = Join-Path $RepoRoot ".workspace-lab-pnpm-path"
  $tsxCliPath = Join-Path $RepoRoot "scripts\node_modules\tsx\dist\cli.mjs"
  $crossCompTestPath = Join-Path $RepoRoot "scripts\cross-platform-interop.test.ts"
  $hasRecordedPnpmPath = $false
  if (Test-Path -LiteralPath $pnpmPathFile -PathType Leaf) {
    try {
      $recordedPnpmPath = (Get-Content -LiteralPath $pnpmPathFile -Raw -ErrorAction Stop).Trim()
      $hasRecordedPnpmPath = (
        -not [string]::IsNullOrWhiteSpace($recordedPnpmPath) -and
        (Test-Path -LiteralPath $recordedPnpmPath -PathType Leaf)
      )
    } catch {
      $hasRecordedPnpmPath = $false
    }
  }
  if ((Test-Path -LiteralPath $marker -PathType Leaf) -and $hasRecordedPnpmPath -and
      (Test-Path -LiteralPath $tsxCliPath -PathType Leaf) -and
      (Test-Path -LiteralPath $crossCompTestPath -PathType Leaf)) {
    return $false
  }
  $setupScript = Join-Path $RepoRoot "scripts/cross-platform-benchmark/setup-windows.ps1"
  if (-not (Test-Path -LiteralPath $setupScript)) {
    throw "Dependencies are not installed and the setup script is missing at '$setupScript'. Make sure -RepoRoot points to a complete checkout of this repository."
  }
  # Do not let a failed retry leave an old completion marker that can cause
  # the next runner invocation to skip setup and fall back to a shadowable
  # PATH lookup.
  Remove-Item -LiteralPath $marker -Force -ErrorAction SilentlyContinue
  Write-Host ""
  Write-Host "Running full setup in '$RepoRoot' (this only happens once, or again after a previous attempt failed)..." -ForegroundColor Yellow
  Write-Host ""
  $process = Start-Process -FilePath "powershell.exe" `
    -ArgumentList @("-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", $setupScript) `
    -WorkingDirectory $RepoRoot -Wait -PassThru -NoNewWindow
  if ($process.ExitCode -ne 0) {
    throw "Full setup failed (exit code $($process.ExitCode)). Fix the issue it reported above, then run this command again."
  }
  if (-not (Test-Path -LiteralPath $marker -PathType Leaf)) {
    # Keep compatibility with an older setup script copied into a checkout.
    Set-Content -LiteralPath $marker -Value ([DateTimeOffset]::UtcNow.ToString("o")) -NoNewline
  }
  Write-Host ""
  Write-Host "Setup complete." -ForegroundColor Green
  return $true
}

function Sync-WorkspaceLabPnpmPath {
  # setup-windows.ps1 records the exact working pnpm candidate it selected.
  # Do not let a broken Corepack pnpm.cmd earlier on PATH shadow the standalone
  # npm-installed pnpm that setup already proved can run.
  $pathFile = Join-Path $RepoRoot ".workspace-lab-pnpm-path"
  if (-not (Test-Path -LiteralPath $pathFile -PathType Leaf)) {
    return
  }
  try {
    $selected = (Get-Content -LiteralPath $pathFile -Raw -ErrorAction Stop).Trim()
    if ([string]::IsNullOrWhiteSpace($selected) -or
        -not (Test-Path -LiteralPath $selected -PathType Leaf)) {
      return
    }
    $directory = Split-Path -Parent $selected
    if (-not [string]::IsNullOrWhiteSpace($directory)) {
      $env:Path = "$directory;$env:Path"
    }
    # PATH is only a compatibility hint. Suite dispatch below uses this exact
    # verified file so a shadowed Corepack pnpm.cmd cannot win resolution.
    $script:WorkspaceLabPnpmPath = (Resolve-Path -LiteralPath $selected).Path
  } catch {
    # A stale or unreadable hint must not hide the normal setup error. The
    # setup marker and pnpm command still provide the authoritative checks.
  }
}

function Get-WorkspaceLabPnpmPath {
  if ([string]::IsNullOrWhiteSpace($script:WorkspaceLabPnpmPath)) {
    throw "Workspace Lab setup did not record a verified pnpm executable. Run setup-windows.ps1 successfully before starting a suite."
  }
  if (-not (Test-Path -LiteralPath $script:WorkspaceLabPnpmPath -PathType Leaf)) {
    throw "The verified Workspace Lab pnpm executable is no longer available at '$script:WorkspaceLabPnpmPath'. Re-run setup-windows.ps1."
  }
  return $script:WorkspaceLabPnpmPath
}

function Get-InterpretedInvocation([string]$FilePath, [string[]]$ArgumentList) {
  # Windows cannot launch .ps1 and .cmd/.bat shims as ordinary executables.
  # Start the interpreter explicitly so the Process object we track owns a
  # reliable exit code instead of being a shim wrapper with a blank ExitCode.
  $extension = [System.IO.Path]::GetExtension($FilePath).ToLowerInvariant()
  $quotedFilePath = '"' + $FilePath.Replace('"', '\"') + '"'
  $quotedArguments = @($ArgumentList | ForEach-Object {
    $value = [string]$_
    if ($value -match '[\s"]') {
      '"' + $value.Replace('"', '\"') + '"'
    } else {
      $value
    }
  })
  if ($extension -eq '.ps1') {
    $hostExe = (Get-Process -Id $PID).Path
    return [pscustomobject]@{
      FileName = $hostExe
      Arguments = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', $quotedFilePath) + $quotedArguments
    }
  }
  if ($extension -eq '.cmd' -or $extension -eq '.bat') {
    return [pscustomobject]@{
      FileName = "$env:WINDIR\System32\cmd.exe"
      Arguments = @('/d', '/c', $quotedFilePath) + $quotedArguments
    }
  }
  return [pscustomobject]@{ FileName = $FilePath; Arguments = $quotedArguments }
}

function Remove-TerminalControlSequences([string]$value) {
  if ($null -eq $value) { return "" }
  $withoutAnsi = [regex]::Replace($value, "\x1B(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))", "")
  return [regex]::Replace($withoutAnsi, "[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]", "")
}

function Limit-Output([string]$value) {
  if ($null -eq $value) { return "" }
  $value = Remove-TerminalControlSequences $value
  if ($value.Length -le $MaxOutputLength) { return $value }
  return $value.Substring(0, $MaxOutputLength) + $OutputTruncationMarker
}

function Limit-SafeMetadata([string]$value) {
  if ($null -eq $value) { return "" }
  $value = Remove-TerminalControlSequences $value
  if ($value.Length -le 128) { return $value }
  return $value.Substring(0, 128)
}

function Get-SafeWorkspaceLabJobId([string]$value) {
  $candidate = Limit-SafeMetadata $value
  if ($candidate -match '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$') {
    return $candidate
  }
  return "[redacted]"
}

function Get-StringSha256([string]$value) {
  if ($null -eq $value) { $value = "" }
  $sha256 = [Security.Cryptography.SHA256]::Create()
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($value)
    return ([BitConverter]::ToString($sha256.ComputeHash($bytes))).Replace("-", "").ToLowerInvariant()
  } finally {
    $sha256.Dispose()
  }
}

function Get-CapturedOutput([string]$path, [switch]$PreserveCompleteOutput) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return "" }
  $output = Get-Content -Raw -LiteralPath $path
  if ($PreserveCompleteOutput) {
    return Remove-TerminalControlSequences $output
  }
  return Limit-Output $output
}

function Limit-OaItTestOutput([string]$value) {
  if ($null -eq $value) { return "" }
  $value = Remove-TerminalControlSequences $value
  if ($value.Length -le $MaxOutputLength) { return $value }

  $lines = @($value -split "`r?`n")
  $aggregateLines = @()
  for ($start = $lines.Length - 1; $start -ge 0 -and $aggregateLines.Count -eq 0; $start--) {
    if ($lines[$start] -notmatch "\btests\s+\d+\b") { continue }
    $end = -1
    for ($candidate = $start; $candidate -lt [Math]::Min($lines.Length, $start + 12); $candidate++) {
      if ($lines[$candidate] -match "\bduration_ms\s+[\d.]+") {
        $end = $candidate
        break
      }
    }
    if ($end -ge $start) {
      $aggregateLines = @($lines[$start..$end])
    }
  }

  $fileSummaryLines = @($lines | Where-Object {
    $_ -match "^WORKSPACE_LAB_FILE_SUMMARY "
  })
  $suffixLines = @($aggregateLines) + @($fileSummaryLines)
  if ($suffixLines.Count -eq 0) {
    return Limit-Output $value
  }

  $suffix = $suffixLines -join "`n"
  $truncationNotice = "[output truncated by Workspace Lab]"
  $prefixLength = [Math]::Max(
    0,
    $MaxOutputLength - $suffix.Length - $truncationNotice.Length - 2
  )
  $prefix = $value.Substring(0, [Math]::Min($prefixLength, $value.Length))
  return $prefix + "`n" + $truncationNotice + "`n" + $suffix
}

function Get-InteropResultJson([string]$suite, [string]$output, [string]$resultPath = "") {
  if ($suite -eq "windows-to-windows-interop") {
    if ([string]::IsNullOrWhiteSpace($resultPath) -or -not (Test-Path -LiteralPath $resultPath -PathType Leaf)) {
      throw "Windows-to-Windows interop did not produce its bounded result packet."
    }
    $json = Get-Content -LiteralPath $resultPath -Raw
    $null = $json | ConvertFrom-Json
    return $json
  }
  $marker = switch ($suite) {
    "cross-comp-interop" { "INTEROP_RESULT_JSON_BASE64" }
    "resilience-stress" { "WINDOWS_RESILIENCE_RESULT_JSON_BASE64" }
    default { return $null }
  }
  $markerPrefix = "$marker "
  if ($suite -eq "resilience-stress" -and
      $output -match 'resilience-result-marker-too-large') {
    throw "Workspace Lab resilience evidence marker was rejected before emission because it exceeded the bounded marker budget (resilience-result-marker-too-large)."
  }
  if ($suite -eq "resilience-stress" -and $output.Contains("[output truncated by Workspace Lab]")) {
    $markerStart = $output.IndexOf($markerPrefix, [StringComparison]::Ordinal)
    $markerEnd = if ($markerStart -ge 0) {
      $output.IndexOf("`n", $markerStart + $markerPrefix.Length, [StringComparison]::Ordinal)
    } else {
      -1
    }
    if ($markerStart -lt 0 -or $markerEnd -lt 0) {
      throw "Workspace Lab resilience evidence marker exceeded the bounded runner capture; structured proof was rejected as incomplete (resilience-result-marker-truncated)."
    }
  }
  $match = [regex]::Match($output, "$marker ([A-Za-z0-9+/=]+)")
  if (-not $match.Success) { return $null }
  try {
    $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($match.Groups[1].Value))
    $null = $json | ConvertFrom-Json
    return $json
  } catch {
    throw "Workspace Lab output contained an invalid structured evidence packet: $($_.Exception.Message)"
  }
}

function Invoke-NativePacketCombine {
  $paths = @($LinuxToWindowsPacket, $WindowsToLinuxPacket, $CombinedPacket)
  $provided = @($paths | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  if ($provided.Count -eq 0) { return $false }
  if ($provided.Count -ne 3) {
    throw "Native packet combine requires -LinuxToWindowsPacket, -WindowsToLinuxPacket, and -CombinedPacket together."
  }
  foreach ($path in @($LinuxToWindowsPacket, $WindowsToLinuxPacket)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
      throw "Native packet combine could not find retained packet '$path'."
    }
  }
  $verifier = Join-Path $RepoRoot "scripts\cross-platform-benchmark\verify-interop-packets.mjs"
  if (-not (Test-Path -LiteralPath $verifier -PathType Leaf)) {
    throw "The strict named-host verifier is missing at '$verifier'."
  }
  $outputDirectory = Split-Path -Parent $CombinedPacket
  if (-not [string]::IsNullOrWhiteSpace($outputDirectory)) {
    New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
  }
  Write-Host "Combining retained native-host packets with the strict named-host verifier."
  & node $verifier `
    --linux-to-windows $LinuxToWindowsPacket `
    --windows-to-linux $WindowsToLinuxPacket `
    --require-named-hosts `
    --output $CombinedPacket
  if ($LASTEXITCODE -ne 0) {
    throw "Strict named-host packet verification rejected the handoff (exit code $LASTEXITCODE)."
  }
  Write-Host "Combined native-host packet written to '$CombinedPacket'." -ForegroundColor Green
  return $true
}

function Get-SuiteCommand([string]$suite, [string]$resultPath = "") {
  switch ($suite) {
    "macos-benchmark" {
      throw "The macOS benchmark is unsupported on Windows. Select macOS in Workspace Lab and run macos-runner.sh there."
    }
    "oa-it-test" {
      return @{ FilePath = (Get-WorkspaceLabPnpmPath); Arguments = @("--filter", "@workspace/oa-it", "run", "test") }
    }
    "iteration-benchmark" {
      return @{ FilePath = (Get-WorkspaceLabPnpmPath); Arguments = @("--filter", "@workspace/oa-it", "run", "iteration-benchmark") }
    }
    "windows-benchmark" {
      return @{ FilePath = "powershell.exe"; Arguments = @("-ExecutionPolicy", "Bypass", "-File", (Join-Path $RepoRoot "scripts/cross-platform-benchmark/run-windows.ps1")) }
    }
    "cross-comp-interop" {
      $testPath = Join-Path $RepoRoot "scripts\cross-platform-interop.test.ts"
      if (-not (Test-Path -LiteralPath $testPath -PathType Leaf)) {
        throw "Cross-Comp source is missing at '$testPath'. Refresh the Windows checkout from the current Studio download, then run setup again."
      }
      return @{
        FilePath = (Get-WorkspaceLabPnpmPath)
        Arguments = @("--filter", "@workspace/scripts", "run", "test:cross-comp-interop")
      }
    }
    "windows-to-windows-interop" {
      if ([string]::IsNullOrWhiteSpace($WindowsInteropEndpoint)) {
        throw "Windows-to-Windows interop requires -WindowsInteropEndpoint pointing to the other native Windows host."
      }
      if ([string]::IsNullOrWhiteSpace($WindowsInteropSharedKey) -or $WindowsInteropSharedKey.Length -lt 16) {
        throw "Windows-to-Windows interop requires -WindowsInteropSharedKey with at least 16 characters."
      }
      $probePath = Join-Path $RepoRoot "scripts\cross-platform-benchmark\cross-platform-interop.ts"
      if (-not (Test-Path -LiteralPath $probePath -PathType Leaf)) {
        throw "Windows-to-Windows interop source is missing at '$probePath'. Refresh the Windows checkout from the current Studio download."
      }
      if ([string]::IsNullOrWhiteSpace($resultPath)) {
        throw "Windows-to-Windows interop requires a bounded result path."
      }
      return @{
        FilePath = (Get-WorkspaceLabPnpmPath)
        Arguments = @(
          "--filter", "@workspace/scripts", "exec", "tsx", $probePath,
          "--mode", "client", "--direction", "windows-to-windows",
          "--platform", "windows", "--endpoint", $WindowsInteropEndpoint,
          "--output", $resultPath, "--timeout-ms", "1000"
        )
      }
    }
    "resilience-stress" {
      $suitePath = Join-Path $RepoRoot "scripts\workspace-lab\windows-resilience-suite.mjs"
      if (-not (Test-Path -LiteralPath $suitePath -PathType Leaf)) {
        throw "The randomized resilience suite is missing at '$suitePath'. Refresh the Windows checkout from the current Studio download, then run setup again."
      }
      return @{ FilePath = "node.exe"; Arguments = @($suitePath) }
    }
    default {
      throw "Suite is not allowlisted: $suite"
    }
  }
}

function Stop-WorkspaceLabProcessTree([int]$processId) {
  if ($processId -le 0) { return }
  try {
    & taskkill.exe /PID ([string]$processId) /T /F 2>$null | Out-Null
  } catch {
    # The process may have exited between the check and taskkill. There is
    # nothing else to clean up in that case.
  }
}

function Get-WorkspaceLabOutputLength([string]$path) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { return [long]0 }
  try {
    return [long](Get-Item -LiteralPath $path -ErrorAction Stop).Length
  } catch {
    return [long]0
  }
}

function Get-WorkspaceLabResiliencePhaseProgress([string]$stdoutPath) {
  $output = Get-CapturedOutput $stdoutPath
  if ([string]::IsNullOrWhiteSpace($output)) { return $null }
  $lines = $output -split "`r?`n"
  $phaseKinds = @("bounded-concurrency", "durability-recovery", "enterprise-pressure")
  for ($lineIndex = $lines.Length - 1; $lineIndex -ge 0; $lineIndex--) {
    $line = $lines[$lineIndex]
    if ($line.Length -gt 4096 -or -not $line.StartsWith("{")) { continue }
    try {
      $event = $line | ConvertFrom-Json
    } catch {
      continue
    }
    $isStart = $event.event -eq "workspace-lab-resilience-phase-start"
    $isCompletion = $event.event -eq "workspace-lab-resilience-phase"
    if (-not $isStart -and -not $isCompletion) { continue }
    try {
      $phaseIndex = [int]$event.phaseIndex
      $totalPhases = [int]$event.totalPhases
      $round = [int]$event.round
      $phaseName = [string]$event.name
      $phaseStatus = [string]$event.status
    } catch {
      continue
    }
    if ($totalPhases -notin @(4, 7, 10) -or
        $phaseIndex -lt 1 -or $phaseIndex -gt $totalPhases) {
      continue
    }
    if ($phaseIndex -eq 1) {
      if ($round -ne 0 -or $phaseName -ne "native-windows-postgres-lifecycle") { continue }
    } else {
      $phaseOffset = $phaseIndex - 2
      $expectedRound = [int][Math]::Floor($phaseOffset / $phaseKinds.Count) + 1
      $expectedName = "round-$expectedRound-$($phaseKinds[$phaseOffset % $phaseKinds.Count])"
      if ($round -ne $expectedRound -or $phaseName -ne $expectedName) { continue }
    }
    if (($isStart -and $phaseStatus -ne "running") -or
        ($isCompletion -and $phaseStatus -notin @("passed", "failed"))) {
      continue
    }
    return @{
      phaseIndex = $phaseIndex
      totalPhases = $totalPhases
      phaseName = $phaseName
      phaseStatus = $phaseStatus
      completedPhases = if ($isStart) { $phaseIndex - 1 } else { $phaseIndex }
    }
  }
  return $null
}

function Invoke-AllowedSuite(
  [string]$suite,
  [scriptblock]$Heartbeat = $null,
  [scriptblock]$DuringRun = $null,
  [scriptblock]$AfterRun = $null,
  [scriptblock]$ProgressCallback = $null,
  [object[]]$DuringRunArguments = @()
) {
  if ($allowedSuites -notcontains $suite) {
    throw "Suite is not allowlisted: $suite"
  }
  $stamp = [guid]::NewGuid().ToString("N")
  $stdoutPath = Join-Path $env:TEMP "workspace-lab-$stamp.out"
  $stderrPath = Join-Path $env:TEMP "workspace-lab-$stamp.err"
  $resultJsonPath = Join-Path $env:TEMP "workspace-lab-$stamp-result.json"
  $command = Get-SuiteCommand $suite $resultJsonPath
  $started = [DateTimeOffset]::UtcNow
  $process = $null
  try {
    Write-Host ("Workspace Lab starting {0} in {1}." -f $suite, $RepoRoot)
    $invocation = Get-InterpretedInvocation $command.FilePath $command.Arguments
    Write-Host ("Workspace Lab executable: {0}" -f $command.FilePath)
    Write-Host ("Workspace Lab interpreter: {0}" -f $invocation.FileName)
    $previousInteropKey = $env:IT_INTEROP_SHARED_KEY
    if ($suite -eq "windows-to-windows-interop") {
      $env:IT_INTEROP_SHARED_KEY = $WindowsInteropSharedKey
    }
    try {
      $process = Start-Process -FilePath $invocation.FileName `
        -ArgumentList $invocation.Arguments `
        -WorkingDirectory $RepoRoot `
        -PassThru `
        -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutPath `
        -RedirectStandardError $stderrPath
    } finally {
      if ($suite -eq "windows-to-windows-interop") {
        $env:IT_INTEROP_SHARED_KEY = $previousInteropKey
      }
    }
    # Retain the native process handle while the child is alive. Without this,
    # Windows PowerShell can lose access to ExitCode after the OS has reaped the
    # process, even though HasExited correctly changed to true.
    $null = $process.Handle
    $lastHeartbeat = [DateTimeOffset]::UtcNow
    $lastProgressUpdate = [DateTimeOffset]::MinValue
    $lastObservedOutputBytes = [long]0
    $outputBytes = [long]0
    $lastOutputAt = $null
    $phaseProgress = $null
    $suiteTimeoutSeconds = if ($suite -eq "resilience-stress") { 3600 } else { 1800 }
    $timedOut = $false
    while (-not $process.HasExited) {
      $now = [DateTimeOffset]::UtcNow
      if (([DateTimeOffset]::UtcNow - $started).TotalSeconds -ge $suiteTimeoutSeconds) {
        $timedOut = $true
        Write-Warning ("Workspace Lab stopped {0} after its {1}-second deadline." -f $suite, $suiteTimeoutSeconds)
        Stop-WorkspaceLabProcessTree $process.Id
        break
      }
      if ($null -ne $Heartbeat -and ([DateTimeOffset]::UtcNow - $lastHeartbeat).TotalSeconds -ge 5) {
        try {
          & $Heartbeat (Get-CapturedOutput $stdoutPath)
        } catch {
          Write-WorkspaceLabNetworkWarning "heartbeat-failed" "" $_
        }
        $lastHeartbeat = [DateTimeOffset]::UtcNow
      }
      Start-Sleep -Milliseconds 250
      if ($null -ne $ProgressCallback -and ($now - $lastProgressUpdate).TotalSeconds -ge 1) {
        $stdoutBytes = Get-WorkspaceLabOutputLength $stdoutPath
        $stderrBytes = Get-WorkspaceLabOutputLength $stderrPath
        $outputBytes = $stdoutBytes + $stderrBytes
        if ($outputBytes -ne $lastObservedOutputBytes) {
          $lastObservedOutputBytes = $outputBytes
          $lastOutputAt = [DateTimeOffset]::UtcNow.ToString("o")
          if ($suite -eq "resilience-stress") {
            $phaseProgress = Get-WorkspaceLabResiliencePhaseProgress $stdoutPath
          }
        }
        $snapshot = @{
          status = "running"
          suite = $suite
          startedAt = $started.ToString("o")
          elapsedMs = [long]([DateTimeOffset]::UtcNow - $started).TotalMilliseconds
          outputBytes = $outputBytes
          lastOutputAt = $lastOutputAt
          phaseProgress = $phaseProgress
        }
        $null = & $ProgressCallback $snapshot
        $lastProgressUpdate = [DateTimeOffset]::UtcNow
      }
      if ($null -ne $DuringRun) {
        & $DuringRun @DuringRunArguments
      }
    }
    if ($null -ne $AfterRun) {
      & $AfterRun @DuringRunArguments
    }
    # Finalize redirected stream handling before reading ExitCode. Do not call
    # Refresh() here: after the OS process is gone, refreshing can discard the
    # cached state that contains the numeric exit code.
    $process.WaitForExit()
    $exitCode = $process.ExitCode
    if ($timedOut) { $exitCode = 124 }
    if ($null -eq $exitCode) {
      throw "Workspace Lab could not read the completed suite exit code (runner revision $RunnerRevision)."
    }
    $deadlineOutput = if ($timedOut) { "`nWorkspace Lab deadline exceeded after $suiteTimeoutSeconds seconds." } else { "" }
    if ($suite -eq "oa-it-test") {
      $stdout = Get-CapturedOutput $stdoutPath -PreserveCompleteOutput
      $stderr = Get-CapturedOutput $stderrPath -PreserveCompleteOutput
    } else {
      $stdout = Get-CapturedOutput $stdoutPath
      $stderr = Get-CapturedOutput $stderrPath
    }
    $combinedOutput = (($stdout + "`n" + $stderr + $deadlineOutput).Trim())
    $outputTruncated = $combinedOutput.Length -gt $MaxOutputLength
    if ($suite -eq "oa-it-test") {
      $output = Limit-OaItTestOutput $combinedOutput
    } else {
      $output = Limit-Output $combinedOutput
    }
    $status = if ($exitCode -eq 0) { "passed" } else { "failed" }
    try {
      $resultJson = Get-InteropResultJson $suite $output $resultJsonPath
    } catch {
      if ($suite -ne "resilience-stress" -or
          $_.Exception.Message -notmatch "resilience-result-marker-(?:truncated|too-large)") {
        throw
      }
      $capturedOutputLength = $output.Length
      $capturedOutputSha256 = Get-StringSha256 $output
      if ($_.Exception.Message -match "resilience-result-marker-too-large") {
        $failureCategory = "resilience-result-marker-too-large"
      } else {
        $failureCategory = "resilience-result-marker-truncated"
      }
      $output = ConvertTo-WorkspaceLabJson ([ordered]@{
        suite = $suite
        status = "failed"
        exitCode = 125
        failureCategory = $failureCategory
        outputLength = $capturedOutputLength
        outputSha256 = $capturedOutputSha256
      })
      $status = "failed"
      $exitCode = 125
      $resultJson = $null
    }
    Write-Host ("Workspace Lab finished {0}: {1} (exit {2})." -f $suite, $status, $exitCode)
    return @{
      suite = $suite
      status = $status
      exitCode = $exitCode
      output = $output
      outputTruncated = $outputTruncated
      resultJson = $resultJson
      host = $env:COMPUTERNAME
      durationMs = ([DateTimeOffset]::UtcNow - $started).TotalMilliseconds
    }
  } finally {
    if ($null -ne $process -and -not $process.HasExited) {
      Stop-WorkspaceLabProcessTree $process.Id
    }
    Remove-Item $stdoutPath, $stderrPath, $resultJsonPath -Force -ErrorAction SilentlyContinue
  }
}

function Write-JsonResponse($context, $statusCode, $body) {
  $payload = ($body | ConvertTo-Json -Depth 6 -Compress)
  $bytes = [Text.Encoding]::UTF8.GetBytes($payload)
  $context.Response.StatusCode = $statusCode
  $context.Response.ContentType = "application/json"
  $context.Response.Headers.Add("Access-Control-Allow-Origin", "*")
  $context.Response.Headers.Add("Access-Control-Allow-Headers", "Content-Type, X-Workspace-Lab-Token")
  $context.Response.ContentLength64 = $bytes.Length
  $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  $context.Response.Close()
}

function Read-JsonBody($context) {
  $reader = [IO.StreamReader]::new($context.Request.InputStream, $context.Request.ContentEncoding)
  try { return ($reader.ReadToEnd() | ConvertFrom-Json) } finally { $reader.Dispose() }
}

function Respond-LocalRunnerRequestDuringSuite($context) {
  if ($context.Request.HttpMethod -eq "OPTIONS") {
    $context.Response.StatusCode = 204
    $context.Response.Headers.Add("Access-Control-Allow-Origin", "*")
    $context.Response.Headers.Add("Access-Control-Allow-Headers", "Content-Type, X-Workspace-Lab-Token")
    if ($context.Request.Headers["Access-Control-Request-Private-Network"] -eq "true") {
      $context.Response.Headers.Add("Access-Control-Allow-Private-Network", "true")
    }
    $context.Response.Close()
    return
  }
  if ($context.Request.Headers["X-Workspace-Lab-Token"] -ne $LocalToken) {
    Write-JsonResponse $context 401 @{ error = "Invalid local runner token" }
    return
  }
  if ($context.Request.HttpMethod -eq "GET" -and $context.Request.Url.AbsolutePath -eq "/health") {
    Write-JsonResponse $context 200 @{
      runner = "windows"
      status = "online"
      active = $true
      setupPaused = $script:WorkspaceLabSetupPaused
      instanceId = $script:WorkspaceLabInstanceId
      host = $env:COMPUTERNAME
      revision = $RunnerRevision
      suites = $allowedSuites
    }
    return
  }
  if ($context.Request.HttpMethod -eq "GET" -and $context.Request.Url.AbsolutePath -eq "/progress") {
    $progress = if ($null -ne $script:LocalRunProgress -and $script:LocalRunProgress.status -eq "running") {
      $script:LocalRunProgress
    } else {
      @{ status = "idle" }
    }
    Write-JsonResponse $context 200 $progress
    return
  }
  if ($context.Request.HttpMethod -eq "POST" -and $context.Request.Url.AbsolutePath -eq "/setup-control") {
    $body = Read-JsonBody $context
    if ($body.paused -isnot [bool]) {
      Write-JsonResponse $context 400 @{ error = "Setup pause must be a boolean." }
      return
    }
    if (-not $body.paused -and $body.setupChanged -eq $true) {
      Write-JsonResponse $context 409 @{
        error = "This local runner cannot adopt changed setup. Keep it paused, stop it in the terminal, and restart with the refreshed command."
      }
      return
    }
    $script:WorkspaceLabSetupPaused = [bool]$body.paused
    Write-JsonResponse $context 200 @{
      paused = $script:WorkspaceLabSetupPaused
      active = $true
    }
    return
  }
  if ($context.Request.HttpMethod -eq "POST" -and $context.Request.Url.AbsolutePath -eq "/run") {
    Write-JsonResponse $context 409 @{ error = "A local Workspace Lab job is already running" }
    return
  }
  Write-JsonResponse $context 404 @{ error = "Not found" }
}

function Pump-LocalRunnerRequestsDuringSuite(
  $listener,
  [hashtable]$listenerState,
  [int]$WaitMilliseconds = 0
) {
  for ($requestIndex = 0; $requestIndex -lt $script:MaxLocalRequestsPerPump; $requestIndex++) {
    if (-not $listener.IsListening) {
      return
    }
    try {
      if ($null -eq $listenerState.PendingContext) {
        $listenerState.PendingContext = $listener.GetContextAsync()
      }
      if (-not $listenerState.PendingContext.Wait($WaitMilliseconds)) {
        return
      }
      $context = $listenerState.PendingContext.GetAwaiter().GetResult()
      $listenerState.PendingContext = $null
    } catch {
      $listenerState.PendingContext = $null
      Write-WorkspaceLabNetworkWarning "local-listener-request-failed" "" $_
      return
    }
    try {
      Respond-LocalRunnerRequestDuringSuite $context
    } catch {
      Write-WorkspaceLabNetworkWarning "local-listener-request-failed" "" $_
      try {
        if ($context.Response.OutputStream.CanWrite) {
          Write-JsonResponse $context 400 @{ error = "Local Workspace Lab request failed." }
        }
      } catch {
        Write-WorkspaceLabNetworkWarning "local-listener-response-failed" "" $_
      }
    }
  }
}

function ConvertTo-WorkspaceLabJson($value) {
  # Windows PowerShell 5.1's ConvertTo-Json can emit malformed request bodies
  # when captured test output contains Unicode reporter glyphs, escaped JSON,
  # and long multiline strings. JavaScriptSerializer handles those strings
  # correctly on the default Windows PowerShell installation. PowerShell 7+
  # may not ship System.Web.Extensions, so retain the native serializer as
  # the explicit fallback there.
  $payload = $null
  try {
    Add-Type -AssemblyName System.Web.Extensions -ErrorAction Stop
    $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
    $serializer.MaxJsonLength = 16 * 1024 * 1024
    $payload = $serializer.Serialize($value)
  } catch {
    $payload = ($value | ConvertTo-Json -Depth 12 -Compress)
  }
  try {
    $null = $payload | ConvertFrom-Json
  } catch {
    throw "Workspace Lab generated invalid JSON before sending the request: $($_.Exception.Message)"
  }
  return $payload
}

function Get-WorkspaceLabFailureMetadata($errorRecord, [string]$category) {
  $statusCode = 0
  $response = $null
  try {
    $response = $errorRecord.Exception.Response
    if ($null -ne $response) {
      $statusCode = [int]$response.StatusCode
    }
  } catch {
    $statusCode = 0
  }
  $exceptionType = "unknown"
  try {
    $exceptionType = [string]$errorRecord.Exception.GetType().FullName
  } catch {
    $exceptionType = "unknown"
  }
  $responseBodyPresent = $false
  try {
    $responseBodyPresent = -not [string]::IsNullOrWhiteSpace(
      [string]$errorRecord.ErrorDetails.Message
    )
  } catch {
    $responseBodyPresent = $false
  }
  return [ordered]@{
    category = $category
    statusCode = $statusCode
    exceptionType = Limit-SafeMetadata $exceptionType
    responseBodyPresent = $responseBodyPresent
  }
}

function Write-WorkspaceLabNetworkWarning([string]$category, [string]$jobId, $errorRecord) {
  if ($category -eq "poll-failed" -or $category -eq "heartbeat-failed") {
    $failureCount = 0
    if ($script:WorkspaceLabNetworkWarningCounts.ContainsKey($category)) {
      $failureCount = [int]$script:WorkspaceLabNetworkWarningCounts[$category]
    }
    $failureCount++
    $script:WorkspaceLabNetworkWarningCounts[$category] = $failureCount
    if ($failureCount -gt 1) {
      return
    }
  }
  $failureMetadata = Get-WorkspaceLabFailureMetadata $errorRecord $category
  $safeMetadata = [ordered]@{
    category = Limit-SafeMetadata $category
    jobId = Get-SafeWorkspaceLabJobId $jobId
    statusCode = [int]$failureMetadata.statusCode
    exceptionType = Limit-SafeMetadata ([string]$failureMetadata.exceptionType)
    responseBodyPresent = [bool]$failureMetadata.responseBodyPresent
  }
  Write-Warning (
    "Workspace Lab runner network warning: " +
    ($safeMetadata | ConvertTo-Json -Compress)
  )
}

function Reset-WorkspaceLabNetworkWarning([string]$category) {
  if ($category -eq "poll-failed" -or $category -eq "heartbeat-failed") {
    $script:WorkspaceLabNetworkWarningCounts[$category] = 0
  }
}

function Write-WorkspaceLabCompletionWarning([string]$jobId, $metadata) {
  $safeMetadata = [ordered]@{
    category = [string]$metadata.category
    jobId = Get-SafeWorkspaceLabJobId $jobId
    statusCode = [int]$metadata.statusCode
    exceptionType = Limit-SafeMetadata ([string]$metadata.exceptionType)
    responseBodyPresent = [bool]$metadata.responseBodyPresent
  }
  Write-Warning (
    "Workspace Lab completion warning: " +
    ($safeMetadata | ConvertTo-Json -Compress)
  )
}

function New-CompletionRecoveryMarker($completionBody) {
  $output = [string]$completionBody.output
  $resultJson = [string]$completionBody.resultJson
  return [ordered]@{
    jobId = [string]$completionBody.jobId
    outcomeStatus = [string]$completionBody.status
    attempts = 2
    exitCode = [int]$completionBody.exitCode
    host = Limit-Output ([string]$completionBody.host)
    outputLength = $output.Length
    outputSha256 = Get-StringSha256 $output
    resultJsonLength = $resultJson.Length
    resultJsonSha256 = Get-StringSha256 $resultJson
    recordedAt = [DateTimeOffset]::UtcNow.ToString("o")
  }
}

function Write-AtomicCompletionRecoveryJson(
  [string]$json,
  [switch]$SimulateInterruptedWrite,
  [switch]$SimulateReplacementFailure
) {
  $parent = Split-Path -Parent $CompletionRecoveryPath
  if ([string]::IsNullOrWhiteSpace($parent)) {
    $parent = [System.IO.Path]::GetDirectoryName(
      [System.IO.Path]::GetFullPath($CompletionRecoveryPath)
    )
  }
  if ([string]::IsNullOrWhiteSpace($parent)) {
    throw "Workspace Lab could not resolve the completion marker directory."
  }
  if (-not (Test-Path -LiteralPath $parent -PathType Container)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  $fileName = [System.IO.Path]::GetFileName($CompletionRecoveryPath)
  $temporaryPath = Join-Path $parent (
    "." + $fileName + "." + [guid]::NewGuid().ToString("N") + ".tmp"
  )
  $keepTemporaryFile = $false
  try {
    $encoding = [System.Text.UTF8Encoding]::new($false)
    $bytes = $encoding.GetBytes($json)
    $stream = [System.IO.File]::Open(
      $temporaryPath,
      [System.IO.FileMode]::CreateNew,
      [System.IO.FileAccess]::Write,
      [System.IO.FileShare]::None
    )
    try {
      if ($SimulateInterruptedWrite) {
        $partialLength = [Math]::Max(1, [int][Math]::Floor($bytes.Length / 2))
        $stream.Write($bytes, 0, $partialLength)
        $stream.Flush($true)
        $keepTemporaryFile = $true
        $interruption = [System.IO.IOException]::new(
          "Synthetic interruption while staging a completion marker."
        )
        $interruption.Data["TemporaryPath"] = $temporaryPath
        throw $interruption
      }
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally {
      $stream.Dispose()
    }

    $lastFailure = $null
    for ($attempt = 1; $attempt -le 2; $attempt++) {
      try {
        if ($SimulateReplacementFailure) {
          throw [System.IO.IOException]::new(
            "Synthetic completion marker replacement failure."
          )
        }
        if (Test-Path -LiteralPath $CompletionRecoveryPath -PathType Leaf) {
          [System.IO.File]::Replace(
            $temporaryPath,
            $CompletionRecoveryPath,
            $null
          )
        } else {
          [System.IO.File]::Move($temporaryPath, $CompletionRecoveryPath)
        }
        return
      } catch {
        $lastFailure = $_
        if ($attempt -lt 2) {
          Start-Sleep -Milliseconds 50
        }
      }
    }
    throw $lastFailure.Exception
  } finally {
    if (-not $keepTemporaryFile -and
        (Test-Path -LiteralPath $temporaryPath -PathType Leaf)) {
      [System.IO.File]::Delete($temporaryPath)
    }
  }
}

function Write-WorkspaceLabMarkerWriteRetryWarning(
  [string]$jobId,
  [int]$attempts,
  [bool]$markerRetained
) {
  $safeMetadata = [ordered]@{
    category = "completion-marker-write-retry"
    jobId = Get-SafeWorkspaceLabJobId $jobId
    attempts = [Math]::Min(2, [Math]::Max(1, $attempts))
    retryCount = [Math]::Min(1, [Math]::Max(0, $attempts - 1))
    markerRetained = $markerRetained
  }
  Write-Warning (
    "Workspace Lab completion warning: " +
    ($safeMetadata | ConvertTo-Json -Compress)
  )
}

function Save-CompletionRecoveryMarker(
  $completionBody,
  [switch]$SimulateReplacementFailure
) {
  $marker = New-CompletionRecoveryMarker $completionBody
  $parent = Split-Path -Parent $CompletionRecoveryPath
  if (-not [string]::IsNullOrWhiteSpace($parent)) {
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
  }
  try {
    Write-AtomicCompletionRecoveryJson `
      (ConvertTo-WorkspaceLabJson $marker) `
      -SimulateReplacementFailure:$SimulateReplacementFailure
    return [ordered]@{
      status = "saved"
      attempts = 1
      retryCount = 0
      markerRetained = $true
    }
  } catch {
    $markerRetained = Test-Path -LiteralPath $CompletionRecoveryPath -PathType Leaf
    Write-WorkspaceLabMarkerWriteRetryWarning `
      ([string]$marker.jobId) 2 $markerRetained
    return [ordered]@{
      status = "retry-required"
      attempts = 2
      retryCount = 1
      markerRetained = $markerRetained
    }
  }
}

function Get-CompletionRecoveryMarker {
  if ([string]::IsNullOrWhiteSpace($CompletionRecoveryPath) -or
      -not (Test-Path -LiteralPath $CompletionRecoveryPath -PathType Leaf)) {
    return $null
  }
  try {
    return Get-Content -Raw -LiteralPath $CompletionRecoveryPath | ConvertFrom-Json
  } catch {
    throw "Workspace Lab found an unreadable completion recovery marker at '$CompletionRecoveryPath'. Do not delete it until the marker is inspected or copied for reconciliation. Error: $($_.Exception.Message)"
  }
}

function Try-RecordCompletionRecovery([string]$base, $headers) {
  $marker = Get-CompletionRecoveryMarker
  if ($null -eq $marker) { return "missing" }
  try {
    $recovery = Invoke-RestMethod -Method Post -Uri "$base/it/workspace-lab/runner/recover" `
      -Headers $headers -ContentType "application/json" -TimeoutSec 15 `
      -Body (ConvertTo-WorkspaceLabJson $marker)
    if ($null -eq $recovery) {
      throw "Workspace Lab recovery returned no acknowledgement for job $([string]$marker.jobId)."
    }
    Remove-Item -LiteralPath $CompletionRecoveryPath -Force
    Write-Warning (
      "Workspace Lab job {0} entered bounded recovery after two completion attempts failed. " +
      "The session queue now exposes safe hashes and lengths for operator reconciliation." -f
      [string]$marker.jobId
    )
    return "acknowledged"
  } catch {
    $failureMetadata = Get-WorkspaceLabFailureMetadata $_ "completion-recovery-recording-failed"
    Write-WorkspaceLabCompletionWarning ([string]$marker.jobId) $failureMetadata
    return "retained"
  }
}

function Invoke-PairedCompletion(
  [string]$base,
  $headers,
  [string]$jobId,
  [hashtable]$completionBody,
  [string]$hostName
) {
  try {
    $completion = Invoke-RestMethod -Method Post -Uri "$base/it/workspace-lab/runner/complete" `
      -Headers $headers -ContentType "application/json" -TimeoutSec 15 `
      -Body (ConvertTo-WorkspaceLabJson $completionBody)
    if ($null -eq $completion) {
      throw "Workspace Lab completion returned no acknowledgement for job $jobId."
    }
    return "accepted"
  } catch {
    $originalFailureMetadata = Get-WorkspaceLabFailureMetadata $_ "completion-rejected"
    $failureOutput = Limit-Output (
      "Workspace Lab completion payload was rejected for job $jobId. " +
      "The suite result was not accepted."
    )
    $fallbackBody = @{
      jobId = $jobId
      status = "failed"
      exitCode = 1
      output = $failureOutput
      host = $hostName
    }
    try {
      $fallback = Invoke-RestMethod -Method Post -Uri "$base/it/workspace-lab/runner/complete" `
        -Headers $headers -ContentType "application/json" -TimeoutSec 15 `
        -Body (ConvertTo-WorkspaceLabJson $fallbackBody)
      if ($null -eq $fallback) {
        throw "Workspace Lab completion failure returned no acknowledgement for job $jobId."
      }
      Write-WorkspaceLabCompletionWarning $jobId $originalFailureMetadata
      return "failure-recorded"
    } catch {
      $fallbackFailureMetadata = Get-WorkspaceLabFailureMetadata $_ "completion-fallback-rejected"
      # A 409 means the original request reached the coordinator and another
      # response won the terminal-state race. Preserve that already-recorded
      # outcome instead of retrying the same job forever.
      $statusCode = 0
      try {
        $statusCode = [int]$_.Exception.Response.StatusCode
      } catch {
        $statusCode = 0
      }
      if ($statusCode -eq 409) {
        $terminalRaceMetadata = Get-WorkspaceLabFailureMetadata $_ "completion-terminal-race"
        $terminalRaceMetadata.originalFailure = $originalFailureMetadata
        Write-WorkspaceLabCompletionWarning $jobId $terminalRaceMetadata
        # The 409 only proves *a* result was saved, not which one -- it could
        # be this attempt's own completion racing a retry of itself, or an
        # unrelated prior write. Recover the durably saved job so the warning
        # reflects the coordinator's actual saved state instead of assuming.
        try {
          $statusBody = @{ jobId = $jobId }
          $savedJob = Invoke-RestMethod -Method Post -Uri "$base/it/workspace-lab/runner/job-status" `
            -Headers $headers -ContentType "application/json" -TimeoutSec 15 `
            -Body (ConvertTo-WorkspaceLabJson $statusBody)
          if ($null -ne $savedJob) {
            $recoveredMetadata = [ordered]@{
              category = "completion-terminal-race-recovered"
              jobId = Get-SafeWorkspaceLabJobId $jobId
              savedStatus = [string]$savedJob.status
              savedHost = Limit-SafeMetadata ([string]$savedJob.host)
            }
            Write-Warning (
              "Workspace Lab runner recovered the saved outcome after a completion race: " +
              ($recoveredMetadata | ConvertTo-Json -Compress)
            )
          }
        } catch {
          # Recovery is best-effort evidence for the warning log; the job's
          # durable state is unaffected either way, so a failed lookup here
          # must not turn into a retry or a synthesized failure result.
          Write-WorkspaceLabNetworkWarning "completion-terminal-race-recovery-failed" $jobId $_
        }
        return "already-recorded"
      }
      $markerWrite = Save-CompletionRecoveryMarker $completionBody
      if ([string]$markerWrite.status -ne "saved") {
        return "marker-write-retry"
      }
      $recoveryMetadata = Get-WorkspaceLabFailureMetadata $_ "completion-recovery-required"
      $recoveryMetadata.originalFailure = $originalFailureMetadata
      $recoveryMetadata.fallbackFailure = $fallbackFailureMetadata
      Write-WorkspaceLabCompletionWarning $jobId $recoveryMetadata
      return "recovery-required"
    }
  }
}

function Invoke-CompletionSmoke {
  if ([string]::IsNullOrWhiteSpace($ApiBaseUrl) -or
      [string]::IsNullOrWhiteSpace($LocalToken) -or
      [string]::IsNullOrWhiteSpace($CompletionSmokeEvidencePath)) {
    throw "Completion smoke requires -ApiBaseUrl, -LocalToken, and -CompletionSmokeEvidencePath."
  }

  $headers = @{ "X-Workspace-Lab-Runner-Token" = $LocalToken }
  $unicode = ([char]0x03BB).ToString() + ([char]0x4E2D).ToString()
  $output = "suite line 1`n$unicode suite line 2"
  $resultJson = ConvertTo-WorkspaceLabJson @{
    marker = "embedded-result-json"
    unicode = $unicode
    lines = @("line one", "line two")
  }
  $acceptedBody = @{
    jobId = "windows-completion-smoke-accepted"
    status = "passed"
    exitCode = 0
    output = $output
    resultJson = $resultJson
    host = "windows-completion-smoke"
  }
  $rejectedBody = @{
    jobId = "windows-completion-smoke-rejected"
    status = "passed"
    exitCode = 0
    output = $output
    resultJson = $resultJson
    host = "windows-completion-smoke"
  }
  $acceptedOutcome = Invoke-PairedCompletion `
    $ApiBaseUrl.TrimEnd("/") $headers $acceptedBody.jobId $acceptedBody "windows-completion-smoke"
  $fallbackOutcome = Invoke-PairedCompletion `
    $ApiBaseUrl.TrimEnd("/") $headers $rejectedBody.jobId $rejectedBody "windows-completion-smoke"
  $evidence = [ordered]@{
    schemaVersion = 1
    kind = "windows-completion-runner"
    status = if ($acceptedOutcome -eq "accepted" -and $fallbackOutcome -eq "failure-recorded") {
      "passed"
    } else {
      "failed"
    }
    acceptedOutcome = $acceptedOutcome
    rejectedOutcome = $fallbackOutcome
  }
  $evidence | ConvertTo-Json -Depth 8 | Set-Content `
    -LiteralPath $CompletionSmokeEvidencePath -Encoding UTF8
  return $evidence
}

function Invoke-CompletionFailureSmoke {
  if ([string]::IsNullOrWhiteSpace($ApiBaseUrl) -or
      [string]::IsNullOrWhiteSpace($LocalToken) -or
      [string]::IsNullOrWhiteSpace($CompletionSmokeEvidencePath)) {
    throw "Completion failure smoke requires -ApiBaseUrl, -LocalToken, and -CompletionSmokeEvidencePath."
  }

  $headers = @{ "X-Workspace-Lab-Runner-Token" = $LocalToken }
  $recoveryPath = Join-Path ([System.IO.Path]::GetTempPath()) `
    ("workspace-lab-completion-failure-" + [guid]::NewGuid().ToString('N') + ".json")
  $previousRecoveryPath = $CompletionRecoveryPath
  $CompletionRecoveryPath = $recoveryPath
  try {
    $completionBody = @{
      jobId = "windows-completion-smoke-fallback-failure"
      status = "passed"
      exitCode = 0
      output = "fixture completion output; raw payload must not enter evidence"
      resultJson = (ConvertTo-WorkspaceLabJson @{
        marker = "fixture-result-json"
        value = "raw result payload must not enter evidence"
      })
      host = "windows-completion-smoke"
    }
    $completionOutcome = Invoke-PairedCompletion `
      $ApiBaseUrl.TrimEnd("/") $headers $completionBody.jobId $completionBody "windows-completion-smoke"
    $marker = Get-CompletionRecoveryMarker
    $metadata = [ordered]@{
      markerPresent = ($null -ne $marker)
      attempts = if ($null -eq $marker) { 0 } else { [int]$marker.attempts }
      outputLength = if ($null -eq $marker) { 0 } else { [int]$marker.outputLength }
      outputSha256 = if ($null -eq $marker) { "" } else { [string]$marker.outputSha256 }
      resultLength = if ($null -eq $marker) { 0 } else { [int]$marker.resultJsonLength }
      resultSha256 = if ($null -eq $marker) { "" } else { [string]$marker.resultJsonSha256 }
    }
    $evidence = [ordered]@{
      schemaVersion = 1
      kind = "windows-completion-failure-runner"
      status = "failed"
      failureCategory = if ($completionOutcome -eq "recovery-required") {
        "completion-fallback-failure"
      } else {
        "completion-fallback-not-rejected"
      }
      completionOutcome = $completionOutcome
      recoveryMetadata = $metadata
    }
    $evidence | ConvertTo-Json -Depth 8 | Set-Content `
      -LiteralPath $CompletionSmokeEvidencePath -Encoding UTF8
    return $evidence
  } finally {
    if (Test-Path -LiteralPath $recoveryPath -PathType Leaf) {
      Remove-Item -LiteralPath $recoveryPath -Force -ErrorAction SilentlyContinue
    }
    $CompletionRecoveryPath = $previousRecoveryPath
  }
}

function Get-CompletionRecoveryMetadata($marker) {
  return [ordered]@{
    markerPresent = ($null -ne $marker)
    jobId = if ($null -eq $marker) { "" } else { [string]$marker.jobId }
    attempts = if ($null -eq $marker) { 0 } else { [int]$marker.attempts }
    outputLength = if ($null -eq $marker) { 0 } else { [int]$marker.outputLength }
    outputSha256 = if ($null -eq $marker) { "" } else { [string]$marker.outputSha256 }
    resultLength = if ($null -eq $marker) { 0 } else { [int]$marker.resultJsonLength }
    resultSha256 = if ($null -eq $marker) { "" } else { [string]$marker.resultJsonSha256 }
  }
}

function Invoke-CompletionRecoveryWriteSmoke {
  if ([string]::IsNullOrWhiteSpace($CompletionRecoveryPath) -or
      [string]::IsNullOrWhiteSpace($CompletionSmokeEvidencePath)) {
    throw "Completion recovery write smoke requires -CompletionRecoveryPath and -CompletionSmokeEvidencePath."
  }

  $oldBody = @{
    jobId = "windows-completion-marker-previous"
    status = "passed"
    exitCode = 0
    output = "previous marker fixture"
    resultJson = "{}"
    host = "windows-completion-marker-smoke"
  }
  $newBody = @{
    jobId = "windows-completion-marker-next"
    status = "passed"
    exitCode = 0
    output = "replacement marker fixture"
    resultJson = "{}"
    host = "windows-completion-marker-smoke"
  }
  $temporaryPath = ""
  try {
    $null = Save-CompletionRecoveryMarker $oldBody
    $interruptedMarker = New-CompletionRecoveryMarker $newBody
    try {
      Write-AtomicCompletionRecoveryJson `
        (ConvertTo-WorkspaceLabJson $interruptedMarker) `
        -SimulateInterruptedWrite
    } catch {
      $temporaryPath = [string]$_.Exception.Data["TemporaryPath"]
    }

    $afterInterruption = Get-CompletionRecoveryMarker
    $interruptionStagedFilePresent = (
      -not [string]::IsNullOrWhiteSpace($temporaryPath) -and
      (Test-Path -LiteralPath $temporaryPath -PathType Leaf)
    )

    $failedWrite = Save-CompletionRecoveryMarker `
      $newBody -SimulateReplacementFailure
    $afterFailedReplacement = Get-CompletionRecoveryMarker
    $successfulWrite = Save-CompletionRecoveryMarker $newBody
    $afterSuccessfulReplacement = Get-CompletionRecoveryMarker
    $canonicalJsonValid = $false
    try {
      $null = Get-Content -Raw -LiteralPath $CompletionRecoveryPath | ConvertFrom-Json
      $canonicalJsonValid = $true
    } catch {}

    $evidence = [ordered]@{
      schemaVersion = 1
      kind = "windows-completion-recovery-write-smoke"
      status = if (
        [string]$afterInterruption.jobId -eq [string]$oldBody.jobId -and
        $interruptionStagedFilePresent -and
        [string]$failedWrite.status -eq "retry-required" -and
        [bool]$failedWrite.markerRetained -and
        [string]$afterFailedReplacement.jobId -eq [string]$oldBody.jobId -and
        [string]$successfulWrite.status -eq "saved" -and
        [string]$afterSuccessfulReplacement.jobId -eq [string]$newBody.jobId -and
        $canonicalJsonValid
      ) { "passed" } else { "failed" }
      interruptedCanonicalJobId = [string]$afterInterruption.jobId
      interruptedCanonicalJsonValid = ($null -ne $afterInterruption)
      interruptionStagedFilePresent = $interruptionStagedFilePresent
      replacementRetryCount = [int]$failedWrite.retryCount
      replacementMarkerRetained = [bool]$failedWrite.markerRetained
      replacementCanonicalJobId = [string]$afterFailedReplacement.jobId
      successfulReplacementJobId = [string]$afterSuccessfulReplacement.jobId
      successfulReplacementJsonValid = $canonicalJsonValid
    }
    $evidence | ConvertTo-Json -Depth 8 | Set-Content `
      -LiteralPath $CompletionSmokeEvidencePath -Encoding UTF8
    return $evidence
  } finally {
    if (-not [string]::IsNullOrWhiteSpace($temporaryPath) -and
        (Test-Path -LiteralPath $temporaryPath -PathType Leaf)) {
      [System.IO.File]::Delete($temporaryPath)
    }
    if (Test-Path -LiteralPath $CompletionRecoveryPath -PathType Leaf) {
      Remove-Item -LiteralPath $CompletionRecoveryPath -Force -ErrorAction SilentlyContinue
    }
  }
}

function Invoke-CompletionRecoverySeed {
  if ([string]::IsNullOrWhiteSpace($ApiBaseUrl) -or
      [string]::IsNullOrWhiteSpace($LocalToken) -or
      [string]::IsNullOrWhiteSpace($CompletionRecoveryPath) -or
      [string]::IsNullOrWhiteSpace($CompletionSmokeEvidencePath)) {
    throw "Completion recovery seed requires -ApiBaseUrl, -LocalToken, -CompletionRecoveryPath, and -CompletionSmokeEvidencePath."
  }

  $headers = @{ "X-Workspace-Lab-Runner-Token" = $LocalToken }
  $completionBody = @{
    jobId = "windows-completion-smoke-fallback-failure"
    status = "passed"
    exitCode = 0
    output = "fixture completion output; raw payload must not enter evidence"
    resultJson = (ConvertTo-WorkspaceLabJson @{
      marker = "fixture-result-json"
      value = "raw result payload must not enter evidence"
    })
    host = "windows-completion-smoke"
  }
  $completionOutcome = Invoke-PairedCompletion `
    $ApiBaseUrl.TrimEnd("/") $headers $completionBody.jobId $completionBody "windows-completion-smoke"
  $marker = Get-CompletionRecoveryMarker
  $markerBytes = if ($null -eq $marker) { "" } else { Get-Content -Raw -LiteralPath $CompletionRecoveryPath }
  $metadata = Get-CompletionRecoveryMetadata $marker
  $metadata.markerSha256 = Get-StringSha256 $markerBytes
  $evidence = [ordered]@{
    schemaVersion = 1
    kind = "windows-completion-recovery-seed"
    status = if ($completionOutcome -eq "recovery-required" -and $null -ne $marker) {
      "passed"
    } else {
      "failed"
    }
    completionOutcome = $completionOutcome
    recoveryMetadata = $metadata
  }
  $evidence | ConvertTo-Json -Depth 8 | Set-Content `
    -LiteralPath $CompletionSmokeEvidencePath -Encoding UTF8
  return $evidence
}

function Invoke-CompletionRecoveryReplay([bool]$expectMarker) {
  if ([string]::IsNullOrWhiteSpace($ApiBaseUrl) -or
      ([string]::IsNullOrWhiteSpace($LocalToken) -and [string]::IsNullOrWhiteSpace($PairingCode)) -or
      [string]::IsNullOrWhiteSpace($CompletionRecoveryPath) -or
      [string]::IsNullOrWhiteSpace($CompletionSmokeEvidencePath)) {
    throw "Completion recovery replay requires -ApiBaseUrl, either -LocalToken or -PairingCode, -CompletionRecoveryPath, and -CompletionSmokeEvidencePath."
  }

  $base = $ApiBaseUrl.TrimEnd("/")
  $pairingOutcome = "local-token"
  $headers = @{ "X-Workspace-Lab-Runner-Token" = $LocalToken }
  if (-not [string]::IsNullOrWhiteSpace($PairingCode)) {
    $pair = Invoke-RestMethod -Method Post -Uri "$base/it/workspace-lab/pair" `
      -ContentType "application/json" -TimeoutSec 15 `
      -Body (ConvertTo-WorkspaceLabJson @{
        pairingCode = $PairingCode
        runnerName = $RunnerName
      })
    if ($null -eq $pair -or [string]::IsNullOrWhiteSpace([string]$pair.runnerToken)) {
      throw "Completion recovery replay pairing returned no runner token."
    }
    $headers = @{ "X-Workspace-Lab-Runner-Token" = [string]$pair.runnerToken }
    $pairingOutcome = "paired"
  }
  $markerBefore = Get-CompletionRecoveryMarker
  $markerBytes = if ($null -eq $markerBefore) { "" } else { Get-Content -Raw -LiteralPath $CompletionRecoveryPath }
  $markerSha256 = Get-StringSha256 $markerBytes
  $recoveryOutcome = Try-RecordCompletionRecovery $base $headers
  $markerAfter = Get-CompletionRecoveryMarker
  $acknowledged = $recoveryOutcome -eq "acknowledged"
  $unchanged = $null -eq $markerAfter
  $noMarker = $recoveryOutcome -eq "missing" -and $null -eq $markerBefore -and $null -eq $markerAfter
  $valid = if ($expectMarker) {
    $null -ne $markerBefore -and $acknowledged -and $unchanged
  } else {
    $noMarker
  }
  $evidence = [ordered]@{
    schemaVersion = 1
    kind = if ($expectMarker) {
      "windows-completion-recovery-replay"
    } else {
      "windows-completion-recovery-repeat"
    }
    status = if ($valid) { "passed" } else { "failed" }
    recoveryOutcome = $recoveryOutcome
    pairingOutcome = $pairingOutcome
    markerBeforePresent = ($null -ne $markerBefore)
    markerAfterPresent = ($null -ne $markerAfter)
    markerSha256 = $markerSha256
    markerBefore = Get-CompletionRecoveryMetadata $markerBefore
  }
  $evidence | ConvertTo-Json -Depth 8 | Set-Content `
    -LiteralPath $CompletionSmokeEvidencePath -Encoding UTF8
  return $evidence
}

function Send-PairedHeartbeat([string]$base, $headers, [string]$jobId, [string]$output, [string]$hostName) {
  Invoke-RestMethod -Method Post -Uri "$base/it/workspace-lab/runner/heartbeat" `
    -Headers $headers -ContentType "application/json" -TimeoutSec 15 `
    -Body (ConvertTo-WorkspaceLabJson @{
      jobId = $jobId
      output = (Limit-Output $output)
      host = $hostName
    }) | Out-Null
  Reset-WorkspaceLabNetworkWarning "heartbeat-failed"
}

function Invoke-NetworkWarningSmoke {
  $script:WorkspaceLabNetworkWarningCounts = @{}
  $retryCount = 12
  $recoveryCounts = [ordered]@{
    poll = 0
    heartbeat = 0
  }
  foreach ($case in @(
    @{ category = "heartbeat-failed"; jobId = "windows-network-warning-heartbeat"; recoveryKey = "heartbeat" },
    @{ category = "poll-failed"; jobId = ""; recoveryKey = "poll" }
  )) {
    for ($attempt = 1; $attempt -le $retryCount; $attempt++) {
      try {
        throw "synthetic provider response: Authorization: Bearer fixture-token; raw response body must not be logged"
      } catch {
        Write-WorkspaceLabNetworkWarning $case.category $case.jobId $_
      }
    }
    # Model a successful request with the same reset hook used by live poll
    # and heartbeat requests before a separate outage begins.
    Reset-WorkspaceLabNetworkWarning $case.category
    $recoveryCounts[$case.recoveryKey]++
    for ($attempt = 1; $attempt -le $retryCount; $attempt++) {
      try {
        throw "synthetic provider response: Authorization: Bearer fixture-token; raw response body must not be logged"
      } catch {
        Write-WorkspaceLabNetworkWarning $case.category $case.jobId $_
      }
    }
  }
  $singleFailureCases = @(
    @{ category = "local-listener-start-failed"; jobId = "" },
    @{ category = "local-listener-request-failed"; jobId = "" }
  )
  foreach ($case in $singleFailureCases) {
    try {
      throw "synthetic provider response: Authorization: Bearer fixture-token; raw response body must not be logged"
    } catch {
      Write-WorkspaceLabNetworkWarning $case.category $case.jobId $_
    }
  }
  return [ordered]@{
    status = "passed"
    categories = @(
      "heartbeat-failed",
      "poll-failed",
      "local-listener-start-failed",
      "local-listener-request-failed"
    )
    retryCounts = [ordered]@{
      poll = [int]$script:WorkspaceLabNetworkWarningCounts["poll-failed"]
      heartbeat = [int]$script:WorkspaceLabNetworkWarningCounts["heartbeat-failed"]
    }
    recoveryCounts = $recoveryCounts
  }
}

function Start-LocalRunner {
  if ([string]::IsNullOrWhiteSpace($LocalToken)) {
    throw "Local mode requires -LocalToken. Use the Workspace Lab pairing key."
  }
  $listener = [Net.HttpListener]::new()
  $listener.Prefixes.Add("http://127.0.0.1:$Port/")
  try {
    $listener.Start()
  } catch {
    Write-WorkspaceLabNetworkWarning "local-listener-start-failed" "" $_
    throw "Could not start the local Workspace Lab listener on port $Port. Check the runner warning metadata for the stable failure category."
  }
  Write-Host "Workspace Lab local runner listening on http://127.0.0.1:$Port/"
  Write-Host "Workspace Lab runner revision: $RunnerRevision"
  Write-Host "This runner does not open its own page. Leave this window open, return to Workspace Lab in your browser, wait for Local runner to show Online, then choose a suite."
  Write-Host "Stop with Ctrl+C. The runner accepts only the four allowlisted suites."
  $active = $false
  $script:LocalRunProgress = $null
  $script:WorkspaceLabSetupPaused = $false
  $script:WorkspaceLabInstanceId = [guid]::NewGuid().ToString("N")
  $listenerState = @{ PendingContext = $null }
  $pumpLocalRequestsDuringSuite = {
    param($runningListener, $runningListenerState)
    Pump-LocalRunnerRequestsDuringSuite $runningListener $runningListenerState 0
  }
  $drainLocalRequestsAfterSuite = {
    param($runningListener, $runningListenerState)
    Pump-LocalRunnerRequestsDuringSuite $runningListener $runningListenerState 250
  }
  try {
    while ($listener.IsListening) {
      # HttpListener.GetContext() blocks inside .NET and can prevent Windows
      # PowerShell from observing Ctrl+C until another request arrives. Poll
      # the asynchronous task in short intervals so pipeline cancellation is
      # processed even while the runner is otherwise idle.
      if ($null -eq $listenerState.PendingContext) {
        $listenerState.PendingContext = $listener.GetContextAsync()
      }
      while (-not $listenerState.PendingContext.Wait(250)) {
        # The bounded wait is deliberately empty. Returning to the PowerShell
        # pipeline four times a second keeps Ctrl+C responsive.
      }
      $context = $listenerState.PendingContext.GetAwaiter().GetResult()
      $listenerState.PendingContext = $null
      try {
        if ($context.Request.HttpMethod -eq "OPTIONS") {
          $context.Response.StatusCode = 204
          $context.Response.Headers.Add("Access-Control-Allow-Origin", "*")
          $context.Response.Headers.Add("Access-Control-Allow-Headers", "Content-Type, X-Workspace-Lab-Token")
          # Studio is served over HTTPS from a public domain, and this
          # listener is loopback. Chromium's Private Network Access policy
          # preflights that gap and silently drops the real request unless
          # the preflight response explicitly allows it -- without this
          # header every /health and /run call from the browser is blocked
          # before it ever reaches this listener, with no error surfaced to
          # the page (it just looks like the runner never received it).
          if ($context.Request.Headers["Access-Control-Request-Private-Network"] -eq "true") {
            $context.Response.Headers.Add("Access-Control-Allow-Private-Network", "true")
          }
          $context.Response.Close()
          continue
        }
        if ($context.Request.Headers["X-Workspace-Lab-Token"] -ne $LocalToken) {
          Write-JsonResponse $context 401 @{ error = "Invalid local runner token" }
          continue
        }
        if ($context.Request.HttpMethod -eq "GET" -and $context.Request.Url.AbsolutePath -eq "/health") {
          Write-JsonResponse $context 200 @{
            runner = "windows"
            status = "online"
            active = $active
            setupPaused = $script:WorkspaceLabSetupPaused
            instanceId = $script:WorkspaceLabInstanceId
            host = $env:COMPUTERNAME
            revision = $RunnerRevision
            suites = $allowedSuites
          }
          continue
        }
        if ($context.Request.HttpMethod -eq "GET" -and $context.Request.Url.AbsolutePath -eq "/progress") {
          $progress = if ($active -and $null -ne $script:LocalRunProgress) {
            $script:LocalRunProgress
          } else {
            @{ status = "idle" }
          }
          Write-JsonResponse $context 200 $progress
          continue
        }
        if ($context.Request.HttpMethod -eq "POST" -and $context.Request.Url.AbsolutePath -eq "/setup-control") {
          $body = Read-JsonBody $context
          if ($body.paused -isnot [bool]) {
            Write-JsonResponse $context 400 @{ error = "Setup pause must be a boolean." }
            continue
          }
          if (-not $body.paused -and $body.setupChanged -eq $true) {
            Write-JsonResponse $context 409 @{
              error = "This local runner cannot adopt changed setup. Keep it paused, stop it in the terminal, and restart with the refreshed command."
            }
            continue
          }
          $script:WorkspaceLabSetupPaused = [bool]$body.paused
          Write-JsonResponse $context 200 @{
            paused = $script:WorkspaceLabSetupPaused
            active = $active
          }
          continue
        }
        if ($context.Request.HttpMethod -ne "POST" -or $context.Request.Url.AbsolutePath -ne "/run") {
          Write-JsonResponse $context 404 @{ error = "Not found" }
          continue
        }
        if ($active) {
          Write-JsonResponse $context 409 @{ error = "A local Workspace Lab job is already running" }
          continue
        }
        if ($script:WorkspaceLabSetupPaused) {
          Write-JsonResponse $context 409 @{ error = "The local runner is paused for setup changes." }
          continue
        }
        $body = Read-JsonBody $context
        $suite = [string]$body.suite
        $active = $true
        $script:LocalRunProgress = @{
          status = "running"
          suite = $suite
          startedAt = [DateTimeOffset]::UtcNow.ToString("o")
          elapsedMs = [long]0
          outputBytes = [long]0
          lastOutputAt = $null
          phaseProgress = $null
        }
        try {
          $runResult = Invoke-AllowedSuite $suite `
            -DuringRun $pumpLocalRequestsDuringSuite `
            -AfterRun $drainLocalRequestsAfterSuite `
            -ProgressCallback {
              param($progress)
              $script:LocalRunProgress = $progress
            } `
            -DuringRunArguments @($listener, $listenerState)
          $script:LocalRunProgress.status = $runResult.status
          $script:LocalRunProgress.elapsedMs = [long]$runResult.durationMs
          Write-JsonResponse $context 200 $runResult
        } finally {
          $active = $false
        }
      } catch {
        Write-WorkspaceLabNetworkWarning "local-listener-request-failed" "" $_
        try {
          if ($context.Response.OutputStream.CanWrite) {
            Write-JsonResponse $context 400 @{ error = "Local Workspace Lab request failed." }
          }
        } catch {
          Write-WorkspaceLabNetworkWarning "local-listener-response-failed" "" $_
        }
      }
    }
  } catch {
    Write-WorkspaceLabNetworkWarning "local-listener-loop-failed" "" $_
    throw "The local Workspace Lab listener stopped. Check the runner warning metadata for the stable failure category."
  } finally {
    $listener.Stop()
    $listener.Close()
  }
}

function Start-PairedRunner {
  if ([string]::IsNullOrWhiteSpace($ApiBaseUrl) -or [string]::IsNullOrWhiteSpace($PairingCode)) {
    throw "Paired mode requires -ApiBaseUrl and -PairingCode."
  }
  $base = $ApiBaseUrl.TrimEnd("/")
  $pair = Invoke-RestMethod -Method Post -Uri "$base/it/workspace-lab/pair" `
    -ContentType "application/json" -TimeoutSec 15 `
    -Body (ConvertTo-WorkspaceLabJson @{ pairingCode = $PairingCode; runnerName = $RunnerName })
  if ($null -eq $pair -or [string]::IsNullOrWhiteSpace([string]$pair.runnerToken)) {
    throw "Workspace Lab pairing did not return a runner token. The pairing code may be expired or already used; generate a fresh code in Cross-Comp Lab and re-run the command."
  }
  $headers = @{ "X-Workspace-Lab-Runner-Token" = $pair.runnerToken }
  Write-Host "Workspace Lab paired as $RunnerName. Polling for allowlisted jobs."
  Write-Host "Workspace Lab runner revision: $RunnerRevision"
  Write-Host "This runner does not open its own page. Leave this window open and start a paired suite from Workspace Lab in your browser."
  Write-Host "Stop with Ctrl+C."
  $lastSetupPaused = $false
  while ($true) {
    try {
      # The return value ("missing"/"acknowledged"/"retained") is deliberately
      # discarded here. An unassigned, unpiped function call is an expression
      # statement in PowerShell, so its return value would otherwise be
      # written straight to the console every poll cycle -- printing a
      # confusing bare "missing" on every single poll while no recovery
      # marker exists, which is nearly always.
      $null = Try-RecordCompletionRecovery $base $headers
      # Windows PowerShell 5.1's Invoke-RestMethod has a long-standing bug: a
      # -Method Post call with no -Body at all can throw a bare
      # "Object reference not set to an instance of an object"
      # (System.NullReferenceException, no HTTP error, no inner exception)
      # while building the request, instead of a normal WebException. Passing
      # an explicit empty JSON body sidesteps it; the poll route never reads
      # the request body, so this is a no-op for the server.
      $poll = Invoke-RestMethod -Method Post -Uri "$base/it/workspace-lab/runner/poll" `
        -Headers $headers -ContentType "application/json" -TimeoutSec 15 -Body "{}"
      Reset-WorkspaceLabNetworkWarning "poll-failed"
      $setupPaused = $poll.setupPaused -eq $true
      if ($setupPaused -ne $lastSetupPaused) {
        if ($setupPaused) {
          Write-Host "Setup paused: no new jobs will be claimed. Any active suite will finish first."
        } else {
          Write-Host "Setup resumed: waiting for allowlisted jobs."
        }
        $lastSetupPaused = $setupPaused
      }
      if ($null -ne $poll.job) {
        $jobId = [string]$poll.job.id
        $heartbeat = {
          param([string]$output)
          Send-PairedHeartbeat $base $headers $jobId $output $env:COMPUTERNAME
        }
        $result = Invoke-AllowedSuite ([string]$poll.job.suite) -Heartbeat $heartbeat
        $completionBody = @{
          jobId = $jobId
          status = $result.status
          exitCode = $result.exitCode
          output = $result.output
          outputTruncated = $result.outputTruncated
          host = $result.host
        }
        if (-not [string]::IsNullOrWhiteSpace([string]$result.resultJson)) {
          $completionBody.resultJson = $result.resultJson
        }
        $completionOutcome = Invoke-PairedCompletion $base $headers $jobId $completionBody $result.host
        if ($completionOutcome -eq "accepted") {
          Write-Host ("Workspace Lab job {0} completed with status {1} (exit {2})." -f $jobId, $result.status, $result.exitCode)
        } elseif ($completionOutcome -eq "failure-recorded") {
          Write-WorkspaceLabCompletionWarning $jobId ([ordered]@{
            category = "completion-failure-recorded"
            statusCode = 0
            exceptionType = ""
            responseBodyPresent = $false
          })
        } elseif ($completionOutcome -eq "recovery-required") {
          Write-WorkspaceLabCompletionWarning $jobId ([ordered]@{
            category = "completion-recovery-required"
            statusCode = 0
            exceptionType = ""
            responseBodyPresent = $false
          })
        } elseif ($completionOutcome -eq "marker-write-retry") {
          # Save-CompletionRecoveryMarker already emitted bounded retry metadata.
        } else {
          Write-WorkspaceLabCompletionWarning $jobId ([ordered]@{
            category = "completion-terminal-outcome"
            statusCode = 409
            exceptionType = ""
            responseBodyPresent = $false
          })
        }
      }
    } catch {
      Write-WorkspaceLabNetworkWarning "poll-failed" "" $_
    }
    Start-Sleep -Seconds ([Math]::Max(1, $PollSeconds))
  }
}

$RepoRoot = Resolve-RepoRoot
if ([string]::IsNullOrWhiteSpace($CompletionRecoveryPath)) {
  $CompletionRecoveryPath = Join-Path $RepoRoot ".workspace-lab-completion-recovery.json"
}

if (Invoke-NativePacketCombine) {
  exit 0
}

if ($NetworkWarningSmoke) {
  $networkWarningSmoke = Invoke-NetworkWarningSmoke
  $networkWarningSmoke | ConvertTo-Json -Depth 8 -Compress
  exit $(if ($networkWarningSmoke.status -eq "passed") { 0 } else { 1 })
}

if ($CompletionSmoke -or $CompletionSmokeFailure -or $CompletionRecoverySeed -or
    $CompletionRecoveryReplay -or $CompletionRecoveryRepeat -or
    $CompletionRecoveryWriteSmoke) {
  $modeCount = @(
    $CompletionSmoke,
    $CompletionSmokeFailure,
    $CompletionRecoverySeed,
    $CompletionRecoveryReplay,
    $CompletionRecoveryRepeat,
    $CompletionRecoveryWriteSmoke
  ) | Where-Object { $_ } | Measure-Object | Select-Object -ExpandProperty Count
  if ($modeCount -ne 1) {
    throw "Completion smoke modes are mutually exclusive."
  }
  $completionSmoke = if ($CompletionSmokeFailure) {
    Invoke-CompletionFailureSmoke
  } elseif ($CompletionRecoverySeed) {
    Invoke-CompletionRecoverySeed
  } elseif ($CompletionRecoveryReplay) {
    Invoke-CompletionRecoveryReplay $true
  } elseif ($CompletionRecoveryRepeat) {
    Invoke-CompletionRecoveryReplay $false
  } elseif ($CompletionRecoveryWriteSmoke) {
    Invoke-CompletionRecoveryWriteSmoke
  } else {
    Invoke-CompletionSmoke
  }
  $completionSmoke | ConvertTo-Json -Depth 8 -Compress
  exit $(if ($completionSmoke.status -eq "passed") { 0 } else { 1 })
}

$null = Invoke-FullSetupIfNeeded
Sync-WorkspaceLabPnpmPath
if ([string]::IsNullOrWhiteSpace($script:WorkspaceLabPnpmPath)) {
  throw "Workspace Lab setup completed without a verified pnpm executable. Refusing to start because PATH could resolve a different Corepack shim."
}

if (-not [string]::IsNullOrWhiteSpace($ApiBaseUrl)) {
  Start-PairedRunner
} else {
  Start-LocalRunner
}