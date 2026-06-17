import { describe, expect, it } from "vitest";
import type { WorkbenchViewUpdated } from "../src/runtime/project-workbench.js";
import {
  addControllerNotice,
  addPendingUserEcho,
  applyWorkbenchViewUpdate,
  buildControllerRenderView,
  createTuiControllerState,
  pendingUserEchoFromPost,
  setControllerSelectedRun,
} from "../src/tui/controller-state.js";
import type { ConversationItem, TuiViewModel } from "../src/tui/types.js";

function makeView(input: {
  runId?: string;
  conversation?: ConversationItem[];
} = {}): TuiViewModel {
  const runId = input.runId ?? "";
  return {
    run: {
      runId,
      status: runId ? "waiting_for_io" : "created",
      stepIndex: runId ? 1 : 0,
      cwd: runId ? "/repo" : "",
    },
    conversation: [...(input.conversation ?? [])],
    loop: [],
    sessions: [],
    activeSkills: [],
  };
}

function userMessage(id: string, text: string): ConversationItem {
  return {
    id,
    kind: "user",
    timestamp: "2026-06-17T00:00:00.000Z",
    channel: "run:run-1",
    text,
  };
}

describe("TuiControllerState", () => {
  it("composes workbench view, notices, and pending user echoes deterministically", () => {
    const base = makeView({
      runId: "run-1",
      conversation: [userMessage("user:existing", "already posted")],
    });
    let state = createTuiControllerState({ lastWorkbenchView: base });
    state = addControllerNotice(state, {
      id: "notice-1",
      timestamp: "2026-06-17T00:00:01.000Z",
      text: "connected",
    });
    state = addPendingUserEcho(state, userMessage("user:pending", "local echo"));
    state = addPendingUserEcho(state, userMessage("user:existing", "duplicate"));

    const rendered = buildControllerRenderView({
      state,
      emptyView: makeView(),
    });

    expect(rendered.conversation.map((item) => item.id)).toEqual([
      "user:existing",
      "user:pending",
    ]);
    expect(rendered.notices).toEqual([
      {
        id: "notice-1",
        timestamp: "2026-06-17T00:00:01.000Z",
        text: "connected",
      },
    ]);
  });

  it("updates selected run and prunes pending echoes when a workbench view catches up", () => {
    let state = createTuiControllerState({
      selectedRunId: "run-old",
      pendingUserEchoes: [
        userMessage("user:msg-1", "sent"),
        userMessage("user:msg-2", "still pending"),
      ],
    });
    const event: WorkbenchViewUpdated = {
      kind: "view.updated",
      reason: "send-message",
      selectedRunId: "run-1",
      view: makeView({
        runId: "run-1",
        conversation: [userMessage("user:msg-1", "sent")],
      }),
    };

    state = applyWorkbenchViewUpdate(state, event);

    expect(state.selectedRunId).toBe("run-1");
    expect(state.pendingUserEchoes.map((item) => item.id)).toEqual(["user:msg-2"]);
    expect(
      buildControllerRenderView({ state, emptyView: makeView() }).conversation.map(
        (item) => item.id,
      ),
    ).toEqual(["user:msg-1", "user:msg-2"]);
  });

  it("builds pending user echoes from workbench responses with explicit fallback run", () => {
    expect(
      pendingUserEchoFromPost({
        data: {},
        fallback: {
          id: "fallback-id",
          timestamp: "2026-06-17T00:00:02.000Z",
          runId: "run-2",
          text: "hello",
        },
      }),
    ).toMatchObject({
      id: "fallback-id",
      kind: "user",
      channel: "run:run-2",
      text: "hello",
    });

    expect(setControllerSelectedRun(createTuiControllerState(), "run-3")).toMatchObject({
      selectedRunId: "run-3",
    });
  });
});
