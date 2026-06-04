import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentRunStateData } from "../types/run.js";
import type { RunIndexRow } from "./debugger.js";

/**
 * Scan a runs directory and build a run index from persisted state.json files.
 *
 * Only subdirectories with a readable state.json are included.
 * Rows are sorted newest-first by updatedAt, then startedAt, then runId.
 * Non-run directories (latest, symlinks, files) are skipped.
 * Unreadable or corrupt state.json files are silently skipped.
 */
export function scanRunIndex(runsDir: string): RunIndexRow[] {
  if (!fs.existsSync(runsDir)) return [];

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const rows: RunIndexRow[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    // Skip known non-run directories and symlinks
    if (entry.name === "latest") continue;
    if (entry.isSymbolicLink()) continue;

    const statePath = path.join(runsDir, entry.name, "state.json");
    if (!fs.existsSync(statePath)) continue;

    const row = readRunRow(entry.name, statePath);
    if (row) rows.push(row);
  }

  // Sort newest-first
  rows.sort((left, right) => {
    const leftUpdated = timestampMs(left.updatedAt);
    const rightUpdated = timestampMs(right.updatedAt);
    if (rightUpdated !== leftUpdated) return rightUpdated - leftUpdated;

    const leftStarted = timestampMs(left.startedAt);
    const rightStarted = timestampMs(right.startedAt);
    if (rightStarted !== leftStarted) return rightStarted - leftStarted;

    return left.runId.localeCompare(right.runId);
  });

  return rows;
}

function readRunRow(
  runId: string,
  statePath: string,
): RunIndexRow | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(statePath, "utf-8");
  } catch {
    return undefined;
  }

  let state: AgentRunStateData;
  try {
    state = JSON.parse(raw) as AgentRunStateData;
  } catch {
    return undefined;
  }

  return buildRowFromState(runId, state);
}

function buildRowFromState(
  runId: string,
  state: AgentRunStateData,
): RunIndexRow {
  const startedMs = timestampMs(state.createdAt);
  const updatedMs = timestampMs(state.updatedAt);

  const row: RunIndexRow = {
    runId,
    status: state.status,
    stepIndex: state.stepIndex,
    cwd: state.cwd,
    frameCount: 0,
    problemFrameCount: 0,
    conversationCount: 0,
    sessionCount: 0,
  };

  if (state.createdAt) row.startedAt = state.createdAt;
  if (state.updatedAt) row.updatedAt = state.updatedAt;
  if (startedMs > 0 && updatedMs >= startedMs) {
    row.durationMs = updatedMs - startedMs;
  }

  if (state.error?.message) {
    row.failureSummary = state.error.message;
  }

  return row;
}

export function timestampMs(timestamp: string | undefined): number {
  if (!timestamp) return 0;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : 0;
}
