import { describe, expect, it } from "vitest";
import { buildRunBrowserView } from "../src/tui/debugger.js";
import type { RunIndexRow } from "../src/tui/debugger.js";

function row(overrides: Partial<RunIndexRow> & { runId: string }): RunIndexRow {
  return {
    runId: overrides.runId,
    status: "running",
    stepIndex: 0,
    cwd: "/repo",
    frameCount: 0,
    problemFrameCount: 0,
    conversationCount: 0,
    sessionCount: 0,
    ...overrides,
  };
}

describe("buildRunBrowserView", () => {
  it("returns empty view for empty rows", () => {
    const view = buildRunBrowserView([]);
    expect(view.isEmpty).toBe(true);
    expect(view.totalCount).toBe(0);
    expect(view.rows).toEqual([]);
    expect(view.selected).toBeUndefined();
  });

  it("formats all rows for display", () => {
    const rows: RunIndexRow[] = [
      row({ runId: "run-a", stepIndex: 3, cwd: "/home/user/project" }),
      row({ runId: "run-b", stepIndex: 7, cwd: "/tmp", status: "failed" }),
    ];
    const view = buildRunBrowserView(rows);
    expect(view.isEmpty).toBe(false);
    expect(view.totalCount).toBe(2);
    expect(view.rows).toHaveLength(2);

    expect(view.rows[0]).toMatchObject({
      runId: "run-a",
      index: 0,
      stepDisplay: "step 3",
      isSelected: false,
    });
    expect(view.rows[0]!.cwdPreview).toBe(".../user/project");
    expect(view.rows[1]).toMatchObject({
      runId: "run-b",
      index: 1,
      stepDisplay: "step 7",
      statusDisplay: "FAILED",
      cwdPreview: "/tmp",
      isSelected: false,
    });
  });

  it("selects by runId", () => {
    const rows: RunIndexRow[] = [
      row({ runId: "run-a" }),
      row({ runId: "run-b" }),
      row({ runId: "run-c" }),
    ];
    const view = buildRunBrowserView(rows, { selectedRunId: "run-b" });
    expect(view.selected).toBeDefined();
    expect(view.selected!.runId).toBe("run-b");
    expect(view.selected!.index).toBe(1);
    expect(view.rows[0]!.isSelected).toBe(false);
    expect(view.rows[1]!.isSelected).toBe(true);
    expect(view.rows[2]!.isSelected).toBe(false);
  });

  it("builds selected run control intent display metadata", () => {
    const rows: RunIndexRow[] = [
      row({ runId: "run-a" }),
      row({ runId: "run-b" }),
    ];
    const view = buildRunBrowserView(rows, { selectedRunId: "run-b" });

    expect(view.controlIntentDisplays).toHaveLength(3);
    expect(view.controlIntentDisplays?.map((display) => display.actionLabel)).toEqual([
      "Attach",
      "Resume",
      "Control",
    ]);

    for (const display of view.controlIntentDisplays ?? []) {
      expect(display.valid).toBe(true);
      if (!display.valid) throw new Error("expected valid control intent display");
      expect(display.status).toBe("valid");
      expect(display.runId).toBe("run-b");
      expect(display.index).toBe(1);
      expect(display.intent.effect).toBe("none");
      expect(display.intent.owner).toBe("runtime_cli");
      expect(display.intent.review).toBe("required");
    }
  });

  it("selects by index", () => {
    const rows: RunIndexRow[] = [
      row({ runId: "run-a" }),
      row({ runId: "run-b" }),
    ];
    const view = buildRunBrowserView(rows, { selectedIndex: 1 });
    expect(view.selected!.runId).toBe("run-b");
    expect(view.selected!.index).toBe(1);
    expect(view.rows[1]!.isSelected).toBe(true);
  });

  it("falls back to no selection for unknown runId", () => {
    const rows: RunIndexRow[] = [row({ runId: "run-a" })];
    const view = buildRunBrowserView(rows, { selectedRunId: "nonexistent" });
    expect(view.selected).toBeUndefined();
    expect(view.rows[0]!.isSelected).toBe(false);
    expect(view.controlIntentDisplays).toBeUndefined();
  });

  it("falls back to no selection for out-of-range index", () => {
    const rows: RunIndexRow[] = [row({ runId: "run-a" })];
    const view = buildRunBrowserView(rows, { selectedIndex: 5 });
    expect(view.selected).toBeUndefined();
  });

  it("falls back to no selection for negative index", () => {
    const rows: RunIndexRow[] = [row({ runId: "run-a" })];
    const view = buildRunBrowserView(rows, { selectedIndex: -1 });
    expect(view.selected).toBeUndefined();
  });

  it("provides detail for selected row", () => {
    const rows: RunIndexRow[] = [
      row({
        runId: "run-a",
        status: "waiting_for_io",
        stepIndex: 5,
        cwd: "/home/dev/work",
        startedAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:01:30.000Z",
        durationMs: 90000,
        frameCount: 12,
        problemFrameCount: 2,
        conversationCount: 3,
        sessionCount: 1,
        taskPreview: "Fix failing tests",
        failureSummary: "Timeout on step 4",
      }),
      row({ runId: "run-b" }),
    ];
    const view = buildRunBrowserView(rows, { selectedRunId: "run-a" });
    expect(view.selected).toBeDefined();
    const detail = view.selected!.detail;
    expect(detail).toMatchObject({
      runId: "run-a",
      status: "waiting_for_io",
      stepIndex: 5,
      cwd: "/home/dev/work",
      startedAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-01T00:01:30.000Z",
      frameCount: 12,
      problemFrameCount: 2,
      conversationCount: 3,
      sessionCount: 1,
      taskPreview: "Fix failing tests",
      failureSummary: "Timeout on step 4",
    });
  });
});

