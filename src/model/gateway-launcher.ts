import * as fs from "node:fs";
import * as path from "node:path";
import type { ModelPort } from "../run/orchestrator.js";
import type { RunSupervisor } from "../runtime/run-supervisor.js";
import { createModelGatewayPort } from "./gateway.js";
import { ChildProcessModelGatewayTransport } from "./gateway-transport.js";

export type LaunchedModelGateway = {
  model: ModelPort;
  processId: string;
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
  statePath?: string;
  logPath?: string;
  requestTimeoutMs?: number;
  newRequestId: () => string;
};

export function launchModelGateway(
  input: LaunchModelGatewayInput,
): LaunchedModelGateway {
  const { child } = input.supervisor.startProcess({
    processId: input.processId,
    kind: "model-gateway",
    owner: input.owner,
    executable: input.executable,
    args: input.args,
    cwd: input.cwd,
    env: input.env,
    statePath: input.statePath,
    logPath: input.logPath,
    stdio: ["pipe", "pipe", "pipe"],
    metadata: {
      runId: input.owner.runId,
    },
  });

  if (input.logPath && child.stderr) {
    fs.mkdirSync(path.dirname(input.logPath), { recursive: true });
    child.stderr.pipe(fs.createWriteStream(input.logPath, { flags: "a" }));
  }

  const transport = new ChildProcessModelGatewayTransport(
    child,
    input.requestTimeoutMs,
  );

  return {
    model: createModelGatewayPort({
      transport,
      newRequestId: input.newRequestId,
    }),
    processId: input.processId,
    dispose: () => transport.shutdown("run_shutdown"),
  };
}
