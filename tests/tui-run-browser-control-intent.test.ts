import { describe, expect, it } from "vitest";
import {
  buildRunBrowserControlIntent,
  buildRunBrowserControlIntentDisplay,
  buildRunBrowserView,
  formatRunBrowserControlAction,
  type RunBrowserControlActionLabel,
  type RunBrowserControlIntent,
  type RunBrowserControlIntentDisplay,
  type RunBrowserControlRequest,
  type RunIndexRow,
} from "../src/tui/debugger.js";

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

function rows(...ids: string[]): RunIndexRow[] {
  return ids.map((id) => row({ runId: id }));
}

function expectIntent(
  result: ReturnType<typeof buildRunBrowserControlIntent>,
): RunBrowserControlIntent {
  expect(result).not.toHaveProperty("kind");
  if ("kind" in result) throw new Error(`expected intent, got ${result.kind}`);
  expect(result.effect).toBe("none");
  expect(result.owner).toBe("runtime_cli");
  expect(result.review).toBe("required");
  expect(result).not.toHaveProperty("requestedAt");
  return result;
}

describe("buildRunBrowserControlIntent valid construction", () => {
  it("constructs attach intent by runId", () => {
    const intent = expectIntent(
      buildRunBrowserControlIntent(rows("run-a", "run-b"), {
        action: "attach",
        runId: "run-a",
      }),
    );

    expect(intent).toMatchObject({
      action: "attach",
      runId: "run-a",
      index: 0,
    });
  });

  it("constructs resume intent by runId", () => {
    const intent = expectIntent(
      buildRunBrowserControlIntent(rows("x", "y"), {
        action: "resume",
        runId: "y",
      }),
    );

    expect(intent).toMatchObject({
      action: "resume",
      runId: "y",
      index: 1,
    });
  });

  it("constructs control intent by runId", () => {
    const intent = expectIntent(
      buildRunBrowserControlIntent(rows("z"), {
        action: "control",
        runId: "z",
      }),
    );

    expect(intent.action).toBe("control");
    expect(intent.runId).toBe("z");
  });

  it("constructs intent by selected row index", () => {
    const intent = expectIntent(
      buildRunBrowserControlIntent(rows("a", "b", "c"), {
        action: "attach",
        index: 2,
      }),
    );

    expect(intent.runId).toBe("c");
    expect(intent.index).toBe(2);
  });

  it("prefers runId over index when both are provided", () => {
    const intent = expectIntent(
      buildRunBrowserControlIntent(rows("by-id", "by-index"), {
        action: "attach",
        runId: "by-id",
        index: 1,
      }),
    );

    expect(intent.runId).toBe("by-id");
    expect(intent.index).toBe(0);
  });

  it("is deterministic for identical explicit inputs", () => {
    const inputRows = rows("same");
    const request = {
      action: "attach",
      runId: "same",
    } satisfies RunBrowserControlRequest;

    const first = expectIntent(buildRunBrowserControlIntent(inputRows, request));
    const second = expectIntent(buildRunBrowserControlIntent(inputRows, request));

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });
});

describe("buildRunBrowserControlIntent missing target", () => {
  it("rejects when no target is provided", () => {
    const error = buildRunBrowserControlIntent(rows("r1"), {
      action: "attach",
    });

    expect(error).toHaveProperty("kind", "missing_run_id");
    if (!("kind" in error)) throw new Error("expected error");
    expect(error.message).toContain("No runId");
  });

  it("rejects when index is out of range for empty rows", () => {
    const error = buildRunBrowserControlIntent([], {
      action: "attach",
      index: 0,
    });

    expect(error).toHaveProperty("kind", "missing_run_id");
    if (!("kind" in error)) throw new Error("expected error");
    expect(error.message).toContain("out of range");
  });

  it("rejects when index is out of range for non-empty rows", () => {
    const error = buildRunBrowserControlIntent(rows("a", "b"), {
      action: "resume",
      index: 5,
    });

    expect(error).toHaveProperty("kind", "missing_run_id");
    if (!("kind" in error)) throw new Error("expected error");
    expect(error.message).toContain("5");
  });

  it("rejects a negative index", () => {
    const error = buildRunBrowserControlIntent(rows("a"), {
      action: "control",
      index: -1,
    });

    expect(error).toHaveProperty("kind", "missing_run_id");
  });

  it("treats an empty string runId as missing", () => {
    const error = buildRunBrowserControlIntent(rows("a"), {
      action: "attach",
      runId: "",
    });

    expect(error).toHaveProperty("kind", "missing_run_id");
  });
});

