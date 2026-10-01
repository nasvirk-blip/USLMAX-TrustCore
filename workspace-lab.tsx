import { useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Check, Clipboard, Download, Laptop, Loader2, Pause, Play, Upload, Wifi, WifiOff } from 'lucide-react';
import { Link } from 'wouter';
import {
  getListWorkspaceLabAuditRunsQueryKey,
  useCreateWorkspaceLabSession,
  useGetWorkspaceLabSession,
  useQueueWorkspaceLabJob,
  useReconcileWorkspaceLabJob,
  useUpdateWorkspaceLabSetupControl,
  useUploadWorkspaceLabResult,
  type WorkspaceLabJob,
  type WorkspaceLabSuite,
} from '@workspace/api-client-react';
import { Brand } from '@/components/brand';
import { PrivateRoomNav } from '@/components/private-room-nav';
import { WindowsEvidenceGuide } from '@/components/windows-evidence';
import { WorkspaceLabChecklist } from '@/components/workspace-lab-checklist';
import { WorkspaceLabJobResults } from '@/components/workspace-lab-job-results';
import { WorkspaceLabRunProgress } from '@/components/workspace-lab-run-progress';
import {
  parseWorkspaceLabResilienceProgress,
  type WorkspaceLabResilienceProgress,
} from '@/components/workspace-lab-progress';
import {
  CrossCompPacketSummary,
  parseCrossCompEvidencePacket,
  ResilienceProofRejectionNotice,
  resilienceProofRejectionFromResult,
  type ResilienceProofRejection,
} from '@/components/cross-comp-evidence';
import { workspaceLabZipFallbackCommand } from '@/generated/workspace-lab-zip-fallback';
type LabPlatform = 'windows' | 'macos';
type LocalRunnerProgressPayload = {
  status: 'running' | 'passed' | 'failed';
  suite: WorkspaceLabSuite;
  startedAt?: string;
  elapsedMs?: number;
  outputBytes?: number;
  lastOutputAt?: string | null;
  phaseProgress?: unknown;
};
type LocalRunProgressState = {
  suite: WorkspaceLabSuite;
  startedAtMs: number;
  payload: LocalRunnerProgressPayload | null;
  connection: 'checking' | 'connected' | 'unavailable';
};
type LocalRunResult = {
  suite: WorkspaceLabSuite;
  status: 'passed' | 'failed';
  output: string;
  outputTruncated: boolean;
  resultJson?: string;
  exitCode?: number;
  host: string;
  proofRejection: ResilienceProofRejection | null;
  saveStatus: 'saving' | 'saved' | 'unconfirmed';
};

const suites: Array<{ id: WorkspaceLabSuite; label: string; detail: string }> = [
  { id: 'oa-it-test', label: 'OA-IT test suite', detail: 'The bounded integration suite for the current workspace.' },
  { id: 'iteration-benchmark', label: 'Iteration benchmark', detail: 'The existing cross-platform iteration benchmark.' },
  { id: 'windows-benchmark', label: 'Windows benchmark', detail: 'The existing Windows setup, run, and baseline comparison scripts.' },
  { id: 'macos-benchmark', label: 'macOS benchmark', detail: 'Run this on macOS; Windows marks it unsupported instead of relabeling the result.' },
  { id: 'cross-comp-interop', label: 'Cross-Comp interoperability', detail: 'The bounded reciprocal Linux/Windows protocol rehearsal.' },
  { id: 'windows-to-windows-interop', label: 'Windows-to-Windows host test', detail: 'A separate bounded native Windows host/runner protocol check. It is not Linux↔Windows Cross-Comp evidence.' },
  { id: 'resilience-stress', label: 'Randomized resilience stress', detail: 'Requires bounded concurrency, randomized load scales and timings, durability recovery, and enterprise queue pressure to all pass.' },
];

const macosSuites: Array<{ id: WorkspaceLabSuite; label: string; detail: string }> = [
  { id: 'oa-it-test', label: 'OA-IT test suite', detail: 'The bounded integration suite for the current workspace.' },
  { id: 'iteration-benchmark', label: 'Iteration benchmark', detail: 'The existing cross-platform iteration benchmark.' },
  { id: 'windows-benchmark', label: 'Windows benchmark', detail: 'Run this on Windows; macOS marks it unsupported instead of relabeling the result.' },
  { id: 'macos-benchmark', label: 'macOS benchmark', detail: 'The POSIX benchmark with macOS host provenance and baseline restoration.' },
  { id: 'cross-comp-interop', label: 'Cross-Comp interoperability', detail: 'The bounded reciprocal protocol rehearsal for named native hosts.' },
  { id: 'resilience-stress', label: 'Randomized resilience stress', detail: 'Windows-host resilience profile; macOS marks it unsupported instead of relabeling the result.' },
];

const SESSION_STORAGE_KEY = 'workspace-lab-session-id';
const MAX_WORKSPACE_LAB_OUTPUT_LENGTH = 120_000;
const OUTPUT_TRUNCATION_MARKER = '\n[output truncated by Workspace Lab]';
const LOCAL_RUNNER_BUSY_MESSAGE = 'A suite is already running on this listened-to runner. It will finish without being replaced; wait for it to finish before selecting another suite.';
const LOCAL_RUNNER_OUTDATED_MESSAGE = 'The local runner is out of date. Download the current runner script and restart it to use this Workspace Lab.';
const LOCAL_RUNNER_REVISIONS: Record<LabPlatform, string> = {
  windows: 'oait-file-median-v9-progress-setup-instance',
  macos: 'cross-comp-interop-v10-progress-setup-instance-macos',
};

function errorStatus(error: unknown): number | undefined {
  const candidate = error as {
    status?: unknown;
    response?: { status?: unknown };
  } | undefined;
  const status = candidate?.status ?? candidate?.response?.status;
  return typeof status === 'number' ? status : undefined;
}

export function shouldDiscardWorkspaceLabSession(error: unknown): boolean {
  const status = errorStatus(error);
  return status === 404 || status === 410;
}

function suiteLabel(suite: WorkspaceLabSuite): string {
  return [...suites, ...macosSuites].find((candidate) => candidate.id === suite)?.label ?? suite;
}

