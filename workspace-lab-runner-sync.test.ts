import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertZipFallbackCommand,
  buildZipFallbackCommand,
  renderWindowsRunnerScript,
} from "./workspace-lab/zip-fallback-command.mjs";
import { getResilienceMarkerBudget } from "./workspace-lab/windows-resilience-suite.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_PATH = "scripts/workspace-lab/windows-runner.ps1";
const TEMPLATE_PATH = "scripts/workspace-lab/windows-runner.template.ps1";
const WINDOWS_VALIDATION_PATH =
  "scripts/cross-platform-benchmark/validate-windows.ps1";
const WINDOWS_VALIDATION_RUNBOOK_PATH =
  "scripts/cross-platform-benchmark/WINDOWS-VALIDATION.md";

const ROOT_PACKAGE_PATH = "package.json";
const WINDOWS_BENCHMARK_PATH =
  "scripts/cross-platform-benchmark/run-windows.ps1";
const PUBLIC_PATH =
  "artifacts/k-code-studio/public/workspace-lab/windows-runner.ps1";
const STUDIO_PAGE_PATH = "artifacts/k-code-studio/src/pages/workspace-lab.tsx";
const CROSS_COMP_LAB_PAGE_PATH = "artifacts/k-code-studio/src/pages/cross-comp-lab.tsx";
const STUDIO_GENERATED_ZIP_FALLBACK_PATH =
  "artifacts/k-code-studio/src/generated/workspace-lab-zip-fallback.ts";
const MACOS_RUNNER_PATH = "scripts/workspace-lab/macos-runner.mjs";
const MACOS_RUNNER_WRAPPER_PATH = "scripts/workspace-lab/macos-runner.sh";
const MACOS_RUNNER_SMOKE_PATH = "scripts/workspace-lab/macos-runner-smoke.mjs";

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

test("the macOS runner keeps its host guard, bounded suites, and bounded output smoke path", () => {
  const runner = read(MACOS_RUNNER_PATH);
  const wrapper = read(MACOS_RUNNER_WRAPPER_PATH);
  const smoke = read(MACOS_RUNNER_SMOKE_PATH);

  assert.match(
    runner,
    /if\s*\(platform\(\)\s*!==\s*"darwin"\)/,
    "the native runner must refuse to start on non-macOS hosts",
  );
  assert.match(
    runner,
    /const MAX_OUTPUT_LENGTH = 120_000/,
    "the macOS runner must retain the Workspace Lab output cap",
  );
  assert.match(
    runner,
    /outputTruncated/,
    "the macOS runner must report when local or paired output reaches the capture cap",
  );
  assert.match(
    runner,
    /request\.url === "\/setup-control"[\s\S]*?setupPaused/,
    "the macOS local runner must expose its explicit setup-paused state",
  );
  assert.match(
    runner,
    /poll\.setupPaused/,
    "the macOS paired runner must report when new claims are paused",
  );
  assert.match(
    runner,
    /"oa-it-test"[\s\S]*?"iteration-benchmark"[\s\S]*?"macos-benchmark"[\s\S]*?"cross-comp-interop"/,
    "the macOS runner must retain only the approved suite allowlist",
  );
  assert.match(
    wrapper,
    /exec node .*macos-runner\.mjs/,
    "the macOS wrapper must delegate to the canonical Node runner",
  );
  assert.match(
    smoke,
    /\/health[\s\S]*?setup-control[\s\S]*?\/run[\s\S]*?runner\/poll[\s\S]*?runner\/heartbeat[\s\S]*?runner\/complete/,
    "the native smoke harness must cover local and paired Workspace Lab protocol endpoints",
  );
});

test("the Windows runner exposes and enforces an explicit local setup pause", () => {
  for (const path of [SOURCE_PATH, TEMPLATE_PATH, PUBLIC_PATH]) {
    const runner = read(path);
    assert.match(runner, /AbsolutePath -eq "\/setup-control"/, `${path} must accept local setup controls.`);
    assert.match(runner, /setupPaused = \$script:WorkspaceLabSetupPaused/, `${path} must expose pause state through health.`);
    assert.match(runner, /local runner is paused for setup changes/i, `${path} must reject suite requests while paused.`);
    assert.match(runner, /poll\.setupPaused/, `${path} must surface paired pause state in its console.`);
  }
});

test("the Windows runner reports bounded output truncation metadata", () => {
  for (const path of [SOURCE_PATH, TEMPLATE_PATH, PUBLIC_PATH]) {
    const runner = read(path);
    assert.match(runner, /\$MaxOutputLength = 120000 - \$OutputTruncationMarker\.Length/);
    assert.match(runner, /outputTruncated = \$outputTruncated/);
    assert.match(runner, /outputTruncated = \$result\.outputTruncated/);
  }
});

test("the macOS runner refuses a non-macOS host", { skip: process.platform === "darwin" }, () => {
  const result = spawnSync(process.execPath, [resolve(repoRoot, MACOS_RUNNER_PATH)], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /macOS-only; detected/);
});

test("the native macOS runner smoke harness passes on macOS", { skip: process.platform !== "darwin" }, () => {
  const result = spawnSync(process.execPath, [resolve(repoRoot, MACOS_RUNNER_SMOKE_PATH)], {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(
    result.status,
    0,
    `macOS runner smoke failed.\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
});

// The runner script embeds the command inside a longer Write-Host line of
// prose ("...then download project.zip from the Files panel..."), and the
// generated TS copy backslash-escapes its quotes, so neither file can be
// matched by full-string equality here. Rather than guess where the command
// ends with a boundary regex -- which silently under-matches again the next
// time the command's own text changes (it already did once, when the
// trailing confirmation was added after the last `-x "project.zip"`
// exclude) -- check that the file contains the exact command `expected`
// produces, verbatim, after undoing only the generated TS file's
// backslash-escaping.
function normalizeEscapedQuotes(source: string): string {
  return source.replace(/\\(["'])/g, "$1");
}

test("the downloadable windows-runner.ps1 stays byte-identical to its canonical source", () => {
  const source = read(SOURCE_PATH);
  const publicCopy = read(PUBLIC_PATH);
  assert.equal(
    publicCopy,
    source,
    `${PUBLIC_PATH} has drifted from ${SOURCE_PATH}. Edit only the source file, ` +
      "then run `pnpm run prepare:brief` (which regenerates the public copy " +
      "from it via scripts/generate-workspace-lab-runner.mjs) and commit the result.",
  );
});

test("the Windows runner never binds a function parameter named $host", () => {
  // $Host is a read-only PowerShell automatic variable (the host application,
  // e.g. ConsoleHost). Declaring a function parameter literally named $host
  // makes PowerShell throw a SessionStateUnauthorizedAccessException
  // ("Cannot overwrite variable Host because it is read-only or constant")
  // the moment the parameter is bound -- even though the parameter's own type
  // annotation and every call site look completely ordinary. Because that
  // throw happens inside Start-PairedRunner's poll loop, it was previously
  // swallowed by the generic "poll-failed" network warning, which silently
  // hid the real cause and meant the suite's pass/fail result was never
  // reported to the server even though it ran and passed locally.
  const reservedParamPattern = /\(\s*[^)]*\[string\]\$host\b[^)]*\)|,\s*\$host\s*[,)]/i;
  for (const path of [SOURCE_PATH, TEMPLATE_PATH, PUBLIC_PATH]) {
    const contents = read(path);
    assert.doesNotMatch(
      contents,
      reservedParamPattern,
      `${path} declares a function parameter named $host, which shadows PowerShell's read-only ` +
        "$Host automatic variable and throws SessionStateUnauthorizedAccessException when bound. " +
        "Rename the parameter (e.g. $hostName) at the point that produced it.",
    );
  }
});

test("the Studio pairing command's expected Windows runner revision matches the canonical runner", () => {
  const source = read(SOURCE_PATH);
  const crossCompLabPage = read(CROSS_COMP_LAB_PAGE_PATH);

  const sourceRevisionMatch = source.match(/\$RunnerRevision\s*=\s*"([^"]+)"/);
  assert.ok(
    sourceRevisionMatch,
    `${SOURCE_PATH} must define $RunnerRevision = "..."`,
  );
  const canonicalRevision = sourceRevisionMatch![1];

  const studioRevisionMatch = crossCompLabPage.match(
    /windows:\s*'([^']+)',\s*\n\s*macos:/,
  );
  assert.ok(
    studioRevisionMatch,
    `${CROSS_COMP_LAB_PAGE_PATH} must define RUNNER_REVISIONS.windows`,
  );
  const studioExpectedRevision = studioRevisionMatch![1];

  assert.equal(
    studioExpectedRevision,
    canonicalRevision,
    `${CROSS_COMP_LAB_PAGE_PATH}'s RUNNER_REVISIONS.windows ("${studioExpectedRevision}") has drifted from ` +
      `${SOURCE_PATH}'s $RunnerRevision ("${canonicalRevision}"). Every downloaded pairing command embeds ` +
      "-ExpectedRunnerRevision from the Studio constant, so a stale value makes every real Windows runner " +
      "refuse to start with a revision-mismatch error. Update RUNNER_REVISIONS.windows to match whenever " +
      "the canonical runner's $RunnerRevision changes.",
  );
});

