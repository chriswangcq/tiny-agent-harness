// ─── Team Dashboard View Model ────────────────────────────────────
//
// Pure function that accepts team/contact/task/run/merge/QA summary
// domain data and produces structured rows/sections/selection suitable
// for TUI rendering.
//
// No IO. No side effects. No runtime. Observer/control surface only.

import type { SubAgentTeamSummary } from "../subagent/team.js";
import type { ContactRegistrySummary } from "../subagent/contact-registry.js";
import type { MasterReviewChecklist } from "../subagent/merge-protocol.js";

// ─── Input Types ──────────────────────────────────────────────────

/** Minimal run summary for dashboard display. */
export type TeamDashboardRun = {
  runId: string;
  workerId: string;
  status: "created" | "running" | "waiting_for_model" | "waiting_for_io" | "finished" | "cancelled" | "failed";
  branch?: string;
  error?: string;
};

/** Pure input for the team dashboard view model builder. */
export type TeamDashboardInput = {
  teamSummary: SubAgentTeamSummary;
  contactRegistrySummary: ContactRegistrySummary;
  runSummaries: TeamDashboardRun[];
  mergeChecklist: MasterReviewChecklist | null;
  /** Optional human-readable QA summary text */
  qaSummary?: string;
  supervisorLifecycle?: SupervisorLifecycleInput;
};

// ─── Output Types ─────────────────────────────────────────────────

export type DashboardRowStatus = "ok" | "warn" | "error" | "info" | "pending";

export type TeamDashboardRow = {
  text: string;
  status: DashboardRowStatus;
  /** Optional key for selection/navigation */
  key?: string;
};

export type TeamDashboardSectionKind =
  | "team-overview"
  | "contact-roster"
  | "active-tasks"
  | "run-status"
  | "merge-qa"
  | "supervisor-lifecycle";

export type TeamDashboardSection = {
  kind: TeamDashboardSectionKind;
  title: string;
  rows: TeamDashboardRow[];
  /** Selection info for TUI pane navigation */
  selectable: boolean;
};

export type TeamDashboardSelection = {
  sectionIndex: number;
  rowIndex: number;
  selectedKey?: string;
};

export type TeamDashboardFailureSummary = {
  totalFailures: number;
  totalWarnings: number;
  failingItems: string[];
  warningItems: string[];
};

export type TeamDashboardViewModel = {
  title: string;
  sections: TeamDashboardSection[];
  rows: TeamDashboardRow[];
  selection: TeamDashboardSelection;
  statusCounts: Record<string, number>;
  failureSummary: TeamDashboardFailureSummary;
};

// ─── Redaction ────────────────────────────────────────────────────

const REDACT_PATTERNS: Array<[RegExp, string]> = [
  // API keys: sk-..., ak-..., key-...
  [/\b(sk|ak|key|token|secret)[-=_][a-zA-Z0-9_\.\-]{6,}/gi, "[REDACTED]"],
  // Bearer tokens
  [/\bBearer\s+[a-zA-Z0-9_\-\.]+\b/gi, "Bearer [REDACTED]"],
  // Long hex strings (potential secrets)
  [/\b[a-fA-F0-9]{32,}\b/g, "[REDACTED]"],
  // Workspace paths ending with token-like segments
  [/\/[a-zA-Z0-9_\-]{20,}\b/g, "/[REDACTED-PATH]"],
];

/**
 * Display-only redaction for dashboard text.
 * Removes secrets and sensitive data before rendering.
 * Must NOT be used on runtime prompt/model context.
 */
