import { describe, expect, it } from "vitest";
import {
  buildChecklist,
  computeMergeReadiness,
  computeMergeQueue,
  createDefaultBranchSnapshot,
  type WorkerMergeInput,
  type MergeQueueTicket,
} from "../src/subagent/master-merge-queue-adapter.js";
import type {
  MasterReviewChecklist,
  MergePriority,
} from "../src/subagent/merge-protocol.js";
import type { WorkerContact } from "../src/subagent/contact-registry.js";
import type {
  WorkerHandoffEvidence,
  GateResult,
} from "../src/subagent/worker-handoff-evidence.js";

// --- Test helpers ---

function makeContact(overrides: Partial<WorkerContact> = {}): WorkerContact {
  return {
    workerId: "w1",
    role: "coder",
    workspace: "/tmp/test",
    branch: "feature/test",
    imChannel: "test-channel",
    allowedActions: [],
    status: "active",
    ...overrides,
  };
}

function makeHandoffEvidence(
  overrides: Partial<WorkerHandoffEvidence> = {},
): WorkerHandoffEvidence {
  return {
    childLedgerId: "test-ledger",
    childLedgerStatus: "closed",
    commit: "abc123",
    branch: "feature/test",
    workspace: "/tmp/test",
    changedFiles: ["src/test.ts"],
    commands: ["tsc --noEmit", "vitest run"],
    gates: {
      typecheck: "PASS" as GateResult,
      build: "PASS" as GateResult,
      test: "PASS" as GateResult,
    },
    overallResult: "PASS",
    residualRisk: "none",
    mergeRecommendation: "approve",
    ...overrides,
  };
}

function allPassedChecklist(): MasterReviewChecklist {
  return {
    workerReported: true,
    runCompleted: true,
    typecheckPasses: true,
    buildPasses: true,
    testsPass: true,
    noConflicts: true,
    rebasedOnMain: true,
    diffReviewable: true,
    noRevertOfOthers: true,
    workerRanGates: true,
    codeReviewed: true,
  };
}

function makeTickets(): MergeQueueTicket[] {
  return [
    { slug: "runtime-tool-policy", priority: "runtime_truth" as MergePriority },
    { slug: "tui-run-browser", priority: "tui_projection" as MergePriority },
    { slug: "runtime-stuck-detection", priority: "runtime_feature" as MergePriority },
  ];
}

// --- Tests ---

describe("master merge queue adapter — createDefaultBranchSnapshot", () => {
  it("returns all false by default", () => {
    const snap = createDefaultBranchSnapshot();
    expect(snap.noConflicts).toBe(false);
    expect(snap.rebasedOnMain).toBe(false);
    expect(snap.diffReviewable).toBe(false);
    expect(snap.noRevertOfOthers).toBe(false);
    expect(snap.codeReviewed).toBe(false);
  });
});

describe("master merge queue adapter — buildChecklist", () => {
  it("returns default all-false checklist with no inputs", () => {
    const checklist = buildChecklist();
    for (const value of Object.values(checklist)) {
      expect(value).toBe(false);
    }
  });

  it("derives gates from handoff evidence", () => {
    const evidence = makeHandoffEvidence();
    const checklist = buildChecklist(evidence);
    expect(checklist.workerReported).toBe(true);
    expect(checklist.runCompleted).toBe(true);
    expect(checklist.typecheckPasses).toBe(true);
    expect(checklist.buildPasses).toBe(true);
    expect(checklist.testsPass).toBe(true);
    expect(checklist.workerRanGates).toBe(true);
  });

  it("detects failed typecheck from evidence", () => {
    const evidence = makeHandoffEvidence({
      gates: { typecheck: "FAIL", build: "PASS", test: "PASS" },
    });
    const checklist = buildChecklist(evidence);
    expect(checklist.typecheckPasses).toBe(false);
    expect(checklist.buildPasses).toBe(true);
    expect(checklist.testsPass).toBe(true);
  });

  it("detects open ledger as run not completed", () => {
    const evidence = makeHandoffEvidence({ childLedgerStatus: "open" });
    const checklist = buildChecklist(evidence);
    expect(checklist.runCompleted).toBe(false);
  });

  it("merges branch snapshot gates", () => {
    const checklist = buildChecklist(undefined, {
      noConflicts: true,
      rebasedOnMain: true,
      diffReviewable: true,
      noRevertOfOthers: false,
      codeReviewed: true,
    });
    expect(checklist.noConflicts).toBe(true);
    expect(checklist.rebasedOnMain).toBe(true);
    expect(checklist.diffReviewable).toBe(true);
    expect(checklist.noRevertOfOthers).toBe(false);
    expect(checklist.codeReviewed).toBe(true);
  });

  it("merges both handoff and branch snapshot", () => {
    const evidence = makeHandoffEvidence();
    const branchSnapshot = {
      noConflicts: true,
      rebasedOnMain: true,
      diffReviewable: true,
      noRevertOfOthers: true,
      codeReviewed: true,
    };
    const checklist = buildChecklist(evidence, branchSnapshot);
    expect(checklist).toEqual(allPassedChecklist());
  });
});