describe("buildRunBrowserView status display", () => {
  const statusCases: [string, string][] = [
    ["created", "created"],
    ["running", "running"],
    ["waiting_for_model", "wait:model"],
    ["waiting_for_review", "wait:review"],
    ["waiting_for_tool", "wait:tool"],
    ["waiting_for_io", "wait:io"],
    ["failed", "FAILED"],
    ["cancelled", "cancelled"],
  ];

  for (const [status, display] of statusCases) {
    it(`displays "${status}" as "${display}"`, () => {
      const rows: RunIndexRow[] = [row({ runId: "r", status: status as RunIndexRow["status"] })];
      const view = buildRunBrowserView(rows);
      expect(view.rows[0]!.statusDisplay).toBe(display);
    });
  }

  it("passes through unknown status", () => {
    const rows: RunIndexRow[] = [row({ runId: "r", status: "unknown_status" as RunIndexRow["status"] })];
    const view = buildRunBrowserView(rows);
    expect(view.rows[0]!.statusDisplay).toBe("unknown_status");
  });
});

describe("buildRunBrowserView task preview", () => {
  it("uses taskPreview from row", () => {
    const rows: RunIndexRow[] = [
      row({ runId: "r", taskPreview: "Add new feature" }),
    ];
    const view = buildRunBrowserView(rows, { selectedRunId: "r" });
    expect(view.rows[0]!.taskPreview).toBe("Add new feature");
    expect(view.selected!.detail.taskPreview).toBe("Add new feature");
  });

  it("uses empty string when taskPreview is undefined", () => {
    const rows: RunIndexRow[] = [row({ runId: "r" })];
    const view = buildRunBrowserView(rows, { selectedRunId: "r" });
    expect(view.rows[0]!.taskPreview).toBe("");
    expect(view.selected!.detail.taskPreview).toBeUndefined();
    expect(view.selected!.detail.failureSummary).toBeUndefined();
  });
});

describe("buildRunBrowserView failure summary", () => {
  it("includes failureSummary in detail", () => {
    const rows: RunIndexRow[] = [
      row({ runId: "r", failureSummary: "API key not found" }),
    ];
    const view = buildRunBrowserView(rows, { selectedRunId: "r" });
    expect(view.rows[0]!.failureSummary).toBe("API key not found");
    expect(view.selected!.detail.failureSummary).toBe("API key not found");
  });

  it("leaves failureSummary undefined when missing", () => {
    const rows: RunIndexRow[] = [row({ runId: "r" })];
    const view = buildRunBrowserView(rows, { selectedRunId: "r" });
    expect(view.rows[0]!.failureSummary).toBeUndefined();
    expect(view.selected!.detail.failureSummary).toBeUndefined();
  });
});