describe("buildRunBrowserControlIntent unknown run id", () => {
  it("rejects an unknown runId", () => {
    const error = buildRunBrowserControlIntent(rows("real"), {
      action: "attach",
      runId: "ghost",
    });

    expect(error).toHaveProperty("kind", "unknown_run_id");
    if (!("kind" in error)) throw new Error("expected error");
    expect(error.message).toContain("ghost");
  });

  it("rejects a runId against an empty row list", () => {
    const error = buildRunBrowserControlIntent([], {
      action: "resume",
      runId: "any",
    });

    expect(error).toHaveProperty("kind", "unknown_run_id");
  });
});

describe("buildRunBrowserControlIntent unsafe mutation", () => {
  it("rejects a direct mutation request even when the run target is valid", () => {
    const error = buildRunBrowserControlIntent(rows("run-1"), {
      action: "attach",
      runId: "run-1",
      directMutation: true,
    });

    expect(error).toHaveProperty("kind", "unsafe_mutation");
    if (!("kind" in error)) throw new Error("expected error");
    expect(error.message).toContain("intent only");
  });

  it("rejects direct mutation before target resolution", () => {
    const error = buildRunBrowserControlIntent(rows("real"), {
      action: "control",
      runId: "ghost",
      directMutation: true,
    });

    expect(error).toHaveProperty("kind", "unsafe_mutation");
  });
});

describe("buildRunBrowserControlIntent side-effect boundary", () => {
  it("does not mutate input rows in the success path", () => {
    const inputRows = rows("a");
    const frozen = JSON.parse(JSON.stringify(inputRows));

    buildRunBrowserControlIntent(inputRows, { action: "attach", runId: "a" });

    expect(inputRows).toEqual(frozen);
  });

  it("does not mutate input rows in the error path", () => {
    const inputRows = rows("real");
    const frozen = JSON.parse(JSON.stringify(inputRows));

    buildRunBrowserControlIntent(inputRows, {
      action: "attach",
      runId: "ghost",
    });

    expect(inputRows).toEqual(frozen);
  });
});

describe("buildRunBrowserControlIntent run browser view integration", () => {
  it("uses selected row data from the pure run browser view", () => {
    const inputRows = rows("r1", "r2");
    const view = buildRunBrowserView(inputRows, { selectedRunId: "r2" });
    if (!view.selected) throw new Error("expected selected row");

    const intent = expectIntent(
      buildRunBrowserControlIntent(inputRows, {
        action: "attach",
        runId: view.selected.runId,
        index: view.selected.index,
      }),
    );

    expect(intent.runId).toBe("r2");
    expect(intent.index).toBe(1);
  });

  it("constructs an explicit inert intent for every supported action", () => {
    for (const action of ["attach", "resume", "control"] as const) {
      const intent = expectIntent(
        buildRunBrowserControlIntent(rows("target"), {
          action,
          runId: "target",
        }),
      );

      expect(intent.action).toBe(action);
      expect(intent.effect).toBe("none");
    }
  });
});

describe("formatRunBrowserControlAction", () => {
  it("maps attach to Attach", () => {
    expect(formatRunBrowserControlAction("attach")).toBe("Attach");
  });

  it("maps resume to Resume", () => {
    expect(formatRunBrowserControlAction("resume")).toBe("Resume");
  });

  it("maps control to Control", () => {
    expect(formatRunBrowserControlAction("control")).toBe("Control");
  });

  it("is pure and deterministic", () => {
    expect(formatRunBrowserControlAction("attach"))
      .toBe(formatRunBrowserControlAction("attach"));
  });

  it("returns a value assignable to RunBrowserControlActionLabel", () => {
    const label: RunBrowserControlActionLabel =
      formatRunBrowserControlAction("resume");
    expect(label).toBe("Resume");
  });
});

