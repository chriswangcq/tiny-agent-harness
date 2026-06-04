import type { ConversationItem, LoopFrame, RunHeaderView, SessionView } from "./types.js";

export type LoopFrameQuery = {
  text?: string;
  phases?: readonly LoopFrame["phase"][];
  statuses?: readonly LoopFrame["status"][];
  stepIndex?: number;
  problemsOnly?: boolean;
};

export type LoopFrameDetailSection = {
  title: string;
  content: string;
};

export type LoopFrameDetail = {
  id: string;
  stepIndex: number;
  phase: LoopFrame["phase"];
  status: LoopFrame["status"];
  title: string;
  summary: string;
  timestamp: string;
  logPath?: string;
  transcriptEventId?: string;
  rawDetail?: string;
  sections: LoopFrameDetailSection[];
};

export type DebuggerRunSnapshot = {
  run: RunHeaderView;
  loop: readonly LoopFrame[];
  conversation?: readonly ConversationItem[];
  sessions?: readonly SessionView[];
};

export type RunIndexRow = {
  runId: string;
  status: RunHeaderView["status"];
  stepIndex: number;
  cwd: string;
  startedAt?: string;
  updatedAt?: string;
  durationMs?: number;
  frameCount: number;
  problemFrameCount: number;
  conversationCount: number;
  sessionCount: number;
  failureSummary?: string;
  taskPreview?: string;
};

export type RunComparisonChange = {
  field:
    | "status"
    | "stepIndex"
    | "durationMs"
    | "frameCount"
    | "problemFrameCount"
    | "conversationCount"
    | "sessionCount";
  left: string | number | undefined;
  right: string | number | undefined;
  changed: boolean;
};

export type RunComparison = {
  left: RunIndexRow;
  right: RunIndexRow;
  changes: RunComparisonChange[];
  changedFields: RunComparisonChange["field"][];
};

export function queryLoopFrames(
  frames: readonly LoopFrame[],
  query: LoopFrameQuery = {},
): LoopFrame[] {
  return frames.filter((frame) => matchesLoopFrame(frame, query));
}

export function matchesLoopFrame(frame: LoopFrame, query: LoopFrameQuery): boolean {
  if (query.stepIndex !== undefined && frame.stepIndex !== query.stepIndex) {
    return false;
  }
  if (query.phases && !query.phases.includes(frame.phase)) {
    return false;
  }
  if (query.statuses && !query.statuses.includes(frame.status)) {
    return false;
  }
  if (query.problemsOnly && !isProblemFrame(frame)) {
    return false;
  }
  if (query.text && !loopFrameSearchText(frame).includes(normalizeQuery(query.text))) {
    return false;
  }
  return true;
}

export function nextLoopFrameIndex(
  frames: readonly LoopFrame[],
  input: {
    currentIndex: number;
    query?: LoopFrameQuery;
    direction: "forward" | "backward";
    wrap?: boolean;
  },
): number | undefined {
  if (frames.length === 0) return undefined;
  const candidates = queryLoopFrames(frames, input.query);
  if (candidates.length === 0) return undefined;

  const candidateIndexes = candidates
    .map((candidate) => frames.findIndex((frame) => frame.id === candidate.id))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);

  if (input.direction === "forward") {
    const next = candidateIndexes.find((index) => index > input.currentIndex);
    return next ?? (input.wrap ? candidateIndexes[0] : undefined);
  }

  const previous = [...candidateIndexes]
    .reverse()
    .find((index) => index < input.currentIndex);
  return previous ?? (input.wrap ? candidateIndexes.at(-1) : undefined);
}

export function buildLoopFrameDetail(frame: LoopFrame): LoopFrameDetail {
  return {
    id: frame.id,
    stepIndex: frame.stepIndex,
    phase: frame.phase,
    status: frame.status,
    title: frame.title,
    summary: frame.summary,
    timestamp: frame.timestamp,
    ...(frame.logPath ? { logPath: frame.logPath } : {}),
    ...(frame.transcriptEventId
      ? { transcriptEventId: frame.transcriptEventId }
      : {}),
    ...(frame.detail ? { rawDetail: frame.detail } : {}),
    sections: parseDetailSections(frame.detail),
  };
}

