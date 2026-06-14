import {
  createRuntimeProcess,
  markProcessRunning,
  type RuntimeProcessCommand,
  type RuntimeProcessOwner,
  type RuntimeProcessRecord,
} from "./process-registry.js";

export type AgentRunProcessOwner = Extract<
  RuntimeProcessOwner,
  | { scope: "project" }
  | { scope: "run" }
  | { scope: "team-member" }
>;

export type RunProcessIdInput = {
  runId: string;
  owner: AgentRunProcessOwner;
};

export type CreateRunProcessRecordInput = RunProcessIdInput & {
  processId?: string;
  command: RuntimeProcessCommand;
  now: string;
  parentProcessId?: string;
  statePath?: string;
  logPath?: string;
  metadata?: Record<string, string | number | boolean | null>;
};

export function runProcessId(input: RunProcessIdInput): string {
  assertOwnerMatchesRun(input);
  if (input.owner.scope === "team-member") {
    return `team-member-run:${input.owner.teamId}:${input.owner.memberId}:${input.runId}`;
  }
  return `run:${input.runId}`;
}

export function createRunProcessRecord(
  input: CreateRunProcessRecordInput,
): RuntimeProcessRecord {
  return createRuntimeProcess({
    id: input.processId ?? runProcessId(input),
    kind: "run",
    owner: input.owner,
    command: input.command,
    now: input.now,
    parentProcessId: input.parentProcessId,
    statePath: input.statePath,
    logPath: input.logPath,
    metadata: input.metadata,
  });
}

export function markRunProcessRunning(
  input: CreateRunProcessRecordInput & { pid: number; startedAt: string },
): RuntimeProcessRecord {
  return markProcessRunning(createRunProcessRecord(input), {
    pid: input.pid,
    now: input.startedAt,
  });
}

function assertOwnerMatchesRun(input: RunProcessIdInput): void {
  if (input.owner.scope === "run" && input.owner.runId !== input.runId) {
    throw new Error(
      `Invalid run process owner: owner runId ${input.owner.runId} does not match ${input.runId}`,
    );
  }
  if (
    input.owner.scope === "team-member" &&
    input.owner.runId !== input.runId
  ) {
    throw new Error(
      `Invalid team-member run process owner: owner runId ${input.owner.runId} does not match ${input.runId}`,
    );
  }
}
