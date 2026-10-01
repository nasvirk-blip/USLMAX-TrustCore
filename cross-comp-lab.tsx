import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Clipboard, Download, Laptop, Loader2, Play, Upload, Wifi, WifiOff } from 'lucide-react';
import { Link } from 'wouter';
import {
  useCreateWorkspaceLabSession,
  useGetWorkspaceLabSession,
  useQueueWorkspaceLabJob,
  useReconcileWorkspaceLabJob,
  useRegenerateWorkspaceLabPairingCode,
  useUploadWorkspaceLabResult,
  type WorkspaceLabJob,
} from '@workspace/api-client-react';
import { Brand } from '@/components/brand';
import { PrivateRoomNav } from '@/components/private-room-nav';
import {
  combineStrictNamedHostPackets,
  CROSS_COMP_HANDOFF_FALLBACK_MESSAGE,
  CROSS_COMP_RUNNER_FALLBACK_MESSAGE,
  CROSS_COMP_UPLOAD_FALLBACK_MESSAGE,
  CrossCompPacketSummary,
  CrossCompValidationNotice,
  crossCompValidationMessage,
  parseCrossCompEvidencePacket,
  ResilienceProofRejectionNotice,
  resilienceProofRejectionFromResult,
} from '@/components/cross-comp-evidence';
import { workspaceLabZipFallbackCommand } from '@/generated/workspace-lab-zip-fallback';

const SUITE = 'cross-comp-interop';
const SESSION_STORAGE_KEY = 'cross-comp-lab-session-id';
const LOCAL_RUNNER_PORT = 8787;
type RunnerPlatform = 'windows' | 'macos';
const RUNNER_REVISIONS: Record<RunnerPlatform, string> = {
  windows: 'oait-file-median-v9-progress-setup-instance',
  macos: 'cross-comp-interop-v10-progress-setup-instance-macos',
};
const PAIRING_INVALIDATION_MESSAGE = 'Run invalidated because the pairing code was regenerated.';

function statusLabel(status: WorkspaceLabJob['status'] | 'recovery-required'): string {
  return status === 'passed'
    ? 'Passed'
    : status === 'failed'
      ? 'Failed'
      : status === 'recovery-required'
        ? 'Needs reconciliation'
        : status === 'reconciled'
          ? 'Reconciled'
        : status === 'running'
          ? 'Running'
          : 'Queued';
}

function isVisuallyHiddenPairedMishap(job: WorkspaceLabJob): boolean {
  return job.source === 'paired'
    && job.status === 'failed'
    && job.output.startsWith(PAIRING_INVALIDATION_MESSAGE);
}

function localRunnerUrl(path: string): string {
  return `http://127.0.0.1:${LOCAL_RUNNER_PORT}${path}`;
}

function sessionQueryFailureKind(error: unknown): 'not-found' | 'expired' | 'unavailable' {
  const status = error && typeof error === 'object' && 'status' in error
    ? (error as { status?: unknown }).status
    : undefined;
  if (status === 404) return 'not-found';
  if (status === 410) return 'expired';
  return 'unavailable';
}

function sessionQueryFailureMessage(kind: ReturnType<typeof sessionQueryFailureKind>): string {
  if (kind === 'not-found') {
    return 'The configured Cross-Comp session was not found. Initialize a new session and update PRIVATE_ROOM_CROSS_COMP_SESSION_ID.';
  }
  if (kind === 'expired') {
    return 'The configured Cross-Comp session has expired. Initialize a new session and update PRIVATE_ROOM_CROSS_COMP_SESSION_ID.';
  }
  return 'The configured Cross-Comp session could not be loaded. Check the approved reviewer session and retry.';
}