describe("buildRunBrowserControlIntentDisplay", () => {
  it("produces valid display for a valid intent", () => {
    const display = buildRunBrowserControlIntentDisplay(
      rows("run-a", "run-b"),
      { action: "attach", runId: "run-a" },
    );

    expect(display.valid).toBe(true);
    expect(display.actionLabel).toBe("Attach");
    expect(display.action).toBe("attach");
    expect(display.status).toBe("valid");
    expect(display.runId).toBe("run-a");
    expect(display.index).toBe(0);
    expect(display.intent).toBeDefined();
    expect(display.intent!.effect).toBe("none");
    expect(display.intent!.owner).toBe("runtime_cli");
    expect(display.intent!.review).toBe("required");
    expect(display.errorKind).toBeUndefined();
    expect(display.errorMessage).toBeUndefined();
  });

  it("produces error display for missing target", () => {
    const display = buildRunBrowserControlIntentDisplay(
      rows("r1"),
      { action: "resume" },
    );

    expect(display.valid).toBe(false);
    expect(display.status).toBe("error");
    expect(display.actionLabel).toBe("Resume");
    expect(display.action).toBe("resume");
    expect(display.errorKind).toBe("missing_run_id");
    expect(display.errorMessage).toContain("No runId");
    expect(display.runId).toBeUndefined();
    expect(display.index).toBeUndefined();
    expect(display.intent).toBeUndefined();
  });

  it("produces error display for unknown run id", () => {
    const display = buildRunBrowserControlIntentDisplay(
      rows("real"),
      { action: "control", runId: "ghost" },
    );

    expect(display.valid).toBe(false);
    expect(display.actionLabel).toBe("Control");
    expect(display.errorKind).toBe("unknown_run_id");
    expect(display.errorMessage).toContain("ghost");
  });

  it("produces error display for unsafe mutation", () => {
    const display = buildRunBrowserControlIntentDisplay(
      rows("run-1"),
      { action: "attach", runId: "run-1", directMutation: true },
    );

    expect(display.valid).toBe(false);
    expect(display.errorKind).toBe("unsafe_mutation");
    expect(display.errorMessage).toContain("intent only");
  });

  it("reports correct action label for every action", () => {
    const cases: Array<{
      action: "attach" | "resume" | "control";
      label: RunBrowserControlActionLabel;
    }> = [
      { action: "attach", label: "Attach" },
      { action: "resume", label: "Resume" },
      { action: "control", label: "Control" },
    ];

    for (const { action, label } of cases) {
      const display = buildRunBrowserControlIntentDisplay(
        rows("t"),
        { action, runId: "t" },
      );

      expect(display.valid).toBe(true);
      expect(display.actionLabel).toBe(label);
    }
  });

  it("is deterministic for identical inputs", () => {
    const inputRows = rows("same");
    const request = { action: "attach" as const, runId: "same" };

    const first = buildRunBrowserControlIntentDisplay(inputRows, request);
    const second = buildRunBrowserControlIntentDisplay(inputRows, request);

    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it("does not mutate input rows on success path", () => {
    const inputRows = rows("a", "b");
    const frozen = JSON.parse(JSON.stringify(inputRows));

    buildRunBrowserControlIntentDisplay(inputRows, {
      action: "attach",
      runId: "a",
    });

    expect(inputRows).toEqual(frozen);
  });

  it("does not mutate input rows on error path", () => {
    const inputRows = rows("real");
    const frozen = JSON.parse(JSON.stringify(inputRows));

    buildRunBrowserControlIntentDisplay(inputRows, {
      action: "control",
      runId: "ghost",
    });

    expect(inputRows).toEqual(frozen);
  });

  it("assigns display to RunBrowserControlIntentDisplay type", () => {
    const display: RunBrowserControlIntentDisplay =
      buildRunBrowserControlIntentDisplay(
        rows("x"),
        { action: "attach", runId: "x" },
      );

    expect(display.valid).toBe(true);
    expect(display.actionLabel).toBe("Attach");
  });
});
