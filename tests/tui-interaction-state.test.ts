import { describe, expect, it } from "vitest";
import { TuiInteractionState } from "../src/tui/interaction-state.js";
import type { LoopFrame } from "../src/tui/types.js";

function frame(id: string, stepIndex: number): LoopFrame {
  return {
    id,
    stepIndex,
    timestamp: `2026-01-01T00:00:0${stepIndex}Z`,
    phase: "model",
    status: "ok",
    title: `frame ${id}`,
    summary: "",
  };
}

describe("TuiInteractionState", () => {
  it("starts in input mode with both panes following bottom", () => {
    const state = new TuiInteractionState();

    expect(state.mode).toBe("input");
    expect(state.followBottom).toEqual({ conversation: true, loop: true });
    expect(state.selectedLoopFrameId).toBeUndefined();
  });

  it("entering loop browse selects the latest loop frame", () => {
    const state = new TuiInteractionState();

    state.enterBrowse([frame("a", 0), frame("b", 1)], "loop");

    expect(state.mode).toBe("browse");
    expect(state.pane).toBe("loop");
    expect(state.selectedLoopFrameId).toBe("b");
  });

  it("moves loop selection by frame id and disables only loop follow", () => {
    const state = new TuiInteractionState();
    const frames = [frame("a", 0), frame("b", 1), frame("c", 2)];

    state.enterBrowse(frames, "loop");
    state.moveSelection(frames, -1);

    expect(state.selectedLoopFrameId).toBe("b");
    expect(state.followBottom).toEqual({ conversation: true, loop: false });

    state.moveSelection(frames, -99);
    expect(state.selectedLoopFrameId).toBe("a");
  });

  it("conversation browsing disables only conversation follow", () => {
    const state = new TuiInteractionState();

    state.enterBrowse([], "conversation");
    state.moveSelection([], 1);

    expect(state.followBottom).toEqual({ conversation: false, loop: true });
  });

  it("returning to input mode clears selection and restores follow bottom", () => {
    const state = new TuiInteractionState();

    state.enterBrowse([frame("a", 0)], "loop");
    state.moveSelection([frame("a", 0)], -1);
    state.enterInput();

    expect(state.mode).toBe("input");
    expect(state.selectedLoopFrameId).toBeUndefined();
    expect(state.followBottom).toEqual({ conversation: true, loop: true });
  });

  it("syncs selection to the latest frame when following bottom", () => {
    const state = new TuiInteractionState();
    const initial = [frame("a", 0)];
    const next = [frame("a", 0), frame("b", 1)];

    state.enterBrowse(initial, "loop");
    state.syncWithFrames(next);

    expect(state.selectedLoopFrameId).toBe("b");
  });

  it("right-detail focus preserves selected loop frame without changing follow state", () => {
    const state = new TuiInteractionState();
    const frames = [frame("a", 0), frame("b", 1)];

    state.enterBrowse(frames, "loop");
    state.enterDetail(frames);
    state.moveSelection(frames, -1);

    expect(state.pane).toBe("detail");
    expect(state.selectedLoopFrameId).toBe("b");
    expect(state.followBottom).toEqual({ conversation: true, loop: true });

    state.leaveDetail(frames);
    expect(state.pane).toBe("loop");
    expect(state.selectedLoopFrameId).toBe("b");
  });
});
