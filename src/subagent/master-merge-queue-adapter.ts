// Master merge queue adapter.
//
// Pure adapter that converts explicit worker/contact/branch/gate snapshots
// into MasterReviewChecklist and merge readiness / queue results.
// Reuses merge-protocol.ts domain functions; no copied gate logic.
// No Date, process.env, fs, network, git, or process execution.

import type { WorkerContact } from "./contact-registry.js";
import type {
  MasterReviewChecklist,
  MergeGateResult,
  MergePriority,
} from "./merge-protocol.js";
import {
  createDefaultMasterReviewChecklist,
  evaluateMergeGates,
  sortByMergePriority,
  canMergeNow,
} from "./merge-protocol.js";
import type { WorkerHandoffEvidence } from "./worker-handoff-evidence.js";
import { deriveGatesFromEvidence } from "./worker-handoff-evidence.js";

// ---- Input types ----

/** Branch status snapshot provided by the runtime. */
export interface BranchSnapshot {
  /** Whether the branch has no merge conflicts with main. */
  noConflicts: boolean;
  /** Whether the branch is rebased on latest main tip. */
  rebasedOnMain: boolean;
  /** Whether the diff is reviewable (non-empty, not too large, relevant files). */
  diffReviewable: boolean;
  /** Whether the branch does not revert other workers' changes. */
  noRevertOfOthers: boolean;
  /** Whether master has done substantive code review. */
  codeReviewed: boolean;
}

/** Ticket with priority classification for merge ordering. */
export interface MergeQueueTicket {
  slug: string;
  priority: MergePriority;
}

/** Aggregate input for a single worker in the merge queue. */
export interface WorkerMergeInput {
  contact: WorkerContact;
  handoffEvidence?: WorkerHandoffEvidence;
  branchSnapshot?: BranchSnapshot;
}

/** Merge readiness result for a single worker. */
export interface WorkerMergeReadiness {
  workerId: string;
  /** Full checklist used for evaluation. */
  checklist: MasterReviewChecklist;
  /** Gate evaluation result. */
  gateResult: MergeGateResult;
  /** True if all hard gates passed (merge ready). */
  ready: boolean;
}

/** Aggregate output of the merge queue adapter. */
export interface MergeQueueResult {
  /** Per-worker merge readiness assessments. */
  workerResults: WorkerMergeReadiness[];
  /** Ticket slugs in recommended merge order. */
  mergeOrder: string[];
  /** Workers that are ready to merge, in priority order. */
  readyWorkers: string[];
  /** Workers that are NOT ready, with reasons. */
  blockedWorkers: string[];
}

// ---- Defaults ----

/** Default branch snapshot: all gates unverified. */
export function createDefaultBranchSnapshot(): BranchSnapshot {
  return {
    noConflicts: false,
    rebasedOnMain: false,
    diffReviewable: false,
    noRevertOfOthers: false,
    codeReviewed: false,
  };
}

// ---- Pure helpers ----

/**
 * Build a MasterReviewChecklist from handoff evidence and branch snapshot.
 *
 * Pure function. All inputs are explicit.
 */
export function buildChecklist(
  handoffEvidence?: WorkerHandoffEvidence,
  branchSnapshot?: BranchSnapshot,
): MasterReviewChecklist {
  const checklist = createDefaultMasterReviewChecklist();

  // Merge evidence-derived gates from handoff
  if (handoffEvidence) {
    const derived = deriveGatesFromEvidence(handoffEvidence);
    checklist.workerReported = derived.workerReported;
    checklist.runCompleted = derived.runCompleted;
    checklist.typecheckPasses = derived.typecheckPasses;
    checklist.buildPasses = derived.buildPasses;
    checklist.testsPass = derived.testsPass;
    checklist.workerRanGates = derived.workerRanGates;
  }

  // Merge branch snapshot gates
  if (branchSnapshot) {
    checklist.noConflicts = branchSnapshot.noConflicts;
    checklist.rebasedOnMain = branchSnapshot.rebasedOnMain;
    checklist.diffReviewable = branchSnapshot.diffReviewable;
    checklist.noRevertOfOthers = branchSnapshot.noRevertOfOthers;
    checklist.codeReviewed = branchSnapshot.codeReviewed;
  }

  return checklist;
}

/**
 * Compute merge readiness for a single worker.
 *
 * Pure function. Returns checklist, gate result, and ready flag.
 */
export function computeMergeReadiness(
  input: WorkerMergeInput,
): WorkerMergeReadiness {
  const checklist = buildChecklist(input.handoffEvidence, input.branchSnapshot);
  const gateResult = evaluateMergeGates(checklist);
  return {
    workerId: input.contact.workerId,
    checklist,
    gateResult,
    ready: gateResult.passed,
  };
}

/**
 * Compute merge readiness for all workers.
 *
 * Pure function. Returns per-worker results plus sorted merge order.
 */
export function computeMergeQueue(
  workers: WorkerMergeInput[],
  tickets: MergeQueueTicket[],
): MergeQueueResult {
  const workerResults = workers.map(computeMergeReadiness);

  // Compute merge order from ticket priorities
  const mergeOrder = sortByMergePriority(tickets);

  // Determine ready/blocked workers
  const readyWorkers: string[] = [];
  const blockedWorkers: string[] = [];

  for (const result of workerResults) {
    if (result.ready) {
      readyWorkers.push(result.workerId);
    } else {
      const reasons = result.gateResult.failures.join("; ");
      blockedWorkers.push(`${result.workerId} (${reasons})`);
    }
  }

  return {
    workerResults,
    mergeOrder,
    readyWorkers,
    blockedWorkers,
  };
}

/**
 * Check if a ticket can merge now given the set of already merged slugs.
 *
 * Delegates to merge-protocol's canMergeNow.
 */
export { canMergeNow };
