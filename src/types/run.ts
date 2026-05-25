// ---------------------------------------------------------------------------
// Run-level types (placeholder for orchestrator state machine)
// ---------------------------------------------------------------------------

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type RunId = string;