test("the resilience proof marker stays within the bounded Windows capture", () => {
  const suite = read("scripts/workspace-lab/windows-resilience-suite.mjs");
  const runnerCopies = [TEMPLATE_PATH, SOURCE_PATH, PUBLIC_PATH].map((path) => ({
    path,
    contents: read(path),
  }));
  const suiteLimitMatch = suite.match(
    /const WINDOWS_RUNNER_OUTPUT_LIMIT = ([\d_]+);/,
  );
  assert.ok(
    suiteLimitMatch,
    "the resilience suite must define the Windows runner output ceiling",
  );
  const suiteLimit = Number(suiteLimitMatch![1].replaceAll("_", ""));
  const runnerLimit = runnerCopies[0].contents.match(
    /\$MaxOutputLength\s*=\s*(\d+)/,
  );
  assert.ok(
    runnerLimit,
    `${runnerCopies[0].path} must define the bounded output ceiling`,
  );
  assert.equal(
    Number(runnerLimit![1]),
    suiteLimit,
    "the resilience suite and Windows runner must share one marker capture ceiling",
  );

  const emptyMarker = getResilienceMarkerBudget("");
  const maxPayloadLength = emptyMarker.maxMarkerLineLength - emptyMarker.markerLineLength;
  const fits = getResilienceMarkerBudget("A".repeat(maxPayloadLength));
  assert.equal(fits.fits, true);
  assert.equal(fits.markerLineLength <= fits.maxMarkerLineLength, true);
  const tooLarge = getResilienceMarkerBudget("A".repeat(maxPayloadLength + 1));
  assert.equal(tooLarge.fits, false);
  assert.equal(tooLarge.markerLineLength > tooLarge.maxMarkerLineLength, true);
  assert.match(
    suite,
    /failureCategory:\s*"resilience-result-marker-too-large"/,
    "an oversized resilience marker must fail with a stable metadata-only category",
  );
  assert.match(
    suite,
    /markerTestMode\s*===\s*"oversized"[\s\S]*?markerTestPadding[\s\S]*?markerTestMode\s*===\s*"truncated"[\s\S]*?WINDOWS_RUNNER_OUTPUT_LIMIT\s*\+\s*1/,
    "the native resilience fixture must exercise both an oversized marker and redirected-output truncation",
  );
  for (const { path, contents } of runnerCopies) {
    assert.match(
      contents,
      /resilience-result-marker-truncated/,
      `${path} must reject a resilience marker visibly truncated by bounded capture`,
    );
    assert.match(
      contents,
      /failureCategory\s*=\s*"resilience-result-marker-truncated"[\s\S]*?outputLength[\s\S]*?outputSha256[\s\S]*?\$resultJson\s*=\s*\$null/,
      `${path} must submit only bounded metadata when rejecting truncated resilience proof`,
    );
    assert.match(
      contents,
      /resilience-result-marker-too-large[\s\S]*?failureCategory\s*=\s*\$failureCategory[\s\S]*?resultJson\s*=\s*\$null/,
      `${path} must convert an oversized resilience marker into a metadata-only failed completion`,
    );
  }
});

