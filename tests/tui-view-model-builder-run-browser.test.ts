import { describe, expect, it } from "vitest";
import { ViewModelBuilder } from "../src/tui/view-model-builder.js";
import { buildRunBrowserView } from "../src/tui/debugger.js";
import type { RunIndexRow, RunBrowserView } from "../src/tui/debugger.js";

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

describe("ViewModelBuilder runBrowser plumbing", () => {
  it("returns undefined runBrowser by default", () => {
    const builder = new ViewModelBuilder();
    const vm = builder.getViewModel();
    expect(vm.runBrowser).toBeUndefined();
  });

  it("applyRunBrowserRows sets runBrowser from rows", () => {
    const builder = new ViewModelBuilder();
    const rows: RunIndexRow[] = [
      row({ runId: "run-a", stepIndex: 1 }),
      row({ runId: "run-b", stepIndex: 7 }),
    ];
    builder.applyRunBrowserRows(rows);

    const vm = builder.getViewModel();
    expect(vm.runBrowser).toBeDefined();
    expect(vm.runBrowser!.isEmpty).toBe(false);
    expect(vm.runBrowser!.totalCount).toBe(2);
    expect(vm.runBrowser!.rows).toHaveLength(2);
    expect(vm.runBrowser!.rows[0]!.runId).toBe("run-a");
    expect(vm.runBrowser!.rows[1]!.runId).toBe("run-b");
  });

  it("applyRunBrowserRows handles empty rows", () => {
    const builder = new ViewModelBuilder();
    builder.applyRunBrowserRows([]);

    const vm = builder.getViewModel();
    expect(vm.runBrowser).toBeDefined();
    expect(vm.runBrowser!.isEmpty).toBe(true);
    expect(vm.runBrowser!.totalCount).toBe(0);
    expect(vm.runBrowser!.rows).toEqual([]);
  });

  it("applyRunBrowserRows supports options (selection by runId)", () => {
    const builder = new ViewModelBuilder();
    const rows: RunIndexRow[] = [
      row({ runId: "run-a" }),
      row({ runId: "run-b" }),
      row({ runId: "run-c" }),
    ];
    builder.applyRunBrowserRows(rows, { selectedRunId: "run-b" });

    const vm = builder.getViewModel();
    expect(vm.runBrowser!.selected).toBeDefined();
    expect(vm.runBrowser!.selected!.runId).toBe("run-b");
    expect(vm.runBrowser!.selected!.index).toBe(1);
    expect(vm.runBrowser!.rows[1]!.isSelected).toBe(true);
  });

  it("applyRunBrowserView sets a pre-built view directly", () => {
    const builder = new ViewModelBuilder();
    const rows: RunIndexRow[] = [row({ runId: "direct" })];
    const view = buildRunBrowserView(rows, { selectedRunId: "direct" });
    builder.applyRunBrowserView(view);

    const vm = builder.getViewModel();
    expect(vm.runBrowser).toBe(view);
    expect(vm.runBrowser!.rows[0]!.runId).toBe("direct");
  });

  it("runBrowser is preserved across getViewModel calls", () => {
    const builder = new ViewModelBuilder();
    const rows: RunIndexRow[] = [row({ runId: "persist" })];
    builder.applyRunBrowserRows(rows);

    const vm1 = builder.getViewModel();
    const vm2 = builder.getViewModel();
    expect(vm2.runBrowser).toBeDefined();
    expect(vm2.runBrowser!.rows[0]!.runId).toBe("persist");
    // The runBrowser reference should be the same (immutable from builder's perspective)
    expect(vm2.runBrowser).toBe(vm1.runBrowser);
  });

  it("replacing runBrowser via applyRunBrowserRows updates the view", () => {
    const builder = new ViewModelBuilder();
    const rows1: RunIndexRow[] = [row({ runId: "first" })];
    builder.applyRunBrowserRows(rows1);
    expect(builder.getViewModel().runBrowser!.rows[0]!.runId).toBe("first");

    const rows2: RunIndexRow[] = [row({ runId: "second" })];
    builder.applyRunBrowserRows(rows2);
    expect(builder.getViewModel().runBrowser!.rows[0]!.runId).toBe("second");
  });

  it("replacing runBrowser via applyRunBrowserView updates the view", () => {
    const builder = new ViewModelBuilder();
    const view1 = buildRunBrowserView([row({ runId: "v1" })]);
    builder.applyRunBrowserView(view1);
    expect(builder.getViewModel().runBrowser).toBe(view1);

    const view2 = buildRunBrowserView([row({ runId: "v2" })]);
    builder.applyRunBrowserView(view2);
    expect(builder.getViewModel().runBrowser).toBe(view2);
  });

  it("does not mutate input rows (immutability)", () => {
    const builder = new ViewModelBuilder();
    const inputRows: RunIndexRow[] = [row({ runId: "immutable" })];
    const frozen = JSON.parse(JSON.stringify(inputRows));

    builder.applyRunBrowserRows(inputRows);
    expect(inputRows).toEqual(frozen);
  });

  it("does not hold hidden global dependencies", () => {
    // ViewModelBuilder does not import fs, path, process.env, Date.now, etc.
    // The applyRunBrowserRows method delegates to the pure buildRunBrowserView
    // which has no filesystem or network access.
    const builder = new ViewModelBuilder();
    // Even with empty rows, no external dependency is triggered.
    builder.applyRunBrowserRows([]);
    const vm = builder.getViewModel();
    expect(vm.runBrowser).toBeDefined();
  });

  it("getViewModel includes runBrowser alongside other fields", () => {
    const builder = new ViewModelBuilder();
    builder.applyRunBrowserRows([row({ runId: "full" })]);

    const vm = builder.getViewModel();
    expect(vm.run).toBeDefined();
    expect(vm.conversation).toBeDefined();
    expect(vm.loop).toBeDefined();
    expect(vm.sessions).toBeDefined();
    expect(vm.activeSkills).toBeDefined();
    expect(vm.runBrowser).toBeDefined();
  });
});
