import type {
  RunSupervisor,
} from "../runtime/run-supervisor.js";
import {
  launchResidentSocketHost,
  type LaunchedResidentSocketHost,
} from "../runtime/resident-host.js";

export type LaunchedCodeIntelHost = LaunchedResidentSocketHost;

export type LaunchCodeIntelHostInput = {
  supervisor: Pick<RunSupervisor, "startProcess">;
  processId: string;
  owner: { scope: "run"; runId: string };
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  socketPath: string;
  workspaceRoot: string;
  statePath?: string;
  logPath?: string;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  nowEpochMs?: () => number;
  wait?: (ms: number) => Promise<void>;
  isSocketReady?: (socketPath: string) => boolean;
};

export async function launchCodeIntelHost(
  input: LaunchCodeIntelHostInput,
): Promise<LaunchedCodeIntelHost> {
  return await launchResidentSocketHost({
    supervisor: input.supervisor,
    kind: "codeq-host",
    processId: input.processId,
    owner: input.owner,
    executable: input.executable,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    socketPath: input.socketPath,
    statePath: input.statePath,
    logPath: input.logPath,
    startupTimeoutMs: input.startupTimeoutMs,
    pollIntervalMs: input.pollIntervalMs,
    nowEpochMs: input.nowEpochMs,
    wait: input.wait,
    isSocketReady: input.isSocketReady,
    metadata: {
      workspaceRoot: input.workspaceRoot,
    },
  });
}