test("the canonical windows-runner.ps1 never ships a placeholder RepoRoot and validates the real one", () => {
  const source = read(SOURCE_PATH);
  assert.match(
    source,
    /\.workspace-lab-setup-ok[\s\S]*?\.workspace-lab-pnpm-path[\s\S]*?Test-Path[\s\S]*?return\s+\$false/,
    "the runner must require both setup completion and the selected pnpm path before skipping setup",
  );
  assert.match(
    source,
    /-NoProfile[\s\S]*?-NonInteractive/,
    "the setup child process should not spend startup time loading an interactive PowerShell profile",
  );
  assert.match(
    source,
    /-PassThru\s+`[\s\S]*?-WindowStyle\s+Hidden/,
    "suite processes must not open empty console windows while their output is captured",
  );
});

test("the Windows runner kills the active suite process tree when its wait is interrupted", () => {
  const source = read(SOURCE_PATH);
  const setup = read("scripts/cross-platform-benchmark/setup-windows.ps1");
  assert.match(
    source,
    /function Sync-WorkspaceLabPnpmPath/,
    "the runner must define a path-sync step for setup's verified pnpm candidate",
  );
  assert.match(
    source,
    /\.workspace-lab-pnpm-path/,
    "the runner must read the setup-created pnpm path marker",
  );
  assert.match(
    source,
    /\$RepoRoot\s*=\s*Resolve-RepoRoot[\s\S]*?Invoke-FullSetupIfNeeded[\s\S]*?Sync-WorkspaceLabPnpmPath/,
    "the runner must complete setup before syncing the newly recorded pnpm path",
  );
  assert.match(
    source,
    /Invoke-FullSetupIfNeeded[\s\S]*?Sync-WorkspaceLabPnpmPath[\s\S]*?IsNullOrWhiteSpace\(\$script:WorkspaceLabPnpmPath\)[\s\S]*?throw/,
    "the runner must refuse to start if setup did not leave an exact pnpm candidate",
  );
  assert.match(
    source,
    /Test-Path\s+-LiteralPath\s+\$pnpmPathFile[\s\S]*?Test-Path\s+-LiteralPath\s+\$recordedPnpmPath\s+-PathType\s+Leaf/,
    "the runner must not treat the setup marker as complete without its recorded pnpm executable",
  );
  assert.match(
    setup,
    /Set-Content\s+-LiteralPath\s+\$pnpmPathFile[\s\S]*?\$script:PnpmExe/,
    "Windows setup must persist the pnpm candidate it actually verified",
  );
  assert.ok(
    setup.includes('$quotedFilePath = \'"\' + $FilePath.Replace'),
    "Windows setup must quote shim paths before passing them through Start-Process",
  );
  assert.match(
    setup,
    /Sort-Object\s+@\{[\s\S]*?'\.cmd'\s*\{\s*0/,
    "Windows setup must prefer the cmd candidate that the Workspace Lab runner can reuse",
  );
  assert.match(
    setup,
    /\$content\s+-notmatch\s+'\(\?i\)corepack'[\s\S]*?return\s+\$false/,
    "Windows setup must reject Corepack shims even when their engine path format is unfamiliar",
  );
});

test("the Windows runner dispatches the recorded pnpm file, not a shadowed Corepack pnpm.cmd", () => {
  const source = read(SOURCE_PATH);
  const dispatchStart = source.indexOf("function Get-SuiteCommand");
  const dispatchEnd = source.indexOf("\nfunction ", dispatchStart + 1);
  assert.ok(dispatchStart >= 0, "the runner must define Get-SuiteCommand");
  const dispatch = source.slice(dispatchStart, dispatchEnd === -1 ? undefined : dispatchEnd);

  assert.match(
    source,
    /\$script:WorkspaceLabPnpmPath\s*=\s*\(Resolve-Path\s+-LiteralPath\s+\$selected\)\.Path/,
    "path synchronization must retain the exact verified file, not only prepend its directory",
  );
  assert.match(
    source,
    /function Get-WorkspaceLabPnpmPath[\s\S]*?\$script:WorkspaceLabPnpmPath[\s\S]*?Test-Path\s+-LiteralPath\s+\$script:WorkspaceLabPnpmPath[\s\S]*?return \$script:WorkspaceLabPnpmPath/,
    "the runner must have an explicit exact-path helper that rejects a missing recorded candidate",
  );
  assert.match(
    dispatch,
    /"oa-it-test"[\s\S]*?FilePath\s*=\s*\(Get-WorkspaceLabPnpmPath\)/,
    "the oa-it suite must launch the setup-selected pnpm file",
  );
  assert.match(
    dispatch,
    /"iteration-benchmark"[\s\S]*?FilePath\s*=\s*\(Get-WorkspaceLabPnpmPath\)/,
    "the iteration suite must launch the setup-selected pnpm file",
  );
  assert.match(
    dispatch,
    /"cross-comp-interop"[\s\S]*?Cross-Comp source is missing[\s\S]*?FilePath\s*=\s*\(Get-WorkspaceLabPnpmPath\)[\s\S]*?"run",\s*"test:cross-comp-interop"/,
    "the Cross-Comp suite must verify its source and launch the package-owned interoperability test through the setup-selected pnpm file",
  );
  assert.doesNotMatch(
    dispatch,
    /FilePath\s*=\s*"pnpm\.cmd"/,
    "suite dispatch must not re-resolve a potentially shadowed bare pnpm.cmd",
  );
  assert.doesNotMatch(
    source,
    /return "pnpm\.cmd"/,
    "the runner must not fall back to a PATH-resolved pnpm.cmd after setup",
  );
});

test("native Windows validation runs oa-it through the recorded path with a broken shim first on PATH", () => {
  const validation = read(WINDOWS_VALIDATION_PATH);
  assert.match(
    validation,
    /BROKEN_COREPACK_SHIM_INVOKED[\s\S]*?\$env:Path\s*=\s*"\$shadowRoot;\$selectedDirectory;\$originalPath"/,
    "native validation must put a deliberately broken pnpm shim before the setup-selected directory",
  );
  assert.match(
    validation,
    /Invoke-RestMethod\s+-Method Post[\s\S]*?\/run[\s\S]*?suite = 'oa-it-test'/,
    "native validation must invoke the allowlisted oa-it-test suite through the running Workspace Lab runner",
  );
  assert.match(
    validation,
    /Workspace Lab executable:[\s\S]*?runnerLoggedExactPath[\s\S]*?brokenShimWasInvoked/,
    "native validation must prove the runner logged the exact selected executable and did not invoke the broken shim",
  );
  assert.match(
    validation,
    /WorkspaceLabRunnerExcerptLimit\s*=\s*1024[\s\S]*?Get-SanitizedRunnerExcerpt[\s\S]*?stdoutExcerpt[\s\S]*?stderrExcerpt/,
    "runner-shadow failures must retain bounded sanitized stdout and stderr excerpts",
  );
  assert.match(
    validation,
    /failureCategory\s*=\s*'runner-(?:health-timeout|suite-failure|executable-mismatch|check-exception)'/,
    "runner-shadow failures must retain a stable failure category",
  );
  assert.match(
    validation,
    /TemporaryToken[\s\S]*?X-Workspace-Lab-Token[\s\S]*?\[REDACTED\]/i,
    "runner-shadow excerpts must redact temporary pairing credentials",
  );
  assert.match(
    validation,
    /workspace-lab-runner-shadow/,
    "the machine-readable validation report must retain the shadow-check result",
  );
});

test("the Windows benchmark reuses setup's verified pnpm path for every pnpm invocation", () => {
  const benchmark = read(WINDOWS_BENCHMARK_PATH);
  assert.match(
    benchmark,
    /\.workspace-lab-pnpm-path/,
    "the benchmark must consume setup's exact pnpm path marker",
  );
  assert.match(
    benchmark,
    /function Invoke-VerifiedPnpm[\s\S]*?GetExtension\(\$script:PnpmExe\)[\s\S]*?\.ps1[\s\S]*?Get-Process -Id \$PID[\s\S]*?-File \$script:PnpmExe \x40Arguments[\s\S]*?&\s+\$script:PnpmExe\s+\x40Arguments/,
    "the benchmark must isolate recorded PowerShell shims while invoking other recorded candidates directly",
  );
  assert.doesNotMatch(
    benchmark,
    /^\s*pnpm\s+--filter/m,
    "the benchmark must not launch a shadowable bare pnpm command",
  );
  assert.doesNotMatch(
    benchmark,
    /node\s+-e\s+\$wrap/,
    "the Windows benchmark must not pass a multi-line JavaScript provenance wrapper through native argument parsing",
  );
  assert.match(
    benchmark,
    /ConvertFrom-Json[\s\S]*?ConvertTo-Json\s+-Depth\s+100[\s\S]*?UTF8Encoding\(\$false\)[\s\S]*?WriteAllText/,
    "the Windows benchmark must build its provenance envelope in PowerShell and save JSON as UTF-8 without a BOM",
  );
});

test("the Windows runner only reuses a complete setup marker", () => {
  const source = read(SOURCE_PATH);
  assert.match(
    source,
    /\.workspace-lab-setup-ok[\s\S]*?\.workspace-lab-pnpm-path[\s\S]*?Test-Path[\s\S]*?return\s+\$false/,
    "the runner must require both setup completion and the selected pnpm path before skipping setup",
  );
  assert.match(
    source,
    /-NoProfile[\s\S]*?-NonInteractive/,
    "the setup child process should not spend startup time loading an interactive PowerShell profile",
  );
  assert.match(
    source,
    /-PassThru\s+`[\s\S]*?-WindowStyle\s+Hidden/,
    "suite processes must not open empty console windows while their output is captured",
  );
});

test("the Windows runner validates completion JSON and records rejected payloads", () => {
  const source = read(SOURCE_PATH);
  const completionStart = source.indexOf("function Invoke-PairedCompletion");
  const completionEnd = source.indexOf("\nfunction Invoke-CompletionSmoke", completionStart);
  assert.ok(completionStart >= 0, "the runner must define Invoke-PairedCompletion");
  const completion = source.slice(completionStart, completionEnd);
  assert.match(
    source,
    /function ConvertTo-WorkspaceLabJson[\s\S]*?System\.Web\.Extensions[\s\S]*?MaxJsonLength/,
    "Windows PowerShell completion requests must use a serializer that handles Unicode, multiline text, and embedded JSON",
  );
  assert.match(
    source,
    /function Limit-SafeMetadata[\s\S]*?128[\s\S]*?function Get-SafeWorkspaceLabJobId[\s\S]*?redacted[\s\S]*?function Get-WorkspaceLabFailureMetadata[\s\S]*?responseBodyPresent[\s\S]*?function Write-WorkspaceLabCompletionWarning[\s\S]*?category[\s\S]*?statusCode/,
    "completion failures must be reduced to stable, bounded metadata before they reach the console",
  );
  assert.match(
    completion,
    /completion payload was rejected[\s\S]*?status = "failed"/,
    "a rejected completion must be converted into an explicit terminal failure instead of leaving the claimed job running",
  );
  assert.match(
    completion,
    /completion-rejected[\s\S]*?completion-fallback-rejected[\s\S]*?completion-recovery-required/,
    "completion warnings must retain stable categories for the original, fallback, and recovery failures",
  );
  assert.match(
    completion,
    /originalFailureMetadata[\s\S]*?fallbackFailureMetadata/,
    "completion warnings must retain only safe failure metadata for both requests",
  );
  assert.doesNotMatch(
    completion,
    /Get-WorkspaceLabFailureDetail|Write-Warning\s+\$failureOutput|Original error:|Fallback error:|\$originalFailure\b|\$fallbackFailure\b/,
    "completion warnings must not interpolate raw coordinator errors or payload text",
  );
});

