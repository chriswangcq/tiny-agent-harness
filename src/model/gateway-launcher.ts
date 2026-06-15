import type { ModelPort } from "../run/orchestrator.js";
import type { RunSupervisor } from "../runtime/run-supervisor.js";
import { createModelGatewayPort } from "./gateway.js";
import { requestModelGatewaySocket } from "./gateway-client.js";
import {
  launchResidentSocketHost,
  type LaunchedResidentSocketHost,
} from "../runtime/resident-host.js";

export type LaunchedModelGateway = {
  model: ModelPort;
  processId: string;
  socketPath: string;
  dispose: () => Promise<void>;
};

export type LaunchModelGatewayInput = {
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

export async function launchModelGateway(
  input: LaunchModelGatewayInput,
): Promise<LaunchedModelGateway> {
  const launched = await launchResidentSocketHost({
    supervisor: input.supervisor,
    kind: "model-gateway",
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
      requestTimeoutMs: input.requestTimeoutMs ?? 120_000,
    },
  });
  const timeoutMs = input.requestTimeoutMs ?? 120_000;

  return {
    model: createModelGatewayPort({
      transport: {
        request: (request) =>
          requestModelGatewaySocket({
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
  input: LaunchModelGatewayInput,
  launched: LaunchedResidentSocketHost,
): Promise<void> {
  await requestModelGatewaySocket({
    socketPath: launched.socketPath,
    timeoutMs: input.requestTimeoutMs ?? 120_000,
    request: {
      schemaVersion: 1,
      id: input.newRequestId(),
      type: "model.shutdown",
      reason: "run_shutdown",
    },
  });
}
