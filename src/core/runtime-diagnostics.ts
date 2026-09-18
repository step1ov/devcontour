export interface RuntimeDiagnostics {
  startedAt: string;
  finishedAt: string;
  lastOutputAt: string | null;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  aborted: boolean;
  stdoutTail: string;
  stderrTail: string;
  processTree?: {
    available: boolean;
    reason?: string;
    processes: { pid: number; parentPid: number; groupPid: number; name: string }[];
  };
}
