// Worker handoff evidence contract.
// Pure domain — no runtime, no IO, no side effects.
//
// Defines the typed schema, parser/validator/normalizer for worker handoff
// evidence that every coder/QA final report must include.
//
// Accepts input from IM/outbox/report text or structured objects.
// The parser and validator are pure functions with explicit text/snapshot input.

/**
 * Individual gate execution result.
 */
export type GateResult = "PASS" | "FAIL" | "NOT_RUN";

/**
 * Overall handoff verdict.
 */
export type HandoffVerdict = "PASS" | "FAIL";

/**
 * Merge recommendation from QA review.
 */
export type MergeRecommendation = "approve" | "reject" | "needs_review";

/**
 * Status of the child ledger that tracks this ticket.
 */
export type LedgerStatus = "open" | "closed" | "missing";

/**
 * Structured worker handoff evidence.
 *
 * Every coder/QA final report must provide this evidence before
 * the master can evaluate merge gates.
 */
export type WorkerHandoffEvidence = {
  /** Unique child ledger identifier for this ticket. */
  childLedgerId: string;

  /** Current status of the child ledger. */
  childLedgerStatus: LedgerStatus;

  /** Git commit hash at the time of handoff. */
  commit: string | null;

  /** Git branch used for the work. */
  branch: string;

  /** Absolute path to the workspace. */
  workspace: string;

  /** Files changed, added, or removed in this work. */
  changedFiles: string[];

  /** Commands that were executed as gates (e.g. typecheck, build, test). */
  commands: string[];

  /** Per-gate pass/fail status. Key is the gate/command name. */
  gates: Record<string, GateResult>;

  /** Overall PASS/FAIL verdict across all required gates. */
  overallResult: HandoffVerdict;

  /** Human-readable residual risk assessment. */
  residualRisk: string;

  /** Merge recommendation from the QA/worker. */
  mergeRecommendation: MergeRecommendation;

  /** Optional ISO-8601 timestamp of the handoff. */
  timestamp?: string;

  /** Optional identifier of the reviewer (coder or QA role). */
  reviewer?: string;
};

/**
 * Validation error for handoff evidence.
 */
export type HandoffValidationError = {
  field: string;
  message: string;
};

/**
 * Result of validating handoff evidence.
 */
export type HandoffValidationResult = {
  valid: boolean;
  errors: HandoffValidationError[];
};

/**
 * Known gate names that every handoff should report.
 */
export const REQUIRED_GATES = [
  "typecheck",
  "build",
  "test",
] as const;

/**
 * Default commands that map to the required gates.
 */
export const DEFAULT_GATE_COMMANDS: Record<string, string> = {
  typecheck: "npm run typecheck",
  build: "npm run build",
  test: "npm test",
};

// --- Normalizer ---

/**
 * Normalize raw input into a structured WorkerHandoffEvidence.
 *
 * Accepts both a structured partial object and plain text (e.g. from
 * IM/outbox/report). Text parsing is best-effort line-oriented extraction.
 *
 * This is a pure function — no runtime, no IO.
 */
export function normalizeWorkerHandoffEvidence(
  input: Partial<WorkerHandoffEvidence> | string,
): WorkerHandoffEvidence {
  if (typeof input === "string") {
    return parseHandoffText(input);
  }
  return normalizeHandoffObject(input);
}

/**
 * Normalize a partial structured object into full evidence with defaults.
 */
export function normalizeHandoffObject(
  partial: Partial<WorkerHandoffEvidence>,
): WorkerHandoffEvidence {
  return {
    childLedgerId: partial.childLedgerId ?? "",
    childLedgerStatus: normalizeLedgerStatus(partial.childLedgerStatus),
    commit: partial.commit ?? null,
    branch: partial.branch ?? "",
    workspace: partial.workspace ?? "",
    changedFiles: Array.isArray(partial.changedFiles) ? [...partial.changedFiles] : [],
    commands: Array.isArray(partial.commands) ? [...partial.commands] : [],
    gates: normalizeGates(partial.gates),
    overallResult: normalizeVerdict(partial.overallResult),
    residualRisk: partial.residualRisk ?? "",
    mergeRecommendation: normalizeMergeRecommendation(partial.mergeRecommendation),
    timestamp: partial.timestamp ?? undefined,
    reviewer: partial.reviewer ?? undefined,
  };
}

function normalizeLedgerStatus(raw: unknown): LedgerStatus {
  if (raw === "open" || raw === "closed" || raw === "missing") return raw;
  return "missing";
}

function normalizeVerdict(raw: unknown): HandoffVerdict {
  if (raw === "PASS") return "PASS";
  return "FAIL";
}

function normalizeMergeRecommendation(raw: unknown): MergeRecommendation {
  if (raw === "approve" || raw === "reject" || raw === "needs_review") return raw;
  return "needs_review";
}