export function summarizeLoopFrames(frames: readonly LoopFrame[]): {
  total: number;
  byStatus: Record<LoopFrame["status"], number>;
  byPhase: Record<LoopFrame["phase"], number>;
  problemCount: number;
} {
  const byStatus = zeroStatusCounts();
  const byPhase = zeroPhaseCounts();
  let problemCount = 0;

  for (const frame of frames) {
    byStatus[frame.status]++;
    byPhase[frame.phase]++;
    if (isProblemFrame(frame)) problemCount++;
  }

  return {
    total: frames.length,
    byStatus,
    byPhase,
    problemCount,
  };
}

export function buildRunIndex(
  runs: readonly DebuggerRunSnapshot[],
): RunIndexRow[] {
  return runs
    .map(buildRunIndexRow)
    .sort((left, right) => {
      const updatedDiff =
        timestampMs(right.updatedAt) - timestampMs(left.updatedAt);
      if (updatedDiff !== 0) return updatedDiff;
      const startedDiff =
        timestampMs(right.startedAt) - timestampMs(left.startedAt);
      if (startedDiff !== 0) return startedDiff;
      return left.runId.localeCompare(right.runId);
    });
}

export function compareRuns(
  leftInput: DebuggerRunSnapshot,
  rightInput: DebuggerRunSnapshot,
): RunComparison {
  const left = buildRunIndexRow(leftInput);
  const right = buildRunIndexRow(rightInput);
  const changes: RunComparisonChange[] = [
    compareField("status", left.status, right.status),
    compareField("stepIndex", left.stepIndex, right.stepIndex),
    compareField("durationMs", left.durationMs, right.durationMs),
    compareField("frameCount", left.frameCount, right.frameCount),
    compareField(
      "problemFrameCount",
      left.problemFrameCount,
      right.problemFrameCount,
    ),
    compareField(
      "conversationCount",
      left.conversationCount,
      right.conversationCount,
    ),
    compareField("sessionCount", left.sessionCount, right.sessionCount),
  ];
  return {
    left,
    right,
    changes,
    changedFields: changes
      .filter((change) => change.changed)
      .map((change) => change.field),
  };
}

function isProblemFrame(frame: LoopFrame): boolean {
  return frame.status === "warn" || frame.status === "error";
}

function loopFrameSearchText(frame: LoopFrame): string {
  return normalizeQuery(
    [
      frame.id,
      String(frame.stepIndex),
      `step ${frame.stepIndex}`,
      frame.phase,
      frame.status,
      frame.title,
      frame.summary,
      frame.detail,
      frame.logPath,
      frame.transcriptEventId,
    ]
      .filter((value): value is string => typeof value === "string")
      .join("\n"),
  );
}