test("the Windows runner exposes a bounded native completion smoke", () => {
  const source = read(SOURCE_PATH);
  const validation = read(WINDOWS_VALIDATION_PATH);
  const validationRunner = read("scripts/cross-platform-benchmark/run-windows-validation.ps1");
  const coordinator = read("scripts/workspace-lab/completion-smoke-coordinator.ps1");
  assert.match(
    source,
    /\$CompletionSmoke[\s\S]*?function Invoke-CompletionSmoke[\s\S]*?Invoke-PairedCompletion[\s\S]*?CompletionSmokeEvidencePath/,
    "the runner must expose a dedicated HTTP completion smoke mode",
  );
  assert.match(
    source,
    /0x03BB[\s\S]*?0x4E2D[\s\S]*?suite line 1[\s\S]*?embedded-result-json/,
    "the runner smoke must include Unicode, multiline output, and embedded resultJson",
  );
  assert.match(
    validation,
    /function Invoke-WorkspaceLabCompletionSmoke[\s\S]*?completion-smoke-coordinator\.ps1[\s\S]*?Start-Process[\s\S]*?PowerShellExecutable[\s\S]*?CompletionSmoke/,
    "native validation must run the coordinator and runner through the selected PowerShell host",
  );
  assert.match(
    coordinator,
    /accepted-payload[\s\S]*?rejected-payload[\s\S]*?rejected-payload-fallback[\s\S]*?failureCategory/,
    "the disposable coordinator must verify accepted, rejected, and fallback outcomes",
  );
  assert.match(
    coordinator,
    /unicodePreserved[\s\S]*?multilinePreserved[\s\S]*?resultJsonPreserved/,
    "the disposable coordinator must retain only bounded preservation metadata",
  );
  assert.match(
    source,
    /CompletionSmokeFailure[\s\S]*?Invoke-CompletionFailureSmoke[\s\S]*?recoveryPath[\s\S]*?completion-fallback-failure[\s\S]*?recoveryMetadata/,
    "the runner must preserve an explicitly supplied marker for a restart leg while retaining metadata-only evidence",
  );
  assert.match(
    source,
    /PairingCode[\s\S]*?Invoke-CompletionRecoveryReplay[\s\S]*?pairingOutcome[\s\S]*?markerSha256/,
    "the restarted runner must pair again and prove the same bounded marker is submitted once",
  );
  assert.match(
    source,
    /function Try-RecordCompletionRecovery[\s\S]*?return "missing"[\s\S]*?return "acknowledged"[\s\S]*?return "retained"/,
    "recovery retries must distinguish an absent marker, an acknowledged record, and a retained marker",
  );
  assert.match(
    validation,
    /ExpectFallbackFailure[\s\S]*?CompletionSmokeFailure[\s\S]*?runner-failure-evidence-unsafe/,
    "native validation must require a nonzero fallback-failure runner and reject unsafe evidence",
  );
  assert.match(
    validation,
    /function Invoke-WorkspaceLabCompletionRecoveryRestart[\s\S]*?CompletionRecoverySeed[\s\S]*?CompletionRecoveryReplay[\s\S]*?CompletionRecoveryPath[\s\S]*?recoveryRequestCount[\s\S]*?pairings/,
    "native validation must restart the runner, re-pair it, and retain only bounded marker/recovery counts",
  );
  assert.match(
    validation,
    /Get-CompletionWarningMetadata[\s\S]*?unsafePattern[\s\S]*?completionWarningMetadata[\s\S]*?runner-completion-warning-unsafe/,
    "native validation must inspect captured completion warnings before deleting temporary logs",
  );
  assert.match(
    validationRunner,
    /completionWarningMetadata[\s\S]*?stable completion warning categories/,
    "the native validation wrapper must require safe warning metadata and stable categories",
  );
  assert.match(
    validationRunner,
    /function Assert-CompletionRecoveryRestartRecord[\s\S]*?recovery-restart[\s\S]*?recoveryRequests[\s\S]*?markerSha256[\s\S]*?Assert-CompletionRecoveryRestartRecord/,
    "the native validation wrapper must require exactly-once restart recovery and bounded marker evidence",
  );
  assert.match(
    coordinator,
    /RejectFallback[\s\S]*?fallback-failure-original[\s\S]*?fallback-failure-fallback[\s\S]*?adversarialError/,
    "the disposable coordinator must reject both completion attempts in the failure leg",
  );
  assert.match(
    coordinator,
    /adversarialJobId[\s\S]*?X-Workspace-Lab-Token: fixture-token[\s\S]*?Secret=fixture-secret[\s\S]*?adversarialError[\s\S]*?Authorization: Bearer fixture-bearer[\s\S]*?raw result payload/,
    "the failure fixture must send deterministic multiline credential-like metadata through both completion failures",
  );
  assert.match(
    coordinator,
    /\$adversarialJobId[\s\S]*?\$adversarialError[\s\S]*?Write-SmokeResponse\s+\$context\s+422[\s\S]*?Write-SmokeResponse\s+\$context\s+503/,
    "the coordinator must retain the adversarial failure fixture and bounded responses",
  );
  assert.match(
    validation,
    /fixture-token[\s\S]*?fixture-secret[\s\S]*?fixture-bearer[\s\S]*?completionWarningMetadata/,
    "native validation must fail closed if credential-like fixture text reaches captured completion warnings",
  );
  assert.match(
    source,
    /function Get-SafeWorkspaceLabJobId[\s\S]*?return "\[redacted\]"[\s\S]*?function Write-WorkspaceLabCompletionWarning[\s\S]*?jobId = Get-SafeWorkspaceLabJobId \$jobId/,
    "completion warnings must retain the redacted job ID rather than adversarial job metadata",
  );
  assert.match(
    coordinator,
    /RecoveryRestart[\s\S]*?\/it\/workspace-lab\/pair[\s\S]*?\/it\/workspace-lab\/runner\/recover[\s\S]*?recovery-marker-invalid/,
    "the disposable coordinator must prove re-pairing, bounded marker validation, and one recovery request",
  );
});

test("the Windows runner proves completion recovery survives restart exactly once", () => {
  const source = read(SOURCE_PATH);
  const validation = read(WINDOWS_VALIDATION_PATH);
  const coordinator = read("scripts/workspace-lab/completion-smoke-coordinator.ps1");
  assert.match(
    source,
    /CompletionRecoverySeed[\s\S]*?CompletionRecoveryReplay[\s\S]*?CompletionRecoveryRepeat/,
    "the runner must expose separate seed, replay, and repeated-restart fixture phases",
  );
  assert.match(
    source,
    /Try-RecordCompletionRecovery[\s\S]*?Remove-Item[\s\S]*?return "acknowledged"[\s\S]*?return "retained"/,
    "the recovery marker must be removed only after an acknowledgement and retained after a failed retry",
  );
  assert.match(
    validation,
    /Invoke-WorkspaceLabCompletionRecoveryRestart[\s\S]*?CompletionRecoverySeed[\s\S]*?CompletionRecoveryReplay[\s\S]*?CompletionRecoveryRepeat[\s\S]*?markerMetadataStable/,
    "native validation must restart the runner through all recovery phases and compare marker metadata",
  );
  assert.match(
    coordinator,
    /RecoveryRestart[\s\S]*?recovery-after-runner-restart[\s\S]*?GetContextAsync\(\)[\s\S]*?Wait\(1500\)/,
    "the disposable coordinator must acknowledge one recovery marker and watch for bounded duplicates",
  );
});

