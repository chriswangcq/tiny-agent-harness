// Pure worker status projector.
// Derives worker status from explicit input snapshots.
// No IO, no Date.now(), no process.env, no side effects.

import type { WorkerContact } from "./contact-registry.js";

// ---- Input types ----

export interface RunSnapshot {
  /** Run lifecycle status */
  status?: string;
  /** ISO timestamp of last step */
  lastStepAt?: string;
}

export interface TranscriptSnapshot {
  /** ISO timestamp of last model output */
  lastModelOutputAt?: string;
  /** ISO timestamp of last tool execution */
  lastToolExecutionAt?: string;
}

export interface ImSnapshot {
  /** ISO timestamp of last received IM */
  lastImReceivedAt?: string;
  /** ISO timestamp of last sent IM */
  lastImSentAt?: string;
}

export interface LedgerSnapshot {
  /** Child ledger identifier */
  ledgerId?: string;
  /** ISO timestamp of last ledger activity */
  lastActivityAt?: string;
  /** Number of currently open problems */
  openProblemCount?: number;
}

export interface LifecycleTemplate {
  /** Worker role */
  role?: string;
  /** Expected heartbeat interval in ms */
  expectedHeartbeatIntervalMs?: number;
}

export interface ProjectorConfig {
  /** Explicit now timestamp (ISO) */
  now: string;
  /** Max age for heartbeat before stale (ms) */
  heartbeatMaxAgeMs: number;
  /** Max age for evidence before stale (ms) */
  evidenceMaxAgeMs: number;
  /** Max age for IM silence (ms) */
  imSilenceMaxAgeMs: number;
  /** Max age for ledger activity before stall (ms) */
  ledgerStallMaxAgeMs: number;
  /** Max age for run step before stall (ms) */
  runStallMaxAgeMs: number;
}

export interface ProjectorInput {
  contact: WorkerContact;
  runSnapshot?: RunSnapshot;
  transcriptSnapshot?: TranscriptSnapshot;
  imSnapshot?: ImSnapshot;
  ledgerSnapshot?: LedgerSnapshot;
  lifecycle?: LifecycleTemplate;
  config: ProjectorConfig;
}

// ---- Output types ----

export type WorkerStatusCode =
  | "healthy"
  | "degraded"
  | "stuck"
  | "idle"
  | "offline"
  | "done"
  | "terminated"
  | "unknown";

export type RiskFlag =
  | "stale_heartbeat"
  | "missing_heartbeat"
  | "missing_evidence"
  | "stale_evidence"
  | "im_silence"
  | "ledger_stall"
  | "run_stall"
  | "no_contact";

export interface EvidenceItem {
  timestamp?: string;
  ageMs?: number;
  source: string;
}

export interface EvidenceMap {
  heartbeat?: EvidenceItem;
  lastEvidence?: EvidenceItem;
  imLastSent?: EvidenceItem;
  imLastReceived?: EvidenceItem;
  runLastStep?: EvidenceItem;
  ledgerLastActivity?: EvidenceItem;
}

export interface WorkerStatusProjection {
  workerId: string;
  status: WorkerStatusCode;
  reason: string;
  evidence: EvidenceMap;
  riskFlags: RiskFlag[];
  projectedAt: string;
  contactStatus: string;
}

// ---- Pure helpers ----

function isoToMs(iso: string): number {
  return new Date(iso).getTime();
}

function computeAge(timestamp: string | undefined, now: string): number | undefined {
  if (!timestamp) return undefined;
  return isoToMs(now) - isoToMs(timestamp);
}

function buildEvidenceItem(
  timestamp: string | undefined,
  now: string,
  source: string,
): EvidenceItem | undefined {
  if (!timestamp) return undefined;
  return {
    timestamp,
    ageMs: computeAge(timestamp, now),
    source,
  };
}

// ---- Main projector ----

