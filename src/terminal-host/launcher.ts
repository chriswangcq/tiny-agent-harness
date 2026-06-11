import type { TerminalPort } from "../run/orchestrator.js";
import type { RunSupervisor } from "../runtime/run-supervisor.js";
import { createTerminalHostRunPort } from "./client.js";
import { ChildProcessTerminalHostTransport } from "./process-transport.js";
import * as fs from "node:fs";
import * as path from "node:path";

export type LaunchedTerminalHost = {
  terminal: TerminalPort;
  processId: string;
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
  statePath?: string;
  logPath?: string;
  requestTimeoutMs?: number;
  newRequestId: () => string;
};

export function launchTerminalHost(
  input: LaunchTerminalHostInput,
): LaunchedTerminalHost {
  const { child } = input.supervisor.startProcess({
    processId: input.processId,
    kind: "terminal-host",
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

  const transport = new ChildProcessTerminalHostTransport(
    child,
    input.requestTimeoutMs,
  );

  return {
    terminal: createTerminalHostRunPort({
      transport,
      newRequestId: input.newRequestId,
    }),
    processId: input.processId,
    dispose: () => transport.shutdown("run_shutdown"),
  };
}
