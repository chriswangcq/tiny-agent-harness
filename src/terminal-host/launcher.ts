import type { TerminalPort } from "../run/orchestrator.js";
import type { RunSupervisor } from "../runtime/run-supervisor.js";
import {
  createTerminalHostRunPort,
  requestTerminalHostSocket,
} from "./client.js";
import {
  launchResidentSocketHost,
  type LaunchedResidentSocketHost,
} from "../runtime/resident-host.js";

export type LaunchedTerminalHost = {
  terminal: TerminalPort;
  processId: string;
  socketPath: string;
  dispose: () => Promise<void>;
};

export type LaunchTerminalHostInput = {
  supervisor: Pick<RunSupervisor, "startProcess">;
  processId: string;
  owner: { scope: "run"; runId: string };
  executable: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  socketPath: string;
  statePath?: string;
  logPath?: string;
  requestTimeoutMs?: number;
  startupTimeoutMs?: number;
  pollIntervalMs?: number;
  nowEpochMs?: () => number;
  wait?: (ms: number) => Promise<void>;
  isSocketReady?: (socketPath: string) => boolean;
  newRequestId: () => string;
};

export async function launchTerminalHost(
  input: LaunchTerminalHostInput,
): Promise<LaunchedTerminalHost> {
  const launched = await launchResidentSocketHost({
    supervisor: input.supervisor,
    kind: "terminal-host",
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
      defaultSession: "default",
    },
  });
  const timeoutMs = input.requestTimeoutMs ?? 30_000;

  return {
    terminal: createTerminalHostRunPort({
      transport: {
        request: (request) =>
          requestTerminalHostSocket({
            socketPath: input.socketPath,
            request,
            timeoutMs,
          }),
      },
      newRequestId: input.newRequestId,
    }),
    processId: input.processId,
    socketPath: input.socketPath,
    dispose: async () => {
      await requestShutdown(input, launched).catch(() => undefined);
      await launched.dispose();
    },
  };
}

async function requestShutdown(
  input: LaunchTerminalHostInput,
  launched: LaunchedResidentSocketHost,
): Promise<void> {
  await requestTerminalHostSocket({
    socketPath: launched.socketPath,
    timeoutMs: input.requestTimeoutMs ?? 30_000,
    request: {
      schemaVersion: 1,
      id: input.newRequestId(),
      type: "terminal.shutdown",
      reason: "run_shutdown",
    },
  });
}
