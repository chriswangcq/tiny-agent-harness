import { describe, expect, it } from "vitest";
import {
  normalizeWorkerHandoffEvidence,
  normalizeHandoffObject,
  parseHandoffText,
  validateHandoffEvidence,
  deriveGatesFromEvidence,
  summarizeHandoffEvidence,
  REQUIRED_GATES,
  DEFAULT_GATE_COMMANDS,
  type WorkerHandoffEvidence,
  type HandoffValidationResult,
  type GateResult,
  type HandoffVerdict,
  type MergeRecommendation,
  type LedgerStatus,
  type EvidenceDerivedGates,
} from "../src/subagent/worker-handoff-evidence.js";

// --- Test helpers ---

function makeEvidence(
  overrides: Partial<WorkerHandoffEvidence> = {},
): WorkerHandoffEvidence {
  return normalizeHandoffObject({
    childLedgerId: "p6-06-test",
    childLedgerStatus: "closed",
    commit: "abc123def456",
    branch: "codex/p6/06-worker-handoff-contract",
    workspace: "/tmp/test-workspace",
    changedFiles: ["src/subagent/worker-handoff-evidence.ts"],
    commands: ["npm run typecheck", "npm run build", "npm test"],
    gates: {
      typecheck: "PASS",
      build: "PASS",
      test: "PASS",
    },
    overallResult: "PASS",
    residualRisk: "Low — changes are additive only",
    mergeRecommendation: "approve",
    timestamp: "2025-06-05T22:00:00Z",
    reviewer: "coder",
    ...overrides,
  });
}

// =============================================================================
// Normalizer tests
// =============================================================================

describe("worker handoff evidence — normalizer", () => {
  it("normalizeHandoffObject fills defaults for empty input", () => {
    const result = normalizeHandoffObject({});
    expect(result.childLedgerId).toBe("");
    expect(result.childLedgerStatus).toBe("missing");
    expect(result.commit).toBeNull();
    expect(result.branch).toBe("");
    expect(result.workspace).toBe("");
    expect(result.changedFiles).toEqual([]);
    expect(result.commands).toEqual([]);
    expect(result.gates).toEqual({});
    expect(result.overallResult).toBe("FAIL");
    expect(result.residualRisk).toBe("");
    expect(result.mergeRecommendation).toBe("needs_review");
    expect(result.timestamp).toBeUndefined();
    expect(result.reviewer).toBeUndefined();
  });

  it("normalizeHandoffObject preserves valid values", () => {
    const result = makeEvidence();
    expect(result.childLedgerId).toBe("p6-06-test");
    expect(result.childLedgerStatus).toBe("closed");
    expect(result.commit).toBe("abc123def456");
    expect(result.branch).toBe("codex/p6/06-worker-handoff-contract");
    expect(result.workspace).toBe("/tmp/test-workspace");
    expect(result.changedFiles).toHaveLength(1);
    expect(result.gates.typecheck).toBe("PASS");
    expect(result.overallResult).toBe("PASS");
    expect(result.mergeRecommendation).toBe("approve");
  });

  it("normalizeHandoffObject clamps invalid enum values", () => {
    const result = normalizeHandoffObject({
      childLedgerStatus: "invalid" as LedgerStatus,
      overallResult: "MAYBE" as HandoffVerdict,
      mergeRecommendation: "yes" as MergeRecommendation,
      gates: { typecheck: "OK" as GateResult },
    });
    expect(result.childLedgerStatus).toBe("missing");
    expect(result.overallResult).toBe("FAIL");
    expect(result.mergeRecommendation).toBe("needs_review");
    expect(result.gates.typecheck).toBe("NOT_RUN");
  });

  it("normalizeWorkerHandoffEvidence delegates string to parseHandoffText", () => {
    const text = [
      "Child Ledger: p6-06-parse",
      "Status: closed",
      "Commit: def789",
      "Branch: feat/x",
      "Workspace: /tmp/x",
      "Overall: PASS",
      "Residual Risk: none",
      "Merge: approve",
      "Gates: typecheck:PASS build:PASS test:PASS",
    ].join("\n");
    const result = normalizeWorkerHandoffEvidence(text);
    expect(result.childLedgerId).toBe("p6-06-parse");
    expect(result.childLedgerStatus).toBe("closed");
    expect(result.commit).toBe("def789");
    expect(result.overallResult).toBe("PASS");
  });

  it("normalizeWorkerHandoffEvidence delegates object to normalizeHandoffObject", () => {
    const result = normalizeWorkerHandoffEvidence({ childLedgerId: "x", commit: "abc" });
    expect(result.childLedgerId).toBe("x");
    expect(result.commit).toBe("abc");
  });
});

