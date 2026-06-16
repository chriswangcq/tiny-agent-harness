import type {
  RuntimeProcessKind,
  RuntimeProcessRecord,
  RuntimeProcessStatus,
} from "./process-registry.js";
import {
  RUNTIME_PROCESS_KINDS,
  RUNTIME_PROCESS_STATUSES,
  isRuntimeProcessKind,
  isRuntimeProcessStatus,
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

export function buildRuntimeRecoverySnapshot(input: {
  processes: readonly RuntimeProcessRecord[];
  recoveredAt: string;
  eventOffset: number;
}): RuntimeRecoverySnapshot {
  const processesByStatus = Object.fromEntries(
    RUNTIME_PROCESS_STATUSES.map((status) => [status, 0]),
  ) as Record<RuntimeProcessStatus, number>;
  const processesByKind = Object.fromEntries(
    RUNTIME_PROCESS_KINDS.map((kind) => [kind, 0]),
  ) as Record<RuntimeProcessKind, number>;
  const activeProcessIds: string[] = [];
  const terminalProcessIds: string[] = [];
  let totalProcesses = 0;

  for (const process of input.processes) {
    if (
      !isRuntimeProcessKind(process.kind) ||
      !isRuntimeProcessStatus(process.status)
    ) {
      continue;
    }
    totalProcesses += 1;
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
    totalProcesses,
    processesByStatus,
    processesByKind,
    activeProcessIds,
    terminalProcessIds,
  };
}
