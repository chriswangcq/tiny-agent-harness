// Master merge protocol domain types and helpers.
// Pure domain — no runtime, no IO, no side effects.
// The Runtime/TUI boundary: runtime owns truth/effects (actual git merge,
// test runs, branch state); TUI projects checklist state.
// This module defines the domain vocabulary and gate logic only.

/**
 * Structured checklist a master agent evaluates before merging a worker branch.
 * Each field represents a gate condition that must be met.
 */
export type MasterReviewChecklist = {
  /** Worker has reported run status (started/blocked/review_pending/done) */
  workerReported: boolean;
  /** The agent run has reached a terminal state (finished/cancelled/failed) */
  runCompleted: boolean;
  /** TypeScript typecheck passes on the worker branch */
  typecheckPasses: boolean;
  /** Build (tsc) passes on the worker branch */
  buildPasses: boolean;
  /** Test suite passes on the worker branch */
  testsPass: boolean;
  /** Worker branch has no merge conflicts with main */
  noConflicts: boolean;
  /** Worker branch is rebased on the latest main tip */
  rebasedOnMain: boolean;
  /** Diff is reviewable: non-empty, not excessively large, relevant files only */
  diffReviewable: boolean;
  /** Worker branch does not revert or overwrite changes from other workers */
  noRevertOfOthers: boolean;
  /** Worker ran the same gate commands before reporting */
  workerRanGates: boolean;
  /** Master has reviewed the substantive code diff (not just checklist) */
  codeReviewed: boolean;
};

/**
 * Merge priority order: which tickets must be merged first.
 */
export type MergePriority =
  | "runtime_truth"   // Runtime contract tickets (environment, recovery, tool-policy)
  | "runtime_feature" // Runtime feature tickets
  | "tui_projection"  // TUI projection tickets
  | "cli_capability"; // CLI capability tickets (MCP, skill, codeq)

export type MergeOrder = {
  /** The priority class for this ticket */
  priority: MergePriority;
  /** Optional explicit ordering within the same priority class */
  orderWithinPriority: string[];
};

export type ConflictResolution = 
  | "worker_rebase"     // Master instructs worker to rebase and resolve
  | "master_merge_fix"; // Master resolves in own workspace

export type ConflictPolicy = {
  /** How conflicts are resolved */
  resolution: ConflictResolution;
  /** If worker is unresponsive after N master review cycles, master may take over */
  fallbackAfterCycles: number | null; // null = no timeout, wait indefinitely
};

/**
 * Feedback loop: how master coaches a worker through the review cycle.
 */
export type FeedbackLoopCheck = {
  /** Master reviews worker status each master loop cycle */
  cycleReview: boolean;
  /** Master sends short IM instructions to blocked/drifting workers */
  coachBlocked: boolean;
  /** Master performs code review on review_pending branches */
  codeReview: boolean;
  /** Master reports merge result back to worker */
  reportMergeResult: boolean;
};

/**
 * Result of evaluating merge gates against a checklist.
 */
export type MergeGateResult = {
  /** All hard gates passed */
  passed: boolean;
  /** Hard failures — must be resolved before merge */
  failures: string[];
  /** Soft warnings — should be addressed but do not block merge */
  warnings: string[];
};

/** Default merge order priority mapping for known ticket classes. */
export const DEFAULT_MERGE_ORDER: readonly MergeOrder[] = [
  {
    priority: "runtime_truth",
    orderWithinPriority: [
      "runtime-environment-events",
      "runtime-recovery-side-effects",
      "runtime-tool-policy",
    ],
  },
  {
    priority: "runtime_feature",
    orderWithinPriority: [
      "runtime-decision-trace",
      "runtime-stuck-detection",
      "runtime-cli-capability-lifecycle",
      "runtime-token-cost-artifacts",
    ],
  },
  {
    priority: "tui_projection",
    orderWithinPriority: [
      "tui-run-browser",
      "tui-loop-detail-sections",
      "tui-live-follow",
      "tui-pty-screen-projection",
      "tui-review-control-panel",
      "tui-token-dashboard",
      "tui-prompt-diff-viewer",
      "tui-layout-display-stability",
    ],
  },
  {
    priority: "cli_capability",
    orderWithinPriority: [
      "team-workspace-run-branch-protocol",
      "team-master-merge-coaching",
    ],
  },
];

/**
 * Default conflict policy for the trial.
 * Workers resolve their own conflicts; master takes over after 3 unresponsive cycles.
 */
export const DEFAULT_CONFLICT_POLICY: ConflictPolicy = {
  resolution: "worker_rebase",
  fallbackAfterCycles: 3,
};

/**
 * Default feedback loop checks — all active in the trial.
 */