// =============================================================================
// Text parser tests
// =============================================================================

describe("worker handoff evidence — parseHandoffText", () => {
  it("parses key-value pairs from report text", () => {
    const text = [
      "## Handoff Report",
      "Child Ledger Id: run-p6-06-001",
      "Status: closed",
      "Commit: abc123def456",
      "Branch: codex/p6/06-worker-handoff-contract",
      "Workspace: /Users/test/workspace",
      "Overall Result: PASS",
      "Residual Risk: Low risk — only additive changes",
      "Merge Recommendation: approve",
      "Reviewer: coder",
    ].join("\n");

    const evidence = parseHandoffText(text);
    expect(evidence.childLedgerId).toBe("run-p6-06-001");
    expect(evidence.childLedgerStatus).toBe("closed");
    expect(evidence.commit).toBe("abc123def456");
    expect(evidence.branch).toBe("codex/p6/06-worker-handoff-contract");
    expect(evidence.workspace).toBe("/Users/test/workspace");
    expect(evidence.overallResult).toBe("PASS");
    expect(evidence.residualRisk).toBe("Low risk — only additive changes");
    expect(evidence.mergeRecommendation).toBe("approve");
    expect(evidence.reviewer).toBe("coder");
  });

  it("parses gate results from compact format", () => {
    const text = "Gates: typecheck:PASS build:PASS test:PASS";
    const evidence = parseHandoffText(text);
    expect(evidence.gates.typecheck).toBe("PASS");
    expect(evidence.gates.build).toBe("PASS");
    expect(evidence.gates.test).toBe("PASS");
  });

  it("handles missing commit as null", () => {
    const text = "Commit: missing";
    const evidence = parseHandoffText(text);
    expect(evidence.commit).toBeNull();
  });

  it("handles commit: none as null", () => {
    const text = "Commit: none";
    const evidence = parseHandoffText(text);
    expect(evidence.commit).toBeNull();
  });

  it("parses bullet items as changed files under file section", () => {
    const text = [
      "## Changed Files",
      "- src/subagent/worker-handoff-evidence.ts",
      "- tests/worker-handoff-evidence.test.ts",
    ].join("\n");
    const evidence = parseHandoffText(text);
    expect(evidence.changedFiles).toHaveLength(2);
    expect(evidence.changedFiles[0]).toContain("worker-handoff-evidence.ts");
    expect(evidence.changedFiles[1]).toContain("worker-handoff-evidence.test.ts");
  });

  it("parses bullet items as commands under command section", () => {
    const text = [
      "## Commands",
      "- npm run typecheck",
      "- npm run build",
      "- npm test",
    ].join("\n");
    const evidence = parseHandoffText(text);
    expect(evidence.commands).toHaveLength(3);
    expect(evidence.commands[0]).toBe("npm run typecheck");
  });

  it("returns defaults for empty text", () => {
    const evidence = parseHandoffText("");
    expect(evidence.childLedgerId).toBe("");
    expect(evidence.commit).toBeNull();
    expect(evidence.overallResult).toBe("FAIL");
    expect(evidence.mergeRecommendation).toBe("needs_review");
  });
});

// =============================================================================
// Validator tests — PASS
// =============================================================================