export function CrossCompLabPage() {
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = useState<string | undefined>(() => (
    typeof window === 'undefined' ? undefined : window.localStorage.getItem(SESSION_STORAGE_KEY) ?? undefined
  ));
  const [sessionWasConfigured, setSessionWasConfigured] = useState(() => (
    typeof window !== 'undefined' && Boolean(window.localStorage.getItem(SESSION_STORAGE_KEY))
  ));
  const [localStatus, setLocalStatus] = useState<'unknown' | 'online' | 'stale' | 'offline'>('unknown');
  const [localMessage, setLocalMessage] = useState('');
  const [uploadMessage, setUploadMessage] = useState('');
  const [uploadStatus, setUploadStatus] = useState<'passed' | 'failed'>('passed');
  const [uploadFile, setUploadFile] = useState<File>();
  const [linuxToWindowsPacket, setLinuxToWindowsPacket] = useState<File>();
  const [windowsToLinuxPacket, setWindowsToLinuxPacket] = useState<File>();
  const [handoffMessage, setHandoffMessage] = useState('');
  const [copiedLocal, setCopiedLocal] = useState(false);
  const [copiedPaired, setCopiedPaired] = useState(false);
  const [copiedZipCommand, setCopiedZipCommand] = useState(false);
  const [repoRootInput, setRepoRootInput] = useState('');
  const [runnerPlatform, setRunnerPlatform] = useState<RunnerPlatform>('windows');
  const [pairingMessage, setPairingMessage] = useState('');
  const [sessionRecoveryMessage, setSessionRecoveryMessage] = useState('');
  const [sessionLoadTimedOut, setSessionLoadTimedOut] = useState(false);
  const [reconciliationMessage, setReconciliationMessage] = useState('');

  const createSession = useCreateWorkspaceLabSession({
    mutation: {
      onSuccess: (createdSession) => {
        queryClient.setQueryData(['workspace-lab-session', createdSession.id], createdSession);
        setSessionId(createdSession.id);
        setSessionWasConfigured(false);
        setSessionLoadTimedOut(false);
        setSessionRecoveryMessage('');
      },
      onError: () => {
        setSessionRecoveryMessage('The protected Cross-Comp session could not be opened. Check the connection and try again.');
      },
    },
  });
  const sessionQuery = useGetWorkspaceLabSession(sessionId ?? '', {
    query: {
      queryKey: ['workspace-lab-session', sessionId],
      enabled: Boolean(sessionId),
      refetchInterval: 1500,
      refetchIntervalInBackground: true,
      retry: false,
    },
  });
  const queueJob = useQueueWorkspaceLabJob();
  const reconcileJob = useReconcileWorkspaceLabJob();
  const uploadResult = useUploadWorkspaceLabResult();
  const session = sessionQuery.data;

  useEffect(() => {
    if (!sessionId || session) {
      setSessionLoadTimedOut(false);
      return;
    }
    const timer = window.setTimeout(() => {
      queryClient.removeQueries({ queryKey: ['workspace-lab-session', sessionId] });
      setSessionId(undefined);
      setSessionWasConfigured(false);
      setSessionLoadTimedOut(true);
      setSessionRecoveryMessage('The saved Cross-Comp session did not finish loading. It was cleared locally; initialize a fresh session to continue.');
    }, 8_000);
    return () => window.clearTimeout(timer);
  }, [queryClient, sessionId, session]);

  useEffect(() => {
    if (!sessionQuery.isError || !sessionId) return;
    const kind = sessionQueryFailureKind(sessionQuery.error);
    if (kind === 'not-found' || kind === 'expired') {
      queryClient.removeQueries({ queryKey: ['workspace-lab-session', sessionId] });
      setSessionId(undefined);
      setSessionWasConfigured(false);
      setSessionRecoveryMessage(sessionQueryFailureMessage(kind));
    }
  }, [queryClient, sessionId, sessionQuery.error, sessionQuery.isError]);
  const regeneratePairingCodeMutation = useRegenerateWorkspaceLabPairingCode({
    mutation: {
      onSuccess: async () => {
        setLocalStatus('unknown');
        setLocalMessage('');
        setPairingMessage('New pairing code generated. Any previously paired runner has been disconnected.');
        await sessionQuery.refetch();
      },
      onError: (error) => {
        const detail = error instanceof Error ? error.message : 'The pairing-code request failed.';
        setPairingMessage(`Pairing code was not regenerated. ${detail} Refresh the room and try again.`);
      },
    },
  });

  useEffect(() => {
    if (sessionId) {
      window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
    } else {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }, [sessionId]);

  const repoRootArg = repoRootInput.trim() || '<PATH-TO-YOUR-CLONED-REPO>';
  const runnerRevision = RUNNER_REVISIONS[runnerPlatform];
  const runnerScriptHref = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/workspace-lab/${runnerPlatform === 'windows' ? 'windows-runner.ps1' : 'macos-runner.sh'}?revision=${runnerRevision}`;
  // windows-runner.ps1 and macos-runner.sh are already committed inside the
  // repository at scripts/workspace-lab/ (and mirrored under
  // artifacts/k-code-studio/public/workspace-lab/, byte-identical). Anyone
  // who already extracted or cloned the repo to -RepoRoot has the runner
  // there and does not need a separate browser download at all -- check
  // that known location first. Only fall back to Downloads/Desktop/the
  // current folder for someone who grabbed just the standalone script
  // before fetching the full repo. Re-runs after a revision bump re-download
  // the same filename, so the browser commonly saves it as
  // "windows-runner (1).ps1", "windows-runner (2).ps1", etc. instead of
  // overwriting -- match that pattern too and pick the most recently
  // modified candidate rather than requiring an exact literal name.
  const runnerScriptArg = runnerPlatform === 'windows'
    ? `$repoRootHint = "${repoRootArg}"; $runner = $null; if (-not [string]::IsNullOrWhiteSpace($repoRootHint) -and (Test-Path -LiteralPath $repoRootHint -PathType Container)) { $repoRunnerCandidates = (Join-Path $repoRootHint 'scripts\\workspace-lab\\windows-runner.ps1'), (Join-Path $repoRootHint 'artifacts\\k-code-studio\\public\\workspace-lab\\windows-runner.ps1'); $runner = $repoRunnerCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1 | Get-Item }; if ($null -eq $runner) { $runner = Get-ChildItem -Path (Join-Path $HOME 'Downloads'), (Join-Path $HOME 'Desktop'), (Get-Location).Path -Filter 'windows-runner*.ps1' -File -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }; if ($null -eq $runner) { throw 'Could not find windows-runner.ps1 inside the repository at -RepoRoot (scripts\\workspace-lab\\windows-runner.ps1), or a browser copy in Downloads, Desktop, or the current folder. Confirm -RepoRoot points at your extracted checkout, or download the runner separately from Cross-Comp Lab first.' }; $runner.FullName`
    : `$(repo_root="${repoRootArg}"; found=""; if [ -n "$repo_root" ] && [ -d "$repo_root" ]; then for candidate in "$repo_root/scripts/workspace-lab/macos-runner.sh" "$repo_root/artifacts/k-code-studio/public/workspace-lab/macos-runner.sh"; do if [ -f "$candidate" ]; then found="$candidate"; break; fi; done; fi; if [ -z "$found" ]; then found=$(find "$HOME/Downloads" "$HOME/Desktop" . -maxdepth 1 -iname 'macos-runner*.sh' -type f -print0 2>/dev/null | xargs -0 ls -t 2>/dev/null | head -n 1); fi; printf '%s' "$found")`;

  const pairedCommand = useMemo(() => {
    if (!session) return '';
    return runnerPlatform === 'windows'
      ? `${runnerScriptArg}; & powershell.exe -ExecutionPolicy Bypass -File $runner.FullName -ApiBaseUrl "${window.location.origin}/api" -PairingCode "${session.pairingCode}" -RepoRoot "${repoRootArg}" -ExpectedRunnerRevision "${runnerRevision}"`
      : `bash "${runnerScriptArg}" --api-base-url "${window.location.origin}/api" --pairing-code "${session.pairingCode}" --repo-root "${repoRootArg}"`;
  }, [session, runnerScriptArg, repoRootArg, runnerPlatform]);

  const localCommand = useMemo(() => {
    if (!session) return '';
    return runnerPlatform === 'windows'
      ? `${runnerScriptArg}; & powershell.exe -ExecutionPolicy Bypass -File $runner.FullName -LocalToken "${session.pairingCode}" -RepoRoot "${repoRootArg}" -ExpectedRunnerRevision "${runnerRevision}"`
      : `bash "${runnerScriptArg}" --local-token "${session.pairingCode}" --repo-root "${repoRootArg}"`;
  }, [session, runnerScriptArg, repoRootArg, runnerPlatform]);

  useEffect(() => {
    if (!session?.pairingCode) return;
    let mounted = true;
    const checkLocalRunner = () => {
      void fetch(localRunnerUrl('/health'), { headers: { 'X-Workspace-Lab-Token': session.pairingCode } })
        .then(async (response) => {
          if (!response.ok) {
            if (mounted) setLocalStatus('offline');
            return;
          }
          const payload = await response.json() as { revision?: string };
           if (payload.revision !== runnerRevision) {
            if (mounted) {
              setLocalStatus('stale');
               setLocalMessage(`The ${runnerPlatform === 'windows' ? 'Windows' : 'macOS'} listener is running an older runner (${payload.revision ?? 'unknown'}). Stop it, download the current runner, and start it again.`);
            }
            return;
          }
          if (mounted) {
            setLocalStatus('online');
            setLocalMessage('');
          }
        })
        .catch(() => {
          if (mounted) setLocalStatus('offline');
        });
    };
    checkLocalRunner();
    const interval = window.setInterval(checkLocalRunner, 4000);
    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, [session?.pairingCode, runnerPlatform, runnerRevision]);

  async function copyLocalCommand() {
    await navigator.clipboard?.writeText(localCommand);
    setCopiedLocal(true);
    window.setTimeout(() => setCopiedLocal(false), 1400);
  }

  async function copyPairedCommand() {
    await navigator.clipboard?.writeText(pairedCommand);
    setCopiedPaired(true);
    window.setTimeout(() => setCopiedPaired(false), 1400);
  }

  async function copyZipCommand() {
    await navigator.clipboard?.writeText(workspaceLabZipFallbackCommand);
    setCopiedZipCommand(true);
    window.setTimeout(() => setCopiedZipCommand(false), 1400);
  }

  async function ensureSession() {
    if (session) return session;
    if (createSession.isPending) return undefined;
    if (sessionId) {
      queryClient.removeQueries({ queryKey: ['workspace-lab-session', sessionId] });
      setSessionId(undefined);
      setSessionWasConfigured(false);
    }
    setSessionLoadTimedOut(false);
    setSessionRecoveryMessage('');
    try {
      return await createSession.mutateAsync();
    } catch {
      return undefined;
    }
  }

  async function runLocal() {
    if (runnerPlatform === 'macos') {
      setLocalMessage('macOS Cross-Comp packet production is not supported by the current Linux↔Windows packet contract. Use Workspace Lab for macOS evidence, or select Windows for this verifier.');
      return;
    }
    const readySession = session ?? await ensureSession();
    if (!readySession?.id || !readySession.pairingCode) {
      setLocalMessage('The protected session could not be prepared. Retry the session before starting the Windows runner.');
      return;
    }
    setLocalMessage(`Starting bounded reciprocal protocol rehearsal…`);
    try {
      const response = await fetch(localRunnerUrl('/run'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workspace-Lab-Token': readySession.pairingCode,
        },
        body: JSON.stringify({ suite: SUITE }),
      });
      const payload = await response.json() as { status?: string; output?: string; resultJson?: string; exitCode?: number; host?: string; error?: string };
      if (!response.ok) throw new Error(payload.error ?? 'The local runner rejected the check.');
      setLocalMessage(
        payload.status === 'passed'
          ? 'Browser Bridge completed the local rehearsal. It was not submitted as Cross-Comp promotion evidence because both directions ran on one host; use Paired Target Agent or native-host handoff for a promotable packet.'
          : `Local rehearsal failed · ${payload.output ?? 'The runner returned no output.'}`,
      );
      setLocalStatus('online');
    } catch (error) {
      const validationMessage = crossCompValidationMessage(error);
      setLocalStatus(validationMessage ? 'online' : 'offline');
      setLocalMessage(validationMessage ?? CROSS_COMP_RUNNER_FALLBACK_MESSAGE);
    }
  }

  function handleRegeneratePairingCode() {
    if (!sessionId || regeneratePairingCodeMutation.isPending) return;
    setPairingMessage('');
    regeneratePairingCodeMutation.mutate({ sessionId });
  }

  function queuePaired() {
    if (runnerPlatform === 'macos') {
      setLocalMessage('macOS Cross-Comp packet production is not supported by the current Linux↔Windows packet contract. Use Workspace Lab for macOS evidence, or select Windows for this verifier.');
      return;
    }
    void (async () => {
      const readySession = session ?? await ensureSession();
      if (!readySession?.id) return;
      queueJob.mutate({ sessionId: readySession.id, data: { suite: SUITE } });
    })();
  }

  async function uploadSelectedResult() {
    if (!sessionId || !uploadFile) return;
    const raw = await uploadFile.text();
    setUploadMessage('');
    try {
      await uploadResult.mutateAsync({
        sessionId,
        data: {
          suite: SUITE,
          status: uploadStatus,
          source: 'upload',
          output: raw.slice(0, 120000),
          resultJson: uploadFile.name.toLowerCase().endsWith('.json') ? raw.slice(0, 120000) : undefined,
          host: 'Uploaded result',
        },
      });
      setUploadMessage('Result recorded in the verification ledger.');
    } catch (error) {
      setUploadMessage(
        crossCompValidationMessage(error)
          ?? CROSS_COMP_UPLOAD_FALLBACK_MESSAGE,
      );
    }
  }

  async function reconcileRecovery(jobId: string) {
    if (!sessionId || reconcileJob.isPending) return;
    setReconciliationMessage('');
    try {
      await reconcileJob.mutateAsync({ sessionId, jobId });
      await sessionQuery.refetch();
      setReconciliationMessage('The recovery record was resolved and remains in the verification ledger.');
    } catch {
      setReconciliationMessage('The recovery record could not be resolved. Refresh the session and try again.');
    }
  }

  async function combineNativePackets() {
    if (!sessionId || !linuxToWindowsPacket || !windowsToLinuxPacket) {
      setHandoffMessage('Choose both retained direction packets before combining.');
      return;
    }
    try {
      setHandoffMessage('Checking both packets with the strict named-host verifier…');
      const packet = combineStrictNamedHostPackets(
        await linuxToWindowsPacket.text(),
        await windowsToLinuxPacket.text(),
      );
      const resultJson = JSON.stringify(packet, null, 2);
      uploadResult.mutate({
        sessionId,
        data: {
          suite: SUITE,
          status: 'passed',
          source: 'upload',
          output: [
            'Native-host handoff combined without loopback connectivity.',
            'Strict named-host verification passed for Linux → Windows and Windows → Linux.',
            'Both direction records are retained in the combined packet.',
          ].join('\n'),
          resultJson,
          host: 'Native host packet handoff',
        },
      });
      setHandoffMessage('Both native-host packets passed strict verification and were submitted as one retained result.');
    } catch (error) {
      setHandoffMessage(crossCompValidationMessage(error) ?? CROSS_COMP_HANDOFF_FALLBACK_MESSAGE);
    }
  }

  const jobs = session?.jobs ?? [];
  const visibleJobs = jobs.filter((job) => !isVisuallyHiddenPairedMishap(job));
  const hasOnlyPairingInvalidationRows = jobs.length > 0 && visibleJobs.length === 0;
  const activeJob = jobs.find((job) => job.status === 'queued' || job.status === 'running');
  const hasExpectedFailedSources = visibleJobs.some((job) => job.source === 'paired' && job.status === 'failed')
    && visibleJobs.some((job) => job.source === 'upload' && job.status === 'failed');
  const sessionDiagnostic = sessionQuery.isError
    ? sessionQueryFailureMessage(sessionQueryFailureKind(sessionQuery.error))
    : sessionRecoveryMessage
      ? sessionRecoveryMessage
      : sessionWasConfigured && session && !activeJob && !hasExpectedFailedSources && !hasOnlyPairingInvalidationRows
        ? 'The configured Cross-Comp session does not contain both expected failed sources (paired and uploaded).'
        : undefined;
  const sessionButtonLabel = createSession.isPending
    ? 'Creating Session'
    : session
      ? 'Session Active'
      : sessionLoadTimedOut || sessionQuery.isError
          ? 'Reinitialize Session'
          : 'Initialize Session';

  return (
    <div className="min-h-[100dvh] bg-ma-cream text-ma-charles">
      <header className="border-b border-ma-fog bg-ma-cream/90 px-5 py-5 backdrop-blur md:px-10">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4">
          <div className="min-w-0 flex items-center gap-5">
            <Brand size="compact" />
            <PrivateRoomNav active="workspace" />
          </div>
          <Link href="/workspace" className="text-xs font-bold text-ma-slate hover:text-ma-brick">Back to Workspace</Link>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-5 py-10 md:px-10 md:py-16">
        <div className="max-w-3xl">
          <div className="font-mono text-[10px] uppercase tracking-[.2em] text-ma-brick">@IT / Cross-Comp Lab</div>
          <h1 className="mt-4 font-serif text-5xl leading-[.95] tracking-[-.06em] md:text-7xl">Cross-machine verification room.</h1>
          <p className="mt-6 max-w-2xl text-base leading-7 text-ma-slate">
            A precise verification surface for bounded reciprocal Linux/Windows protocol rehearsals.
            Connect a Replit-hosted coordinator to a native runner.
            Promotion requires both native-host packets, bounded host provenance, matching directions,
            negotiated contract/authentication details, and both retry-recovery probes. This is a rehearsal
            room; it never enables a production claim.
          </p>
          <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="Cross-Comp runner platform">
            {(['windows', 'macos'] as const).map((candidate) => (
              <button
                key={candidate}
                type="button"
                onClick={() => {
                  setRunnerPlatform(candidate);
                  setLocalMessage('');
                  setLocalStatus('unknown');
                }}
                className={`rounded-full border px-4 py-2 text-sm font-bold ${runnerPlatform === candidate ? 'border-ma-charles bg-ma-charles text-ma-cream' : 'border-ma-fog bg-white/50 text-ma-slate'}`}
                aria-pressed={runnerPlatform === candidate}
              >
                {candidate === 'windows' ? 'Windows packet verifier' : 'macOS readiness'}
              </button>
            ))}
          </div>
          {runnerPlatform === 'macos' && (
            <p className="mt-4 max-w-2xl rounded-2xl border border-ma-fog bg-ma-cream/70 p-4 text-sm leading-6 text-ma-slate" role="status">
              macOS can run the native Workspace Lab and its evidence collector. Cross-Comp packet promotion remains explicitly limited to the Linux↔Windows direction contract, so macOS controls below stay read-only and cannot create mislabeled packets.
            </p>
          )}
           <section className="mt-8 rounded-2xl border border-ma-fog bg-white/60 p-5 md:p-6" aria-labelledby="cross-comp-start-here">
             <div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">Start here</div>
             <h2 id="cross-comp-start-here" className="mt-2 font-serif text-2xl tracking-[-.04em]">How a Cross-Comp run works</h2>
             <ol className="mt-4 grid gap-3 md:grid-cols-4">
               {[
                 ['1. Pick the verified lane', 'Use Windows packet verifier for the Linux↔Windows contract. Select macOS only to review native macOS readiness; it cannot produce a Cross-Comp packet.'],
                 ['2. Prepare the native checkout', 'Download the runner, enter the repository root that contains pnpm-workspace.yaml, and keep the runner terminal open.'],
                 ['3. Connect one of two ways', 'Use Browser Bridge when the browser and runner share a computer. Use Paired Agent when the runner should poll this room for work.'],
                 ['4. Review both directions', 'A valid handoff needs named Linux and Windows hosts, matching directions, contract/authentication details, and recovery probes.'],
               ].map(([title, detail]) => (
                 <li key={title} className="rounded-xl border border-ma-fog bg-ma-cream/70 p-4">
                   <div className="text-sm font-bold text-ma-charles">{title}</div>
                   <p className="mt-2 text-xs leading-5 text-ma-slate">{detail}</p>
                 </li>
               ))}
             </ol>
             <p className="mt-4 text-xs leading-5 text-ma-slate"><strong className="text-ma-charles">Important:</strong> this is a bounded synthetic protocol rehearsal. A passed packet proves the recorded named-host direction, its declared transport, authentication, and contract fields, and its recorded recovery probes — evidence about those hosts and directions only; it is not production, capacity, compliance, customer, or SLA evidence.</p>
           </section>
        </div>

         <section
           className="mt-6 rounded-[2rem] border border-ma-brick/30 bg-ma-cream/70 p-5 md:p-7"
           aria-labelledby="checkout-download-heading"
           data-testid="cross-comp-checkout-download"
         >
           <div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">00 / full test checkout</div>
           <h2 id="checkout-download-heading" className="mt-2 font-serif text-3xl tracking-[-.04em]">Download the complete test checkout</h2>
           <p className="mt-3 max-w-3xl text-sm leading-6 text-ma-slate">
             The native runner is only one file. The tests, package manifests, generated support files, and runner revision must come from the same checkout. Use the full ZIP when updating a local machine so an older <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">windows-runner.ps1</code> or test copy is not reused accidentally.
           </p>
           <div className="mt-5 grid gap-4 md:grid-cols-2">
             <div className="rounded-2xl border border-ma-fog bg-white/60 p-4">
               <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-[.1em] text-ma-charles">
                 <Download size={15} />
                 Option A — Download as ZIP
               </div>
               <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm leading-6 text-ma-slate">
                 <li>Open the Replit <span className="font-bold text-ma-charles">Files</span> tool and use its three-dot menu.</li>
                 <li>Choose <span className="font-bold text-ma-charles">Download as zip</span>, then extract it on the native machine.</li>
                 <li>Replace the old local checkout, or extract to a new folder and point <span className="font-bold text-ma-charles">Repository Path</span> at the folder containing <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">pnpm-workspace.yaml</code>.</li>
               </ol>
             </div>
             <div className="rounded-2xl border border-ma-fog bg-white/60 p-4">
               <div className="text-xs font-bold uppercase tracking-[.1em] text-ma-charles">Option B — Create the ZIP from Shell</div>
               <p className="mt-3 text-sm leading-6 text-ma-slate">
                 If the Files menu does not offer ZIP download, run this from the Replit Shell, then download <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">project.zip</code> from Files.
               </p>
               <div className="mt-3 flex gap-2">
                 <code className="min-w-0 flex-1 overflow-x-auto rounded-xl bg-ma-charles px-3 py-2 font-mono text-[11px] leading-5 text-ma-cream">{workspaceLabZipFallbackCommand}</code>
                 <button
                   type="button"
                   onClick={() => void copyZipCommand()}
                   className="grid h-10 w-10 shrink-0 place-items-center rounded-xl border border-ma-fog bg-ma-cream hover:border-ma-charles"
                   aria-label="Copy full checkout ZIP command"
                 >
                   {copiedZipCommand ? <Check size={15} /> : <Clipboard size={15} />}
                 </button>
               </div>
             </div>
           </div>
           <p className="mt-4 rounded-xl border border-ma-brick/30 bg-white/50 p-3 text-xs leading-5 text-ma-slate" role="note">
             <strong className="text-ma-charles">Before starting a new run:</strong> replace stale local copies, stop the old runner, and use the newly extracted checkout. The console must show the current runner revision; if it shows an older revision, do not queue another job.
           </p>
         </section>

        <section className="mt-10 rounded-[2rem] border border-ma-fog bg-white/50 p-5 shadow-[0_20px_70px_rgba(39,93,113,.08)] md:p-8" aria-labelledby="session-heading">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">01 / Verification Boundary</div>
              <h2 id="session-heading" className="mt-2 font-serif text-3xl tracking-[-.04em]">Protected Lab Session</h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-ma-slate">
                Establish a time-bounded connection. Sessions expire after 30 minutes. The session maintains a precise ledger of protocol interoperability check results.
              </p>
            </div>
            <button 
              type="button" 
              onClick={() => void ensureSession()} 
              disabled={Boolean(session) || createSession.isPending}
              className="inline-flex items-center gap-2 rounded-full bg-ma-charles px-5 py-3 text-sm font-bold text-ma-cream transition-transform hover:-translate-y-0.5 disabled:translate-y-0 disabled:opacity-50"
            >
              {createSession.isPending ? <Loader2 size={16} className="animate-spin" /> : <Laptop size={16} />}
              {sessionButtonLabel}
            </button>
          </div>

          {session && (
            <div className="mt-6 grid gap-4 border-t border-ma-fog pt-6 md:grid-cols-[1fr_auto]">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[.16em] text-ma-slate">Cryptographic Pairing Key</div>
                <code className="mt-2 block break-all rounded-xl bg-ma-charles px-4 py-3 font-mono text-sm text-ma-cream">
                  {session.pairingCode}
                </code>
                <p className="mt-2 text-xs text-ma-slate">Redeem this key strictly on the selected native host. Valid only for the duration of this session.</p>
              </div>
              <div className="flex flex-col items-start gap-1">
                <div className="font-mono text-[10px] uppercase tracking-[.16em] text-ma-slate">Agent Status</div>
                <div className="flex items-center gap-2 text-sm font-semibold">
                  {session.runnerStatus === 'connected' ? <Wifi size={16} className="text-ma-brick" /> : <WifiOff size={16} className="text-ma-slate" />}
                  {session.runnerStatus === 'connected' ? `${session.runnerName ?? `${runnerPlatform === 'windows' ? 'Windows' : 'macOS'} Runner`} Connected` : 'Awaiting Connection'}
                </div>
              </div>
               <div className="md:col-span-2">
                 <button
                   type="button"
                   onClick={handleRegeneratePairingCode}
                   disabled={regeneratePairingCodeMutation.isPending}
                   className="inline-flex items-center gap-2 rounded-full border border-ma-fog bg-ma-cream px-4 py-2 text-xs font-bold text-ma-charles hover:border-ma-brick disabled:cursor-not-allowed disabled:opacity-50"
                  data-testid="button-regenerate-workspace-lab-pairing-code"
                 >
                   {regeneratePairingCodeMutation.isPending && <Loader2 size={14} className="animate-spin" />}
                   {regeneratePairingCodeMutation.isPending ? 'Generating Pairing Code' : 'Regenerate Pairing Code'}
                 </button>
                 <p className="mt-2 text-xs leading-5 text-ma-slate">
                    Regenerating invalidates the previous code, disconnects any runner using it, and closes any queued or running run so a fresh runner can start. Existing session history remains available.
                 </p>
                 {pairingMessage && (
                  <div className="mt-2 rounded-xl border border-ma-fog bg-ma-cream p-3 text-xs leading-5 text-ma-slate" role="status" data-testid="status-workspace-lab-pairing-rotation">
                     {pairingMessage}
                   </div>
                 )}
               </div>
            </div>
          )}

          {session && (
            <div className="mt-6 max-w-xl border-t border-ma-fog pt-6">
              <label htmlFor="repo-root-input" className="font-mono text-[10px] uppercase tracking-[.16em] text-ma-slate">
                 {runnerPlatform === 'windows' ? 'Windows' : 'macOS'} Target Repository Path
              </label>
              <input
                id="repo-root-input"
                type="text"
                value={repoRootInput}
                onChange={(event) => setRepoRootInput(event.target.value)}
                 placeholder={runnerPlatform === 'windows' ? 'e.g. C:\\dev\\project' : 'e.g. /Users/me/code/project'}
                spellCheck={false}
                className="mt-2 w-full rounded-xl border border-ma-fog bg-ma-cream px-4 py-3 font-mono text-sm text-ma-charles outline-none placeholder:text-ma-slate/60 focus:border-ma-brick"
              />
              <p className="mt-2 text-xs leading-5 text-ma-slate">
                 Enter the absolute path to the repository root on the selected machine. The command below points at the freshly downloaded platform runner.
              </p>
              <a
                href={runnerScriptHref}
                 download={runnerPlatform === 'windows' ? 'windows-runner.ps1' : 'macos-runner.sh'}
                className="mt-4 inline-flex items-center gap-2 text-xs font-bold text-ma-brick underline decoration-ma-brick/40 underline-offset-4 hover:decoration-ma-brick"
              >
                <Download size={14} />
                 Download the allowlisted {runnerPlatform === 'windows' ? 'Windows' : 'macOS'} runner
              </a>
            </div>
          )}
        </section>

        <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <section className="min-w-0 rounded-[2rem] border border-ma-fog bg-ma-cream/70 p-5 md:p-7" aria-labelledby="local-heading">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">02 / Local Host Bridge</div>
                <h2 id="local-heading" className="mt-2 font-serif text-3xl tracking-[-.04em]">Browser-Bridged Runner</h2>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-bold ${localStatus === 'online' ? 'bg-ma-fog text-ma-charles' : 'bg-ma-cream text-ma-slate'}`}>
                {localStatus === 'online' ? 'Detected' : localStatus === 'stale' ? 'Update Required' : 'Not Detected'}
              </span>
            </div>
            <p className="mt-4 text-sm leading-6 text-ma-slate">
               Replit cannot dial a remote machine's <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">127.0.0.1</code> directly. Local mode uses the browser running on the selected host to bridge the connection to the runner listening on <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">localhost:{LOCAL_RUNNER_PORT}</code>. Run the command, wait for Detected, then press the button once; the browser will not accept arbitrary commands.
            </p>

            {session ? (
              <div className="mt-6">
                <div className="font-mono text-[10px] uppercase tracking-[.16em] text-ma-slate">Local Invocation Command</div>
                <div className="mt-2 flex gap-2">
                  <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-xl bg-ma-charles px-3 py-3 font-mono text-[11px] leading-5 text-ma-cream">
                    {localCommand}
                  </code>
                  <button type="button" onClick={copyLocalCommand} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-ma-fog bg-ma-cream hover:border-ma-charles" aria-label="Copy local command">
                    {copiedLocal ? <Check size={16} /> : <Clipboard size={16} />}
                  </button>
                </div>

                <div className="mt-6 border-t border-ma-fog pt-6">
                  <p className="mb-3 text-xs leading-5 text-ma-slate">
                    This runs the interop suite on this one machine playing both directions, so the API always rejects the resulting packet as evidence -- it is a connectivity rehearsal, not a passing record. To record a passing packet, use Paired Target Agent with a second real host, or the native-host packet handoff below with two independently produced packets.
                  </p>
                  <button 
                    type="button" 
                    onClick={runLocal} 
                    disabled={localStatus !== 'online' || runnerPlatform === 'macos'}
                    className="flex w-full items-center justify-between gap-3 rounded-xl border border-ma-fog bg-ma-cream px-4 py-3 text-left text-sm font-bold hover:border-ma-brick disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span>Execute Interop Suite via Browser Bridge</span>
                    <Play size={15} />
                  </button>
                  {localMessage && crossCompValidationMessage(localMessage) && (
                    <CrossCompValidationNotice message={crossCompValidationMessage(localMessage)!} />
                  )}
                  {localMessage && !crossCompValidationMessage(localMessage) && (
                    <div className="mt-3 rounded-xl border border-ma-fog bg-ma-cream p-3 text-xs leading-5 text-ma-slate" role="status">
                      {localMessage}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="mt-6 rounded-xl border border-dashed border-ma-fog bg-ma-cream p-4 text-center text-sm text-ma-slate">
                Initialize a session to generate the local command.
              </div>
            )}
          </section>

          <section className="min-w-0 rounded-[2rem] border border-ma-fog bg-ma-cream/70 p-5 md:p-7" aria-labelledby="paired-heading">
            <div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">03 / Paired Target Agent</div>
            <h2 id="paired-heading" className="mt-2 font-serif text-3xl tracking-[-.04em]">Remote Outbound Agent</h2>
            <p className="mt-4 text-sm leading-6 text-ma-slate">
               In paired mode, the native runner makes an outbound connection to the Replit coordinator to poll for queued execution mandates. Run the command once and leave the terminal open, then queue the suite from this card. The runner reports heartbeats and a final bounded result; macOS remains read-only here because the packet contract is Linux↔Windows.
            </p>

            {session ? (
              <div className="mt-6">
                <div className="font-mono text-[10px] uppercase tracking-[.16em] text-ma-slate">Paired Invocation Command</div>
                <div className="mt-2 flex gap-2">
                  <code className="min-w-0 flex-1 overflow-x-auto whitespace-pre rounded-xl bg-ma-charles px-3 py-3 font-mono text-[11px] leading-5 text-ma-cream">
                    {pairedCommand}
                  </code>
                  <button type="button" onClick={copyPairedCommand} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-ma-fog bg-ma-cream hover:border-ma-charles" aria-label="Copy paired command">
                    {copiedPaired ? <Check size={16} /> : <Clipboard size={16} />}
                  </button>
                </div>

                <div className="mt-6 border-t border-ma-fog pt-6">
                  <button 
                    type="button" 
                    onClick={queuePaired} 
                    disabled={queueJob.isPending || Boolean(activeJob) || runnerPlatform === 'macos'}
                    className="flex w-full items-center justify-between gap-3 rounded-xl border border-ma-fog bg-ma-cream px-4 py-3 text-left text-sm font-bold hover:border-ma-brick disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span>Queue Interop Mandate for Paired Agent</span>
                    <Wifi size={15} />
                  </button>
                  {activeJob && (
                    <p className="mt-3 rounded-xl border border-ma-fog bg-ma-cream p-3 text-xs leading-5 text-ma-slate" role="status">
                      A {activeJob.status} {activeJob.suite} run is holding the session queue. If that runner is no longer executing, regenerate the pairing code above; the old run will be retained as invalidated and a fresh mandate can then start.
                    </p>
                  )}
                </div>
              </div>
            ) : (
              <div className="mt-6 rounded-xl border border-dashed border-ma-fog bg-ma-cream p-4 text-center text-sm text-ma-slate">
                Initialize a session to generate the paired command.
              </div>
            )}
          </section>
        </div>

        <section className="mt-6 rounded-[2rem] border border-ma-fog bg-ma-cream/70 p-5 md:p-7" aria-labelledby="upload-heading">
          <div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">04 / Offline Verification Result</div>
          <h2 id="upload-heading" className="mt-2 font-serif text-3xl tracking-[-.04em]">Ingest Result File</h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-ma-slate">
             If execution occurred fully offline, upload the resulting JSON or text digest. The system accepts this as a bounded result record for the protocol rehearsal, but uploading a file does not bypass named-host, direction, contract, or recovery validation.
          </p>
          <div className="mt-6 grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_auto_auto]">
            <label className="min-w-0 flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-ma-fog bg-ma-cream px-4 py-3 text-sm font-semibold transition-colors hover:border-ma-charles hover:bg-ma-fog/30">
              <Upload size={16} />
              <span className="min-w-0 truncate">{uploadFile?.name ?? 'Select .json, .log, or .txt digest'}</span>
              <input type="file" accept=".json,.log,.txt" className="sr-only" onChange={(event) => setUploadFile(event.target.files?.[0])} />
            </label>
            <select value={uploadStatus} onChange={(event) => setUploadStatus(event.target.value as 'passed' | 'failed')} className="min-w-0 rounded-xl border border-ma-fog bg-ma-cream px-4 py-3 text-sm font-semibold outline-none focus:border-ma-brick">
              <option value="passed">Declare Success</option>
              <option value="failed">Declare Failure</option>
            </select>
            <button type="button" onClick={() => void uploadSelectedResult()} disabled={!sessionId || !uploadFile || uploadResult.isPending} className="min-w-0 rounded-xl bg-ma-charles px-5 py-3 text-sm font-bold text-ma-cream disabled:cursor-not-allowed disabled:opacity-50">
              {uploadResult.isPending ? 'Ingesting...' : 'Ingest Result'}
            </button>
          </div>
          {uploadMessage && crossCompValidationMessage(uploadMessage) && (
            <CrossCompValidationNotice message={crossCompValidationMessage(uploadMessage)!} />
          )}
          {uploadMessage && !crossCompValidationMessage(uploadMessage) && (
            <div className="mt-3 rounded-xl border border-ma-fog bg-ma-cream p-3 text-xs leading-5 text-ma-slate" role="status">
              {uploadMessage}
            </div>
          )}
        </section>

        <section className="mt-6 rounded-[2rem] border border-ma-fog bg-white/50 p-5 shadow-[0_20px_70px_rgba(39,93,113,.06)] md:p-7" aria-labelledby="handoff-heading">
          <div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">05 / native-host handoff</div>
          <h2 id="handoff-heading" className="mt-2 font-serif text-3xl tracking-[-.04em]">Combine two retained packets</h2>
          <p className="mt-3 max-w-3xl text-sm leading-6 text-ma-slate">
             This path does not connect to either host. Choose the two JSON packets produced by the native Linux and Windows runs, then let the strict named-host verifier combine them here. Select the Linux → Windows file first and the Windows → Linux file second. Missing, mismatched, duplicate, or platform-overridden packets stay rejected, and the combined result keeps both direction records.
          </p>
          <div className="mt-5 grid grid-cols-1 gap-3 md:grid-cols-2">
            <label className="min-w-0 flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-ma-fog bg-ma-cream px-4 py-3 text-sm font-semibold hover:border-ma-charles">
              <Upload size={16} />
              <span className="min-w-0 truncate">{linuxToWindowsPacket?.name ?? 'Linux → Windows packet (.json)'}</span>
              <input type="file" accept=".json,application/json" className="sr-only" onChange={(event) => setLinuxToWindowsPacket(event.target.files?.[0])} />
            </label>
            <label className="min-w-0 flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-ma-fog bg-ma-cream px-4 py-3 text-sm font-semibold hover:border-ma-charles">
              <Upload size={16} />
              <span className="min-w-0 truncate">{windowsToLinuxPacket?.name ?? 'Windows → Linux packet (.json)'}</span>
              <input type="file" accept=".json,application/json" className="sr-only" onChange={(event) => setWindowsToLinuxPacket(event.target.files?.[0])} />
            </label>
          </div>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <button type="button" onClick={() => void combineNativePackets()} disabled={!sessionId || !linuxToWindowsPacket || !windowsToLinuxPacket || uploadResult.isPending} className="rounded-xl bg-ma-charles px-5 py-3 text-sm font-bold text-ma-cream disabled:cursor-not-allowed disabled:opacity-50">
              {uploadResult.isPending ? 'Submitting…' : 'Verify and combine packets'}
            </button>
            <span className="text-xs text-ma-slate">The coordinator rechecks the combined packet before it enters session history.</span>
          </div>
          {handoffMessage && <p className="mt-4 rounded-xl border border-ma-fog bg-ma-cream p-3 text-xs leading-5 text-ma-slate" role="status">{handoffMessage}</p>}
        </section>

        {sessionDiagnostic && (
          <section
            className="mt-6 rounded-[2rem] border border-ma-brick/40 bg-ma-brick/5 p-5 md:p-7"
            data-testid="cross-comp-session-diagnostic"
            role="alert"
          >
            <div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">Configured evidence check</div>
            <h2 className="mt-2 font-serif text-2xl tracking-[-.04em]">Cross-Comp session needs attention</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-ma-slate">{sessionDiagnostic}</p>
            <button
              type="button"
              onClick={() => {
                queryClient.removeQueries({ queryKey: ['workspace-lab-session', sessionId] });
                setSessionId(undefined);
                setSessionWasConfigured(false);
                setSessionLoadTimedOut(false);
                setSessionRecoveryMessage('');
              }}
              className="mt-5 rounded-full border border-ma-brick px-4 py-2 text-xs font-bold text-ma-brick hover:bg-ma-brick hover:text-ma-cream"
            >
              Clear configured session
            </button>
          </section>
        )}

        {session?.jobHistoryTruncated && (
          <section
            className="mt-6 rounded-2xl border border-ma-copper/40 bg-ma-copper/10 p-5 md:p-6"
            data-testid="cross-comp-history-truncated"
            role="status"
          >
            <div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">Retained history</div>
            <p className="mt-2 max-w-3xl text-sm leading-6 text-ma-charles">
              This session keeps at most {session.jobHistoryLimit} job records. {session.jobHistoryPrunedCount} earlier {session.jobHistoryPrunedCount === 1 ? 'record has' : 'records have'} been permanently removed, so the results shown here are only retained history—not a complete run archive.
            </p>
          </section>
        )}

        {hasOnlyPairingInvalidationRows && (
          <section
            className="mt-6 min-w-0 rounded-[2rem] border border-ma-fog bg-ma-cream/70 p-4 sm:p-5 md:p-7"
            data-testid="cross-comp-invalidated-history"
            role="status"
          >
            <div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">06 / ledger</div>
            <h2 className="mt-2 font-serif text-2xl leading-tight tracking-[-.04em] sm:text-3xl">No visible verification results</h2>
            <p className="mt-3 max-w-2xl text-sm leading-6 text-ma-slate">
              Cross-Comp history contains only runs invalidated when the pairing code was regenerated. The retained invalidated runs are hidden from these results; start a new paired run to create a visible result.
            </p>
          </section>
        )}

        {visibleJobs.length > 0 && (
           <section className="mt-6 rounded-[2rem] border border-ma-fog bg-ma-cream/70 p-5 md:p-7" data-testid="cross-comp-ledger">
              <div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">06 / ledger</div>
             <h2 className="mt-2 font-serif text-3xl tracking-[-.04em]">Verification Results</h2>
             {reconciliationMessage && <p className="mt-4 rounded-xl border border-ma-copper/40 bg-ma-copper/10 p-3 text-sm text-ma-charles" role="status" data-testid="status-cross-comp-reconciliation">{reconciliationMessage}</p>}
             <div className="mt-6 space-y-4">
               {visibleJobs.map((job) => {
                 const resilienceRejection = resilienceProofRejectionFromResult(job.resultJson, job.output);
                 return (
                 <div key={job.id} data-testid={`cross-comp-job-${job.source}`} className="rounded-xl border border-ma-fog bg-white/50 overflow-hidden shadow-sm">
                   <div className="flex flex-wrap items-center justify-between gap-4 border-b border-ma-fog bg-white px-4 py-3">
                     <div className="flex items-center gap-3">
                        <span
                          id={`cross-comp-status-${job.id}`}
                          className={`inline-flex items-center rounded-full px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider ${
                         resilienceRejection ? 'bg-ma-brick text-ma-cream' :
                         job.status === 'passed' || job.status === 'reconciled' ? 'bg-ma-fog text-ma-charles' :
                         job.status === 'failed' ? 'bg-ma-brick text-ma-cream' : 
                         'bg-ma-cream text-ma-slate'
                          }`}
                        >
                         {resilienceRejection ? 'Rejected as incomplete' : statusLabel(job.status)}
                       </span>
                       <span className="font-mono text-[10px] text-ma-slate">ID {job.id.slice(0,8)}</span>
                     </div>
                      <div
                        id={`cross-comp-source-${job.id}`}
                        className="text-xs font-semibold text-ma-slate"
                      >
                        {job.source === 'paired' ? 'Paired Agent' : job.source === 'local' ? 'Local Bridge' : 'Offline Upload'}
                      </div>
                   </div>
                   <div className="p-4">
                      {job.recovery && (
                        <div className="mb-4 rounded-xl border border-ma-copper/40 bg-ma-copper/10 p-3 text-xs leading-5 text-ma-charles" data-testid={`cross-comp-recovery-${job.id}`}>
                          <div className="font-mono text-[10px] uppercase tracking-[.16em] text-ma-brick">Bounded recovery metadata</div>
                          <dl className="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2">
                            <div><dt className="inline font-semibold">Runner outcome:</dt> <dd className="inline">{job.recovery.outcomeStatus === 'passed' ? 'Passed' : 'Failed'}</dd></div>
                            <div><dt className="inline font-semibold">Attempts:</dt> <dd className="inline">{job.recovery.attempts}</dd></div>
                            <div><dt className="inline font-semibold">Exit code:</dt> <dd className="inline">{job.recovery.exitCode}</dd></div>
                            <div><dt className="inline font-semibold">Host:</dt> <dd className="inline">{job.recovery.host}</dd></div>
                            <div><dt className="inline font-semibold">Captured output:</dt> <dd className="inline">{job.recovery.outputLength} characters · {job.recovery.outputSha256}</dd></div>
                            <div><dt className="inline font-semibold">Captured result:</dt> <dd className="inline">{job.recovery.resultJsonLength} characters · {job.recovery.resultJsonSha256}</dd></div>
                            <div><dt className="inline font-semibold">Recorded:</dt> <dd className="inline">{new Date(job.recovery.recordedAt).toLocaleString()}</dd></div>
                          </dl>
                          <p className="mt-2 text-ma-slate">Raw runner output and credentials were not retained.</p>
                          {job.status === 'recovery-required' ? (
                            <button type="button" onClick={() => void reconcileRecovery(job.id)} disabled={reconcileJob.isPending} className="mt-3 rounded-full bg-ma-charles px-4 py-2 text-xs font-bold text-ma-cream disabled:cursor-not-allowed disabled:opacity-50" data-testid={`button-reconcile-cross-comp-job-${job.id}`}>
                              {reconcileJob.isPending ? 'Resolving…' : 'Resolve recovery record'}
                            </button>
                          ) : (
                            <p className="mt-2 font-semibold text-ma-charles">{job.status === 'reconciled' ? 'Resolved as reconciled from the bounded metadata.' : 'Resolved as failed from the bounded metadata.'}</p>
                          )}
                        </div>
                      )}
                      {job.status === 'failed' && crossCompValidationMessage(job.output) && (
                        <div data-testid={`cross-comp-rejection-${job.source}`}>
                           <CrossCompValidationNotice
                             message={crossCompValidationMessage(job.output)!}
                             noticeId={`cross-comp-rejection-notice-${job.id}`}
                             labelledBy={`cross-comp-status-${job.id} cross-comp-source-${job.id}`}
                           />
                        </div>
                      )}
                      {parseCrossCompEvidencePacket(job.resultJson) && (
                        <CrossCompPacketSummary packet={parseCrossCompEvidencePacket(job.resultJson)!} />
                      )}
                      {resilienceRejection && (
                        <ResilienceProofRejectionNotice rejection={resilienceRejection} noticeId={`cross-comp-resilience-rejection-${job.id}`} />
                      )}
                     <div className="font-mono text-[10px] uppercase tracking-[.16em] text-ma-slate mb-2">Transcribed Output</div>
                     {!resilienceRejection && (
                       <div className="max-h-[300px] overflow-y-auto rounded-xl bg-ma-charles p-3 text-xs leading-relaxed text-ma-cream">
                         <pre className="font-mono whitespace-pre-wrap break-all">{job.output || 'No output recorded.'}</pre>
                       </div>
                     )}
                   </div>
                 </div>
                 );
               })}
             </div>
          </section>
        )}
      </main>
    </div>
  );
}