export function redactDashboardDisplay(text: string): string {
  let result = text;
  for (const [pattern, replacement] of REDACT_PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

// ─── Status Helpers ───────────────────────────────────────────────

function contactStatusRowStatus(
  status: string,
): DashboardRowStatus {
  switch (status) {
    case "active":
    case "idle":
      return "ok";
    case "stale":
    case "offline":
      return "warn";
    case "terminated":
      return "error";
    default:
      return "pending";
  }
}

function taskStatusRowStatus(
  status: string,
): DashboardRowStatus {
  switch (status) {
    case "succeeded":
      return "ok";
    case "running":
    case "assigned":
      return "info";
    case "queued":
      return "pending";
    case "failed":
      return "error";
    case "cancelled":
      return "warn";
    default:
      return "pending";
  }
}

function runStatusRowStatus(
  status: TeamDashboardRun["status"],
): DashboardRowStatus {
  switch (status) {
    case "finished":
      return "ok";
    case "running":
    case "waiting_for_model":
    case "waiting_for_io":
      return "info";
    case "created":
      return "pending";
    case "failed":
      return "error";
    case "cancelled":
      return "warn";
    default:
      return "pending";
  }
}

// ─── Section Builders ─────────────────────────────────────────────

function buildTeamOverviewSection(
  team: SubAgentTeamSummary,
): TeamDashboardSection {
  const rows: TeamDashboardRow[] = [
    { text: `Team: ${team.teamId}`, status: "info" },
    { text: `Total Tasks: ${team.totalTasks}`, status: "info" },
    { text: `Total Workers: ${team.totalWorkers}`, status: "info" },
  ];

  // Task status breakdown
  for (const [status, count] of Object.entries(team.tasksByStatus ?? {})) {
    rows.push({
      text: `  Tasks ${status}: ${count}`,
      status: taskStatusRowStatus(status),
    });
  }

  // Worker status breakdown
  for (const [status, count] of Object.entries(team.workersByStatus ?? {})) {
    rows.push({
      text: `  Workers ${status}: ${count}`,
      status: contactStatusRowStatus(status),
    });
  }

  return {
    kind: "team-overview",
    title: "Team Overview",
    rows,
    selectable: true,
  };
}

function buildContactRosterSection(
  summary: ContactRegistrySummary,
): TeamDashboardSection {
  const rows: TeamDashboardRow[] = [
    { text: `Total Contacts: ${summary.totalWorkers}`, status: "info" },
  ];

  for (const [status, count] of Object.entries(summary.workersByStatus ?? {})) {
    rows.push({
      text: `  ${status}: ${count}`,
      status: contactStatusRowStatus(status),
    });
  }

  if (summary.activeWorkers && summary.activeWorkers.length > 0) {
    rows.push({ text: "Active Workers:", status: "info" });
    for (const worker of summary.activeWorkers) {
      const displayId = worker.workerId ?? "unknown";
      const displayRole = worker.role ? ` (${worker.role})` : "";
      rows.push({
        text: `  ${displayId}${displayRole}`,
        status: "ok",
        key: `worker:${displayId}`,
      });
    }
  }

  return {
    kind: "contact-roster",
    title: "Contact Roster",
    rows,
    selectable: true,
  };
}

function buildActiveTasksSection(
  team: SubAgentTeamSummary,
): TeamDashboardSection {
  const rows: TeamDashboardRow[] = [];

  if (team.activeAssignments && team.activeAssignments.length > 0) {
    rows.push({ text: `Active Assignments: ${team.activeAssignments.length}`, status: "info" });
    for (const assignment of team.activeAssignments) {
      rows.push({
        text: `  ${assignment.taskId} → ${assignment.workerId}`,
        status: "info",
        key: `task:${assignment.taskId}`,
      });
    }
  } else {
    rows.push({ text: "No active assignments", status: "info" });
  }

  return {
    kind: "active-tasks",
    title: "Active Tasks",
    rows,
    selectable: true,
  };
}

function buildRunStatusSection(
  runs: TeamDashboardRun[],
): TeamDashboardSection {
  const rows: TeamDashboardRow[] = [
    { text: `Total Runs: ${runs.length}`, status: "info" },
  ];

  for (const run of runs) {
    let text = `${run.workerId}: ${run.status}`;
    if (run.branch) text += ` [${run.branch}]`;
    if (run.error) text += ` error=${run.error}`;

    rows.push({
      text: `  ${text}`,
      status: runStatusRowStatus(run.status),
      key: `run:${run.runId}`,
    });
  }

  if (runs.length === 0) {
    rows.push({ text: "  No runs", status: "info" });
  }

  return {
    kind: "run-status",
    title: "Run Status",
    rows,
    selectable: true,
  };
}

function buildMergeQaSection(
  checklist: MasterReviewChecklist,
  qaSummary?: string,
): TeamDashboardSection {
  const rows: TeamDashboardRow[] = [];

  if (qaSummary) {
    rows.push({ text: `QA: ${qaSummary}`, status: "info" });
  }

  // Show each boolean gate as PASS/FAIL
  const gateEntries: Array<[string, boolean]> = [
    ["workerReported", checklist.workerReported],
    ["runCompleted", checklist.runCompleted],
    ["typecheckPasses", checklist.typecheckPasses],
    ["buildPasses", checklist.buildPasses],
    ["testsPass", checklist.testsPass],
    ["noConflicts", checklist.noConflicts],
    ["rebasedOnMain", checklist.rebasedOnMain],
    ["diffReviewable", checklist.diffReviewable],
    ["noRevertOfOthers", checklist.noRevertOfOthers],
    ["workerRanGates", checklist.workerRanGates],
    ["codeReviewed", checklist.codeReviewed],
  ];

  for (const [gate, passed] of gateEntries) {
    const gateResult = passed ? "PASS" : "FAIL";
    const gateStatus: DashboardRowStatus = passed ? "ok" : "error";
    rows.push({
      text: `  ${gate}: ${gateResult}`,
      status: gateStatus,
      key: `gate:${gate}`,
    });
  }

  // Overall: all must pass
  const allPassed = gateEntries.every(([, p]) => p);
  rows.push({
    text: `Overall: ${allPassed ? "PASS" : "FAIL"}`,
    status: allPassed ? "ok" : "error",
  });

  return {
    kind: "merge-qa",
    title: "Merge / QA",
    rows,
    selectable: true,
  };
}
// ─── Aggregation Helpers ──────────────────────────────────────────

function collectStatusCounts(
  sections: TeamDashboardSection[],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const section of sections) {
    for (const row of section.rows) {
      counts[row.status] = (counts[row.status] ?? 0) + 1;
    }
  }
  return counts;
}

function buildFailureSummary(
  sections: TeamDashboardSection[],
): TeamDashboardFailureSummary {
  const failingItems: string[] = [];
  const warningItems: string[] = [];
  let totalFailures = 0;
  let totalWarnings = 0;

  for (const section of sections) {
    for (const row of section.rows) {
      if (row.status === "error") {
        totalFailures++;
        failingItems.push(`[${section.title}] ${row.text}`);
      } else if (row.status === "warn") {
        totalWarnings++;
        warningItems.push(`[${section.title}] ${row.text}`);
      }
    }
  }

  return { totalFailures, totalWarnings, failingItems, warningItems };
}

function flattenRows(
  sections: TeamDashboardSection[],
): TeamDashboardRow[] {
  const rows: TeamDashboardRow[] = [];
  for (const section of sections) {
    // Section header
    rows.push({
      text: `── ${section.title} ──`,
      status: "info",
      key: `section:${section.kind}`,
    });
    // Section rows
    for (const row of section.rows) {
      rows.push({ ...row });
    }
  }
  return rows;
}

// ─── Main Builder ─────────────────────────────────────────────────

/**
 * Build the team dashboard view model from explicit typed inputs.
 *
 * Pure function — no IO, no side effects, no runtime coupling.
 * This is an observer/control surface, NOT a second orchestrator.
 *
 * Does NOT start workers, NOT bypass review, NOT change PTY rows/cols.
 */
export function buildTeamDashboardViewModel(
  input: TeamDashboardInput,
): TeamDashboardViewModel {
  const sections: TeamDashboardSection[] = [];

  sections.push(buildTeamOverviewSection(input.teamSummary));
  sections.push(buildContactRosterSection(input.contactRegistrySummary));
  sections.push(buildActiveTasksSection(input.teamSummary));
  sections.push(buildRunStatusSection(input.runSummaries));

  if (input.supervisorLifecycle) {
    sections.push(
      buildSupervisorLifecycleSection(input.supervisorLifecycle),
    );
  }

  if (input.mergeChecklist) {
    sections.push(
      buildMergeQaSection(input.mergeChecklist, input.qaSummary),
    );
  }

  const rows = flattenRows(sections);
  const selection: TeamDashboardSelection = { sectionIndex: 0, rowIndex: 0 };
  const statusCounts = collectStatusCounts(sections);
  const failureSummary = buildFailureSummary(sections);

  return {
    title: "Team Dashboard",
    sections,
    rows,
    selection,
    statusCounts,
    failureSummary,
  };
}

// ─── Supervisor Lifecycle Input Types ────────────────────────────

export interface SupervisorLeaseItem {
  leaseId: string;
  holder: string;
  resource: string;
  acquiredAt: string;
  expiresAt: string;
  renewedAt?: string;
  status: "active" | "expired" | "released";
}

export interface StaleRunItem {
  workerId: string;
  runId?: string;
  lastHeartbeat?: string;
  ageMs: number;
  reason: string;
}

export type ShutdownPhase = "active" | "draining" | "shutting_down" | "stopped";

export interface SupervisorLifecycleInput {
  leases: SupervisorLeaseItem[];
  heartbeatCadenceMs: number;
  staleRuns: StaleRunItem[];
  shutdownPhase: ShutdownPhase;
  dryRun: boolean;
  recoveryReady: boolean;
}

// ─── Supervisor Lifecycle Section Builder ─────────────────────────

function buildSupervisorLifecycleSection(
  input: SupervisorLifecycleInput,
): TeamDashboardSection {
  const rows: TeamDashboardRow[] = [];

  // Leases section
  rows.push({ text: `Leases (${input.leases.length}):`, status: "info" });
  for (const lease of input.leases) {
    const leaseStatus: DashboardRowStatus =
      lease.status === "active" ? "ok" :
      lease.status === "expired" ? "error" : "warn";
    rows.push({
      text: `  ${lease.leaseId}: ${lease.holder}/${lease.resource} [${lease.status}]`,
      status: leaseStatus,
      key: `lease:${lease.leaseId}`,
    });
  }
  if (input.leases.length === 0) {
    rows.push({ text: "  No active leases", status: "info" });
  }

  // Heartbeat cadence
  const cadenceSec = (input.heartbeatCadenceMs / 1000).toFixed(0);
  rows.push({ text: `Heartbeat Cadence: ${cadenceSec}s`, status: "info" });

  // Stale runs
  rows.push({
    text: `Stale Runs: ${input.staleRuns.length}`,
    status: input.staleRuns.length > 0 ? "warn" : "ok",
  });
  for (const stale of input.staleRuns) {
    const ageSec = (stale.ageMs / 1000).toFixed(0);
    rows.push({
      text: `  ${stale.workerId}: ${stale.reason} (${ageSec}s old)`,
      status: "error",
      key: `stale:${stale.workerId}`,
    });
  }

  // Dry run flag
  rows.push({
    text: `Dry Run: ${input.dryRun ? "ON" : "OFF"}`,
    status: input.dryRun ? "warn" : "info",
  });

  // Shutdown phase
  const shutdownStatus: DashboardRowStatus =
    input.shutdownPhase === "active" ? "ok" :
    input.shutdownPhase === "stopped" ? "error" :
    "warn";
  rows.push({
    text: `Shutdown Phase: ${input.shutdownPhase}`,
    status: shutdownStatus,
  });

  // Recovery readiness
  rows.push({
    text: `Recovery Ready: ${input.recoveryReady ? "YES" : "NO"}`,
    status: input.recoveryReady ? "ok" : "warn",
  });

  return {
    kind: "supervisor-lifecycle",
    title: "Supervisor Lifecycle",
    rows,
    selectable: true,
  };
}