describe("worker handoff evidence — validateHandoffEvidence PASS", () => {
  it("validates a complete PASS evidence successfully", () => {
    const evidence = makeEvidence();
    const result = validateHandoffEvidence(evidence);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("validates with warning gates but no hard failures", () => {
    const evidence = makeEvidence({
      gates: {
        typecheck: "PASS",
        build: "PASS",
        test: "PASS",
        lint: "FAIL", // not a required gate, should not affect
      },
    });
    const result = validateHandoffEvidence(evidence);
    expect(result.valid).toBe(true);
  });
});

// =============================================================================
// Validator tests — FAIL scenarios
// =============================================================================

describe("worker handoff evidence — validateHandoffEvidence FAIL", () => {
  it("fails when overall result is FAIL", () => {
    const evidence = makeEvidence({
      overallResult: "FAIL",
      gates: { typecheck: "FAIL", build: "PASS", test: "PASS" },
      mergeRecommendation: "reject",
    });
    const result = validateHandoffEvidence(evidence);
    // FAIL overall is valid as long as it's consistent
    expect(result.valid).toBe(true);
  });

  it("fails when any required gate is FAIL but overall is PASS", () => {
    const evidence = makeEvidence({
      overallResult: "PASS",
      gates: { typecheck: "FAIL", build: "PASS", test: "PASS" },
    });
    const result = validateHandoffEvidence(evidence);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "overallResult")).toBe(true);
  });
});

// =============================================================================
// Validator tests — missing ledger
// =============================================================================

describe("worker handoff evidence — validateHandoffEvidence missing ledger", () => {
  it("fails when childLedgerId is empty", () => {
    const evidence = makeEvidence({ childLedgerId: "" });
    const result = validateHandoffEvidence(evidence);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "childLedgerId")).toBe(true);
  });

  it("fails when childLedgerStatus is not closed", () => {
    const evidence = makeEvidence({ childLedgerStatus: "open" });
    const result = validateHandoffEvidence(evidence);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "childLedgerStatus")).toBe(true);
  });

  it("fails when childLedgerStatus is missing", () => {
    const evidence = makeEvidence({ childLedgerStatus: "missing" });
    const result = validateHandoffEvidence(evidence);
    expect(result.valid).toBe(false);
    const err = result.errors.find((e) => e.field === "childLedgerStatus");
    expect(err?.message).toContain("missing");
  });
});

// =============================================================================
// Validator tests — missing gates
// =============================================================================

describe("worker handoff evidence — validateHandoffEvidence missing gates", () => {
  it("fails when typecheck gate is missing", () => {
    const evidence = makeEvidence({
      gates: { build: "PASS", test: "PASS" },
    });
    const result = validateHandoffEvidence(evidence);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "gates.typecheck")).toBe(true);
  });

  it("fails when build gate is missing", () => {
    const evidence = makeEvidence({
      gates: { typecheck: "PASS", test: "PASS" },
    });
    const result = validateHandoffEvidence(evidence);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "gates.build")).toBe(true);
  });

  it("fails when test gate is missing", () => {
    const evidence = makeEvidence({
      gates: { typecheck: "PASS", build: "PASS" },
    });
    const result = validateHandoffEvidence(evidence);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "gates.test")).toBe(true);
  });

  it("fails when all gates are missing", () => {
    const evidence = makeEvidence({ gates: {} });
    const result = validateHandoffEvidence(evidence);
    expect(result.valid).toBe(false);
    expect(result.errors.filter((e) => e.field.startsWith("gates."))).toHaveLength(3);
  });
});

// =============================================================================
// Validator tests — stale/missing commit
// =============================================================================

describe("worker handoff evidence — validateHandoffEvidence stale/missing commit", () => {
  it("fails when commit is null", () => {
    const evidence = makeEvidence({ commit: null });
    const result = validateHandoffEvidence(evidence);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "commit")).toBe(true);
  });

  it("fails when commit is empty string", () => {
    const evidence = makeEvidence({ commit: "" });
    const result = validateHandoffEvidence(evidence);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "commit")).toBe(true);
  });
});

// =============================================================================
// Validator tests — QA without merge recommendation
// =============================================================================

describe("worker handoff evidence — QA without merge recommendation", () => {
  it("normalizes empty mergeRecommendation to needs_review (validator sees safe default)", () => {
    const evidence = makeEvidence({ mergeRecommendation: "" as MergeRecommendation });
    const result = validateHandoffEvidence(evidence);
    expect(result.valid).toBe(true);
    expect(evidence.mergeRecommendation).toBe("needs_review");
  });
});

// =============================================================================
// Validator tests — residual risk
// =============================================================================

