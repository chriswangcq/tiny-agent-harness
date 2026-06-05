import { describe, expect, it } from "vitest";
import {
  buildLoopFrameDetail,
  buildRunIndex,
  compareRuns,
  nextLoopFrameIndex,
  queryLoopFrames,
  resolveLoopDetailFrame,
  summarizeLoopFrames,
} from "../src/tui/debugger.js";
import type { LoopFrame, TuiViewModel } from "../src/tui/types.js";

function frame(input: Partial<LoopFrame> & Pick<LoopFrame, "id">): LoopFrame {
  return {
    stepIndex: 0,
    timestamp: "2026-05-31T00:00:00.000Z",
    phase: "tool",
    status: "ok",
    title: "tool completed",
    summary: "",
    ...input,
  };
}

describe("TUI debugger loop frame helpers", () => {
  const frames: LoopFrame[] = [
    frame({
      id: "f1",
      stepIndex: 1,
      phase: "model",
      title: "model completed",
      summary: "decision=tool_call command=pwd",
    }),
    frame({
      id: "f2",
      stepIndex: 2,
      phase: "decision",
      status: "warn",
      title: "invalid model output",
      summary: "Tool call arguments were not valid JSON.",
      detail: "## message\ninvalid JSON\n\n## raw\n{bad",
    }),
    frame({
      id: "f3",
      stepIndex: 3,
      phase: "tool",
      status: "waiting",
      title: "terminal_write timeout",
      summary: "screen=truncated",
      logPath: ".tiny-agent/sessions/default/output.log",
    }),
  ];

  it("searches across frame metadata and detail text", () => {
    expect(queryLoopFrames(frames, { text: "invalid json" }).map((f) => f.id))
      .toEqual(["f2"]);
    expect(queryLoopFrames(frames, { text: "output.log" }).map((f) => f.id))
      .toEqual(["f3"]);
    expect(queryLoopFrames(frames, { text: "STEP 1" }).map((f) => f.id))
      .toEqual(["f1"]);
  });

  it("filters by phase, status, step, and problem-only status", () => {
    expect(queryLoopFrames(frames, { phases: ["decision"] }).map((f) => f.id))
      .toEqual(["f2"]);
    expect(queryLoopFrames(frames, { statuses: ["waiting"] }).map((f) => f.id))
      .toEqual(["f3"]);
    expect(queryLoopFrames(frames, { stepIndex: 2 }).map((f) => f.id))
      .toEqual(["f2"]);
    expect(queryLoopFrames(frames, { problemsOnly: true }).map((f) => f.id))
      .toEqual(["f2"]);
  });

  it("finds the next matching frame index with optional wrapping", () => {
    expect(
      nextLoopFrameIndex(frames, {
        currentIndex: 0,
        query: { statuses: ["waiting"] },
        direction: "forward",
      }),
    ).toBe(2);
    expect(
      nextLoopFrameIndex(frames, {
        currentIndex: 0,
        query: { statuses: ["waiting"] },
        direction: "backward",
        wrap: true,
      }),
    ).toBe(2);
  });

  it("extracts stable detail sections from markdown-like frame detail", () => {
    expect(buildLoopFrameDetail(frames[1]!)).toMatchObject({
      id: "f2",
      phase: "decision",
      status: "warn",
      sections: [
        { title: "message", content: "invalid JSON" },
        { title: "raw", content: "{bad" },
      ],
    });
  });

  it("resolves selected loop detail frame before latest fallback", () => {
    expect(resolveLoopDetailFrame(frames, { selectedFrameId: "f2" })?.id)
      .toBe("f2");
  });

  it("resolves latest loop detail frame without an active selection", () => {
    expect(resolveLoopDetailFrame(frames)?.id).toBe("f3");
    expect(resolveLoopDetailFrame(frames, { selectedFrameId: "missing" })?.id)
      .toBe("f3");
  });

  it("resolves no loop detail frame from empty input", () => {
    expect(resolveLoopDetailFrame([])).toBeUndefined();
  });

  it("keeps latest loop detail resolution advancing with appended frames", () => {
    const first = resolveLoopDetailFrame(frames);
    const next = resolveLoopDetailFrame([
      ...frames,
      frame({ id: "f4", stepIndex: 4, title: "new latest" }),
    ]);

    expect(first?.id).toBe("f3");
    expect(next?.id).toBe("f4");
  });

  it("summarizes status and phase counts", () => {
    expect(summarizeLoopFrames(frames)).toMatchObject({
      total: 3,
      problemCount: 1,
      byStatus: {
        ok: 1,
        warn: 1,
        waiting: 1,
      },
      byPhase: {
        model: 1,
        decision: 1,
        tool: 1,
      },
    });
  });
});