describe("master merge queue adapter — computeMergeReadiness", () => {
  it("marks worker ready when all gates pass", () => {
    const input: WorkerMergeInput = {
      contact: makeContact({ workerId: "w1" }),
      handoffEvidence: makeHandoffEvidence(),
      branchSnapshot: {
        noConflicts: true,
        rebasedOnMain: true,
        diffReviewable: true,
        noRevertOfOthers: true,
        codeReviewed: true,
      },
    };
    const result = computeMergeReadiness(input);
    expect(result.workerId).toBe("w1");
    expect(result.ready).toBe(true);
    expect(result.gateResult.passed).toBe(true);
    expect(result.gateResult.failures).toEqual([]);
  });

  it("marks worker not ready when typecheck fails", () => {
    const input: WorkerMergeInput = {
      contact: makeContact({ workerId: "w2" }),
      handoffEvidence: makeHandoffEvidence({
        gates: { typecheck: "FAIL", build: "PASS", test: "PASS" },
      }),
      branchSnapshot: {
        noConflicts: true,
        rebasedOnMain: true,
        diffReviewable: true,
        noRevertOfOthers: true,
        codeReviewed: true,
      },
    };
    const result = computeMergeReadiness(input);
    expect(result.ready).toBe(false);
    expect(result.gateResult.passed).toBe(false);
    expect(result.gateResult.failures).toContain("Typecheck does not pass (tsc --noEmit)");
  });

  it("marks worker not ready with no inputs (all gates fail)", () => {
    const input: WorkerMergeInput = {
      contact: makeContact({ workerId: "w3" }),
    };
    const result = computeMergeReadiness(input);
    expect(result.ready).toBe(false);
    expect(result.gateResult.failures.length).toBeGreaterThan(0);
  });
});

describe("master merge queue adapter — computeMergeQueue", () => {
  it("sorts merge order by priority", () => {
    const tickets = makeTickets();
    const input: WorkerMergeInput = {
      contact: makeContact({ workerId: "w1" }),
      handoffEvidence: makeHandoffEvidence(),
      branchSnapshot: {
        noConflicts: true,
        rebasedOnMain: true,
        diffReviewable: true,
        noRevertOfOthers: true,
        codeReviewed: true,
      },
    };
    const result = computeMergeQueue([input], tickets);
    expect(result.mergeOrder).toEqual([
      "runtime-tool-policy",
      "runtime-stuck-detection",
      "tui-run-browser",
    ]);
  });

  it("separates ready and blocked workers", () => {
    const tickets = makeTickets();
    const readyWorker: WorkerMergeInput = {
      contact: makeContact({ workerId: "ready-1" }),
      handoffEvidence: makeHandoffEvidence(),
      branchSnapshot: {
        noConflicts: true,
        rebasedOnMain: true,
        diffReviewable: true,
        noRevertOfOthers: true,
        codeReviewed: true,
      },
    };
    const blockedWorker: WorkerMergeInput = {
      contact: makeContact({ workerId: "blocked-1" }),
    };
    const result = computeMergeQueue([readyWorker, blockedWorker], tickets);
    expect(result.readyWorkers).toEqual(["ready-1"]);
    expect(result.blockedWorkers.length).toBe(1);
    expect(result.blockedWorkers[0]).toContain("blocked-1");
  });

  it("handles empty input", () => {
    const result = computeMergeQueue([], []);
    expect(result.workerResults).toEqual([]);
    expect(result.mergeOrder).toEqual([]);
    expect(result.readyWorkers).toEqual([]);
    expect(result.blockedWorkers).toEqual([]);
  });

  it("computes per-worker results with full checklists", () => {
    const tickets = makeTickets();
    const input: WorkerMergeInput = {
      contact: makeContact({ workerId: "detail-worker" }),
      handoffEvidence: makeHandoffEvidence(),
      branchSnapshot: {
        noConflicts: true,
        rebasedOnMain: true,
        diffReviewable: true,
        noRevertOfOthers: true,
        codeReviewed: true,
      },
    };
    const result = computeMergeQueue([input], tickets);
    expect(result.workerResults).toHaveLength(1);
    expect(result.workerResults[0].checklist).toEqual(allPassedChecklist());
    expect(result.workerResults[0].gateResult.passed).toBe(true);
  });
});

describe("master merge queue adapter — purity contract", () => {
  it("buildChecklist is pure (no IO, no Date)", () => {
    const evidence = makeHandoffEvidence();
    const snapshot = {
      noConflicts: true,
      rebasedOnMain: true,
      diffReviewable: true,
      noRevertOfOthers: true,
      codeReviewed: true,
    };
    const r1 = buildChecklist(evidence, snapshot);
    const r2 = buildChecklist(evidence, snapshot);
    expect(r1).toEqual(r2);
  });

  it("computeMergeReadiness is deterministic", () => {
    const input: WorkerMergeInput = {
      contact: makeContact({ workerId: "det-worker" }),
    };
    const r1 = computeMergeReadiness(input);
    const r2 = computeMergeReadiness(input);
    expect(r1).toEqual(r2);
  });
});