export const DEFAULT_FEEDBACK_LOOP: FeedbackLoopCheck = {
  cycleReview: true,
  coachBlocked: true,
  codeReview: true,
  reportMergeResult: true,
};

/**
 * Create a default master review checklist with all gates unverified.
 */
export function createDefaultMasterReviewChecklist(): MasterReviewChecklist {
  return {
    workerReported: false,
    runCompleted: false,
    typecheckPasses: false,
    buildPasses: false,
    testsPass: false,
    noConflicts: false,
    rebasedOnMain: false,
    diffReviewable: false,
    noRevertOfOthers: false,
    workerRanGates: false,
    codeReviewed: false,
  };
}

/**
 * Evaluate merge gates against a checklist.
 * Returns structured pass/fail with specific failure and warning messages.
 */
export function evaluateMergeGates(
  checklist: MasterReviewChecklist,
): MergeGateResult {
  const failures: string[] = [];
  const warnings: string[] = [];

  // Hard gates — merge is blocked if any fail
  if (!checklist.workerReported) {
    failures.push("Worker has not reported run status");
  }
  if (!checklist.runCompleted) {
    failures.push("Run has not reached a terminal state");
  }
  if (!checklist.typecheckPasses) {
    failures.push("Typecheck does not pass (tsc --noEmit)");
  }
  if (!checklist.buildPasses) {
    failures.push("Build does not pass (tsc)");
  }
  if (!checklist.testsPass) {
    failures.push("Test suite does not pass (vitest run)");
  }
  if (!checklist.noConflicts) {
    failures.push("Branch has unresolved merge conflicts with main");
  }
  if (!checklist.diffReviewable) {
    failures.push(
      "Diff is not reviewable (empty, excessively large, or includes irrelevant files)",
    );
  }
  if (!checklist.noRevertOfOthers) {
    failures.push("Branch reverts or overwrites changes from other workers");
  }

  // Soft gates — warnings only, do not block merge
  if (!checklist.rebasedOnMain) {
    warnings.push("Branch is not rebased on latest main (recommended)");
  }
  if (!checklist.workerRanGates) {
    warnings.push("Worker did not self-report gate results (master verified independently)");
  }
  if (!checklist.codeReviewed) {
    warnings.push("Master has not performed substantive code review of the diff");
  }

  return {
    passed: failures.length === 0,
    failures,
    warnings,
  };
}

/**
 * Determine merge order for a list of tickets given their priority classes.
 * Returns tickets sorted by merge priority, then by explicit order.
 */
export function sortByMergePriority(
  tickets: { slug: string; priority: MergePriority }[],
  order: readonly MergeOrder[] = DEFAULT_MERGE_ORDER,
): string[] {
  const priorityRank: Record<MergePriority, number> = {
    runtime_truth: 0,
    runtime_feature: 1,
    tui_projection: 2,
    cli_capability: 3,
  };

  const explicitPosition: Record<string, number> = {};
  for (const entry of order) {
    entry.orderWithinPriority.forEach((slug, idx) => {
      explicitPosition[slug] = idx;
    });
  }

  const sorted = [...tickets].sort((a, b) => {
    const rankDiff = priorityRank[a.priority] - priorityRank[b.priority];
    if (rankDiff !== 0) return rankDiff;
    const posA = explicitPosition[a.slug] ?? Number.MAX_SAFE_INTEGER;
    const posB = explicitPosition[b.slug] ?? Number.MAX_SAFE_INTEGER;
    return posA - posB;
  });

  return sorted.map((t) => t.slug);
}

/**
 * Check if a ticket's priority class is allowed to merge given the
 * already-merged tickets. Runtime truth tickets must merge before others.
 */
export function canMergeNow(
  ticket: { slug: string; priority: MergePriority },
  alreadyMergedSlugs: readonly string[],
  order: readonly MergeOrder[] = DEFAULT_MERGE_ORDER,
): { allowed: boolean; reason?: string } {
  if (ticket.priority === "runtime_truth") {
    return { allowed: true };
  }

  const priorityRank: Record<MergePriority, number> = {
    runtime_truth: 0,
    runtime_feature: 1,
    tui_projection: 2,
    cli_capability: 3,
  };

  // Collect all runtime_truth tickets from the default order
  const runtimeTruthTickets = order
    .filter((o) => o.priority === "runtime_truth")
    .flatMap((o) => o.orderWithinPriority);

  const unmergedRuntimeTruth = runtimeTruthTickets.filter(
    (slug) => !alreadyMergedSlugs.includes(slug),
  );

  if (unmergedRuntimeTruth.length > 0 && priorityRank[ticket.priority] > 0) {
    return {
      allowed: false,
      reason: `Runtime truth tickets must merge first. Unmerged: ${unmergedRuntimeTruth.join(", ")}`,
    };
  }

  return { allowed: true };
}