function normalizeGateResult(raw: unknown): GateResult {
  if (raw === "PASS" || raw === "FAIL" || raw === "NOT_RUN") return raw;
  return "NOT_RUN";
}

function normalizeGates(raw: unknown): Record<string, GateResult> {
  if (typeof raw !== "object" || raw === null) return {};
  const gates: Record<string, GateResult> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    gates[key] = normalizeGateResult(value);
  }
  return gates;
}

// --- Text Parser ---

/**
 * Parse handoff evidence from free-form text (IM message, outbox report, etc.).
 *
 * Best-effort line-oriented extraction. Recognises key-value pairs and
 * section markers. Fallback to defaults for any missing fields.
 */
export function parseHandoffText(text: string): WorkerHandoffEvidence {
  const evidence: Partial<WorkerHandoffEvidence> = {
    changedFiles: [],
    commands: [],
    gates: {},
  };

  const lines = text.split("\n");
  let currentSection = "";

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line === "") continue;

    // Section headers
    const sectionMatch = line.match(/^#+\s*(.+?)\s*:?\s*$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].toLowerCase();
      continue;
    }

    // Explicit key: value pairs
    const kvMatch = line.match(/^(\w[\w\s]*?)\s*:\s*(.+?)\s*$/);
    if (kvMatch) {
      const key = kvMatch[1].toLowerCase().trim();
      const value = kvMatch[2].trim();
      applyKV(evidence, key, value);
      continue;
    }

    // Bullet items for lists
    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      const item = bulletMatch[1].trim();
      if (currentSection.includes("file") || currentSection.includes("change")) {
        evidence.changedFiles = [...(evidence.changedFiles ?? []), item];
      } else if (currentSection.includes("command") || currentSection.includes("gate")) {
        evidence.commands = [...(evidence.commands ?? []), item];
      }
    }
  }

  return normalizeHandoffObject(evidence);
}

function applyKV(
  evidence: Partial<WorkerHandoffEvidence>,
  key: string,
  value: string,
): void {
  switch (key) {
    case "child ledger id":
    case "childledgerid":
    case "ledger id":
    case "ledger":
    case "child ledger":
      evidence.childLedgerId = value;
      break;
    case "child ledger status":
    case "ledger status":
    case "status":
      evidence.childLedgerStatus = parseLedgerStatus(value);
      break;
    case "commit":
    case "commit hash":
      evidence.commit = value === "none" || value === "missing" ? null : value;
      break;
    case "branch":
      evidence.branch = value;
      break;
    case "workspace":
      evidence.workspace = value;
      break;
    case "overall result":
    case "overall":
    case "result":
      evidence.overallResult = value.toUpperCase() === "PASS" ? "PASS" : "FAIL";
      break;
    case "residual risk":
    case "risk":
    case "residual risks":
      evidence.residualRisk = value;
      break;
    case "merge recommendation":
    case "merge":
    case "recommendation":
      evidence.mergeRecommendation = normalizeMergeRecommendation(value.toLowerCase());
      break;
    case "timestamp":
    case "time":
      evidence.timestamp = value;
      break;
    case "reviewer":
    case "reviewed by":
    case "coder":
    case "qa":
      evidence.reviewer = value;
      break;
    case "gate":
    case "gates": {
      // Attempt to parse gate results from a compact format like "typecheck:PASS build:FAIL"
      const gatePairs = value.split(/\s+/);
      for (const pair of gatePairs) {
        const [gateName, gateResult] = pair.split(":");
        if (gateName && gateResult) {
          evidence.gates = {
            ...(evidence.gates ?? {}),
            [gateName.trim()]: normalizeGateResult(gateResult.trim().toUpperCase()),
          };
        }
      }
      break;
    }
    default:
      // Unknown keys are silently ignored
      break;
  }
}

function parseLedgerStatus(value: string): LedgerStatus {
  const lowered = value.toLowerCase().trim();
  if (lowered === "open") return "open";
  if (lowered === "closed") return "closed";
  return "missing";
}

// --- Validator ---

/**
 * Validate handoff evidence and return structured results.
 *
 * Pure function — evaluates the snapshot of evidence against the
 * required contract. Does not look at runtime state.
 */
