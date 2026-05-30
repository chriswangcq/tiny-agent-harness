import { describe, expect, it } from "vitest";
import { TuiInteractionState } from "../src/tui/interaction-state.js";
import type { TuiPane } from "../src/tui/interaction-state.js";
import type { ConversationItem, LoopFrame } from "../src/tui/types.js";

const focusablePanes: Record<TuiPane, true> = {
  conversation: true,
  loop: true,
};

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

function conversation(id: string, text: string): ConversationItem {
  return {
    id,
    kind: "user",
    timestamp: `2026-01-01T00:00:0${id}Z`,
    channel: "default",
    text,
  };
}

describe("TuiInteractionState", () => {
  it("starts in input mode with both panes following bottom", () => {
    const state = new TuiInteractionState();

    expect(state.mode).toBe("input");
    expect(state.followBottom).toEqual({ conversation: true, loop: true });
    expect(state.selectedConversationItemId).toBeUndefined();
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
    const items = [
      conversation("a", "first"),
      conversation("b", "second"),
      conversation("c", "third"),
    ];

    state.enterBrowse([], "conversation", items);
    state.moveSelection([], -1, items);

    expect(state.selectedConversationItemId).toBe("b");
    expect(state.followBottom).toEqual({ conversation: false, loop: true });

    state.moveSelection([], -99, items);
    expect(state.selectedConversationItemId).toBe("a");
  });

  it("returning to input mode restores follow bottom and sync selects the latest frame", () => {
    const state = new TuiInteractionState();
    const frames = [frame("a", 0), frame("b", 1)];

    state.enterBrowse(frames, "loop");
    state.moveSelection(frames, -1);
    state.enterInput();

    expect(state.mode).toBe("input");
    expect(state.selectedLoopFrameId).toBeUndefined();
    expect(state.followBottom).toEqual({ conversation: true, loop: true });

    state.syncWithFrames(frames);
    expect(state.selectedLoopFrameId).toBe("b");
  });

  it("returning to input mode restores follow bottom and sync selects the latest conversation item", () => {
    const state = new TuiInteractionState();
    const items = [conversation("a", "first"), conversation("b", "second")];

    state.enterBrowse([], "conversation", items);
    state.moveSelection([], -1, items);
    state.enterInput();

    expect(state.mode).toBe("input");
    expect(state.selectedConversationItemId).toBeUndefined();
    expect(state.followBottom).toEqual({ conversation: true, loop: true });

    state.syncWithConversation(items);
    expect(state.selectedConversationItemId).toBe("b");
  });

  it("syncs selection to the latest frame when following bottom", () => {
    const state = new TuiInteractionState();
    const initial = [frame("a", 0)];
    const next = [frame("a", 0), frame("b", 1)];

    state.enterBrowse(initial, "loop");
    state.syncWithFrames(next);

    expect(state.selectedLoopFrameId).toBe("b");
  });

  it("limits focusable panes to messages and loop", () => {
    expect(Object.keys(focusablePanes)).toEqual(["conversation", "loop"]);
  });

  it("input mode keeps cursor on newest frame as frames append", () => {
    const state = new TuiInteractionState();

    state.syncWithFrames([frame("a", 0)]);
    expect(state.selectedLoopFrameId).toBe("a");

    state.syncWithFrames([frame("a", 0), frame("b", 1)]);
    expect(state.selectedLoopFrameId).toBe("b");
  });

  it("input mode keeps cursor on newest conversation item as messages append", () => {
    const state = new TuiInteractionState();

    state.syncWithConversation([conversation("a", "first")]);
    expect(state.selectedConversationItemId).toBe("a");

    state.syncWithConversation([
      conversation("a", "first"),
      conversation("b", "second"),
    ]);
    expect(state.selectedConversationItemId).toBe("b");
  });
  it("syncWithFrames does not affect conversation selection", () => {
    const state = new TuiInteractionState();
    const frames = [frame("a", 0), frame("b", 1)];
    const items = [conversation("x", "msg1"), conversation("y", "msg2")];

    state.syncWithView(items, frames);
    expect(state.selectedConversationItemId).toBe("y");
    expect(state.selectedLoopFrameId).toBe("b");

    state.syncWithFrames([frame("c", 2)]);
    expect(state.selectedLoopFrameId).toBe("c");
    // conversation selection must not be cleared
    expect(state.selectedConversationItemId).toBe("y");
  });

  it("syncWithConversation does not affect loop selection", () => {
    const state = new TuiInteractionState();
    const frames = [frame("a", 0), frame("b", 1)];
    const items = [conversation("x", "msg1"), conversation("y", "msg2")];

    state.syncWithView(items, frames);
    expect(state.selectedConversationItemId).toBe("y");
    expect(state.selectedLoopFrameId).toBe("b");

    state.syncWithConversation([conversation("z", "msg3")]);
    expect(state.selectedConversationItemId).toBe("z");
    // loop selection must not be cleared
    expect(state.selectedLoopFrameId).toBe("b");
  });

});