function statusLabel(status: WorkspaceLabJob['status']): string {
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

function formatHeartbeatAge(lastSeenAt: Date | string | null | undefined, nowMs: number): string {
  if (!lastSeenAt) return 'No heartbeat received yet';
  const ageMs = nowMs - new Date(lastSeenAt).getTime();
  if (ageMs < 0) return 'Just now';
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m ago`;
}

function localRunnerPhaseProgress(value: unknown): WorkspaceLabResilienceProgress | null {
  if (!value || typeof value !== 'object') return null;
  const phase = value as Record<string, unknown>;
  if (typeof phase.phaseName !== 'string') return null;
  const roundMatch = /^round-(\d+)-/.exec(phase.phaseName);
  const round = phase.phaseName === 'native-windows-postgres-lifecycle'
    ? 0
    : roundMatch
      ? Number(roundMatch[1])
      : Number.NaN;
  const event = phase.phaseStatus === 'running'
    ? 'workspace-lab-resilience-phase-start'
    : 'workspace-lab-resilience-phase';
  return parseWorkspaceLabResilienceProgress(JSON.stringify({
    event,
    phaseIndex: phase.phaseIndex,
    totalPhases: phase.totalPhases,
    round,
    name: phase.phaseName,
    status: phase.phaseStatus,
  }));
}

function parseLocalRunnerProgress(value: unknown, suite: WorkspaceLabSuite): LocalRunnerProgressPayload | null {
  if (!value || typeof value !== 'object') return null;
  const payload = value as Record<string, unknown>;
  if (
    payload.suite !== suite
    || !['running', 'passed', 'failed'].includes(String(payload.status))
  ) {
    return null;
  }
  const elapsedMs = typeof payload.elapsedMs === 'number' && Number.isFinite(payload.elapsedMs)
    ? Math.max(0, payload.elapsedMs)
    : undefined;
  const outputBytes = typeof payload.outputBytes === 'number' && Number.isFinite(payload.outputBytes)
    ? Math.max(0, payload.outputBytes)
    : undefined;
  const lastOutputAt = typeof payload.lastOutputAt === 'string' && Number.isFinite(Date.parse(payload.lastOutputAt))
    ? payload.lastOutputAt
    : null;
  return {
    status: payload.status as LocalRunnerProgressPayload['status'],
    suite,
    startedAt: typeof payload.startedAt === 'string' ? payload.startedAt : undefined,
    elapsedMs,
    outputBytes,
    lastOutputAt,
    phaseProgress: localRunnerPhaseProgress(payload.phaseProgress),
  };
}

function activeJobQueueState(
  job: WorkspaceLabJob,
  runnerStatus: 'waiting' | 'connected' | 'offline',
): 'queued-without-runner' | 'queued-with-runner' | 'queued-runner-offline' | 'claimed' {
  if (job.status === 'running') return 'claimed';
  if (runnerStatus === 'connected') return 'queued-with-runner';
  return runnerStatus === 'offline' ? 'queued-runner-offline' : 'queued-without-runner';
}

function activeJobStatusMessage(
  job: WorkspaceLabJob,
  runnerStatus: 'waiting' | 'connected' | 'offline',
  runnerName?: string | null,
): string {
  if (job.status === 'running') {
    return `Running — a paired runner has claimed the ${suiteLabel(job.suite)} run.`;
  }
  if (runnerStatus === 'connected') {
    return `Queued — a paired runner is connected but has not claimed the ${suiteLabel(job.suite)} run yet. It has not failed.`;
  }
  if (runnerStatus === 'offline') {
    return `Queued — ${runnerName ?? 'The paired runner'} disconnected before claiming the ${suiteLabel(job.suite)} run. It has not failed. To reconnect, regenerate the pairing code and start a replacement runner from Cross-Comp Lab; regenerating the code cancels this queued run, so queue it again after pairing.`;
  }
  return `Queued — waiting for a newly paired runner to claim the ${suiteLabel(job.suite)} run. It has not failed.`;
}

function localRunnerUrl(path: string): string {
  return `http://127.0.0.1:8787${path}`;
}

export function WorkspaceLabPage() {
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = useState<string | undefined>(() => (
    typeof window === 'undefined' ? undefined : window.localStorage.getItem(SESSION_STORAGE_KEY) ?? undefined
  ));
  const [sessionMessage, setSessionMessage] = useState('');
  const [localStatus, setLocalStatus] = useState<'unknown' | 'online' | 'offline'>('unknown');
  const [localRunnerActive, setLocalRunnerActive] = useState(false);
  const [localRunnerPaused, setLocalRunnerPaused] = useState(false);
  const [localRunnerStoppedConfirmed, setLocalRunnerStoppedConfirmed] = useState(false);
  const [localSetupChanged, setLocalSetupChanged] = useState(false);
  const [pairedSetupChanged, setPairedSetupChanged] = useState(false);
  const [localSetupMessage, setLocalSetupMessage] = useState('');
  const [pairedSetupMessage, setPairedSetupMessage] = useState('');
  const [runningLocalSuite, setRunningLocalSuite] = useState<WorkspaceLabSuite | null>(null);
  const [localProgress, setLocalProgress] = useState<LocalRunProgressState | null>(null);
  const [localRunResult, setLocalRunResult] = useState<LocalRunResult | null>(null);
  const [localMessage, setLocalMessage] = useState('');
  const localRunLock = useRef(false);
  const localRunnerInstance = useRef<string | null>(null);
  const [platform, setPlatform] = useState<LabPlatform>('windows');
  const [selectedSuite, setSelectedSuite] = useState<WorkspaceLabSuite>('oa-it-test');
  const [uploadStatus, setUploadStatus] = useState<'passed' | 'failed'>('passed');
  const [uploadFile, setUploadFile] = useState<File>();
  const [uploadMessage, setUploadMessage] = useState<{ status: 'success' | 'error'; text: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [repoRootInput, setRepoRootInput] = useState('');
  const [reconciliationMessage, setReconciliationMessage] = useState('');
  const [windowsInteropEndpoint, setWindowsInteropEndpoint] = useState('');
  const [windowsInteropSharedKey, setWindowsInteropSharedKey] = useState('');

  const createSession = useCreateWorkspaceLabSession({
    mutation: {
      onSuccess: (createdSession) => {
        queryClient.setQueryData(['workspace-lab-session', createdSession.id], createdSession);
        setSessionId(createdSession.id);
        setSessionMessage('');
      },
      onError: () => {
        setSessionMessage('The protected session could not be opened. Check the connection and try again.');
      },
    },
  });
  const sessionQuery = useGetWorkspaceLabSession(sessionId ?? '', {
    query: {
      queryKey: ['workspace-lab-session', sessionId],
      enabled: Boolean(sessionId),
      refetchInterval: 1500,
      refetchIntervalInBackground: true,
      retry: (failureCount, error) => (
        !shouldDiscardWorkspaceLabSession(error) && failureCount < 2
      ),
    },
  });
  const queueJob = useQueueWorkspaceLabJob();
  const updateSetupControl = useUpdateWorkspaceLabSetupControl({
    mutation: {
      onSuccess: (updatedSession) => {
        queryClient.setQueryData(['workspace-lab-session', updatedSession.id], updatedSession);
      },
    },
  });
  const reconcileJob = useReconcileWorkspaceLabJob();
  const uploadResult = useUploadWorkspaceLabResult();
  const session = sessionQuery.data;
  // The session query polls while the runner is active. `isFetching` is true
  // during every background poll, so using it for the initial-session button
  // makes an already loaded session look permanently stuck on "Checking saved
  // session". Only the first request without cached data is a blocking load.
  const isLoadingSavedSession = Boolean(sessionId) && sessionQuery.isLoading;

  useEffect(() => {
    if (sessionId) {
      window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
    } else {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionQuery.isError || !sessionId) return;
    if (shouldDiscardWorkspaceLabSession(sessionQuery.error)) {
      queryClient.removeQueries({ queryKey: ['workspace-lab-session', sessionId] });
      setSessionId(undefined);
      setSessionMessage('The saved lab session expired or is no longer available. Open a new session to continue.');
      return;
    }
    setSessionMessage('The saved lab session could not be refreshed. Its controls remain paused until the connection recovers or you open a new session.');
  }, [queryClient, sessionId, sessionQuery.error, sessionQuery.isError]);

  useEffect(() => {
    if (!session) return;
    const expiresAt = new Date(session.expiresAt).getTime();
    const remaining = expiresAt - Date.now();
    if (!Number.isFinite(expiresAt) || remaining <= 0) {
      queryClient.removeQueries({ queryKey: ['workspace-lab-session', session.id] });
      setSessionId(undefined);
      setSessionMessage('This lab session expired. Open a new session to continue.');
      return;
    }
    const timer = window.setTimeout(() => {
      queryClient.removeQueries({ queryKey: ['workspace-lab-session', session.id] });
      setSessionId(undefined);
      setSessionMessage('This lab session expired. Open a new session to continue.');
    }, Math.min(remaining + 250, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [queryClient, session]);

  const hasRepoRoot = repoRootInput.trim().length > 0;
  const repoRootArg = repoRootInput.trim() || '<PATH-TO-YOUR-CLONED-REPO>';
  const availableSuites = platform === 'windows' ? suites : macosSuites;
  // windows-runner.ps1 is already committed inside the repository itself, at
  // scripts\workspace-lab\windows-runner.ps1 -- whichever way the user got
  // the code onto Windows (zip, git clone), that copy came with it. Once we
  // know the repository folder, point -File straight at it instead of
  // asking the user to separately download the script and move it into that
  // same folder by hand. Until the folder is filled in, fall back to the
  // download-and-run-from-here flow below, since there is nowhere else to
  // point.
  const runnerScriptArg = platform === 'windows'
    ? (hasRepoRoot ? `${repoRootArg}\\scripts\\workspace-lab\\windows-runner.ps1` : '.\\windows-runner.ps1')
    : (hasRepoRoot ? `${repoRootArg}/scripts/workspace-lab/macos-runner.sh` : './macos-runner.sh');
  const runnerScriptHref = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/workspace-lab/${platform === 'windows' ? 'windows-runner.ps1' : 'macos-runner.sh'}?revision=${LOCAL_RUNNER_REVISIONS[platform]}`;
  const windowsHostInstallerHref = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/workspace-lab/windows-host-install.ps1`;
  const windowsInteropConfigured = windowsInteropEndpoint.trim().length > 0
    && windowsInteropSharedKey.trim().length >= 16;
  const pairedCommand = useMemo(() => {
    if (!session) return '';
    const windowsInteropArgs = platform === 'windows' && windowsInteropEndpoint.trim() && windowsInteropSharedKey.trim()
      ? ` -WindowsInteropEndpoint "${windowsInteropEndpoint.trim()}" -WindowsInteropSharedKey "${windowsInteropSharedKey.trim()}"`
      : '';
    return platform === 'windows'
      ? `powershell -ExecutionPolicy Bypass -File "${runnerScriptArg}" -ApiBaseUrl "${window.location.origin}/api" -PairingCode "${session.pairingCode}" -RepoRoot "${repoRootArg}" -ExpectedRunnerRevision "${LOCAL_RUNNER_REVISIONS.windows}"${windowsInteropArgs}`
      : `bash "${runnerScriptArg}" --api-base-url "${window.location.origin}/api" --pairing-code "${session.pairingCode}" --repo-root "${repoRootArg}" --expected-runner-revision "${LOCAL_RUNNER_REVISIONS.macos}"`;
  }, [session, runnerScriptArg, repoRootArg, platform, windowsInteropEndpoint, windowsInteropSharedKey]);
  const localCommand = useMemo(() => {
    if (!session) return '';
    return platform === 'windows'
      ? `powershell -ExecutionPolicy Bypass -File "${runnerScriptArg}" -LocalToken "${session.pairingCode}" -RepoRoot "${repoRootArg}" -ExpectedRunnerRevision "${LOCAL_RUNNER_REVISIONS.windows}"`
      : `bash "${runnerScriptArg}" --local-token "${session.pairingCode}" --repo-root "${repoRootArg}" --expected-runner-revision "${LOCAL_RUNNER_REVISIONS.macos}"`;
  }, [session, runnerScriptArg, repoRootArg, platform]);

  useEffect(() => {
    if (!session?.pairingCode) return;
    let mounted = true;
    const checkLocalRunner = () => {
      void fetch(localRunnerUrl('/health'), { headers: { 'X-Workspace-Lab-Token': session.pairingCode } })
        .then(async (response) => {
          const payload = response.ok
            ? await response.json() as { active?: unknown; setupPaused?: unknown; revision?: unknown; instanceId?: unknown }
            : undefined;
          const instanceId = typeof payload?.instanceId === 'string' && payload.instanceId.length > 0
            ? payload.instanceId : null;
          const runnerMatches = payload?.revision === LOCAL_RUNNER_REVISIONS[platform] && instanceId !== null;
          if (mounted) {
            if (runnerMatches) setLocalRunnerStoppedConfirmed(false);
            if (runnerMatches && instanceId !== localRunnerInstance.current) {
              if (localRunnerInstance.current !== null) {
                setLocalSetupChanged(false);
                setLocalSetupMessage('A replacement local runner is online. Fresh suite requests use its startup setup.');
              }
              localRunnerInstance.current = instanceId;
            }
            setLocalStatus(response.ok && runnerMatches ? 'online' : 'offline');
            setLocalRunnerActive(response.ok && runnerMatches && payload?.active === true);
            setLocalRunnerPaused(response.ok && runnerMatches && payload?.setupPaused === true);
            if (response.ok && !runnerMatches) {
              setLocalMessage(LOCAL_RUNNER_OUTDATED_MESSAGE);
              return;
            }
            if (response.ok && runnerMatches) {
              setLocalMessage((message) => message === LOCAL_RUNNER_OUTDATED_MESSAGE ? '' : message);
            }
            if (response.ok && payload?.active !== true) {
              setLocalMessage((message) => (
                message === LOCAL_RUNNER_BUSY_MESSAGE || message === LOCAL_RUNNER_OUTDATED_MESSAGE
                  ? ''
                  : message
              ));
            }
          }
        })
        .catch(() => {
          if (mounted) {
            setLocalStatus('offline');
            setLocalRunnerActive(false);
          }
        });
    };
    checkLocalRunner();
    const interval = window.setInterval(checkLocalRunner, 4000);
    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, [session?.pairingCode, platform]);

  useEffect(() => {
    if (!runningLocalSuite || !session?.pairingCode) return;
    let mounted = true;
    let timer: number | undefined;
    const checkProgress = async () => {
      try {
        const response = await fetch(localRunnerUrl('/progress'), {
          headers: { 'X-Workspace-Lab-Token': session.pairingCode },
        });
        if (!response.ok) throw new Error('Progress endpoint unavailable');
        const raw = await response.json() as unknown;
        const payload = parseLocalRunnerProgress(raw, runningLocalSuite);
        if (mounted) {
          setLocalProgress((current) => current?.suite === runningLocalSuite
            ? { ...current, payload, connection: 'connected' }
            : current);
        }
      } catch {
        if (mounted) {
          setLocalProgress((current) => current?.suite === runningLocalSuite
            ? { ...current, connection: 'unavailable' }
            : current);
        }
      } finally {
        if (mounted) timer = window.setTimeout(() => void checkProgress(), 1500);
      }
    };
    void checkProgress();
    return () => {
      mounted = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [runningLocalSuite, session?.pairingCode]);

  async function copyText(value: string) {
    await navigator.clipboard?.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  async function ensureSession() {
    if (session) return session;
    if (createSession.isPending) return undefined;
    if (sessionId) {
      queryClient.removeQueries({ queryKey: ['workspace-lab-session', sessionId] });
      setSessionId(undefined);
    }
    setSessionMessage('');
    try {
      return await createSession.mutateAsync();
    } catch {
      return undefined;
    }
  }

  async function runLocal(suite: WorkspaceLabSuite) {
    if (localRunLock.current || localRunnerActive || localRunnerPaused || localSetupChanged) return;
    localRunLock.current = true;
    setRunningLocalSuite(suite);
    setLocalProgress({
      suite,
      startedAtMs: Date.now(),
      payload: null,
      connection: 'checking',
    });
    setLocalMessage('');
    try {
      const readySession = session ?? await ensureSession();
      if (!readySession?.id || !readySession.pairingCode) {
        setLocalMessage(`The protected session could not be prepared. Retry it before starting the ${platform === 'windows' ? 'Windows' : 'macOS'} runner.`);
        return;
      }
      const response = await fetch(localRunnerUrl('/run'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workspace-Lab-Token': readySession.pairingCode,
        },
        body: JSON.stringify({ suite }),
      });
      const payload = await response.json() as {
        status?: string;
        output?: string;
        outputTruncated?: boolean;
        resultJson?: string;
        exitCode?: number;
        host?: string;
        error?: string;
      };
      if (response.status === 409) {
        setLocalStatus('online');
        if (payload.error === 'The local runner is paused for setup changes.') {
          setLocalRunnerPaused(true);
          setLocalMessage('The local runner is paused for setup changes. Resume it without edits, or restart it after applying changed setup.');
        } else {
          setLocalRunnerActive(true);
          setLocalMessage(LOCAL_RUNNER_BUSY_MESSAGE);
        }
        return;
      }
      if (!response.ok) throw new Error(payload.error ?? 'The local runner rejected the check.');

      const output = payload.output ?? '';
      const resultJson = payload.resultJson;
      const proofRejection = resilienceProofRejectionFromResult(resultJson, output);
      const status = payload.status === 'passed' ? 'passed' : 'failed';
      const host = payload.host ?? `Local ${platform === 'windows' ? 'Windows' : 'macOS'} runner`;
      const outputTruncated = payload.outputTruncated ?? false;
      const localResult: LocalRunResult = {
        suite,
        status,
        output,
        outputTruncated,
        resultJson,
        exitCode: payload.exitCode,
        host,
        proofRejection,
        saveStatus: 'saving',
      };
      setLocalRunResult(localResult);
      setLocalStatus('online');
      setLocalRunnerActive(false);
      try {
        await uploadResult.mutateAsync({
          sessionId: readySession.id,
          data: {
            suite,
            status,
            source: 'local',
            output,
            outputTruncated,
            resultJson,
            exitCode: payload.exitCode,
            host,
          },
        });
        await refreshSavedResultLists(readySession.id);
        setLocalRunResult((current) => current ? { ...current, saveStatus: 'saved' } : current);
        setLocalMessage(`${suiteLabel(suite)} finished and was saved to Recent Results.`);
      } catch {
        setLocalRunResult((current) => current ? { ...current, saveStatus: 'unconfirmed' } : current);
        setLocalMessage(
          `${suiteLabel(suite)} finished on the local runner, but Workspace Lab could not confirm the save. Check Recent Results before rerunning; the output remains visible here.`,
        );
      }
    } catch (error) {
      setLocalStatus('offline');
      setLocalRunnerActive(false);
      setLocalMessage(error instanceof Error ? error.message : 'The local runner is unavailable.');
    } finally {
      localRunLock.current = false;
      setRunningLocalSuite(null);
      setLocalProgress(null);
    }
  }

  async function queuePaired(suite: WorkspaceLabSuite) {
    const readySession = session ?? await ensureSession();
    if (!readySession?.id || readySession.setupPaused || pairedSetupChanged) return;
    queueJob.mutate({ sessionId: readySession.id, data: { suite } });
  }

  async function setPairedSetupPaused(paused: boolean) {
    if (!session || updateSetupControl.isPending) return;
    const setupChanged = !paused && pairedSetupChanged;
    setPairedSetupMessage('');
    try {
      await updateSetupControl.mutateAsync({ sessionId: session.id, data: { paused, setupChanged } });
      setPairedSetupChanged(false);
      setPairedSetupMessage(setupChanged
        ? 'Setup applied. The old runner pairing and queued work were invalidated. Start the refreshed runner and queue a new run.'
        : paused
          ? 'New paired jobs are paused. Any active suite will finish before setup fields unlock. No new suite can start until you resume.'
          : 'The existing paired runner can claim queued work again.');
    } catch {
      setPairedSetupMessage('The paired runner state could not be changed. Wait for an active suite to finish, then try again.');
    }
  }

  async function setLocalSetupPaused(paused: boolean) {
    if (!session) return;
    if (!paused && localSetupChanged) {
      setLocalSetupMessage('The local runner remains paused because it cannot adopt changed settings in place. Stop it in its terminal, then restart the refreshed command.');
      return;
    }
    try {
      const response = await fetch(localRunnerUrl('/setup-control'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Workspace-Lab-Token': session.pairingCode },
        body: JSON.stringify({ paused, setupChanged: !paused && localSetupChanged }),
      });
      const payload = await response.json().catch(() => ({})) as { paused?: unknown; error?: unknown };
      if (!response.ok) throw new Error(typeof payload.error === 'string' ? payload.error : 'The local runner rejected setup control.');
      setLocalRunnerPaused(payload.paused === true);
      setLocalSetupMessage(paused
        ? 'New local suite requests are paused. Any active suite will finish before setup fields unlock.'
        : 'The existing local runner resumed with its current setup.');
    } catch (error) {
      setLocalSetupMessage(error instanceof Error ? error.message : 'The local runner could not be controlled.');
    }
  }

  function markSetupEdited() {
    setPairedSetupChanged(true);
    if (localRunnerInstance.current !== null) setLocalSetupChanged(true);
  }

  async function uploadSelectedResult() {
    if (!sessionId || !uploadFile) return;
    setUploadMessage(null);
    try {
      const raw = await uploadFile.text();
      const outputTruncated = raw.length > MAX_WORKSPACE_LAB_OUTPUT_LENGTH;
      const output = outputTruncated
        ? `${raw.slice(0, MAX_WORKSPACE_LAB_OUTPUT_LENGTH - OUTPUT_TRUNCATION_MARKER.length)}${OUTPUT_TRUNCATION_MARKER}`
        : raw;
      await uploadResult.mutateAsync({
        sessionId,
        data: {
          suite: selectedSuite,
          status: uploadStatus,
          output,
          outputTruncated,
          resultJson: uploadFile.name.toLowerCase().endsWith('.json') ? raw.slice(0, 120000) : undefined,
          host: 'Uploaded result',
        },
      });
      await refreshSavedResultLists(sessionId);
      setUploadMessage({ status: 'success', text: 'Result saved to Recent Results and the audit archive.' });
    } catch {
      setUploadMessage({ status: 'error', text: 'Workspace Lab could not confirm that this result was saved. Check Recent Results before retrying.' });
    }
  }

  async function refreshSavedResultLists(targetSessionId: string) {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['workspace-lab-session', targetSessionId] }),
      queryClient.invalidateQueries({ queryKey: getListWorkspaceLabAuditRunsQueryKey() }),
    ]);
  }

  async function reconcileRecovery(jobId: string) {
    if (!sessionId || reconcileJob.isPending) return;
    setReconciliationMessage('');
    try {
      await reconcileJob.mutateAsync({ sessionId, jobId });
      await sessionQuery.refetch();
      setReconciliationMessage('The recovery record was resolved and remains in this session history.');
    } catch {
      setReconciliationMessage('The recovery record could not be resolved. Refresh the session and try again.');
    }
  }

  const jobs = session?.jobs ?? [];
  const activeJob = jobs.find((job) => job.status === 'queued' || job.status === 'running');
  const hasRunningPairedJob = jobs.some((job) => job.status === 'running');
  const pairedSetupSafe = Boolean(session?.setupPaused && !hasRunningPairedJob);
  const localSetupSafe = localStatus === 'offline'
    ? localRunnerInstance.current === null || localRunnerStoppedConfirmed
    : localStatus === 'online' && localRunnerPaused && !localRunnerActive;
  const setupLocked = !pairedSetupSafe || !localSetupSafe;
  const localRunBusy = runningLocalSuite !== null || localRunnerActive;

  return (
    <div className="min-h-[100dvh] bg-ma-cream text-ma-charles">
      <header className="border-b border-ma-fog bg-ma-cream/90 px-5 py-5 backdrop-blur md:px-10">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-5">
            <Brand size="compact" />
            <PrivateRoomNav active="workspace" />
          </div>
          <Link href="/workspace" className="text-xs font-bold text-ma-slate hover:text-ma-brick">Back to Workspace</Link>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-5 py-10 md:px-10 md:py-16">
        <div className="max-w-3xl">
          <div className="font-mono text-[10px] uppercase tracking-[.2em] text-ma-brick">@IT / Workspace Lab</div>
           <h1 className="mt-4 font-serif text-5xl leading-[.95] tracking-[-.06em] md:text-7xl">Run native checks from the room.</h1>
           <p className="mt-6 max-w-2xl text-base leading-7 text-ma-slate">Use the same bounded scripts already in the repository. Choose Windows or macOS, then connect a runner on that computer, pair it through a short-lived queue, or upload a retained result. The browser never sends arbitrary shell or PowerShell.</p>
        </div>

         <section className="mt-8 rounded-2xl border border-ma-fog bg-white/60 p-5 md:p-6" aria-labelledby="workspace-start-here">
           <div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">Start here</div>
           <h2 id="workspace-start-here" className="mt-2 font-serif text-2xl tracking-[-.04em]">The beginner path</h2>
           <div className="mt-4 grid gap-3 md:grid-cols-3">
             {[
               ['1. Choose the computer', 'Select Windows or macOS, then use that computer for the download, checkout, and runner command.'],
               ['2. Open one session', 'Create a protected session here. Its pairing key is short-lived and only authorizes this lab session.'],
               ['3. Run or upload', 'Start the runner, wait for Online, and choose a suite. If you already ran a check, upload its bounded .json, .log, or .txt result instead.'],
             ].map(([title, detail]) => (
               <div key={title} className="rounded-xl border border-ma-fog bg-ma-cream/70 p-4">
                 <div className="text-sm font-bold text-ma-charles">{title}</div>
                 <p className="mt-2 text-xs leading-5 text-ma-slate">{detail}</p>
               </div>
             ))}
           </div>
           <p className="mt-4 text-xs leading-5 text-ma-slate"><strong className="text-ma-charles">Which mode should I use?</strong> Choose Local runner when the browser and checkout are on the same computer. Choose Paired runner when the native computer should poll this room for a queued job. Use Upload when execution happened elsewhere or the computer cannot connect back.</p>
         </section>

          <div className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-ma-fog bg-ma-paper p-5" data-testid="workspace-lab-checklist-link">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[.16em] text-ma-brick">Completion checklist</div>
              <p className="mt-2 text-sm leading-6 text-ma-slate">Track the full Replit and Windows test plan from the Workspace home.</p>
            </div>
            <Link
              href="/workspace#workspace-completion-checklist"
              className="rounded-full bg-ma-charles px-4 py-2.5 text-xs font-bold text-ma-cream transition-colors hover:bg-ma-brick focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ma-brick"
              data-testid="link-workspace-full-checklist"
            >
              Open full checklist
            </Link>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-ma-brick/25 bg-ma-copper/10 p-5" data-testid="workspace-lab-cross-comp-lab-link">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[.16em] text-ma-brick">Cross-Comp Lab</div>
              <p className="mt-2 text-sm leading-6 text-ma-slate">Run the full paired hand-off between this Replit workspace and a named Windows or macOS host, including packet exchange. The Cross-Comp interoperability suite below runs a bounded rehearsal here; open Cross-Comp Lab for the complete reciprocal workflow.</p>
            </div>
            <Link
              href="/workspace/cross-comp-lab"
              className="rounded-full bg-ma-brick px-4 py-2.5 text-xs font-bold text-ma-cream transition-colors hover:bg-ma-charles focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ma-brick"
              data-testid="link-workspace-lab-cross-comp-lab"
            >
              Open Cross-Comp Lab
            </Link>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-ma-fog bg-ma-paper p-5" data-testid="workspace-lab-host-lab-link">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[.16em] text-ma-brick">Host Lab</div>
              <p className="mt-2 text-sm leading-6 text-ma-slate">Set up a Windows 10 desktop listener, send a synthetic task from a Windows laptop, and review the test limits before opening the runner controls.</p>
            </div>
            <Link
              href="/workspace/host-lab"
              className="rounded-full border border-ma-fog bg-white px-4 py-2.5 text-xs font-bold text-ma-charles hover:border-ma-brick focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ma-brick"
              data-testid="link-workspace-lab-host-lab"
            >
              Open Host Lab
            </Link>
          </div>

         <div className="mt-8 flex flex-wrap gap-2" role="group" aria-label="Runner platform">
           {(['windows', 'macos'] as const).map((candidate) => (
             <button
               key={candidate}
               type="button"
               onClick={() => {
                  if (candidate === platform) return;
                 setPlatform(candidate);
                 setSelectedSuite('oa-it-test');
                 setLocalMessage('');
                  if (session) markSetupEdited();
               }}
                 disabled={localRunBusy || (Boolean(session) && setupLocked)}
                className={`rounded-full border px-4 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50 ${platform === candidate ? 'border-ma-charles bg-ma-charles text-ma-cream' : 'border-ma-fog bg-white/50 text-ma-slate'}`}
               aria-pressed={platform === candidate}
                data-testid={`button-runner-platform-${candidate}`}
             >
               {candidate === 'windows' ? 'Windows' : 'macOS'}
             </button>
           ))}
         </div>

         {platform === 'windows' ? <WindowsEvidenceGuide id="workspace-windows-evidence-guide" compact /> : (
           <section className="mt-6 rounded-2xl border border-ma-fog bg-white/50 p-5" aria-labelledby="workspace-macos-evidence-guide">
             <div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">macOS readiness</div>
             <h2 id="workspace-macos-evidence-guide" className="mt-2 font-serif text-2xl tracking-[-.04em]">Native macOS runner and evidence collector</h2>
              <p className="mt-2 max-w-2xl text-sm leading-6 text-ma-slate">Use the generated shell runner on the Mac that contains the repository checkout. The first run can install workspace dependencies; it does not run anything on Replit's server.</p>
              <ol className="mt-4 grid gap-2 text-sm leading-6 text-ma-slate md:grid-cols-3">
                 <li className="rounded-xl border border-ma-fog bg-ma-cream/70 p-3"><strong className="text-ma-charles">1. Prepare:</strong> Install Node 22.12 or newer and a working pnpm. Add PostgreSQL server binaries if you need contention coverage.</li>
                <li className="rounded-xl border border-ma-fog bg-ma-cream/70 p-3"><strong className="text-ma-charles">2. Run:</strong> Download <code className="rounded bg-ma-fog/60 px-1 font-mono text-xs">macos-runner.sh</code>, or use the copy in the checkout, then run the command generated below.</li>
                <li className="rounded-xl border border-ma-fog bg-ma-cream/70 p-3"><strong className="text-ma-charles">3. Save:</strong> For a three-suite packet, run <code className="rounded bg-ma-fog/60 px-1 font-mono text-xs">bash ./scripts/workspace-lab/save-macos-evidence.sh</code> from the repository root.</li>
              </ol>
              <p className="mt-3 text-xs leading-5 text-ma-slate">The iteration benchmark can still run without PostgreSQL. A missing prerequisite is recorded as incomplete or failed; it is never silently counted as a pass.</p>
           </section>
         )}

        <section className="mt-10 rounded-[2rem] border border-ma-fog bg-white/50 p-5 shadow-[0_20px_70px_rgba(39,93,113,.08)] md:p-8" aria-labelledby="get-code-heading">
          <div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">00 / before you start</div>
          <h2 id="get-code-heading" className="mt-2 font-serif text-3xl tracking-[-.04em]">Get the code onto the {platform === 'windows' ? 'Windows' : 'macOS'} computer</h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-ma-slate">The runner script runs the real checks from a local copy of this repository's source — it isn't a standalone download. Pick whichever of these gets you there; you only need one.</p>

          <div className="mt-5 max-w-2xl rounded-2xl border border-ma-fog bg-ma-cream/60 p-4">
                <div className="text-xs font-bold uppercase tracking-[.1em] text-ma-charles">Prerequisites — install these on the {platform === 'windows' ? 'Windows' : 'macOS'} computer first</div>
            {platform === 'windows' ? <>
            <p className="mt-2 text-sm leading-6 text-ma-slate">The runner checks all of this itself the first time it runs and tells you exactly what's missing, so it's safe to skip ahead and let it walk you through gaps. Installing these up front just avoids stopping partway through.</p>
            <ol className="mt-2 list-decimal space-y-3 pl-5 text-sm leading-6 text-ma-slate">
              <li><span className="font-bold text-ma-charles">Node.js 22.12 or newer.</span> Required by the locked Vite workspace and the built-in <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">node:sqlite</code> module used in durable queue checks. <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">winget install OpenJS.NodeJS</code> or download from <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">nodejs.org</code>.</li>
              <li><span className="font-bold text-ma-charles">pnpm.</span> The runner enables it automatically through <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">corepack enable</code> once Node is installed — no separate action needed unless that fails, in which case <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">npm i -g pnpm</code> works.</li>
              <li><span className="font-bold text-ma-charles">PostgreSQL server binaries</span> (<code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">initdb</code>, <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">postgres</code>, <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">pg_ctl</code>) — the psql client alone isn't enough. Needed for the full test suite and the queue-contention benchmark profile; the iteration benchmark itself runs fine without it. Any current major version works; the setup script only checks that the binaries are on PATH.
                <code className="mt-2 block overflow-x-auto rounded-xl bg-ma-charles px-3 py-2 font-mono text-[11px] leading-5 text-ma-cream">winget install PostgreSQL.PostgreSQL.18</code>
                <span className="mt-2 block text-xs leading-5 text-ma-slate">Then add its bin folder to PATH. For just this PowerShell window (you'll need to repeat this every time you open a new one):</span>
                <code className="mt-1 block overflow-x-auto rounded-xl bg-ma-charles px-3 py-2 font-mono text-[11px] leading-5 text-ma-cream">$env:Path += ";C:\Program Files\PostgreSQL\18\bin"</code>
                <span className="mt-2 block text-xs leading-5 text-ma-slate">Or make it permanent, so every new PowerShell window already has it:</span>
                <ol className="mt-1 list-decimal space-y-1 pl-5 text-xs leading-5 text-ma-slate">
                  <li>Press the <span className="font-bold text-ma-charles">Windows</span> key, type <span className="font-bold text-ma-charles">env</span>, and open <span className="font-bold text-ma-charles">"Edit the system environment variables."</span></li>
                  <li>In the System Properties window, click the <span className="font-bold text-ma-charles">Environment Variables…</span> button.</li>
                  <li>Under <span className="font-bold text-ma-charles">System variables</span> (use <span className="font-bold text-ma-charles">User variables</span> instead if you don't have administrator rights), select <span className="font-bold text-ma-charles">Path</span> and click <span className="font-bold text-ma-charles">Edit…</span>.</li>
                  <li>Click <span className="font-bold text-ma-charles">New</span>, paste <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">C:\Program Files\PostgreSQL\18\bin</code>, then click <span className="font-bold text-ma-charles">OK</span> on every open dialog to save.</li>
                  <li>Close and reopen PowerShell so it picks up the change.</li>
                 </ol>
              </li>
              <li><span className="font-bold text-ma-charles">Win32 long paths enabled.</span> pnpm's nested store plus TypeScript build output can exceed the legacy 260-character path limit, which fails installs with <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">ENAMETOOLONG</code>. Open PowerShell as an administrator — right-click the Start menu's PowerShell entry (or search for it) and choose <span className="font-bold text-ma-charles">Run as administrator</span> — then run this and reboot:
                <code className="mt-2 block overflow-x-auto rounded-xl bg-ma-charles px-3 py-2 font-mono text-[11px] leading-5 text-ma-cream">New-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\FileSystem" -Name "LongPathsEnabled" -Value 1 -PropertyType DWORD -Force</code>
              </li>
              <li><span className="font-bold text-ma-charles">Allow the script to run.</span> The commands below already pass <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">-ExecutionPolicy Bypass</code>, so no separate step is needed unless you double-click the file directly — in that case, run <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass</code> first.</li>
             </ol>
             </> : <>
               <p className="mt-2 text-sm leading-6 text-ma-slate">The macOS runner checks the repository and tools before starting. Install these first if you want the smoothest first run.</p>
               <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm leading-6 text-ma-slate">
                 <li><span className="font-bold text-ma-charles">macOS and Node.js 22.12 or newer.</span> Confirm with <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">node --version</code>.</li>
                 <li><span className="font-bold text-ma-charles">pnpm.</span> Confirm with <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">pnpm --version</code>. If it is missing, install Node's Corepack support or use <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">npm i -g pnpm</code>.</li>
                 <li><span className="font-bold text-ma-charles">PostgreSQL server binaries, when needed.</span> The full suite and contention profile use <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">initdb</code>, <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">postgres</code>, and <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">pg_ctl</code>. The iteration benchmark does not require them.</li>
                 <li><span className="font-bold text-ma-charles">A checkout with</span> <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">pnpm-workspace.yaml</code> at its top level. Use the repository root, not its parent folder.</li>
               </ol>
             </>}
          </div>


          <div className="mt-3 max-w-2xl rounded-2xl border border-ma-fog bg-ma-cream/60 p-4">
            <div className="text-xs font-bold uppercase tracking-[.1em] text-ma-charles">Option A — Download as zip (usually fastest)</div>
            <ol className="mt-2 list-decimal space-y-2 pl-5 text-sm leading-6 text-ma-slate">
              <li>In the left-hand toolbar of this Replit workspace, click the folder icon to open the <span className="font-bold text-ma-charles">Files</span> tool. If you don't see a folder icon, click the grid icon labeled <span className="font-bold text-ma-charles">All tools</span> (or use the search bar at the top) and open <span className="font-bold text-ma-charles">Files</span> from there.</li>
              <li>At the top of the Files panel, click the <span className="font-bold text-ma-charles">⋮</span> (three-dot) menu.</li>
              <li>Choose <span className="font-bold text-ma-charles">Download as zip</span>.</li>
              <li>Extract the zip on the Windows computer to a short, simple path — for example <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">C:\dev\workspace</code>. Avoid spaces or deeply nested folders.</li>
            </ol>
          </div>

          <div className="mt-3 max-w-2xl rounded-2xl border border-ma-fog bg-ma-cream/60 p-4">
            <div className="text-xs font-bold uppercase tracking-[.1em] text-ma-charles">Option B — Still no "Download as zip"? Zip it yourself</div>
            <p className="mt-2 text-sm leading-6 text-ma-slate">If your workspace has code export disabled, the Files menu won't show it. Open the <span className="font-bold text-ma-charles">Shell</span> tool the same way (folder icon's neighbor, or search "Shell"), then run:</p>
            <code className="mt-2 block overflow-x-auto rounded-xl bg-ma-charles px-3 py-2 font-mono text-[11px] leading-5 text-ma-cream">{workspaceLabZipFallbackCommand}</code>
            <p className="mt-2 text-sm leading-6 text-ma-slate">The <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">.git</code>, <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">.cache</code>, and <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">.local</code> folders hold version history and this environment's own tool caches — none of it is your code, and together it is usually several times larger than the code itself, which is why a manually zipped download can come out corrupted, refuse to open, or take forever. The leading <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">rm -f project.zip</code> also clears out any earlier attempt so it doesn't get zipped into itself and balloon in size. Then find <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">project.zip</code> in the Files panel and download it directly, and extract it as in Option A.</p>
          </div>

          <div className="mt-3 max-w-2xl rounded-2xl border border-ma-fog bg-ma-cream/60 p-4">
            <div className="text-xs font-bold uppercase tracking-[.1em] text-ma-charles">Option C — Prefer Git</div>
            <p className="mt-2 text-sm leading-6 text-ma-slate">Open the <span className="font-bold text-ma-charles">Git</span> tool (search "Git" from the top search bar), connect a GitHub repository, and push. Then on the Windows computer run <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">git clone &lt;your-repo-url&gt;</code> into a folder such as <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">C:\dev\workspace</code>.</p>
          </div>

          <p className="mt-4 max-w-2xl text-xs leading-5 text-ma-slate">Whichever option you use, the folder that directly contains <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">pnpm-workspace.yaml</code> is the repository folder the runner asks for below.</p>
        </section>

        <section className="mt-6 rounded-[2rem] border border-ma-fog bg-white/50 p-5 shadow-[0_20px_70px_rgba(39,93,113,.08)] md:p-8" aria-labelledby="session-heading">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">01 / session boundary</div>
              <h2 id="session-heading" className="mt-2 font-serif text-3xl tracking-[-.04em]">Open a protected lab session</h2>
              <p className="mt-2 max-w-xl text-sm leading-6 text-ma-slate">Sessions expire after 30 minutes. Pairing secrets are redeemed once and runner output is capped before it is retained.</p>
            </div>
            <button type="button" onClick={() => void ensureSession()} disabled={Boolean(session) || createSession.isPending || isLoadingSavedSession} className="inline-flex items-center gap-2 rounded-full bg-ma-charles px-5 py-3 text-sm font-bold text-ma-cream disabled:cursor-not-allowed disabled:opacity-50" data-testid="button-create-workspace-lab-session">
              {createSession.isPending || isLoadingSavedSession ? <Loader2 size={16} className="animate-spin" /> : <Laptop size={16} />}
              {session ? 'Session open' : isLoadingSavedSession ? 'Checking saved session' : sessionId ? 'Replace unavailable session' : 'Open lab session'}
            </button>
          </div>
          {sessionMessage && (
            <div className="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ma-copper/40 bg-ma-copper/10 p-4 text-sm leading-6 text-ma-charles" role="status" data-testid="status-workspace-lab-session">
              <span>{sessionMessage}</span>
              {!session && !isLoadingSavedSession && (
                <button type="button" onClick={() => void ensureSession()} disabled={createSession.isPending} className="rounded-full border border-ma-charles/30 px-3 py-1.5 text-xs font-bold hover:bg-ma-cream disabled:opacity-50">
                  Open a fresh session
                </button>
              )}
            </div>
          )}
          {session && (
            <div className="mt-6 grid gap-4 border-t border-ma-fog pt-6 md:grid-cols-[1fr_auto]">
              <div>

                <div className="font-mono text-[10px] uppercase tracking-[.16em] text-ma-slate">Pairing key</div>
                <code className="mt-2 block break-all rounded-xl bg-ma-charles px-4 py-3 font-mono text-sm text-ma-cream" data-testid="text-workspace-lab-pairing-key">{session.pairingCode}</code>
                <p className="mt-2 text-xs text-ma-slate">Use this key only on the {platform === 'windows' ? 'Windows' : 'Mac'} computer you control. It is not an API key and expires with this session.</p>
              </div>
              <div>
                <div className="flex items-start gap-2 text-sm font-semibold">
                  {session.runnerStatus === 'connected' ? <Wifi size={16} className="mt-0.5 text-ma-brick" /> : <WifiOff size={16} className="mt-0.5 text-ma-slate" />}
                  <span data-testid="text-workspace-lab-runner-status">
                    {session.runnerStatus === 'connected'
                      ? `${session.runnerName ?? `${platform === 'windows' ? 'Windows' : 'macOS'} runner`} connected`
                      : session.runnerStatus === 'offline'
                        ? `${session.runnerName ?? 'Paired runner'} disconnected`
                        : 'Runner waiting'}
                  </span>
                </div>
                <p className="mt-1 text-xs text-ma-slate" data-testid="text-workspace-lab-heartbeat-age">
                  Last heartbeat: {formatHeartbeatAge(session.lastSeenAt, Date.now())}
                </p>
                <p className="mt-1 text-xs text-ma-slate" data-testid="text-workspace-lab-queue-summary">
                  Queue: {session.jobs.filter((job) => job.status === 'queued').length} queued · {session.jobs.filter((job) => job.status === 'running').length} running
                </p>
              </div>
            </div>
          )}
          {session && (
            <div className="mt-5 rounded-xl border border-ma-fog bg-ma-cream/70 p-4" data-testid="workspace-lab-paired-setup-control">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-bold">{session.setupPaused ? 'Paired job claims paused' : 'Paired runner can claim queued jobs'}</div>
                  <p className="mt-1 text-xs leading-5 text-ma-slate">Pause before changing setup. An active suite finishes first. This controls only the Workspace Lab runner, not Replit Agent or an external @IT queue worker.</p>
                </div>
                <button type="button" onClick={() => void setPairedSetupPaused(!session.setupPaused)} disabled={updateSetupControl.isPending || (session.setupPaused && hasRunningPairedJob)} className="inline-flex items-center gap-2 rounded-full border border-ma-charles/20 bg-white px-4 py-2.5 text-xs font-bold disabled:opacity-50" data-testid="button-workspace-lab-paired-setup-control">
                  {session.setupPaused ? <Play size={14} /> : <Pause size={14} />}
                  {session.setupPaused ? pairedSetupChanged ? 'Apply setup & reconnect' : 'Resume paired runner' : 'Pause paired runner'}
                </button>
              </div>
              {pairedSetupMessage && <p className="mt-3 text-xs leading-5 text-ma-slate" role="status" data-testid="status-workspace-lab-setup-control">{pairedSetupMessage}</p>}
            </div>
          )}
          {session && (
            <div className="mt-6 max-w-xl border-t border-ma-fog pt-6">
              <label htmlFor="workspace-lab-repo-root" className="font-mono text-[10px] uppercase tracking-[.16em] text-ma-slate">Repository folder on the {platform === 'windows' ? 'Windows' : 'macOS'} computer</label>
              <input
                id="workspace-lab-repo-root"
                type="text"
                value={repoRootInput}
                onChange={(event) => { setRepoRootInput(event.target.value); markSetupEdited(); }}
                placeholder={platform === 'windows' ? 'e.g. C:\\OAIT\\project' : 'e.g. /Users/me/code/project'}
                spellCheck={false}
                disabled={setupLocked}
                className="mt-2 w-full rounded-xl border border-ma-fog bg-ma-cream px-4 py-3 font-mono text-sm text-ma-charles outline-none placeholder:text-ma-slate/60 focus:border-ma-brick"
                data-testid="input-workspace-lab-repo-root"
              />
               <p className="mt-2 text-xs leading-5 text-ma-slate">{setupLocked ? 'Pause both Workspace Lab runners and wait for active suites to finish before editing setup.' : 'Use the folder containing pnpm-workspace.yaml. Changed local setup requires restarting the paused native runner.'}</p>
            </div>
          )}
        </section>

         {platform === 'windows' && (
           <section id="windows-to-windows-host-controls" className="mt-6 rounded-[2rem] border border-ma-copper/40 bg-ma-copper/10 p-5 md:p-7" aria-labelledby="windows-host-heading" data-testid="windows-to-windows-host-controls">
             <div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">Native Windows host</div>
             <h2 id="windows-host-heading" className="mt-2 font-serif text-3xl tracking-[-.04em]">Pair another Windows computer</h2>
             <p className="mt-3 max-w-3xl text-sm leading-6 text-ma-slate">Install the bounded host launcher on the other Windows computer, then run one Windows runner here as the client. The host only exposes the allowlisted <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">/execute</code> probe; it does not accept arbitrary commands or change firewall rules.</p>
             <a href={windowsHostInstallerHref} download className="mt-4 inline-flex items-center gap-2 text-sm font-bold text-ma-brick underline underline-offset-4"><Download size={15} /> Download windows-host-install.ps1</a>
             <ol className="mt-4 grid gap-2 text-xs leading-5 text-ma-slate md:grid-cols-3">
               <li><span className="font-bold text-ma-charles">1.</span> Run the downloaded launcher from the checked-out repository on the other Windows computer.</li>
               <li><span className="font-bold text-ma-charles">2.</span> Copy the printed endpoint and one-time shared key into the fields below.</li>
               <li><span className="font-bold text-ma-charles">3.</span> Queue only “Windows-to-Windows host test” after the paired runner is online.</li>
             </ol>
             <div className="mt-5 grid gap-3 md:grid-cols-2">
               <label className="text-xs font-bold text-ma-charles">
                 Host endpoint
                 <input
                   type="url"
                   value={windowsInteropEndpoint}
                    onChange={(event) => { setWindowsInteropEndpoint(event.target.value); markSetupEdited(); }}
                   placeholder="http://OTHER-WINDOWS-HOST:8789"
                    disabled={setupLocked}
                    className="mt-2 w-full rounded-xl border border-ma-fog bg-ma-cream px-4 py-3 font-mono text-sm font-normal outline-none placeholder:text-ma-slate/60 focus:border-ma-brick disabled:opacity-60"
                   data-testid="input-windows-interop-endpoint"
                 />
               </label>
               <label className="text-xs font-bold text-ma-charles">
                 Host shared key
                 <input
                   type="password"
                   value={windowsInteropSharedKey}
                    onChange={(event) => { setWindowsInteropSharedKey(event.target.value); markSetupEdited(); }}
                   placeholder="Paste the key printed by the host"
                    disabled={setupLocked}
                    className="mt-2 w-full rounded-xl border border-ma-fog bg-ma-cream px-4 py-3 font-mono text-sm font-normal outline-none placeholder:text-ma-slate/60 focus:border-ma-brick disabled:opacity-60"
                   data-testid="input-windows-interop-shared-key"
                 />
               </label>
             </div>
             <p className="mt-3 text-xs leading-5 text-ma-slate">The key is included only in the copied Windows runner command, used for this bounded probe, and omitted from the uploaded packet. Use a reachable private network address and HTTPS or a protected network when this leaves a local test environment; the packet itself remains explicitly non-production evidence.</p>
           </section>
         )}

        <div className="mt-6 grid gap-6 lg:grid-cols-2">
          <section className="rounded-[2rem] border border-ma-fog bg-ma-cream/70 p-5 md:p-7" aria-labelledby="local-heading">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">02 / same laptop</div>
                <h2 id="local-heading" className="mt-2 font-serif text-3xl tracking-[-.04em]">Local runner</h2>
              </div>
              <span className={`rounded-full px-3 py-1 text-xs font-bold ${localStatus === 'online' ? 'bg-ma-fog text-ma-charles' : 'bg-ma-cream text-ma-slate'}`} data-testid="workspace-lab-local-runner-status">{localStatus === 'online' ? localRunnerPaused ? 'Paused' : 'Online' : localMessage === LOCAL_RUNNER_OUTDATED_MESSAGE ? 'Update needed' : 'Not detected'}</span>
            </div>
             <p className="mt-3 text-sm leading-6 text-ma-slate">Use this when the browser and native runner are on the same computer. Start the command below in a terminal, wait for the status to say Online, then choose a suite from this card. The browser sends only the selected allowlisted suite to <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">localhost:8787</code>.</p>
            {session && !hasRepoRoot && <p className="mt-3 rounded-xl border border-dashed border-ma-fog bg-ma-cream p-3 text-xs leading-5 text-ma-slate">Enter the repository folder to point the command at the runner that came with the checkout, or download the platform runner separately into the folder where you run it.</p>}
            <a href={runnerScriptHref} download className="mt-5 inline-flex items-center gap-2 text-sm font-bold text-ma-brick underline underline-offset-4"><Download size={15} /> Download {platform === 'windows' ? 'windows-runner.ps1' : 'macos-runner.sh'} separately</a>
            {session && <p className="mt-4 text-xs leading-5 text-ma-slate">Only needed if you'd rather run the script from somewhere other than the repository folder. Fill in the repository folder above and this command updates automatically; leaving it blank still works — the script will ask for that folder itself and install dependencies before it starts.</p>}
            {session && <div className="mt-2 flex gap-2"><code className="min-w-0 flex-1 overflow-x-auto rounded-xl bg-ma-charles px-3 py-3 font-mono text-[11px] leading-5 text-ma-cream">{localCommand}</code><button type="button" onClick={() => void copyText(localCommand)} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-ma-fog bg-ma-cream" aria-label="Copy local runner command">{copied ? <Check size={16} /> : <Clipboard size={16} />}</button></div>}
             {localSetupMessage && <p className="mt-3 text-xs leading-5 text-ma-slate" role="status">{localSetupMessage}</p>}
             {session && localStatus === 'offline' && localRunnerInstance.current !== null && !localRunnerStoppedConfirmed && (
               <div className="mt-4 rounded-xl border border-ma-copper/40 bg-ma-copper/10 p-4 text-xs leading-5 text-ma-charles" role="status">
                 The local runner was previously online, but its current state cannot be checked. Setup remains locked until you stop it in its terminal.
                 <button type="button" onClick={() => { setLocalRunnerStoppedConfirmed(true); setLocalSetupMessage('You confirmed the previous local runner was stopped. Restart with the refreshed command after changing setup.'); }} className="mt-3 block rounded-full border border-ma-charles/30 bg-white px-3 py-2 font-bold">I stopped the local runner</button>
               </div>
             )}
             {session && localStatus === 'online' && (
               <div className="mt-4 rounded-xl border border-ma-fog bg-white/60 p-4" data-testid="workspace-lab-local-setup-control">
                 <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="text-xs leading-5 text-ma-slate">{localRunnerPaused ? localSetupChanged ? 'Setup changed. Stop this paused runner and restart it with the refreshed command; an active suite finishes first.' : 'Local runner paused; active work will finish.' : 'Pause the local runner before changing setup.'}</div>
                   <button type="button" onClick={() => void setLocalSetupPaused(!localRunnerPaused)} disabled={localRunnerActive && localRunnerPaused} className="inline-flex items-center gap-2 rounded-full border border-ma-charles/20 bg-white px-3 py-2 text-xs font-bold disabled:opacity-50">
                     {localRunnerPaused ? <Play size={14} /> : <Pause size={14} />}
                     {localRunnerPaused ? 'Resume local runner' : 'Pause local runner'}
                   </button>
                 </div>
               </div>
             )}
            <div className="mt-5 space-y-2">
               {availableSuites.map((suite) => (
                    <button key={suite.id} type="button" onClick={() => void runLocal(suite.id)} disabled={!session || localStatus !== 'online' || localRunBusy || localRunnerPaused || localSetupChanged || (platform === 'windows' && (suite.id === 'macos-benchmark' || suite.id === 'windows-to-windows-interop')) || (platform === 'macos' && (suite.id === 'windows-benchmark' || suite.id === 'windows-to-windows-interop' || suite.id === 'resilience-stress'))} className="flex w-full items-center justify-between gap-3 rounded-xl border border-ma-fog bg-ma-cream px-4 py-3 text-left text-sm font-bold hover:border-ma-brick disabled:cursor-not-allowed disabled:opacity-50" data-testid={`button-local-${suite.id}`}>
                  <span>{suite.label}</span>{runningLocalSuite === suite.id ? <Loader2 size={15} className="animate-spin" aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
                </button>
              ))}
            </div>
            {runningLocalSuite ? (
              <div className="mt-4 space-y-3">
                <p className="rounded-xl border border-ma-fog bg-ma-cream p-3 text-xs leading-5 text-ma-slate" role="status" data-testid="status-workspace-lab-local-run">
                  Running {suiteLabel(runningLocalSuite)}. All local suite choices stay locked until it finishes.
                </p>
                {localProgress && (
                  <WorkspaceLabRunProgress
                    suiteLabel={suiteLabel(runningLocalSuite)}
                    elapsedMs={localProgress.payload?.elapsedMs ?? Date.now() - localProgress.startedAtMs}
                    phaseProgress={localRunnerPhaseProgress(localProgress.payload?.phaseProgress)}
                    lastActivityLabel={localProgress.connection === 'unavailable'
                      ? 'Live runner details are temporarily unavailable; waiting for the final result.'
                      : localProgress.payload?.lastOutputAt
                        ? `Runner responding · latest test output ${formatHeartbeatAge(localProgress.payload.lastOutputAt, Date.now())}.`
                        : localProgress.connection === 'connected'
                          ? 'Runner responding · no suite output received yet.'
                          : 'Connecting to live runner status.'}
                    testId="workspace-lab-local-run-progress"
                  />
                )}
              </div>
            ) : localRunnerActive ? (
              <p className="mt-4 rounded-xl border border-ma-copper/40 bg-ma-copper/10 p-3 text-xs leading-5 text-ma-charles" role="status" data-testid="status-workspace-lab-local-run">
                A suite is already running on this listened-to runner. Wait for it to finish before selecting another suite.
              </p>
            ) : localMessage ? (
              <p className="mt-4 rounded-xl border border-ma-fog bg-ma-cream p-3 text-xs leading-5 text-ma-slate" role="status" data-testid="status-workspace-lab-local-run">{localMessage}</p>
            ) : null}
            {localRunResult && (
              <section className="mt-4 rounded-2xl border border-ma-fog bg-white/70 p-4" aria-label="Latest local runner result" data-testid="workspace-lab-latest-local-result">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-mono text-[10px] uppercase tracking-[.14em] text-ma-brick">Latest local result</div>
                    <h3 className="mt-1 text-sm font-bold text-ma-charles">{suiteLabel(localRunResult.suite)}</h3>
                    <p className="mt-1 text-xs text-ma-slate">{localRunResult.host}{localRunResult.exitCode === undefined ? '' : ` · exit ${localRunResult.exitCode}`}</p>
                  </div>
                  <span className={`rounded-full px-3 py-1 text-xs font-bold ${localRunResult.status === 'passed' ? 'bg-ma-fog text-ma-charles' : 'bg-ma-brick/10 text-ma-brick'}`}>
                    {localRunResult.status === 'passed' ? 'Passed' : 'Failed'}
                  </span>
                </div>
                <p
                  className={`mt-2 text-xs ${localRunResult.saveStatus === 'unconfirmed' ? 'text-ma-brick' : 'text-ma-slate'}`}
                  role="status"
                  data-testid="workspace-lab-local-save-status"
                >
                  {localRunResult.saveStatus === 'saving'
                    ? 'Saving to Recent Results…'
                    : localRunResult.saveStatus === 'saved'
                      ? 'Saved to Recent Results and the audit archive.'
                      : 'Save not confirmed. Check Recent Results before rerunning.'}
                </p>
                {localRunResult.proofRejection ? (
                  <ResilienceProofRejectionNotice rejection={localRunResult.proofRejection} />
                ) : (
                  <WorkspaceLabJobResults
                    jobId="latest-local"
                    output={localRunResult.output}
                    outputTruncated={localRunResult.outputTruncated}
                  />
                )}
              </section>
            )}
          </section>

          <section className="rounded-[2rem] border border-ma-fog bg-ma-cream/70 p-5 md:p-7" aria-labelledby="paired-heading" data-testid="workspace-lab-paired-agent-controls">
            <div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">03 / paired agent</div>
            <h2 id="paired-heading" className="mt-2 font-serif text-3xl tracking-[-.04em]">Pair a {platform === 'windows' ? 'Windows' : 'macOS'} computer</h2>
             <p className="mt-3 text-sm leading-6 text-ma-slate">Use this when the native computer should wait for work from this room. Run the paired command on that computer, leave the terminal open, then click one suite here. The runner polls the coordinator, executes only that named suite, sends heartbeats while it works, and returns capped output.</p>
            {session ? (
              <>
                 <p className="mt-5 text-xs leading-5 text-ma-slate">Run the generated command as-is. Keep the terminal open; it will say when pairing succeeds and when each queued job finishes. If the command asks for a repository folder, enter the folder that directly contains <code className="rounded bg-ma-fog/60 px-1 py-0.5 font-mono">pnpm-workspace.yaml</code>.</p>
                <div className="mt-2 flex gap-2">
                  <code className="min-w-0 flex-1 overflow-x-auto rounded-xl bg-ma-charles px-3 py-3 font-mono text-[11px] leading-5 text-ma-cream">{pairedCommand}</code>
                  <button type="button" onClick={() => void copyText(pairedCommand)} className="grid h-11 w-11 shrink-0 place-items-center rounded-xl border border-ma-fog bg-ma-cream" aria-label="Copy paired runner command">{copied ? <Check size={16} /> : <Clipboard size={16} />}</button>
                </div>
                <div className="mt-5 space-y-2">
                   {availableSuites.map((suite) => (
                       <button key={suite.id} type="button" onClick={() => void queuePaired(suite.id)} disabled={queueJob.isPending || session.setupPaused || pairedSetupChanged || Boolean(session.jobs.find((job) => job.status === 'queued' || job.status === 'running')) || (platform === 'windows' && (suite.id === 'macos-benchmark' || (suite.id === 'windows-to-windows-interop' && !windowsInteropConfigured))) || (platform === 'macos' && (suite.id === 'windows-benchmark' || suite.id === 'windows-to-windows-interop' || suite.id === 'resilience-stress'))} className="flex w-full items-center justify-between gap-3 rounded-xl border border-ma-fog bg-ma-cream px-4 py-3 text-left text-sm font-bold hover:border-ma-brick disabled:cursor-not-allowed disabled:opacity-50" data-testid={`button-paired-${suite.id}`}>
                      <span>{suite.label}</span><Wifi size={15} />
                    </button>
                  ))}
                </div>
                 {activeJob && (
                    <div className="mt-3 space-y-3">
                      <p
                        className="rounded-xl border border-ma-fog bg-ma-cream p-3 text-xs leading-5 text-ma-slate"
                        role="status"
                        data-testid="status-workspace-lab-active-job"
                        data-queue-state={activeJobQueueState(activeJob, session.runnerStatus)}
                      >
                        {activeJobStatusMessage(activeJob, session.runnerStatus, session.runnerName)}
                      </p>
                      {activeJob.status === 'running' && (
                        <WorkspaceLabRunProgress
                          suiteLabel={suiteLabel(activeJob.suite)}
                          phaseProgress={parseWorkspaceLabResilienceProgress(activeJob.output ?? '')}
                          lastActivityLabel={`Paired runner heartbeat: ${formatHeartbeatAge(session.lastSeenAt, Date.now())}.`}
                          testId="workspace-lab-active-job-progress"
                        />
                      )}
                    </div>
                 )}
              </>
            ) : <p className="mt-6 rounded-xl border border-dashed border-ma-fog p-4 text-sm text-ma-slate">Open a lab session above to receive a pairing command.</p>}
          </section>
         </div>

         <section className="mt-6 rounded-2xl border border-ma-fog bg-ma-cream/60 p-5" aria-labelledby="workspace-troubleshooting-heading">
           <div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">If you get stuck</div>
           <h2 id="workspace-troubleshooting-heading" className="mt-2 font-serif text-2xl tracking-[-.04em]">Common first-run messages</h2>
           <dl className="mt-4 grid gap-3 md:grid-cols-3">
             {[
               ['Not detected / Offline', 'Keep the terminal command running, confirm the browser is on the same computer for Local runner, and check that port 8787 is free.'],
               ['Repository root missing', 'Point the field at the folder that contains pnpm-workspace.yaml. Do not point it at the downloaded zip or one folder above the checkout.'],
               ['Setup or PostgreSQL failed', 'Read the runner output, fix the named prerequisite, and run the same command again. A failed prerequisite stays visible as a failure.'],
             ].map(([title, detail]) => (
               <div key={title}>
                 <dt className="text-sm font-bold text-ma-charles">{title}</dt>
                 <dd className="mt-1 text-xs leading-5 text-ma-slate">{detail}</dd>
               </div>
             ))}
           </dl>
         </section>

         <section className="mt-6 rounded-[2rem] border border-ma-fog bg-ma-cream/70 p-5 md:p-7" aria-labelledby="upload-heading">
          <div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">04 / evidence file</div>
          <h2 id="upload-heading" className="mt-2 font-serif text-3xl tracking-[-.04em]">Run and upload a result file</h2>
          <p className="mt-3 max-w-2xl text-sm leading-6 text-ma-slate">Upload a text or JSON result from an existing {platform === 'windows' ? 'Windows' : 'macOS'} run. The room stores the file as a bounded result record; it does not treat an unavailable prerequisite as a pass.</p>
          <div className="mt-5 grid gap-3 md:grid-cols-[1fr_auto_auto]">
            <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-ma-fog bg-ma-cream px-4 py-3 text-sm font-semibold">
              <Upload size={16} /><span className="min-w-0 truncate">{uploadFile?.name ?? 'Choose a .json, .log, or .txt file'}</span>
              <input type="file" accept=".json,.log,.txt" className="sr-only" onChange={(event) => setUploadFile(event.target.files?.[0])} />
            </label>
            <select value={selectedSuite} onChange={(event) => setSelectedSuite(event.target.value as WorkspaceLabSuite)} className="rounded-xl border border-ma-fog bg-ma-cream px-3 py-3 text-sm">
               {availableSuites.map((suite) => <option key={suite.id} value={suite.id}>{suite.label}</option>)}
            </select>
            <button type="button" onClick={() => void uploadSelectedResult()} disabled={!sessionId || !uploadFile || uploadResult.isPending} className="rounded-xl bg-ma-charles px-5 py-3 text-sm font-bold text-ma-cream disabled:cursor-not-allowed disabled:opacity-50">Upload as {uploadStatus}</button>
          </div>
          <div className="mt-3 flex items-center gap-3 text-xs text-ma-slate">
            <label className="flex items-center gap-2"><input type="radio" checked={uploadStatus === 'passed'} onChange={() => setUploadStatus('passed')} /> Passed</label>
            <label className="flex items-center gap-2"><input type="radio" checked={uploadStatus === 'failed'} onChange={() => setUploadStatus('failed')} /> Failed</label>
          </div>
          {uploadMessage && (
            <p
              className={`mt-3 rounded-xl border p-3 text-xs leading-5 ${uploadMessage.status === 'error' ? 'border-ma-brick/40 bg-ma-brick/10 text-ma-brick' : 'border-ma-fog bg-white/60 text-ma-charles'}`}
              role={uploadMessage.status === 'error' ? 'alert' : 'status'}
              data-testid="workspace-lab-upload-message"
            >
              {uploadMessage.text}
            </p>
          )}
        </section>

        <section className="mt-6 rounded-[2rem] border border-ma-fog bg-ma-cream/70 p-5 md:p-7" aria-labelledby="history-heading">
          <div className="flex items-end justify-between gap-3">
            <div><div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">05 / bounded history</div><h2 id="history-heading" className="mt-2 font-serif text-3xl tracking-[-.04em]">Recent results</h2></div>
            <span className="text-xs text-ma-slate">{jobs.length}/20 retained in this session</span>
          </div>
          {reconciliationMessage && <p className="mt-4 rounded-xl border border-ma-copper/40 bg-ma-copper/10 p-3 text-sm text-ma-charles" role="status" data-testid="status-workspace-lab-reconciliation">{reconciliationMessage}</p>}
          <div className="mt-4 space-y-3">
            {jobs.length === 0 ? <div className="rounded-2xl border border-dashed border-ma-fog p-6 text-sm text-ma-slate">No results yet. Start one of the allowlisted checks or upload an existing result.</div> : jobs.slice().reverse().map((job) => {
              const resilienceRejection = resilienceProofRejectionFromResult(job.resultJson, job.output);
              return (
              <article key={job.id} className="rounded-2xl border border-ma-fog bg-white/50 p-4" data-testid={`workspace-lab-history-job-${job.id}`}>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div><div className="text-sm font-bold">{suiteLabel(job.suite)}</div><div className="mt-1 text-xs text-ma-slate">{job.source} · {job.host} · {new Date(job.createdAt).toLocaleString()}</div></div>
                  <span data-testid={`workspace-lab-job-status-${job.id}`} className={`rounded-full px-3 py-1 text-xs font-bold ${resilienceRejection ? 'bg-ma-brick text-ma-cream' : job.status === 'passed' || job.status === 'reconciled' ? 'bg-ma-fog text-ma-charles' : job.status === 'failed' ? 'bg-ma-brick/10 text-ma-brick' : 'bg-ma-cream text-ma-slate'}`}>{resilienceRejection ? 'Rejected as incomplete' : statusLabel(job.status)}</span>
                </div>
                 {parseCrossCompEvidencePacket(job.resultJson) && (
                   <CrossCompPacketSummary packet={parseCrossCompEvidencePacket(job.resultJson)!} />
                 )}
                 {resilienceRejection && (
                   <ResilienceProofRejectionNotice rejection={resilienceRejection} noticeId={`workspace-lab-resilience-rejection-${job.id}`} />
                 )}
                {job.recovery && (
                  <div className="mt-3 rounded-xl border border-ma-copper/40 bg-ma-copper/10 p-3 text-xs leading-5 text-ma-charles" data-testid={`workspace-lab-recovery-${job.id}`}>
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
                      <button type="button" onClick={() => void reconcileRecovery(job.id)} disabled={reconcileJob.isPending} className="mt-3 rounded-full bg-ma-charles px-4 py-2 text-xs font-bold text-ma-cream disabled:cursor-not-allowed disabled:opacity-50" data-testid={`button-reconcile-workspace-lab-job-${job.id}`}>
                        {reconcileJob.isPending ? 'Resolving…' : 'Resolve recovery record'}
                      </button>
                    ) : (
                      <p className="mt-2 font-semibold text-ma-charles">{job.status === 'reconciled' ? 'Resolved as reconciled from the bounded metadata.' : 'Resolved as failed from the bounded metadata.'}</p>
                    )}
                  </div>
                )}
                {job.output && !resilienceRejection && (
                  <WorkspaceLabJobResults jobId={job.id} output={job.output} outputTruncated={job.outputTruncated} />
                )}
              </article>
              );
            })}
          </div>
        </section>
      </main>
    </div>
  );
}
/*
export function WorkspaceLabPage() {
  const queryClient = useQueryClient();
  const [sessionId, setSessionId] = useState<string | undefined>(() => (
    typeof window === 'undefined' ? undefined : window.localStorage.getItem(SESSION_STORAGE_KEY) ?? undefined
  ));
  const [sessionMessage, setSessionMessage] = useState('');
  const [localStatus, setLocalStatus] = useState<'unknown' | 'online' | 'offline'>('unknown');
  const [localRunnerActive, setLocalRunnerActive] = useState(false);
  const [localRunnerPaused, setLocalRunnerPaused] = useState(false);
  const [localSetupChanged, setLocalSetupChanged] = useState(false);
  const [pairedSetupChanged, setPairedSetupChanged] = useState(false);
  const [setupControlMessage, setSetupControlMessage] = useState('');
  const [runningLocalSuite, setRunningLocalSuite] = useState<WorkspaceLabSuite | null>(null);
  const [localRunResult, setLocalRunResult] = useState<LocalRunResult | null>(null);
  const [localMessage, setLocalMessage] = useState('');
  const localRunLock = useRef(false);
  const [platform, setPlatform] = useState<LabPlatform>('windows');
  const [selectedSuite, setSelectedSuite] = useState<WorkspaceLabSuite>('oa-it-test');
  const [uploadStatus, setUploadStatus] = useState<'passed' | 'failed'>('passed');
  const [uploadFile, setUploadFile] = useState<File>();
  const [copied, setCopied] = useState(false);
  const [repoRootInput, setRepoRootInput] = useState('');
  const [reconciliationMessage, setReconciliationMessage] = useState('');
  const [windowsInteropEndpoint, setWindowsInteropEndpoint] = useState('');
  const [windowsInteropSharedKey, setWindowsInteropSharedKey] = useState('');

  const createSession = useCreateWorkspaceLabSession({
    mutation: {
      onSuccess: (createdSession) => {
        queryClient.setQueryData(['workspace-lab-session', createdSession.id], createdSession);
        setSessionId(createdSession.id);
        setSessionMessage('');
      },
      onError: () => {
        setSessionMessage('The protected session could not be opened. Check the connection and try again.');
      },
    },
  });
  const sessionQuery = useGetWorkspaceLabSession(sessionId ?? '', {
    query: {
      queryKey: ['workspace-lab-session', sessionId],
      enabled: Boolean(sessionId),
      refetchInterval: 1500,
      refetchIntervalInBackground: true,
      retry: (failureCount, error) => (
        !shouldDiscardWorkspaceLabSession(error) && failureCount < 2
      ),
    },
  });
  const queueJob = useQueueWorkspaceLabJob();
  const updateSetupControl = useUpdateWorkspaceLabSetupControl({
    mutation: {
      onSuccess: (updatedSession) => {
        queryClient.setQueryData(['workspace-lab-session', updatedSession.id], updatedSession);
      },
    },
  });
  const reconcileJob = useReconcileWorkspaceLabJob();
  const uploadResult = useUploadWorkspaceLabResult();
  const session = sessionQuery.data;
  // The session query polls while the runner is active. `isFetching` is true
  // during every background poll, so using it for the initial-session button
  // makes an already loaded session look permanently stuck on "Checking saved
  // session". Only the first request without cached data is a blocking load.
  const isLoadingSavedSession = Boolean(sessionId) && sessionQuery.isLoading;

  useEffect(() => {
    if (sessionId) {
      window.localStorage.setItem(SESSION_STORAGE_KEY, sessionId);
    } else {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    }
  }, [sessionId]);

  useEffect(() => {
    if (!sessionQuery.isError || !sessionId) return;
    if (shouldDiscardWorkspaceLabSession(sessionQuery.error)) {
      queryClient.removeQueries({ queryKey: ['workspace-lab-session', sessionId] });
      setSessionId(undefined);
      setSessionMessage('The saved lab session expired or is no longer available. Open a new session to continue.');
      return;
    }
    setSessionMessage('The saved lab session could not be refreshed. Its controls remain paused until the connection recovers or you open a new session.');
  }, [queryClient, sessionId, sessionQuery.error, sessionQuery.isError]);

  useEffect(() => {
    if (!session) return;
    const expiresAt = new Date(session.expiresAt).getTime();
    const remaining = expiresAt - Date.now();
    if (!Number.isFinite(expiresAt) || remaining <= 0) {
      queryClient.removeQueries({ queryKey: ['workspace-lab-session', session.id] });
      setSessionId(undefined);
      setSessionMessage('This lab session expired. Open a new session to continue.');
      return;
    }
    const timer = window.setTimeout(() => {
      queryClient.removeQueries({ queryKey: ['workspace-lab-session', session.id] });
      setSessionId(undefined);
      setSessionMessage('This lab session expired. Open a new session to continue.');
    }, Math.min(remaining + 250, 2_147_483_647));
    return () => window.clearTimeout(timer);
  }, [queryClient, session]);

  const hasRepoRoot = repoRootInput.trim().length > 0;
  const repoRootArg = repoRootInput.trim() || '<PATH-TO-YOUR-CLONED-REPO>';
  const availableSuites = platform === 'windows' ? suites : macosSuites;
  // windows-runner.ps1 is already committed inside the repository itself, at
  // scripts\workspace-lab\windows-runner.ps1 -- whichever way the user got
  // the code onto Windows (zip, git clone), that copy came with it. Once we
  // know the repository folder, point -File straight at it instead of
  // asking the user to separately download the script and move it into that
  // same folder by hand. Until the folder is filled in, fall back to the
  // download-and-run-from-here flow below, since there is nowhere else to
  // point.
  const runnerScriptArg = platform === 'windows'
    ? (hasRepoRoot ? `${repoRootArg}\\scripts\\workspace-lab\\windows-runner.ps1` : '.\\windows-runner.ps1')
    : (hasRepoRoot ? `${repoRootArg}/scripts/workspace-lab/macos-runner.sh` : './macos-runner.sh');
  const runnerScriptHref = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/workspace-lab/${platform === 'windows' ? 'windows-runner.ps1' : 'macos-runner.sh'}`;
  const windowsHostInstallerHref = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/workspace-lab/windows-host-install.ps1`;
  const windowsInteropConfigured = windowsInteropEndpoint.trim().length > 0
    && windowsInteropSharedKey.trim().length >= 16;
  const pairedCommand = useMemo(() => {
    if (!session) return '';
    const windowsInteropArgs = platform === 'windows' && windowsInteropEndpoint.trim() && windowsInteropSharedKey.trim()
      ? ` -WindowsInteropEndpoint "${windowsInteropEndpoint.trim()}" -WindowsInteropSharedKey "${windowsInteropSharedKey.trim()}"`
      : '';
    return platform === 'windows'
      ? `powershell -ExecutionPolicy Bypass -File "${runnerScriptArg}" -ApiBaseUrl "${window.location.origin}/api" -PairingCode "${session.pairingCode}" -RepoRoot "${repoRootArg}"${windowsInteropArgs}`
      : `bash "${runnerScriptArg}" --api-base-url "${window.location.origin}/api" --pairing-code "${session.pairingCode}" --repo-root "${repoRootArg}"`;
  }, [session, runnerScriptArg, repoRootArg, platform, windowsInteropEndpoint, windowsInteropSharedKey]);
  const localCommand = useMemo(() => {
    if (!session) return '';
    return platform === 'windows'
      ? `powershell -ExecutionPolicy Bypass -File "${runnerScriptArg}" -LocalToken "${session.pairingCode}" -RepoRoot "${repoRootArg}"`
      : `bash "${runnerScriptArg}" --local-token "${session.pairingCode}" --repo-root "${repoRootArg}"`;
  }, [session, runnerScriptArg, repoRootArg, platform]);

  useEffect(() => {
    if (!session?.pairingCode) return;
    let mounted = true;
    const checkLocalRunner = () => {
      void fetch(localRunnerUrl('/health'), { headers: { 'X-Workspace-Lab-Token': session.pairingCode } })
        .then(async (response) => {
          const payload = response.ok
            ? await response.json() as { active?: unknown; setupPaused?: unknown }
            : undefined;
          if (mounted) {
            setLocalStatus(response.ok ? 'online' : 'offline');
            setLocalRunnerActive(response.ok && payload?.active === true);
            setLocalRunnerPaused(response.ok && payload?.setupPaused === true);
            if (response.ok && payload?.active !== true) {
              setLocalMessage((message) => message === LOCAL_RUNNER_BUSY_MESSAGE ? '' : message);
            }
          }
        })
        .catch(() => {
          if (mounted) {
            setLocalStatus('offline');
            setLocalRunnerActive(false);
          }
        });
    };
    checkLocalRunner();
    const interval = window.setInterval(checkLocalRunner, 4000);
    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, [session?.pairingCode]);

  async function copyText(value: string) {
    await navigator.clipboard?.writeText(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  }

  async function ensureSession() {
    if (session) return session;
    if (createSession.isPending) return undefined;
    if (sessionId) {
      queryClient.removeQueries({ queryKey: ['workspace-lab-session', sessionId] });
      setSessionId(undefined);
    }
    setSessionMessage('');
    try {
      return await createSession.mutateAsync();
    } catch {
      return undefined;
    }
  }

  async function runLocal(suite: WorkspaceLabSuite) {
    if (localRunLock.current || localRunnerActive) return;
    localRunLock.current = true;
    setRunningLocalSuite(suite);
    setLocalMessage('');
    try {
      const readySession = session ?? await ensureSession();
      if (!readySession?.id || !readySession.pairingCode) {
        setLocalMessage(`The protected session could not be prepared. Retry it before starting the ${platform === 'windows' ? 'Windows' : 'macOS'} runner.`);
        return;
      }
      const response = await fetch(localRunnerUrl('/run'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workspace-Lab-Token': readySession.pairingCode,
        },
        body: JSON.stringify({ suite }),
      });
      const payload = await response.json() as {
        status?: string;
        output?: string;
        outputTruncated?: boolean;
        resultJson?: string;
        exitCode?: number;
        host?: string;
        error?: string;
      };
      if (response.status === 409) {
        setLocalStatus('online');
        setLocalRunnerActive(true);
        setLocalMessage(LOCAL_RUNNER_BUSY_MESSAGE);
        return;
      }
      if (!response.ok) throw new Error(payload.error ?? 'The local runner rejected the check.');

      const output = payload.output ?? '';
      const resultJson = payload.resultJson;
      const proofRejection = resilienceProofRejectionFromResult(resultJson, output);
      const status = payload.status === 'passed' ? 'passed' : 'failed';
      const host = payload.host ?? `Local ${platform === 'windows' ? 'Windows' : 'macOS'} runner`;
      const outputTruncated = payload.outputTruncated ?? false;
      setLocalRunResult({
        suite,
        status,
        output,
        outputTruncated,
        resultJson,
        exitCode: payload.exitCode,
        host,
        proofRejection,
      });
      uploadResult.mutate({
        sessionId: readySession.id,
        data: {
          suite,
          status,
          source: 'local',
          output,
          outputTruncated,
          resultJson,
          exitCode: payload.exitCode,
          host,
        },
      });
      setLocalMessage(`${suiteLabel(suite)} finished. The concise result and copy/expand controls are below.`);
      setLocalStatus('online');
      setLocalRunnerActive(false);
    } catch (error) {
      setLocalStatus('offline');
      setLocalRunnerActive(false);
      setLocalMessage(error instanceof Error ? error.message : 'The local runner is unavailable.');
    } finally {
      localRunLock.current = false;
      setRunningLocalSuite(null);
    }
  }

  async function queuePaired(suite: WorkspaceLabSuite) {
    const readySession = session ?? await ensureSession();
    if (!readySession?.id) return;
    queueJob.mutate({ sessionId: readySession.id, data: { suite } });
  }

  async function setPairedSetupPaused(paused: boolean) {
    if (!session || updateSetupControl.isPending) return;
    const applyingChangedSetup = !paused && pairedSetupChanged;
    setSetupControlMessage('');
    try {
      await updateSetupControl.mutateAsync({
        sessionId: session.id,
        data: { paused, setupChanged: applyingChangedSetup },
      });
      if (applyingChangedSetup) {
        setPairedSetupChanged(false);
        setSetupControlMessage('Setup applied. The old runner pairing and queued work were invalidated. Start the refreshed command and queue a new run from the beginning.');
      } else {
        setSetupControlMessage(paused
          ? 'New paired jobs are paused. A suite already running will finish before setup fields unlock.'
          : 'The existing paired runner can claim queued work again.');
      }
    } catch {
      setSetupControlMessage('The paired runner state could not be changed. If a suite is running, wait for it to finish before resuming or applying setup.');
    }
  }

  async function setLocalSetupPaused(paused: boolean) {
    if (!session) return;
    if (!paused && localSetupChanged) {
      setSetupControlMessage('The local runner remains paused because it cannot adopt changed settings in place. Stop it in its terminal, then start the updated local command.');
      return;
    }
    setSetupControlMessage('');
    try {
      const response = await fetch(localRunnerUrl('/setup-control'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Workspace-Lab-Token': session.pairingCode,
        },
        body: JSON.stringify({ paused }),
      });
      const payload = await response.json().catch(() => ({})) as { paused?: unknown; error?: unknown };
      if (!response.ok) {
        throw new Error(typeof payload.error === 'string' ? payload.error : 'The local runner control was rejected.');
      }
      setLocalRunnerPaused(payload.paused === true);
      setSetupControlMessage(paused
        ? 'New local suite requests are paused. A suite already running will finish before setup fields unlock.'
        : 'The existing local runner resumed with its current setup.');
    } catch (error) {
      setSetupControlMessage(error instanceof Error
        ? error.message
        : 'The local runner could not be controlled. Confirm it is online and running the current runner script.');
    }
  }

  function confirmLocalRunnerRestarted() {
    if (localStatus !== 'online' || localRunnerPaused || localRunnerActive) return;
    setLocalSetupChanged(false);
    setSetupControlMessage('The refreshed local runner is confirmed. It will use the current setup values.');
  }

  function markSetupEdited() {
    setPairedSetupChanged(true);
    if (localStatus === 'online') setLocalSetupChanged(true);
    setSetupControlMessage('');
  }

  async function uploadSelectedResult() {
    if (!sessionId || !uploadFile) return;
    const raw = await uploadFile.text();
    const outputTruncated = raw.length > MAX_WORKSPACE_LAB_OUTPUT_LENGTH;
    const output = outputTruncated
      ? `${raw.slice(0, MAX_WORKSPACE_LAB_OUTPUT_LENGTH - OUTPUT_TRUNCATION_MARKER.length)}${OUTPUT_TRUNCATION_MARKER}`
      : raw;
    uploadResult.mutate({
      sessionId,
      data: {
        suite: selectedSuite,
        status: uploadStatus,
        output,
        outputTruncated,
        resultJson: uploadFile.name.toLowerCase().endsWith('.json') ? raw.slice(0, 120000) : undefined,
        host: 'Uploaded result',
      },
    });
  }

  async function reconcileRecovery(jobId: string) {
    if (!sessionId || reconcileJob.isPending) return;
    setReconciliationMessage('');
    try {
      await reconcileJob.mutateAsync({ sessionId, jobId });
      await sessionQuery.refetch();
      setReconciliationMessage('The recovery record was resolved and remains in this session history.');
    } catch {
      setReconciliationMessage('The recovery record could not be resolved. Refresh the session and try again.');
    }
  }

  const jobs = session?.jobs ?? [];
  const activeJob = jobs.find((job) => job.status === 'queued' || job.status === 'running');
  const hasRunningPairedJob = jobs.some((job) => job.status === 'running');
  const pairedSetupSafe = Boolean(session?.setupPaused && !hasRunningPairedJob);
  const localSetupSafe = localStatus === 'offline'
    || (localStatus === 'online' && localRunnerPaused && !localRunnerActive);
  const setupLocked = !pairedSetupSafe || !localSetupSafe;
  const localRunBusy = runningLocalSuite !== null || localRunnerActive;

  return (
    <div className="min-h-[100dvh] bg-ma-cream text-ma-charles">
      <header className="border-b border-ma-fog bg-ma-cream/90 px-5 py-5 backdrop-blur md:px-10">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-5">
            <Brand size="compact" />
            <PrivateRoomNav active="workspace" />
          </div>
          <Link href="/workspace" className="text-xs font-bold text-ma-slate hover:text-ma-brick">Back to Workspace</Link>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-5 py-10 md:px-10 md:py-16">
        <div className="max-w-3xl">
          <div className="font-mono text-[10px] uppercase tracking-[.2em] text-ma-brick">@IT / Workspace Lab</div>
           <h1 className="mt-4 font-serif text-5xl leading-[.95] tracking-[-.06em] md:text-7xl">Run native checks from the room.</h1>
           <p className="mt-6 max-w-2xl text-base leading-7 text-ma-slate">Use the same bounded scripts already in the repository. Choose Windows or macOS, then connect a runner on that computer, pair it through a short-lived queue, or upload a retained result. The browser never sends arbitrary shell or PowerShell.</p>
        </div>

         <section className="mt-8 rounded-2xl border border-ma-fog bg-white/60 p-5 md:p-6" aria-labelledby="workspace-start-here">
           <div className="font-mono text-[10px] uppercase tracking-[.18em] text-ma-brick">Start here</div>
           <h2 id="workspace-start-here" className="mt-2 font-serif text-2xl tracking-[-.04em]">The beginner path</h2>
           <div className="mt-4 grid gap-3 md:grid-cols-3">
             {[
               ['1. Choose the computer', 'Select Windows or macOS, then use that computer for the download, checkout, and runner command.'],
               ['2. Open one session', 'Create a protected session here. Its pairing key is short-lived and only authorizes this lab session.'],
               ['3. Run or upload', 'Start the runner, wait for Online, and choose a suite. If you already ran a check, upload its bounded .json, .log, or .txt result instead.'],
             ].map(([title, detail]) => (
               <div key={title} className="rounded-xl border border-ma-fog bg-ma-cream/70 p-4">
                 <div className="text-sm font-bold text-ma-charles">{title}</div>
                 <p className="mt-2 text-xs leading-5 text-ma-slate">{detail}</p>
               </div>
             ))}
           </div>
           <p className="mt-4 text-xs leading-5 text-ma-slate"><strong className="text-ma-charles">Which mode should I use?</strong> Choose Local runner when the browser and checkout are on the same computer. Choose Paired runner when the native computer should poll this room for a queued job. Use Upload when execution happened elsewhere or the computer cannot connect back.</p>
         </section>

          <div className="mt-8 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-ma-fog bg-ma-paper p-5" data-testid="workspace-lab-checklist-link">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[.16em] text-ma-brick">Completion checklist</div>
              <p className="mt-2 text-sm leading-6 text-ma-slate">Track the full Replit and Windows test plan from the Workspace home.</p>
            </div>
            <Link
              href="/workspace#workspace-completion-checklist"
              className="rounded-full bg-ma-charles px-4 py-2.5 text-xs font-bold text-ma-cream transition-colors hover:bg-ma-brick focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ma-brick"
              data-testid="link-workspace-full-checklist"
            >
              Open full checklist
            </Link>
          </div>

          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-ma-brick/25 bg-ma-copper/10 p-5" data-testid="workspace-lab-cross-comp-lab-link">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[.16em] text-ma-brick">Cross-Comp Lab</div>
              <p className="mt-2 text-sm leading-6 text-ma-slate">Run the full paired hand-off between this Replit workspace and a named Windows or macOS host, including packet exchange. The Cross-Comp interoperability suite below runs a bounded rehearsal here; open Cross-Comp Lab for the complete reciprocal workflow.</p>
            </div>
            <Link href="/workspace/cross-comp-lab" className="rounded-full bg-ma-brick px-4 py-2.5 text-xs font-bold text-ma-cream transition-colors hover:bg-ma-charles" data-testid="link-workspace-lab-cross-comp-lab">Open Cross-Comp Lab</Link>
          </div>
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4 rounded-2xl border border-ma-fog bg-ma-paper p-5" data-testid="workspace-lab-host-lab-link">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[.16em] text-ma-brick">Host Lab</div>
              <p className="mt-2 text-sm leading-6 text-ma-slate">Set up a Windows 10 desktop listener, send a synthetic task from a Windows laptop, and review the test limits before opening the runner controls.</p>
            </div>
            <Link href="/workspace/host-lab" className="rounded-full border border-ma-fog bg-white px-4 py-2.5 text-xs font-bold text-ma-charles hover:border-ma-brick" data-testid="link-workspace-lab-host-lab">Open Host Lab</Link>
          </div>
          <div className="mt-8 flex flex-wrap gap-2" role="group" aria-label="Runner platform">
            {(['windows', 'macos'] as const).map((candidate) => (
              <button key={candidate} type="button" onClick={() => { if (candidate === platform) return; setPlatform(candidate); setSelectedSuite('oa-it-test'); setLocalMessage(''); if (session) markSetupEdited(); }} disabled={localRunBusy || (Boolean(session) && setupLocked)} className={`rounded-full border px-4 py-2 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-50 ${platform === candidate ? 'border-ma-charles bg-ma-charles text-ma-cream' : 'border-ma-fog bg-white/50 text-ma-slate'}`} aria-pressed={platform === candidate} data-testid={`button-runner-platform-${candidate}`}>
                {candidate === 'windows' ? 'Windows' : 'macOS'}
              </button>
            ))}
          </div>
*/