export function validateHandoffEvidence(
  evidence: WorkerHandoffEvidence,
): HandoffValidationResult {
  const errors: HandoffValidationError[] = [];

  // childLedgerId must be non-empty
  if (!evidence.childLedgerId || evidence.childLedgerId.trim() === "") {
    errors.push({
      field: "childLedgerId",
      message: "Child ledger ID is required",
    });
  }

  // childLedgerStatus must be "closed"
  if (evidence.childLedgerStatus !== "closed") {
    errors.push({
      field: "childLedgerStatus",
      message: `Child ledger must be closed. Current status: ${evidence.childLedgerStatus}`,
    });
  }

  // commit must be present (non-null, non-empty)
  if (!evidence.commit || evidence.commit.trim() === "") {
    errors.push({
      field: "commit",
      message: "Commit hash is required (stale or missing commit)",
    });
  }

  // branch must be non-empty
  if (!evidence.branch || evidence.branch.trim() === "") {
    errors.push({
      field: "branch",
      message: "Branch is required",
    });
  }

  // workspace must be non-empty
  if (!evidence.workspace || evidence.workspace.trim() === "") {
    errors.push({
      field: "workspace",
      message: "Workspace path is required",
    });
  }

  // At least one changed file should be listed
  if (evidence.changedFiles.length === 0) {
    errors.push({
      field: "changedFiles",
      message: "At least one changed file must be listed",
    });
  }

  // Required gates must be present
  for (const gate of REQUIRED_GATES) {
    if (!(gate in evidence.gates)) {
      errors.push({
        field: `gates.${gate}`,
        message: `Required gate "${gate}" is missing`,
      });
    }
  }

  // If any required gate is FAIL, overallResult should be FAIL
  let anyRequiredFail = false;
  for (const gate of REQUIRED_GATES) {
    if (evidence.gates[gate] === "FAIL") {
      anyRequiredFail = true;
      break;
    }
  }
  if (anyRequiredFail && evidence.overallResult === "PASS") {
    errors.push({
      field: "overallResult",
      message: "Overall result is PASS but at least one required gate failed",
    });
  }

  // overallResult is required
  if (!evidence.overallResult) {
    errors.push({
      field: "overallResult",
      message: "Overall result is required (PASS or FAIL)",
    });
  }

  // residualRisk must be non-empty
  if (!evidence.residualRisk || evidence.residualRisk.trim() === "") {
    errors.push({
      field: "residualRisk",
      message: "Residual risk assessment is required",
    });
  }

  // mergeRecommendation is required
  if (!evidence.mergeRecommendation) {
    errors.push({
      field: "mergeRecommendation",
      message: "Merge recommendation is required (QA must provide one)",
    });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

// --- Evidence-driven gate evaluation ---

/**
 * Convert handoff evidence into a subset of MasterReviewChecklist gates
 * that can be auto-filled from the evidence alone.
 *
 * This bridges worker handoff evidence with the existing merge-protocol
 * gate evaluation without requiring runtime actions.
 */
export type EvidenceDerivedGates = {
  workerReported: boolean;
  runCompleted: boolean;
  typecheckPasses: boolean;
  buildPasses: boolean;
  testsPass: boolean;
  workerRanGates: boolean;
};

/**
 * Derive merge-protocol checklist gates from handoff evidence.
 *
 * Pure function. The output can be merged into an existing
 * MasterReviewChecklist or used standalone.
 */
export function deriveGatesFromEvidence(
  evidence: WorkerHandoffEvidence,
): EvidenceDerivedGates {
  return {
    workerReported: evidence.childLedgerId !== "" && evidence.childLedgerStatus !== "missing",
    runCompleted: evidence.childLedgerStatus === "closed",
    typecheckPasses: evidence.gates["typecheck"] === "PASS",
    buildPasses: evidence.gates["build"] === "PASS",
    testsPass: evidence.gates["test"] === "PASS",
    workerRanGates: Object.keys(evidence.gates).length > 0,
  };
}

// --- Summary helper ---

/**
 * Produce a human-readable summary of handoff evidence.
 *
 * Suitable for IM reporting, outbox, or TUI display.
 */
export function summarizeHandoffEvidence(
  evidence: WorkerHandoffEvidence,
): string {
  const lines: string[] = [
    `Child Ledger: ${evidence.childLedgerId} (${evidence.childLedgerStatus})`,
    `Commit: ${evidence.commit ?? "MISSING"}`,
    `Branch: ${evidence.branch}`,
    `Workspace: ${evidence.workspace}`,
    `Overall: ${evidence.overallResult}`,
  ];

  if (evidence.changedFiles.length > 0) {
    lines.push(`Changed Files (${evidence.changedFiles.length}):`);
    for (const f of evidence.changedFiles) {
      lines.push(`  - ${f}`);
    }
  }

  lines.push(`Gates:`);
  for (const [gate, result] of Object.entries(evidence.gates)) {
    lines.push(`  ${gate}: ${result}`);
  }

  lines.push(`Residual Risk: ${evidence.residualRisk}`);
  lines.push(`Merge Recommendation: ${evidence.mergeRecommendation}`);

  if (evidence.reviewer) {
    lines.push(`Reviewer: ${evidence.reviewer}`);
  }

  return lines.join("\n");
}
