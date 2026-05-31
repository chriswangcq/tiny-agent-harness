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