describe("worker handoff evidence — validateHandoffEvidence residual risk", () => {
  it("fails when residualRisk is empty", () => {
    const evidence = makeEvidence({ residualRisk: "" });
    const result = validateHandoffEvidence(evidence);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === "residualRisk")).toBe(true);
  });

  it("passes when residual risk is provided", () => {
    const evidence = makeEvidence({
      residualRisk: "Medium — new dependency added, but tested",
    });
    const result = validateHandoffEvidence(evidence);
    expect(result.valid).toBe(true);
  });
});

// =============================================================================
// Evidence-derived gates tests
// =============================================================================

describe("worker handoff evidence — deriveGatesFromEvidence", () => {
  it("derives all gates as true for complete PASS evidence", () => {
    const evidence = makeEvidence();
    const gates = deriveGatesFromEvidence(evidence);
    expect(gates.workerReported).toBe(true);
    expect(gates.runCompleted).toBe(true);
    expect(gates.typecheckPasses).toBe(true);
    expect(gates.buildPasses).toBe(true);
    expect(gates.testsPass).toBe(true);
    expect(gates.workerRanGates).toBe(true);
  });

  it("derives workerReported as false for empty ledger ID", () => {
    const evidence = makeEvidence({ childLedgerId: "" });
    const gates = deriveGatesFromEvidence(evidence);
    expect(gates.workerReported).toBe(false);
  });

  it("derives runCompleted as false for open ledger", () => {
    const evidence = makeEvidence({ childLedgerStatus: "open" });
    const gates = deriveGatesFromEvidence(evidence);
    expect(gates.runCompleted).toBe(false);
  });

  it("derives typecheckPasses as false for FAIL gate", () => {
    const evidence = makeEvidence({
      gates: { typecheck: "FAIL", build: "PASS", test: "PASS" },
    });
    const gates = deriveGatesFromEvidence(evidence);
    expect(gates.typecheckPasses).toBe(false);
    expect(gates.buildPasses).toBe(true);
    expect(gates.testsPass).toBe(true);
  });

  it("derives workerRanGates as false for empty gates object", () => {
    const evidence = makeEvidence({ gates: {} });
    const gates = deriveGatesFromEvidence(evidence);
    expect(gates.workerRanGates).toBe(false);
  });
});

// =============================================================================
// Summary helper tests
// =============================================================================

describe("worker handoff evidence — summarizeHandoffEvidence", () => {
  it("produces human-readable summary", () => {
    const evidence = makeEvidence();
    const summary = summarizeHandoffEvidence(evidence);
    expect(summary).toContain("Child Ledger: p6-06-test (closed)");
    expect(summary).toContain("Commit: abc123def456");
    expect(summary).toContain("Branch: codex/p6/06-worker-handoff-contract");
    expect(summary).toContain("Overall: PASS");
    expect(summary).toContain("Residual Risk: Low");
    expect(summary).toContain("Merge Recommendation: approve");
    expect(summary).toContain("Reviewer: coder");
  });

  it("shows MISSING for null commit", () => {
    const evidence = makeEvidence({ commit: null });
    const summary = summarizeHandoffEvidence(evidence);
    expect(summary).toContain("Commit: MISSING");
  });

  it("includes changed files section", () => {
    const evidence = makeEvidence({
      changedFiles: ["a.ts", "b.ts"],
    });
    const summary = summarizeHandoffEvidence(evidence);
    expect(summary).toContain("Changed Files (2):");
    expect(summary).toContain("- a.ts");
    expect(summary).toContain("- b.ts");
  });
});

// =============================================================================
// Constants tests
// =============================================================================

describe("worker handoff evidence — constants", () => {
  it("REQUIRED_GATES contains typecheck, build, test", () => {
    expect(REQUIRED_GATES).toHaveLength(3);
    expect(REQUIRED_GATES).toContain("typecheck");
    expect(REQUIRED_GATES).toContain("build");
    expect(REQUIRED_GATES).toContain("test");
  });

  it("DEFAULT_GATE_COMMANDS maps to npm commands", () => {
    expect(DEFAULT_GATE_COMMANDS.typecheck).toBe("npm run typecheck");
    expect(DEFAULT_GATE_COMMANDS.build).toBe("npm run build");
    expect(DEFAULT_GATE_COMMANDS.test).toBe("npm test");
  });
});