describe("TUI debugger run helpers", () => {
  it("builds a newest-first run index from explicit snapshots", () => {
    const index = buildRunIndex([
      {
        run: {
          runId: "run-b",
          status: "running",
          stepIndex: 1,
          cwd: "/repo",
          startedAt: "2026-05-31T00:00:00.000Z",
          updatedAt: "2026-05-31T00:01:00.000Z",
        },
        loop: [frame({ id: "b1", status: "warn" })],
        conversation: [],
        sessions: [],
      },
      {
        run: {
          runId: "run-a",
          status: "waiting_for_io",
          stepIndex: 4,
          cwd: "/repo",
          startedAt: "2026-05-31T00:00:00.000Z",
          updatedAt: "2026-05-31T00:02:00.000Z",
        },
        loop: [frame({ id: "a1" }), frame({ id: "a2", status: "error" })],
        conversation: [
          {
            id: "msg-1",
            kind: "user",
            timestamp: "2026-05-31T00:00:10.000Z",
            channel: "default",
            text: "hi",
          },
        ],
        sessions: [
          {
            session: "default",
            state: "idle",
            logPath: ".tiny-agent/sessions/default/output.log",
            tail: "",
            updatedAt: "2026-05-31T00:02:00.000Z",
          },
        ],
      },
    ]);

    expect(index.map((row) => row.runId)).toEqual(["run-a", "run-b"]);
    expect(index[0]).toMatchObject({
      runId: "run-a",
      durationMs: 120000,
      frameCount: 2,
      problemFrameCount: 1,
      conversationCount: 1,
      sessionCount: 1,
    });
  });

  it("compares run summaries with explicit changed fields", () => {
    const comparison = compareRuns(
      {
        run: {
          runId: "left",
          status: "running",
          stepIndex: 1,
          cwd: "/repo",
          startedAt: "2026-05-31T00:00:00.000Z",
          updatedAt: "2026-05-31T00:01:00.000Z",
        },
        loop: [frame({ id: "l1" })],
      },
      {
        run: {
          runId: "right",
          status: "waiting_for_io",
          stepIndex: 2,
          cwd: "/repo",
          startedAt: "2026-05-31T00:00:00.000Z",
          updatedAt: "2026-05-31T00:03:00.000Z",
        },
        loop: [frame({ id: "r1" }), frame({ id: "r2", status: "warn" })],
      },
    );

    expect(comparison.changedFields).toEqual([
      "status",
      "stepIndex",
      "durationMs",
      "frameCount",
      "problemFrameCount",
    ]);
    expect(comparison.changes.find((change) => change.field === "durationMs"))
      .toMatchObject({ left: 60000, right: 180000, changed: true });
  });

  it("consumes the active TuiViewModel shape as a run snapshot", () => {
    const view: TuiViewModel = {
      run: {
        runId: "run-view",
        status: "waiting_for_io",
        stepIndex: 2,
        cwd: "/repo",
        startedAt: "2026-05-31T00:00:00.000Z",
        updatedAt: "2026-05-31T00:01:00.000Z",
      },
      conversation: [],
      loop: [frame({ id: "v1", detail: "## thinking\nlook around" })],
      sessions: [],
      activeSkills: [],
    };

    expect(buildRunIndex([view])[0]).toMatchObject({
      runId: "run-view",
      frameCount: 1,
    });
    expect(buildLoopFrameDetail(view.loop[0]!).sections).toEqual([
      { title: "thinking", content: "look around" },
    ]);
  });
});

import { extractRiskFindings, type RiskFindingEntry } from "../src/tui/debugger.js";

describe("extractRiskFindings", () => {
  const errorFinding: RiskFindingEntry = {
    code: "dangerous_recursive_delete",
    severity: "error",
    message: "Recursive delete targets a root path.",
  };
  const warningFinding: RiskFindingEntry = {
    code: "warning_network_transfer",
    severity: "warning",
    message: "Network transfer command may fetch unreviewed remote content.",
  };
  const infoFinding: RiskFindingEntry = {
    code: "safe_terminal_write",
    severity: "info",
    message: "Terminal write is allowed after policy evaluation.",
  };

  it("returns empty summary when source has no reviewDecision", () => {
    const result = extractRiskFindings({});
    expect(result.isEmpty).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.counts).toEqual({ error: 0, warning: 0, info: 0 });
  });

  it("returns empty summary when reviewDecision has no findings", () => {
    const result = extractRiskFindings({ reviewDecision: { findings: [] } });
    expect(result.isEmpty).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.counts).toEqual({ error: 0, warning: 0, info: 0 });
  });

  it("returns empty summary for null source", () => {
    const result = extractRiskFindings(null as unknown as { reviewDecision?: { findings?: RiskFindingEntry[] } });
    expect(result.isEmpty).toBe(true);
  });

  it("extracts single error finding", () => {
    const result = extractRiskFindings({
      reviewDecision: { findings: [errorFinding] },
    });
    expect(result.isEmpty).toBe(false);
    expect(result.findings).toEqual([errorFinding]);
    expect(result.counts).toEqual({ error: 1, warning: 0, info: 0 });
  });

  it("extracts mixed severity findings", () => {
    const result = extractRiskFindings({
      reviewDecision: {
        findings: [errorFinding, warningFinding, infoFinding, warningFinding],
      },
    });
    expect(result.isEmpty).toBe(false);
    expect(result.findings).toHaveLength(4);
    expect(result.counts).toEqual({ error: 1, warning: 2, info: 1 });
  });

  it("works with LoopFrame-compatible shape", () => {
    const frameLike = {
      reviewDecision: {
        findings: [errorFinding],
        status: "rejected" as const,
        reason: "Blocked",
        reviewer: "tool-policy",
      },
    };
    const result = extractRiskFindings(frameLike);
    expect(result.isEmpty).toBe(false);
    expect(result.counts.error).toBe(1);
  });
});