function normalizeQuery(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function parseDetailSections(detail: string | undefined): LoopFrameDetailSection[] {
  if (!detail) return [];

  const lines = detail.split(/\r?\n/u);
  const sections: LoopFrameDetailSection[] = [];
  let currentTitle = "detail";
  let currentLines: string[] = [];
  let sawHeading = false;

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (sawHeading || currentLines.some((currentLine) => currentLine.trim())) {
        sections.push({
          title: currentTitle,
          content: currentLines.join("\n").trim(),
        });
      }
      sawHeading = true;
      currentTitle = line.slice(3).trim() || "detail";
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  if (sawHeading || currentLines.some((line) => line.trim())) {
    sections.push({
      title: currentTitle,
      content: currentLines.join("\n").trim(),
    });
  }

  return sections.filter(
    (section) => section.title !== "" || section.content !== "",
  );
}

function zeroStatusCounts(): Record<LoopFrame["status"], number> {
  return {
    pending: 0,
    running: 0,
    ok: 0,
    warn: 0,
    error: 0,
    waiting: 0,
  };
}

function zeroPhaseCounts(): Record<LoopFrame["phase"], number> {
  return {
    model: 0,
    decision: 0,
    validation: 0,
    review: 0,
    tool: 0,
    observation: 0,
    environment: 0,
    io_wait: 0,
    skill: 0,
  };
}

function buildRunIndexRow(snapshot: DebuggerRunSnapshot): RunIndexRow {
  return {
    runId: snapshot.run.runId,
    status: snapshot.run.status,
    stepIndex: snapshot.run.stepIndex,
    cwd: snapshot.run.cwd,
    ...(snapshot.run.startedAt ? { startedAt: snapshot.run.startedAt } : {}),
    ...(snapshot.run.updatedAt ? { updatedAt: snapshot.run.updatedAt } : {}),
    ...durationField(snapshot.run.startedAt, snapshot.run.updatedAt),
    frameCount: snapshot.loop.length,
    problemFrameCount: summarizeLoopFrames(snapshot.loop).problemCount,
    conversationCount: snapshot.conversation?.length ?? 0,
    sessionCount: snapshot.sessions?.length ?? 0,
  };
}

function compareField<T extends RunComparisonChange["field"]>(
  field: T,
  left: string | number | undefined,
  right: string | number | undefined,
): RunComparisonChange {
  return {
    field,
    left,
    right,
    changed: left !== right,
  };
}

function durationField(
  startedAt: string | undefined,
  updatedAt: string | undefined,
): { durationMs?: number } {
  const started = timestampMs(startedAt);
  const updated = timestampMs(updatedAt);
  if (started === 0 || updated === 0 || updated < started) return {};
  return { durationMs: updated - started };
}

function timestampMs(timestamp: string | undefined): number {
  if (!timestamp) return 0;
  const ms = Date.parse(timestamp);
  return Number.isFinite(ms) ? ms : 0;
}

// Run browser view model.

export type RunBrowserOptions = {
  selectedRunId?: string;
  selectedIndex?: number;
};

export type RunBrowserView = {
  rows: RunBrowserRow[];
  totalCount: number;
  isEmpty: boolean;
  selected?: RunBrowserSelected;
};

export type RunBrowserRow = {
  runId: string;
  index: number;
  statusDisplay: string;
  stepDisplay: string;
  durationDisplay: string;
  taskPreview: string;
  cwdPreview: string;
  failureSummary?: string;
  isSelected: boolean;
};

export type RunBrowserSelected = {
  runId: string;
  index: number;
  detail: RunBrowserDetail;
};

export type RunBrowserDetail = {
  runId: string;
  status: string;
  stepIndex: number;
  cwd: string;
  startedAt?: string;
  updatedAt?: string;
  durationDisplay: string;
  frameCount: number;
  problemFrameCount: number;
  conversationCount: number;
  sessionCount: number;
  taskPreview?: string;
  failureSummary?: string;
};

/**
 * Build a pure, read-only run browser view model from RunIndexRow data.
 *
 * Returns a structured view with formatted display strings, an optional
 * selected row with detail, and empty-list state. No filesystem I/O,
 * no runtime mutation, no external reads.
 */
export function buildRunBrowserView(
  rows: readonly RunIndexRow[],
  options: RunBrowserOptions = {},
): RunBrowserView {
  if (rows.length === 0) {
    return { rows: [], totalCount: 0, isEmpty: true };
  }

  const selectedIndex = resolveSelectedIndex(rows, options);
  const selected =
    selectedIndex !== undefined
      ? buildSelected(rows, selectedIndex)
      : undefined;

  const browserRows: RunBrowserRow[] = rows.map((row, idx) => ({
    runId: row.runId,
    index: idx,
    statusDisplay: formatStatusDisplay(row.status),
    stepDisplay: `step ${row.stepIndex}`,
    durationDisplay: formatDurationDisplay(row.durationMs),
    taskPreview: row.taskPreview ?? "",
    cwdPreview: formatCwdPreview(row.cwd),
    failureSummary: row.failureSummary,
    isSelected: idx === selectedIndex,
  }));

  return {
    rows: browserRows,
    totalCount: rows.length,
    isEmpty: false,
    selected,
  };
}

function resolveSelectedIndex(
  rows: readonly RunIndexRow[],
  options: RunBrowserOptions,
): number | undefined {
  if (options.selectedRunId !== undefined) {
    const byId = rows.findIndex((r) => r.runId === options.selectedRunId);
    if (byId >= 0) return byId;
    // unknown selection fallback: return undefined (no selection)
    return undefined;
  }
  if (options.selectedIndex !== undefined) {
    if (options.selectedIndex >= 0 && options.selectedIndex < rows.length) {
      return options.selectedIndex;
    }
    // unknown selection fallback: return undefined (no selection)
    return undefined;
  }
  return undefined;
}

function buildSelected(
  rows: readonly RunIndexRow[],
  index: number,
): RunBrowserSelected {
  const row = rows[index]!;
  return {
    runId: row.runId,
    index,
    detail: {
      runId: row.runId,
      status: row.status,
      stepIndex: row.stepIndex,
      cwd: row.cwd,
      startedAt: row.startedAt,
      updatedAt: row.updatedAt,
      durationDisplay: formatDurationDisplay(row.durationMs),
      frameCount: row.frameCount,
      problemFrameCount: row.problemFrameCount,
      conversationCount: row.conversationCount,
      sessionCount: row.sessionCount,
      taskPreview: row.taskPreview,
      failureSummary: row.failureSummary,
    },
  };
}

/** Maximum path segments to show in cwd preview. */
const CWD_PREVIEW_SEGMENTS = 2;

function formatCwdPreview(cwd: string): string {
  if (!cwd) return "";
  // Normalize separators and remove trailing slashes
  const cleaned = cwd.replace(/[/\\]+/g, "/").replace(/\/+$/u, "");
  if (!cleaned) return "";
  const segments = cleaned.split("/").filter(Boolean);
  if (segments.length === 0) return "/";
  // Show last N segments prefixed with ".../"
  if (segments.length > CWD_PREVIEW_SEGMENTS) {
    return ".../" + segments.slice(-CWD_PREVIEW_SEGMENTS).join("/");
  }
  // Absolute path has leading "/"
  return (cwd.startsWith("/") ? "/" : "") + segments.join("/");
}

const STATUS_DISPLAY: Record<string, string> = {
  created: "created",
  running: "running",
  waiting_for_model: "wait:model",
  waiting_for_review: "wait:review",
  waiting_for_tool: "wait:tool",
  waiting_for_io: "wait:io",
  failed: "FAILED",
  cancelled: "cancelled",
};

function formatStatusDisplay(status: string): string {
  return STATUS_DISPLAY[status] ?? status;
}

function formatDurationDisplay(durationMs: number | undefined): string {
  if (durationMs === undefined || durationMs < 0) return "--";
  const totalSec = Math.floor(durationMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const remainingSec = totalSec % 60;
  if (totalMin < 60) {
    if (remainingSec === 0) return `${totalMin}m`;
    return `${totalMin}m ${remainingSec}s`;
  }
  const hours = Math.floor(totalMin / 60);
  const remainingMin = totalMin % 60;
  if (remainingMin === 0) return `${hours}h`;
  return `${hours}h ${remainingMin}m`;
}

// Run browser control intent boundary.

/** Data-only action a user can request through the run browser. */
export type RunBrowserControlAction = "attach" | "resume" | "control";

/** User-initiated request from the run browser UI. */
export type RunBrowserControlRequest = {
  action: RunBrowserControlAction;
  /** Target run by id (preferred). */
  runId?: string;
  /** Target run by row index (fallback). */
  index?: number;
  /** Reject requests that try to bypass the intent-only control path. */
  directMutation?: boolean;
};

/** Auditable intent produced by the TUI.  No side-effects are executed here. */
export type RunBrowserControlIntent = {
  action: RunBrowserControlAction;
  runId: string;
  index: number;
  /** TUI emits an inert request; runtime/CLI owns every effect. */
  effect: "none";
  /** Runtime/CLI is the only owner allowed to execute the intent. */
  owner: "runtime_cli";
  /** Tool review must be preserved before any effectful control action. */
  review: "required";
};

/** Deterministic rejection reasons. */
export type RunBrowserControlError = {
  kind: "missing_run_id" | "unknown_run_id" | "unsafe_mutation";
  message: string;
};

/**
 * Build a pure, auditable run-browser control intent.
 *
 * The intent is a **request contract only**:
 * - TUI creates the intent; it never mutates run state.
 * - Runtime / CLI owns the actual attach / resume / control effects.
 * - Tool review must be preserved upstream.
 *
 * Rejects deterministically:
 * - `missing_run_id` - no `runId` or `index` provided, or `index` out of range.
 * - `unknown_run_id` - `runId` is not present in `rows`.
 * - `unsafe_mutation` - the request tries to bypass the intent path.
 */
export function buildRunBrowserControlIntent(
  rows: readonly RunIndexRow[],
  request: RunBrowserControlRequest,
): RunBrowserControlIntent | RunBrowserControlError {
  if (request.directMutation === true) {
    return {
      kind: "unsafe_mutation",
      message: "TUI control requests must produce intent only; direct mutation is unsafe",
    };
  }

  const resolved = resolveRunBrowserTarget(rows, request);
  if ("kind" in resolved) return resolved;

  return {
    action: request.action,
    runId: resolved.runId,
    index: resolved.index,
    effect: "none",
    owner: "runtime_cli",
    review: "required",
  };
}

type ResolvedTarget = { runId: string; index: number };

function resolveRunBrowserTarget(
  rows: readonly RunIndexRow[],
  request: RunBrowserControlRequest,
): ResolvedTarget | RunBrowserControlError {
  // Prefer explicit runId.
  if (request.runId !== undefined && request.runId !== "") {
    const idx = rows.findIndex((r) => r.runId === request.runId);
    if (idx < 0) {
      return {
        kind: "unknown_run_id",
        message: `Run "${request.runId}" is not in the current run list`,
      };
    }
    return { runId: request.runId, index: idx };
  }

  // Fallback to index.
  if (request.index !== undefined) {
    if (request.index < 0 || request.index >= rows.length) {
      return {
        kind: "missing_run_id",
        message: `Index ${request.index} is out of range (0..${rows.length - 1})`,
      };
    }
    const row = rows[request.index]!;
    return { runId: row.runId, index: request.index };
  }

  // Nothing resolvable.
  return {
    kind: "missing_run_id",
    message: "No runId or valid index provided; cannot resolve target run",
  };
}

export type RunBrowserControlActionLabel = "Attach" | "Resume" | "Control";

export function formatRunBrowserControlAction(
  action: RunBrowserControlAction,
): RunBrowserControlActionLabel {
  return (
    { attach: "Attach", resume: "Resume", control: "Control" } as const
  )[action];
}

export type RunBrowserControlIntentDisplay =
  | {
      status: "valid";
      valid: true;
      actionLabel: RunBrowserControlActionLabel;
      action: RunBrowserControlAction;
      runId: string;
      index: number;
      intent: RunBrowserControlIntent;
      errorKind?: never;
      errorMessage?: never;
    }
  | {
      status: "error";
      valid: false;
      actionLabel: RunBrowserControlActionLabel;
      action: RunBrowserControlAction;
      errorKind: RunBrowserControlError["kind"];
      errorMessage: string;
      runId?: never;
      index?: never;
      intent?: never;
    };

export function buildRunBrowserControlIntentDisplay(
  rows: readonly RunIndexRow[],
  request: RunBrowserControlRequest,
): RunBrowserControlIntentDisplay {
  const result = buildRunBrowserControlIntent(rows, request);
  const actionLabel = formatRunBrowserControlAction(request.action);

  if ("kind" in result) {
    return {
      actionLabel,
      action: request.action,
      status: "error",
      valid: false,
      errorKind: result.kind,
      errorMessage: result.message,
    };
  }

  return {
    actionLabel,
    action: result.action,
    status: "valid",
    valid: true,
    runId: result.runId,
    index: result.index,
    intent: result,
  };
}