export function projectWorkerStatus(input: ProjectorInput): WorkerStatusProjection {
  const { contact, config, runSnapshot, imSnapshot, ledgerSnapshot, lifecycle } = input;
  const now = config.now;

  const riskFlags: RiskFlag[] = [];
  const evidence: EvidenceMap = {};

  // --- Evidence extraction ---

  // Heartbeat
  if (contact.lastHeartbeat) {
    evidence.heartbeat = buildEvidenceItem(contact.lastHeartbeat, now, "contact.lastHeartbeat");
  } else if (contact.status !== "terminated" && contact.status !== "offline") {
    riskFlags.push("missing_heartbeat");
  }

  // Last evidence
  if (contact.lastEvidence) {
    evidence.lastEvidence = buildEvidenceItem(contact.lastEvidence, now, "contact.lastEvidence");
  } else if (contact.status !== "terminated" && contact.status !== "offline") {
    riskFlags.push("missing_evidence");
  }

  // IM
  if (imSnapshot?.lastImSentAt) {
    evidence.imLastSent = buildEvidenceItem(imSnapshot.lastImSentAt, now, "im.lastImSentAt");
  }
  if (imSnapshot?.lastImReceivedAt) {
    evidence.imLastReceived = buildEvidenceItem(imSnapshot.lastImReceivedAt, now, "im.lastImReceivedAt");
  }

  // Run
  if (runSnapshot?.lastStepAt) {
    evidence.runLastStep = buildEvidenceItem(runSnapshot.lastStepAt, now, "run.lastStepAt");
  }

  // Ledger
  if (ledgerSnapshot?.lastActivityAt) {
    evidence.ledgerLastActivity = buildEvidenceItem(ledgerSnapshot.lastActivityAt, now, "ledger.lastActivityAt");
  }

  // --- Risk flag analysis ---

  // Determine effective heartbeat threshold
  const heartbeatThreshold =
    lifecycle?.expectedHeartbeatIntervalMs ?? config.heartbeatMaxAgeMs;

  if (evidence.heartbeat && evidence.heartbeat.ageMs !== undefined &&
      evidence.heartbeat.ageMs > heartbeatThreshold) {
    riskFlags.push("stale_heartbeat");
  }

  if (evidence.lastEvidence && evidence.lastEvidence.ageMs !== undefined &&
      evidence.lastEvidence.ageMs > config.evidenceMaxAgeMs) {
    riskFlags.push("stale_evidence");
  }

  if (evidence.imLastSent && evidence.imLastSent.ageMs !== undefined &&
      evidence.imLastSent.ageMs > config.imSilenceMaxAgeMs) {
    riskFlags.push("im_silence");
  }

  if (evidence.runLastStep && evidence.runLastStep.ageMs !== undefined &&
      evidence.runLastStep.ageMs > config.runStallMaxAgeMs) {
    riskFlags.push("run_stall");
  }

  if (evidence.ledgerLastActivity && evidence.ledgerLastActivity.ageMs !== undefined &&
      evidence.ledgerLastActivity.ageMs > config.ledgerStallMaxAgeMs) {
    riskFlags.push("ledger_stall");
  }

  // --- Status classification (priority-ordered) ---

  let status: WorkerStatusCode = "unknown";
  let reason = "";

  const contactStatus = contact.status || "unknown";

  // Priority: terminated > offline > done > stuck > degraded > idle > healthy > unknown

  if (contactStatus === "terminated") {
    status = "terminated";
    reason = `Worker ${contact.workerId} is terminated.`;
  } else if (contactStatus === "offline") {
    status = "offline";
    reason = `Worker ${contact.workerId} is offline.`;
  } else if (isDone(riskFlags, runSnapshot, ledgerSnapshot)) {
    status = "done";
    reason = `Worker ${contact.workerId} appears to have completed all work.`;
  } else if (riskFlags.length >= 3 &&
      (riskFlags.includes("stale_heartbeat") || riskFlags.includes("missing_heartbeat"))) {
    status = "stuck";
    reason = `Worker ${contact.workerId} appears stuck: ${riskFlags.join(", ")}.`;
  } else if (riskFlags.length > 0) {
    status = "degraded";
    reason = `Worker ${contact.workerId} has risk flags: ${riskFlags.join(", ")}.`;
  } else if (contactStatus === "idle") {
    status = "idle";
    reason = `Worker ${contact.workerId} is idle.`;
  } else if (contactStatus === "active" || contactStatus === "stale") {
    status = "healthy";
    reason = `Worker ${contact.workerId} is healthy and active.`;
  } else {
    status = "unknown";
    reason = `Worker ${contact.workerId} status is unknown (contact status: ${contactStatus}).`;
  }

  return {
    workerId: contact.workerId,
    status,
    reason,
    evidence,
    riskFlags,
    projectedAt: now,
    contactStatus,
  };
}

/**
 * "done" requires multiple corroborating signals, not a single IM or display event.
 * Requirements:
 * - Run is explicitly finished, OR ledger shows zero open problems with no run
 * - No risk flags (meaning recent heartbeat/evidence)
 * - Must have at least one strong signal (run finished or ledger clean)
 */

function isDone(
  riskFlags: RiskFlag[],
  runSnapshot?: RunSnapshot,
  ledgerSnapshot?: LedgerSnapshot,
): boolean {
  if (riskFlags.length > 0) return false;

  const runFinished = runSnapshot?.status === "finished";
  const ledgerClean = ledgerSnapshot !== undefined && ledgerSnapshot.openProblemCount === 0;

  // Need at least one concrete "done" signal
  if (!runFinished && !ledgerClean) return false;

  return true;
}