test("the Windows recovery marker is atomically replaced and survives interrupted writes", () => {
  const source = read(SOURCE_PATH);
  const validation = read(WINDOWS_VALIDATION_PATH);
  assert.match(
    source,
    /function Write-AtomicCompletionRecoveryJson[\s\S]*?UTF8Encoding\]::new\(\$false\)[\s\S]*?Flush\(\$true\)[\s\S]*?\[System\.IO\.File\]::Replace[\s\S]*?\[System\.IO\.File\]::Move/,
    "the runner must stage UTF-8 JSON beside the marker, flush it, then atomically replace or move it",
  );
  assert.match(
    source,
    /function Write-AtomicCompletionRecoveryJson[\s\S]*?for \(\$attempt = 1; \$attempt -le 2; \$attempt\+\+\)[\s\S]*?function Write-WorkspaceLabMarkerWriteRetryWarning[\s\S]*?completion-marker-write-retry[\s\S]*?retryCount[\s\S]*?markerRetained[\s\S]*?function Save-CompletionRecoveryMarker[\s\S]*?Write-AtomicCompletionRecoveryJson[\s\S]*?Write-WorkspaceLabMarkerWriteRetryWarning/,
    "a failed replacement must preserve the current marker and report a bounded retry state",
  );
  assert.match(
    source,
    /function Invoke-CompletionRecoveryWriteSmoke[\s\S]*?SimulateInterruptedWrite[\s\S]*?SimulateReplacementFailure[\s\S]*?interruptedCanonicalJsonValid[\s\S]*?successfulReplacementJsonValid/,
    "the runner fixture must test interruption, failed replacement, and a complete successful replacement",
  );
  assert.match(
    validation,
    /CompletionRecoveryWriteSmoke[\s\S]*?retryWarningValid[\s\S]*?recovery-marker-atomicity-invalid/,
    "native Windows validation must require the marker interruption and retry evidence",
  );
});

