import { describe, expect, it } from "vitest";
import {
  createDefaultMasterReviewChecklist,
  evaluateMergeGates,
  sortByMergePriority,
  canMergeNow,
  DEFAULT_MERGE_ORDER,
  DEFAULT_CONFLICT_POLICY,
  DEFAULT_FEEDBACK_LOOP,
  type MasterReviewChecklist,
  type MergeGateResult,
  type MergePriority,
} from "../src/subagent/merge-protocol.js";

function makeChecklist(
  overrides: Partial<MasterReviewChecklist> = {},
): MasterReviewChecklist {
  return { ...createDefaultMasterReviewChecklist(), ...overrides };
}

function allPassed(): MasterReviewChecklist {
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

describe("merge protocol — evaluateMergeGates", () => {
  it("passes when all hard gates are met", () => {
    const result = evaluateMergeGates(allPassed());
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("fails when worker has not reported", () => {
    const result = evaluateMergeGates(
      makeChecklist({ ...allPassed(), workerReported: false }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toContain("Worker has not reported run status");
  });

  it("fails when run is not completed", () => {
    const result = evaluateMergeGates(
      makeChecklist({ ...allPassed(), runCompleted: false }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toContain(
      "Run has not reached a terminal state",
    );
  });

  it("fails when typecheck does not pass", () => {
    const result = evaluateMergeGates(
      makeChecklist({ ...allPassed(), typecheckPasses: false }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toContain("Typecheck does not pass (tsc --noEmit)");
  });

  it("fails when build does not pass", () => {
    const result = evaluateMergeGates(
      makeChecklist({ ...allPassed(), buildPasses: false }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toContain("Build does not pass (tsc)");
  });

  it("fails when tests do not pass", () => {
    const result = evaluateMergeGates(
      makeChecklist({ ...allPassed(), testsPass: false }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toContain(
      "Test suite does not pass (vitest run)",
    );
  });

  it("fails when branch has unresolved conflicts", () => {
    const result = evaluateMergeGates(
      makeChecklist({ ...allPassed(), noConflicts: false }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toContain(
      "Branch has unresolved merge conflicts with main",
    );
  });

  it("fails when diff is not reviewable", () => {
    const result = evaluateMergeGates(
      makeChecklist({ ...allPassed(), diffReviewable: false }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toContain(
      "Diff is not reviewable (empty, excessively large, or includes irrelevant files)",
    );
  });

  it("fails when branch reverts other workers' changes", () => {
    const result = evaluateMergeGates(
      makeChecklist({ ...allPassed(), noRevertOfOthers: false }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures).toContain(
      "Branch reverts or overwrites changes from other workers",
    );
  });

  it("warns but does not fail when not rebased on main", () => {
    const result = evaluateMergeGates(
      makeChecklist({ ...allPassed(), rebasedOnMain: false }),
    );
    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.warnings).toContain(
      "Branch is not rebased on latest main (recommended)",
    );
  });

  it("warns when worker did not self-report gates", () => {
    const result = evaluateMergeGates(
      makeChecklist({ ...allPassed(), workerRanGates: false }),
    );
    expect(result.passed).toBe(true);
    expect(result.warnings).toContain(
      "Worker did not self-report gate results (master verified independently)",
    );
  });

  it("warns when code review not performed", () => {
    const result = evaluateMergeGates(
      makeChecklist({ ...allPassed(), codeReviewed: false }),
    );
    expect(result.passed).toBe(true);
    expect(result.warnings).toContain(
      "Master has not performed substantive code review of the diff",
    );
  });

  it("collects multiple failures and warnings", () => {
    const result = evaluateMergeGates(
      makeChecklist({
        workerReported: false,
        runCompleted: false,
        typecheckPasses: false,
        testsPass: false,
        rebasedOnMain: false,
        codeReviewed: false,
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures.length).toBeGreaterThanOrEqual(4);
    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
  });
});

describe("merge protocol — default checklist factory", () => {
  it("returns a checklist with all gates false", () => {
    const checklist = createDefaultMasterReviewChecklist();
    for (const value of Object.values(checklist)) {
      expect(value).toBe(false);
    }
  });
});

describe("merge protocol — sortByMergePriority", () => {
  it("sorts runtime_truth before runtime_feature before tui_projection", () => {
    const tickets: { slug: string; priority: MergePriority }[] = [
      { slug: "tui-run-browser", priority: "tui_projection" },
      { slug: "runtime-tool-policy", priority: "runtime_truth" },
      { slug: "runtime-stuck-detection", priority: "runtime_feature" },
    ];
    const sorted = sortByMergePriority(tickets);
    expect(sorted[0]).toBe("runtime-tool-policy");
    expect(sorted[1]).toBe("runtime-stuck-detection");
    expect(sorted[2]).toBe("tui-run-browser");
  });

  it("respects explicit order within the same priority", () => {
    const tickets: { slug: string; priority: MergePriority }[] = [
      { slug: "runtime-stuck-detection", priority: "runtime_feature" },
      { slug: "runtime-decision-trace", priority: "runtime_feature" },
    ];
    const sorted = sortByMergePriority(tickets);
    expect(sorted[0]).toBe("runtime-decision-trace");
    expect(sorted[1]).toBe("runtime-stuck-detection");
  });

  it("returns empty array for empty input", () => {
    expect(sortByMergePriority([])).toEqual([]);
  });

  it("places unknown slugs at end within same priority", () => {
    const tickets: { slug: string; priority: MergePriority }[] = [
      { slug: "unknown-ticket", priority: "runtime_feature" },
      { slug: "runtime-decision-trace", priority: "runtime_feature" },
    ];
    const sorted = sortByMergePriority(tickets);
    expect(sorted[0]).toBe("runtime-decision-trace");
    expect(sorted[1]).toBe("unknown-ticket");
  });
});

describe("merge protocol — canMergeNow", () => {
  it("allows runtime_truth tickets at any time", () => {
    const result = canMergeNow(
      { slug: "runtime-tool-policy", priority: "runtime_truth" },
      [],
    );
    expect(result.allowed).toBe(true);
  });

  it("blocks non-runtime-truth tickets when runtime truth tickets are unmerged", () => {
    const result = canMergeNow(
      { slug: "runtime-decision-trace", priority: "runtime_feature" },
      [],
    );
    expect(result.allowed).toBe(false);
    expect(result.reason).toBeDefined();
    expect(result.reason).toContain("Runtime truth tickets must merge first");
  });

  it("allows non-runtime-truth tickets when all runtime truth tickets are merged", () => {
    const merged = [
      "runtime-environment-events",
      "runtime-recovery-side-effects",
      "runtime-tool-policy",
    ];
    const result = canMergeNow(
      { slug: "runtime-decision-trace", priority: "runtime_feature" },
      merged,
    );
    expect(result.allowed).toBe(true);
  });

  it("allows tui_projection after runtime truth and feature tickets are merged", () => {
    const merged = [
      "runtime-environment-events",
      "runtime-recovery-side-effects",
      "runtime-tool-policy",
    ];
    const result = canMergeNow(
      { slug: "tui-run-browser", priority: "tui_projection" },
      merged,
    );
    expect(result.allowed).toBe(true);
  });
});

describe("merge protocol — defaults", () => {
  it("DEFAULT_CONFLICT_POLICY uses worker_rebase with fallback after 3 cycles", () => {
    expect(DEFAULT_CONFLICT_POLICY.resolution).toBe("worker_rebase");
    expect(DEFAULT_CONFLICT_POLICY.fallbackAfterCycles).toBe(3);
  });

  it("DEFAULT_FEEDBACK_LOOP has all checks active", () => {
    expect(DEFAULT_FEEDBACK_LOOP.cycleReview).toBe(true);
    expect(DEFAULT_FEEDBACK_LOOP.coachBlocked).toBe(true);
    expect(DEFAULT_FEEDBACK_LOOP.codeReview).toBe(true);
    expect(DEFAULT_FEEDBACK_LOOP.reportMergeResult).toBe(true);
  });

  it("DEFAULT_MERGE_ORDER has four priority entries", () => {
    expect(DEFAULT_MERGE_ORDER).toHaveLength(4);
    expect(DEFAULT_MERGE_ORDER[0].priority).toBe("runtime_truth");
    expect(DEFAULT_MERGE_ORDER[1].priority).toBe("runtime_feature");
    expect(DEFAULT_MERGE_ORDER[2].priority).toBe("tui_projection");
    expect(DEFAULT_MERGE_ORDER[3].priority).toBe("cli_capability");
  });
});
