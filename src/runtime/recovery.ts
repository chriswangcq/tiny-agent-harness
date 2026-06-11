import type {
  RuntimeProcessKind,
  RuntimeProcessRecord,
  RuntimeProcessStatus,
} from "./process-registry.js";

export type RuntimeRecoverySnapshot = {
  schemaVersion: 1;
  recoveredAt: string;
  eventOffset: number;
  totalProcesses: number;
  processesByStatus: Record<RuntimeProcessStatus, number>;
  processesByKind: Record<RuntimeProcessKind, number>;
  activeProcessIds: string[];
  terminalProcessIds: string[];
};

const PROCESS_STATUSES: RuntimeProcessStatus[] = [
  "planned",
  "starting",
  "running",
  "stopping",
  "exited",
  "crashed",
];

const PROCESS_KINDS: RuntimeProcessKind[] = [
  "run",
  "terminal-host",
  "pty-session",
  "mcp-server",
  "codeq-host",
  "model-gateway",
];

export function buildRuntimeRecoverySnapshot(input: {
  processes: readonly RuntimeProcessRecord[];
  recoveredAt: string;
  eventOffset: number;
}): RuntimeRecoverySnapshot {
  const processesByStatus = Object.fromEntries(
    PROCESS_STATUSES.map((status) => [status, 0]),
  ) as Record<RuntimeProcessStatus, number>;
  const processesByKind = Object.fromEntries(
    PROCESS_KINDS.map((kind) => [kind, 0]),
  ) as Record<RuntimeProcessKind, number>;
  const activeProcessIds: string[] = [];
  const terminalProcessIds: string[] = [];

  for (const process of input.processes) {
    processesByStatus[process.status] += 1;
    processesByKind[process.kind] += 1;
    if (
      process.status === "planned" ||
      process.status === "starting" ||
      process.status === "running" ||
      process.status === "stopping"
    ) {
      activeProcessIds.push(process.id);
    } else {
      terminalProcessIds.push(process.id);
    }
  }

  activeProcessIds.sort();
  terminalProcessIds.sort();

  return {
    schemaVersion: 1,
    recoveredAt: input.recoveredAt,
    eventOffset: input.eventOffset,
    totalProcesses: input.processes.length,
    processesByStatus,
    processesByKind,
    activeProcessIds,
    terminalProcessIds,
  };
}