test("the Windows runner keeps network warnings metadata-only", () => {
  const source = read(SOURCE_PATH);
  const validation = read(WINDOWS_VALIDATION_PATH);
  const validationRunner = read("scripts/cross-platform-benchmark/run-windows-validation.ps1");
  assert.match(
    source,
    /function Write-WorkspaceLabNetworkWarning[\s\S]*?statusCode[\s\S]*?exceptionType[\s\S]*?responseBodyPresent/,
    "network warnings must retain only bounded safe metadata",
  );
  assert.match(
    source,
    /heartbeat-failed[\s\S]*?Write-WorkspaceLabNetworkWarning/,
    "heartbeat failures must use the metadata-only warning writer",
  );
  assert.match(
    source,
    /local-listener-start-failed[\s\S]*?Write-WorkspaceLabNetworkWarning/,
    "local listener startup failures must use the metadata-only warning writer",
  );
  assert.match(
    source,
    /poll-failed[\s\S]*?Write-WorkspaceLabNetworkWarning/,
    "paired poll failures must use the metadata-only warning writer",
  );
  assert.match(
    source,
    /WorkspaceLabNetworkWarningCounts[\s\S]*?failureCount -gt 1[\s\S]*?return/,
    "repeated poll and heartbeat failures must be suppressed after the first warning in a failure streak",
  );
  assert.match(
    source,
    /Send-PairedHeartbeat[\s\S]*?Reset-WorkspaceLabNetworkWarning "heartbeat-failed"/,
    "a successful heartbeat must allow a later heartbeat failure to be reported",
  );
  assert.match(
    source,
    /runner\/poll[\s\S]*?Reset-WorkspaceLabNetworkWarning "poll-failed"/,
    "a successful poll must allow a later poll failure to be reported",
  );
  assert.match(
    source,
    /retryCount = 12[\s\S]*?retryCounts = \[ordered\]@\{[\s\S]*?poll = \[int\].*poll-failed[\s\S]*?heartbeat = \[int\].*heartbeat-failed/,
    "the native warning fixture must record repeated poll and heartbeat attempt counts",
  );
  assert.match(
    source,
    /function Invoke-NetworkWarningSmoke[\s\S]*?for \(\$attempt = 1; \$attempt -le \$retryCount; \$attempt\+\+\)[\s\S]*?Reset-WorkspaceLabNetworkWarning \$case\.category[\s\S]*?\$recoveryCounts\[\$case\.recoveryKey\]\+\+[\s\S]*?for \(\$attempt = 1; \$attempt -le \$retryCount; \$attempt\+\+\)[\s\S]*?recoveryCounts = \$recoveryCounts/,
    "the native fixture must start a second failure streak after simulating a successful request",
  );
  assert.doesNotMatch(
    source,
    /Workspace Lab runner heartbeat failed:.*Exception\.Message|Workspace Lab runner poll failed:.*Exception\.Message/,
    "network warnings must not interpolate exception messages",
  );
  assert.match(
    validation,
    /function Get-NetworkWarningMetadata[\s\S]*?unsafePattern[\s\S]*?function Invoke-WorkspaceLabNetworkWarningSmoke[\s\S]*?NetworkWarningSmoke/,
    "native validation must inspect captured network warning logs before cleanup",
  );
  assert.match(
    validationRunner,
    /function Assert-NetworkWarningSmokeRecord[\s\S]*?recordCount -ne 6[\s\S]*?recoveryCounts\.poll -ne 1[\s\S]*?heartbeat-failed' = 2[\s\S]*?poll-failed' = 2[\s\S]*?local-listener-request-failed/,
    "the native validation wrapper must require repeated-streak warning counts without retaining warning text",
  );
  assert.match(
    validation,
    /WorkspaceLabNetworkWarningRecordLimit[\s\S]*?recordCount[\s\S]*?maxRecordLength[\s\S]*?retryCounts[\s\S]*?recoveryCounts/,
    "native validation must retain warning size and bounded retry/recovery counts",
  );
  assert.match(
    validation,
    /recordCount -ne 6[\s\S]*?recoveryCounts\.poll -ne 1[\s\S]*?expectedWarningCounts[\s\S]*?'heartbeat-failed' = 2[\s\S]*?'poll-failed' = 2/,
    "native validation must require one warning in each of two recovered failure streaks",
  );
  assert.match(
    validation,
    /allowedCategories[\s\S]*?unknownCategoryCount[\s\S]*?unknownCategoryCount -gt 0/,
    "native evidence must reject unknown categories instead of retaining arbitrary category text",
  );
  assert.match(
    validationRunner,
    /recordCount[\s\S]*?maxRecordLength[\s\S]*?retryCounts\.poll[\s\S]*?retryCounts\.heartbeat[\s\S]*?recoveryCounts\.poll[\s\S]*?recoveryCounts\.heartbeat[\s\S]*?categoryCounts/,
    "the release wrapper must reject unthrottled warnings or missing recovery evidence",
  );
});

test("the idle Windows runner stays cancellable and explains that controls remain in the browser", () => {
  const source = read(SOURCE_PATH);
  assert.match(
    source,
    /listenerState\.PendingContext = \$listener\.GetContextAsync\(\)[\s\S]*?listenerState\.PendingContext\.Wait\(250\)[\s\S]*?listenerState\.PendingContext\.GetAwaiter\(\)\.GetResult\(\)/,
    "local mode must not block indefinitely in HttpListener.GetContext while waiting for a browser request",
  );
  assert.doesNotMatch(
    source,
    /\$listener\.GetContext\(\)/,
    "the blocking HttpListener API prevents reliable Ctrl+C handling while idle",
  );
  assert.match(
    source,
    /does not open its own page[\s\S]*?return to Workspace Lab in your browser/,
    "local mode must tell the operator where suites are started",
  );
  assert.match(
    source,
    /runner\/poll[\s\S]*?-TimeoutSec 15/,
    "paired polling must have a bounded network wait so shutdown cannot hang indefinitely",
  );
});

test("the Windows local runner serves health and preflight while rejecting queued suite requests", () => {
  for (const path of [SOURCE_PATH, TEMPLATE_PATH, PUBLIC_PATH]) {
    const source = read(path);
    assert.match(
      source,
      /\$script:MaxLocalRequestsPerPump\s*=\s*8[\s\S]*?function Pump-LocalRunnerRequestsDuringSuite[\s\S]*?for\s*\(\$requestIndex\s*=\s*0; \$requestIndex -lt \$script:MaxLocalRequestsPerPump; \$requestIndex\+\+\)[\s\S]*?GetContextAsync\(\)[\s\S]*?Wait\(\$WaitMilliseconds\)[\s\S]*?Respond-LocalRunnerRequestDuringSuite/,
      `${path} must process a bounded batch of requests accepted during a running suite`,
    );
    assert.match(
      source,
      /function Respond-LocalRunnerRequestDuringSuite[\s\S]*?HttpMethod -eq "OPTIONS"[\s\S]*?Access-Control-Allow-Private-Network[\s\S]*?active = \$true[\s\S]*?HttpMethod -eq "POST"[\s\S]*?\/run[\s\S]*?Write-JsonResponse \$context 409/,
      `${path} must keep the browser preflight and active health response available while rejecting another run`,
    );
    assert.match(
      source,
      /Invoke-AllowedSuite[\s\S]*?-DuringRun \$pumpLocalRequestsDuringSuite[\s\S]*?-DuringRunArguments @\(\$listener, \$listenerState\)/,
      `${path} must pump the listener while the allowlisted suite process runs`,
    );
    assert.match(
      source,
      /while \(-not \$process\.HasExited\)[\s\S]*?TotalSeconds -ge \$suiteTimeoutSeconds[\s\S]*?TotalSeconds -ge 5[\s\S]*?Start-Sleep -Milliseconds 250[\s\S]*?& \$DuringRun @DuringRunArguments/,
      `${path} must return from each request batch so suite timeout and heartbeat checks run between pumps`,
    );
  }

  const validation = read(WINDOWS_VALIDATION_PATH);
  assert.match(
    validation,
    /Start-Job[\s\S]*?suite = 'oa-it-test'[\s\S]*?candidateHealth\.active -eq \$true[\s\S]*?Access-Control-Request-Private-Network[\s\S]*?suite = 'windows-to-windows-interop'[\s\S]*?burstHealthResponseCount[\s\S]*?burstPreflightResponseCount[\s\S]*?burstFailureCount[\s\S]*?runResponse = \$runEnvelope\.response[\s\S]*?originalResponseSuite[\s\S]*?runResponse\.status/,
    "native Windows validation must sustain a health/preflight request burst during a real suite and retain the original result",
  );
});

test("the local runner answers the browser's Private Network Access preflight", () => {
  const source = read(SOURCE_PATH);
  assert.match(
    source,
    /HttpMethod -eq "OPTIONS"[\s\S]*?Access-Control-Request-Private-Network"\]\s*-eq\s*"true"[\s\S]*?Access-Control-Allow-Private-Network/,
    "an HTTPS Studio page fetching a loopback runner needs an explicit Private Network Access allow, or Chromium silently drops the real request",
  );
});

test("the local runner health response identifies its revision and allowlist", () => {
  const source = read(SOURCE_PATH);
  assert.match(
    source,
    /revision\s*=\s*\$RunnerRevision[\s\S]*?suites\s*=\s*\$allowedSuites/,
    "health must expose the runner revision and allowlist so Studio can reject stale listeners before execution",
  );
});

test("local runners expose token-protected metadata-only progress while a suite is active", () => {
  const windows = read(SOURCE_PATH);
  const macos = read(MACOS_RUNNER_PATH);
  assert.match(
    windows,
    /X-Workspace-Lab-Token[\s\S]*?HttpMethod -eq "GET" -and \$context\.Request\.Url\.AbsolutePath -eq "\/progress"[\s\S]*?LocalRunProgress/,
    "the Windows progress endpoint must stay behind the local-runner token and expose only the active progress snapshot",
  );
  assert.match(
    macos,
    /x-workspace-lab-token[\s\S]*?request\.method === "GET" && request\.url === "\/progress"[\s\S]*?currentProgress/,
    "the macOS progress endpoint must stay behind the local-runner token and expose only the active progress snapshot",
  );
  assert.match(
    windows,
    /phaseProgress[\s\S]*?outputBytes[\s\S]*?lastOutputAt/,
    "Windows progress should carry bounded metadata rather than captured suite output",
  );
  assert.match(
    macos,
    /outputBytes[\s\S]*?lastOutputAt[\s\S]*?phaseProgress/,
    "macOS progress should carry bounded metadata rather than captured suite output",
  );
});

test("Workspace Lab command and local health checks pin the current native runner revisions", () => {
  const page = read("artifacts/k-code-studio/src/pages/workspace-lab.tsx");
  const livePage = page.split("\n/*\nexport function WorkspaceLabPage()")[0];
  const windows = read(SOURCE_PATH);
  const macos = read(MACOS_RUNNER_PATH);
  assert.match(page, /windows:\s*'oait-file-median-v9-progress-setup-instance'/);
  assert.match(page, /macos:\s*'cross-comp-interop-v10-progress-setup-instance-macos'/);
  assert.match(page, /payload\?\.revision === LOCAL_RUNNER_REVISIONS\[platform\]/);
  assert.match(page, /instanceId !== localRunnerInstance\.current/);
  assert.match(page, /localRunnerPaused \|\| localSetupChanged/);
  assert.match(livePage, /disabled=\{localRunBusy \|\| \(Boolean\(session\) && setupLocked\)\}/);
  assert.match(livePage, /if \(session\) markSetupEdited\(\);/);
  assert.match(livePage, /No new suite can start until you resume/);
  assert.match(livePage, /old runner pairing and queued work were invalidated/);
  assert.match(page, /-ExpectedRunnerRevision/);
  assert.match(page, /--expected-runner-revision/);
  assert.match(windows, /\$RunnerRevision = "oait-file-median-v9-progress-setup-instance"/);
  assert.match(windows, /instanceId = \$script:WorkspaceLabInstanceId/g);
  assert.match(macos, /const RUNNER_REVISION = "cross-comp-interop-v10-progress-setup-instance-macos"/);
  assert.match(macos, /instanceId,\s+suites:/);
});

test("the randomized Windows resilience suite emits counted phase-start markers", () => {
  const suite = read("scripts/workspace-lab/windows-resilience-suite.mjs");
  assert.match(
    suite,
    /const totalPhases = rounds \* 3 \+ 1[\s\S]*?event: "workspace-lab-resilience-phase-start"[\s\S]*?phaseIndex: 1[\s\S]*?totalPhases/,
    "the initial native phase must announce its real position before it can take a long time",
  );
  assert.match(
    suite,
    /const phaseIndex = phases\.length \+ 1[\s\S]*?event: "workspace-lab-resilience-phase-start"[\s\S]*?phaseIndex[\s\S]*?totalPhases/,
    "each randomized phase must announce its real phase count before execution starts",
  );
});

test("the Windows runner combines retained native packets offline with strict named-host verification", () => {
  const source = read(SOURCE_PATH);
  assert.match(
    source,
    /LinuxToWindowsPacket[\s\S]*?WindowsToLinuxPacket[\s\S]*?CombinedPacket/,
    "the runner must accept both retained direction packets and an explicit combined output path",
  );
  assert.match(
    source,
    /Invoke-NativePacketCombine[\s\S]*?verify-interop-packets\.mjs[\s\S]*?require-named-hosts/,
    "the offline handoff must invoke the strict named-host verifier",
  );
  assert.match(
    source,
    /Native packet combine requires[\s\S]*?together/,
    "partial native packet handoffs must fail closed",
  );
  assert.match(
    source,
    /\$RepoRoot\s*=\s*Resolve-RepoRoot[\s\S]*?Invoke-NativePacketCombine[\s\S]*?Invoke-FullSetupIfNeeded/,
    "offline packet handoff must not require a listener or full dependency setup",
  );
});

test("the Windows runner kills the active suite process tree when its wait is interrupted", () => {
  const source = read(SOURCE_PATH);
  assert.match(
    source,
    /function Stop-WorkspaceLabProcessTree/,
    "the runner must define an explicit process-tree cleanup path",
  );
  assert.match(
    source,
    /taskkill\.exe\s+\/PID[\s\S]*?\/T\s+\/F/,
    "suite cancellation must terminate the pnpm/PowerShell/Node descendant tree",
  );
  assert.match(
    source,
    /\$process = Start-Process[\s\S]*?-PassThru[\s\S]*?while\s*\(-not\s+\$process\.HasExited\)/,
    "suite execution must retain the child handle and use an interruptible wait loop",
  );
  assert.match(
    source,
    /\$null\s*=\s*\$process\.Handle[\s\S]*?\$process\.WaitForExit\(\)[\s\S]*?\$exitCode\s*=\s*\$process\.ExitCode/,
    "suite execution must retain the native process handle and finalize the child before classifying its exit code",
  );
  assert.doesNotMatch(
    source,
    /\$process\.Refresh\(\)/,
    "refreshing a completed Windows process can discard the cached numeric exit code",
  );
  assert.match(
    source,
    /\$null -eq \$exitCode[\s\S]*?could not read the completed suite exit code/,
    "a missing exit code must be reported explicitly instead of silently classifying a passing suite as failed",
  );
  assert.match(
    source,
    /Workspace Lab starting[\s\S]*?Workspace Lab finished/,
    "the long-lived runner console must make suite launch and completion visible",
  );
  assert.match(
    source,
    /Workspace Lab executable:[\s\S]*?Workspace Lab interpreter:/,
    "the runner console must identify the selected executable and interpreter without exposing the local token",
  );
  assert.match(
    source,
    /\$RunnerRevision[\s\S]*?Workspace Lab runner revision:/,
    "the runner console must identify its revision so a stale Windows checkout is obvious",
  );
  assert.match(
    source,
    /function Get-InterpretedInvocation[\s\S]*?\.ps1[\s\S]*?Get-Process -Id \$PID[\s\S]*?\.cmd[\s\S]*?cmd\.exe/,
    "the runner must launch Windows pnpm shims through their interpreter so the tracked process exposes a real exit code",
  );
  assert.match(
    source,
    /\$invocation = Get-InterpretedInvocation[\s\S]*?Start-Process -FilePath \$invocation\.FileName[\s\S]*?-ArgumentList \$invocation\.Arguments/,
    "suite execution must start the interpreted invocation rather than the raw shim path",
  );
  assert.match(
    source,
    /finally\s*\{[\s\S]*?\$process\.HasExited[\s\S]*?Stop-WorkspaceLabProcessTree/,
    "suite cleanup must run when Ctrl+C interrupts the wait",
  );
  assert.match(
    source,
    /-PassThru\s+`[\s\S]*?-WindowStyle\s+Hidden/,
    "suite processes must not open empty console windows while their output is captured",
  );
});

test("the checked-in Windows validation records every release prerequisite with distinct failure categories", () => {
  const setup = read("scripts/cross-platform-benchmark/setup-windows.ps1");
  const validation = read(WINDOWS_VALIDATION_PATH);
  const runbook = read(WINDOWS_VALIDATION_RUNBOOK_PATH);

  const packageJson = JSON.parse(read(ROOT_PACKAGE_PATH)) as {
    scripts?: Record<string, string>;
  };

  assert.equal(
    packageJson.scripts?.["test:windows-syntax"],
    "pnpm --filter @workspace/scripts run test:windows-syntax",
    "the root command must expose the Windows syntax preflight without running native setup",
  );
  assert.match(
    runbook,
    /Host-independent syntax preflight[\s\S]*?pnpm test:windows-syntax[\s\S]*?Native Windows validation/,
    "the runbook must place the syntax preflight before the native install procedure",
  );
  assert.match(
    runbook,
    /powershell-5\.1[\s\S]*?powershell\.exe[\s\S]*?pwsh\.exe/,
    "the syntax preflight must not replace the existing PowerShell 5.1 and 7.4 matrix",
  );
  assert.match(
    validation,
    /['"]-LocalToken['"]\s*,\s*\$temporaryToken[\s\S]*?X-Workspace-Lab-Token[\s\S]*?\/health[\s\S]*?\/run[\s\S]*?suite\s*=\s*'oa-it-test'/,
    "Windows validation must start the local runner with a temporary token and invoke the allowlisted suite over HTTP",
  );
  assert.match(
    validation,
    /workspace-lab-runner[\s\S]*?selectedExecutablePath[\s\S]*?response[\s\S]*?outputLength[\s\S]*?outputSha256/,
    "the validation report must retain the runner result and selected executable without raw output",
  );
  assert.match(
    validation,
    /failureCategory\s*=\s*'runner-(?:start-failure|health-timeout|http-failure|response-invalid|suite-failure)'/,
    "runner failures must use a distinct bounded category",
  );
  assert.match(
    validation,
    /WorkspaceLabRunnerOutputLimit[\s\S]*?Substring\(0,\s*\$script:WorkspaceLabRunnerOutputLimit\)/,
    "runner output hashing must be bounded before it is retained as evidence",
  );
  assert.match(
    validation,
    /ResilienceMarkerMode 'oversized'[\s\S]*ResilienceMarkerMode 'truncated'[\s\S]*Get-ResilienceMarkerProof/,
    "native validation must exercise complete, oversized, and truncated resilience markers through the selected PowerShell host",
  );
  assert.match(
    read("scripts/cross-platform-benchmark/run-windows-validation.ps1"),
    /Assert-SafeRunnerShadowRecord[\s\S]*?raw runner output[\s\S]*?runnerExcerptLimit/,
    "the artifact uploader must reject raw or oversized runner-shadow evidence",
  );
  assert.match(
    runbook,
    /workspace-lab-runner[\s\S]*?selected executable[\s\S]*?temporary token[\s\S]*?failureCategory/,
    "the Windows runbook must document the local runner report contract",
  );
  const validationRunner = read("scripts/cross-platform-benchmark/run-windows-validation.ps1");
  assert.match(
    validationRunner,
    /resilienceMarkerProof[\s\S]*?resilience-result-marker-too-large[\s\S]*?resilience-result-marker-truncated[\s\S]*?resultJsonPresent/,
    "run-windows-validation.ps1 must require metadata-only failures and an intact structured resilience result",
  );
});

test("the Windows CPU-affinity workflow keeps its host matrix, runner gate, and evidence upload", () => {
  const workflow = read(".github/workflows/windows-release-validation.yml");
  const start = workflow.indexOf("\n  windows-affinity-wrapper-validation:\n");
  const end = workflow.indexOf(
    "\n  windows-runner-shadow-comparison:\n",
    start,
  );
  assert.ok(
    start >= 0,
    "the Windows CPU-affinity validation job must remain in the release workflow",
  );
  assert.ok(
    end > start,
    "the Windows CPU-affinity job must remain a distinct workflow job",
  );
  const job = workflow.slice(start, end);

  assert.match(job, /^\s+runs-on:\s*windows-2022\s*$/m);
  const matrix = job.match(/^\s+matrix:\s*\n([\s\S]*?)^\s+steps:\s*$/m)?.[1];
  assert.ok(
    matrix,
    "the CPU-affinity job must keep its explicit PowerShell host matrix",
  );
  assert.deepEqual(
    [...matrix.matchAll(/^\s+- name:\s*(\S+)\s*$/gm)].map((match) => match[1]),
    ["powershell-5.1", "powershell-7"],
    "the CPU-affinity job must cover both supported PowerShell hosts and no accidental replacement matrix",
  );
  assert.match(
    matrix,
    /- name:\s*powershell-5\.1\s*\n\s+host:\s*powershell\.exe[\s\S]*?- name:\s*powershell-7\s*\n\s+host:\s*pwsh\.exe/,
    "each PowerShell matrix leg must select its corresponding executable",
  );
  assert.match(
    job,
    /scripts\\hardware-setup\\run-windows-affinity-validation\.ps1/,
    "the job must delegate to the checked-in CPU-affinity validation runner",
  );
  assert.match(
    job,
    /& \$env:VALIDATION_HOST[\s\S]*?-File \$runner[\s\S]*?-PowerShellPath \$env:VALIDATION_HOST/,
    "the job must invoke the runner under the selected PowerShell host",
  );
  assert.match(
    job,
    /\$exitCode = \$LASTEXITCODE[\s\S]*?if \(\$exitCode -ne 0\)[\s\S]*?throw/,
    "a failed runner exit code must fail the workflow step",
  );
  assert.match(
    job,
    /- name: Upload Windows CPU-affinity wrapper evidence\s*\n\s+if:\s*always\(\)[\s\S]*?uses:\s*actions\/upload-artifact@v4[\s\S]*?name:\s*windows-affinity-wrapper-validation-\$\{\{\s*matrix\.name\s*\}\}/,
    "each host leg must upload its named evidence artifact even after validation fails",
  );
});

test("the Windows CPU-affinity multi-core workflow validates both engines with distinct evidence", () => {
  const workflow = read(".github/workflows/windows-release-validation.yml");
  const start = workflow.indexOf(
    "\n  windows-affinity-wrapper-multi-core-validation:\n",
  );
  const end = workflow.indexOf("\n  windows-runner-shadow-comparison:\n", start);
  assert.ok(start >= 0, "the multi-core CPU-affinity job must remain in the release workflow");
  assert.ok(end > start, "the multi-core CPU-affinity job must remain a distinct workflow job");
  const job = workflow.slice(start, end);

  assert.match(job, /^\s+runs-on:\s*windows-2025-4core\s*$/m);
  assert.deepEqual(
    [...job.matchAll(/^\s+- name:\s*(powershell-[\w.-]+)\s*$/gm)].map((match) => match[1]),
    ["powershell-5.1", "powershell-7"],
    "the four-vCPU multi-core job must cover both Windows PowerShell engines",
  );
  assert.match(
    job,
    /- name:\s*powershell-5\.1\s*\n\s+host:\s*powershell\.exe[\s\S]*?- name:\s*powershell-7\s*\n\s+host:\s*pwsh\.exe/,
    "each multi-core leg must select its corresponding PowerShell executable",
  );
  assert.match(
    job,
    /& \$env:VALIDATION_HOST[\s\S]*?-FixtureShape multi-core[\s\S]*?-PowerShellPath \$env:VALIDATION_HOST/,
    "each engine must run the expanded fixture using the requested PowerShell host",
  );
  assert.match(
    job,
    /if \(\$exitCode -ne 0\)[\s\S]*?throw "\[\$env:VALIDATION_NAME\]\[\$env:VALIDATION_HOST\]/,
    "a failed multi-core validation runner must fail its engine leg",
  );
  assert.match(
    job,
    /- name: Upload Windows CPU-affinity multi-core evidence[\s\S]*?if:\s*always\(\)[\s\S]*?name:\s*windows-affinity-wrapper-multi-core-validation-\$\{\{\s*matrix\.name\s*\}\}[\s\S]*?path:\s*windows-affinity-multi-core-fixture\/\$\{\{\s*matrix\.name\s*\}\}\/windows-affinity-validation\.json/,
    "each engine must upload distinct multi-core evidence even when validation fails",
  );
});

test("Windows setup pins the supported Node floor, frozen install, and clean in-place CI path", () => {
  const packageJson = JSON.parse(read(ROOT_PACKAGE_PATH)) as {
    engines?: { node?: string };
  };
  const windowsSetup = read("scripts/cross-platform-benchmark/setup-windows.ps1");
  const macosSetup = read("scripts/cross-platform-benchmark/setup-macos.sh");
  const validationRunner = read(
    "scripts/cross-platform-benchmark/run-windows-validation.ps1",
  );
  const workflow = read(".github/workflows/windows-release-validation.yml");
  const studioPage = read(STUDIO_PAGE_PATH);
  const checklistData = read("artifacts/k-code-studio/src/components/workspace-lab-checklist-data.ts");

  assert.equal(packageJson.engines?.node, ">=22.12.0");
  assert.match(windowsSetup, /\$nodeMinor -lt 12/);
  assert.match(macosSetup, /\$NODE_MINOR" -lt 12/);
  assert.match(windowsSetup, /Node 22\.12 or newer/);
  assert.match(macosSetup, /Node 22\.12 or newer/);
  assert.match(windowsSetup, /install', '--frozen-lockfile'/);
  assert.doesNotMatch(
    windowsSetup,
    /Retrying with a normal install|ArgumentList @\('install'\)/,
  );
  assert.match(validationRunner, /\[switch\]\$UseSourceRepoInPlace/);
  assert.match(
    validationRunner,
    /UseSourceRepoInPlace[\s\S]*?status --porcelain --untracked-files=all[\s\S]*?in-place validation requires a clean source checkout/,
  );
  assert.match(workflow, /runs-on:\s*windows-2022/);
  assert.match(workflow, /node-version:\s*22\.12\.0/);
  assert.match(workflow, /node-version:\s*24/);
  assert.match(workflow, /-UseSourceRepoInPlace/);
  assert.doesNotMatch(workflow, /Install release guard dependencies|pnpm install --frozen-lockfile/);
  assert.match(workflow, /pnpm -w run typecheck/);
  assert.match(workflow, /\$env:PORT = '3000'[\s\S]*?\$env:BASE_PATH = '\/'/);
  assert.match(workflow, /pnpm --filter @workspace\/k-code-studio run build/);
  assert.match(workflow, /pnpm --filter @workspace\/api-server run build/);
  assert.match(studioPage, /Node 22\.12 or newer/);
  assert.match(checklistData, /Node\.js 22\.12\+/);
  assert.doesNotMatch(studioPage + checklistData, /22\.5/);
});

test("the canonical windows-runner.ps1 is exactly the template rendered with the shared zip fallback command", () => {
  const template = read(TEMPLATE_PATH);
  const source = read(SOURCE_PATH);
  assert.equal(
    source,
    renderWindowsRunnerScript(template),
    `${SOURCE_PATH} has drifted from ${TEMPLATE_PATH} and/or ` +
      "scripts/workspace-lab/zip-fallback-command.mjs. Edit only the template " +
      "(or the shared zip-fallback-command module), then run " +
      "`pnpm run prepare:brief` and commit the result.",
  );
});

test("the generated Studio zip fallback command matches the shared source", () => {
  const generated = read(STUDIO_GENERATED_ZIP_FALLBACK_PATH);
  assert.equal(
    generated,
    [
      "// Generated by scripts/generate-workspace-lab-runner.mjs; edit",
      "// scripts/workspace-lab/zip-fallback-command.mjs instead.",
      `export const workspaceLabZipFallbackCommand = ${JSON.stringify(buildZipFallbackCommand('"'))};`,
      "",
    ].join("\n"),
    `${STUDIO_GENERATED_ZIP_FALLBACK_PATH} has drifted from ` +
      "scripts/workspace-lab/zip-fallback-command.mjs. Run `pnpm run " +
      "prepare:brief` and commit the result.",
  );
});

test("the Studio UI renders the shared zip fallback command instead of a hand-duplicated copy", () => {
  const page = read(STUDIO_PAGE_PATH);
  assert.match(
    page,
    /import\s*\{\s*workspaceLabZipFallbackCommand\s*\}\s*from\s*['"]@\/generated\/workspace-lab-zip-fallback['"]/,
    `${STUDIO_PAGE_PATH} must import workspaceLabZipFallbackCommand from the generated module instead of hand-writing the zip fallback command`,
  );
  assert.match(
    page,
    /\{workspaceLabZipFallbackCommand\}/,
    `${STUDIO_PAGE_PATH} must render {workspaceLabZipFallbackCommand} instead of a literal zip command string`,
  );
  assert.ok(
    !/zip -r project\.zip/.test(page.replace(/\{workspaceLabZipFallbackCommand\}/g, "")),
    `${STUDIO_PAGE_PATH} must not hand-duplicate the zip fallback command outside of {workspaceLabZipFallbackCommand}`,
  );
});

test("the zip fallback command excludes node_modules, .git, .cache, and .local everywhere it appears, and never zips a stale project.zip into itself", () => {
  const canonicalExpected = buildZipFallbackCommand("'");
  const studioExpected = buildZipFallbackCommand('"');

  assertZipFallbackCommand(canonicalExpected, "buildZipFallbackCommand(\"'\")");
  assertZipFallbackCommand(studioExpected, 'buildZipFallbackCommand(\'"\')');

  assert.ok(
    read(SOURCE_PATH).includes(canonicalExpected),
    `${SOURCE_PATH} must contain the shared zip fallback command exactly`,
  );
  assert.ok(
    read(PUBLIC_PATH).includes(canonicalExpected),
    `${PUBLIC_PATH} must contain the shared zip fallback command exactly`,
  );
  assert.ok(
    normalizeEscapedQuotes(read(STUDIO_GENERATED_ZIP_FALLBACK_PATH)).includes(studioExpected),
    `${STUDIO_GENERATED_ZIP_FALLBACK_PATH} must contain the shared zip fallback command exactly`,
  );
});