describe("buildRunBrowserView cwd preview", () => {
  it("shows full short path", () => {
    const rows: RunIndexRow[] = [row({ runId: "r", cwd: "/repo" })];
    expect(buildRunBrowserView(rows).rows[0]!.cwdPreview).toBe("/repo");
  });

  it("truncates deep paths to last 2 segments", () => {
    const rows: RunIndexRow[] = [row({ runId: "r", cwd: "/a/b/c/d/e" })];
    expect(buildRunBrowserView(rows).rows[0]!.cwdPreview).toBe(".../d/e");
  });

  it("handles exactly 2 segments", () => {
    const rows: RunIndexRow[] = [row({ runId: "r", cwd: "/home/user" })];
    expect(buildRunBrowserView(rows).rows[0]!.cwdPreview).toBe("/home/user");
  });

  it("shows single segment with leading slash", () => {
    const rows: RunIndexRow[] = [row({ runId: "r", cwd: "/tmp" })];
    expect(buildRunBrowserView(rows).rows[0]!.cwdPreview).toBe("/tmp");
  });

  it("returns empty string for empty cwd", () => {
    const rows: RunIndexRow[] = [row({ runId: "r", cwd: "" })];
    expect(buildRunBrowserView(rows).rows[0]!.cwdPreview).toBe("");
  });

  it("handles trailing slashes", () => {
    const rows: RunIndexRow[] = [row({ runId: "r", cwd: "/repo/" })];
    expect(buildRunBrowserView(rows).rows[0]!.cwdPreview).toBe("/repo");
  });

  it("handles relative paths", () => {
    const rows: RunIndexRow[] = [row({ runId: "r", cwd: "project/sub" })];
    expect(buildRunBrowserView(rows).rows[0]!.cwdPreview).toBe("project/sub");
  });
});

describe("buildRunBrowserView duration display", () => {
  it('returns "--" for undefined duration', () => {
    const rows: RunIndexRow[] = [row({ runId: "r" })];
    expect(buildRunBrowserView(rows).rows[0]!.durationDisplay).toBe("--");
  });

  it('returns "--" for negative duration', () => {
    const rows: RunIndexRow[] = [row({ runId: "r", durationMs: -1 })];
    expect(buildRunBrowserView(rows).rows[0]!.durationDisplay).toBe("--");
  });

  it("formats seconds", () => {
    const rows: RunIndexRow[] = [row({ runId: "r", durationMs: 45000 })];
    expect(buildRunBrowserView(rows).rows[0]!.durationDisplay).toBe("45s");
  });

  it("formats minutes without seconds", () => {
    const rows: RunIndexRow[] = [row({ runId: "r", durationMs: 120000 })];
    expect(buildRunBrowserView(rows).rows[0]!.durationDisplay).toBe("2m");
  });

  it("formats minutes with seconds", () => {
    const rows: RunIndexRow[] = [row({ runId: "r", durationMs: 150000 })];
    expect(buildRunBrowserView(rows).rows[0]!.durationDisplay).toBe("2m 30s");
  });

  it("formats hours without minutes", () => {
    const rows: RunIndexRow[] = [row({ runId: "r", durationMs: 3600000 })];
    expect(buildRunBrowserView(rows).rows[0]!.durationDisplay).toBe("1h");
  });

  it("formats hours with minutes", () => {
    const rows: RunIndexRow[] = [row({ runId: "r", durationMs: 5400000 })];
    expect(buildRunBrowserView(rows).rows[0]!.durationDisplay).toBe("1h 30m");
  });

  it("uses duration in detail", () => {
    const rows: RunIndexRow[] = [row({ runId: "r", durationMs: 90000 })];
    const view = buildRunBrowserView(rows, { selectedRunId: "r" });
    expect(view.selected!.detail.durationDisplay).toBe("1m 30s");
  });
});

describe("buildRunBrowserView truncation / format boundaries", () => {
  it("handles exactly 59 seconds", () => {
    const rows: RunIndexRow[] = [row({ runId: "r", durationMs: 59000 })];
    expect(buildRunBrowserView(rows).rows[0]!.durationDisplay).toBe("59s");
  });

  it("handles exactly 60 seconds", () => {
    const rows: RunIndexRow[] = [row({ runId: "r", durationMs: 60000 })];
    expect(buildRunBrowserView(rows).rows[0]!.durationDisplay).toBe("1m");
  });

  it("handles zero duration", () => {
    const rows: RunIndexRow[] = [row({ runId: "r", durationMs: 0 })];
    expect(buildRunBrowserView(rows).rows[0]!.durationDisplay).toBe("0s");
  });

  it("displays step display with zero", () => {
    const rows: RunIndexRow[] = [row({ runId: "r", stepIndex: 0 })];
    expect(buildRunBrowserView(rows).rows[0]!.stepDisplay).toBe("step 0");
  });

  it("handles single row without selection", () => {
    const rows: RunIndexRow[] = [row({ runId: "r" })];
    const view = buildRunBrowserView(rows);
    expect(view.totalCount).toBe(1);
    expect(view.isEmpty).toBe(false);
    expect(view.selected).toBeUndefined();
  });
});
