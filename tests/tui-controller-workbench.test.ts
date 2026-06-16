import { describe, expect, it } from "vitest";
import {
  ProjectUiController,
  parseProjectUiCommand,
  type TuiRendererPort,
} from "../src/tui/controller.js";
import type {
  TuiWorkbenchClientPort,
  TuiWorkbenchSessionPort,
} from "../src/tui/workbench-client.js";
import type {
  ConversationItem,
  TuiKey,
  TuiViewModel,
} from "../src/tui/types.js";
import type {
  WorkbenchCommand,
  WorkbenchEvent,
} from "../src/runtime/project-workbench.js";

class FakeRenderer implements TuiRendererPort {
  keyHandler: ((key: TuiKey) => void) | undefined;
  messageHandler: ((text: string) => void) | undefined;
  renders: TuiViewModel[] = [];
  closed = false;

  render(view: TuiViewModel): void {
    this.renders.push(view);
  }

  onKey(handler: (key: TuiKey) => void): void {
    this.keyHandler = handler;
  }

  onMessage(handler: (text: string) => void): void {
    this.messageHandler = handler;
  }

  close(): void {
    this.closed = true;
  }
}

class WorkbenchHarness implements TuiWorkbenchClientPort {
  subscriptions: Array<{ selectedRunId?: string }> = [];
  commands: WorkbenchCommand[] = [];
  selectedRunId: string | undefined;
  messages: ConversationItem[] = [];
  autoEvents: boolean;
  private messageSequence = 0;
  private subscription:
    | {
        onEvent: (event: WorkbenchEvent) => void;
        onError: (error: Error) => void;
      }
    | undefined;

  constructor(input: {
    selectedRunId?: string;
    messages?: ConversationItem[];
    autoEvents?: boolean;
  } = {}) {
    this.selectedRunId = input.selectedRunId;
    this.messages = [...(input.messages ?? [])];
    this.autoEvents = input.autoEvents ?? true;
  }

  async subscribe(input: {
    selectedRunId?: string;
    onEvent: (event: WorkbenchEvent) => void;
    onError: (error: Error) => void;
  }): Promise<TuiWorkbenchSessionPort> {
    this.subscriptions.push({ selectedRunId: input.selectedRunId });
    this.subscription = {
      onEvent: input.onEvent,
      onError: input.onError,
    };
    if (input.selectedRunId && input.selectedRunId !== "latest") {
      this.selectedRunId = input.selectedRunId;
    }
    this.emitView("subscribe");
    return {
      clientId: "client-a",
      command: async (command) => await this.command(command),
      close: () => undefined,
    };
  }

  emitView(reason: "subscribe" | "send-message" | "create-run" | "stop-run" | "refresh"): void {
    this.subscription?.onEvent({
      kind: "view.updated",
      reason,
      selectedRunId: this.selectedRunId,
      view: makeView(this.selectedRunId ?? "", this.messages),
    });
  }

  private async command(command: WorkbenchCommand): Promise<Record<string, unknown>> {
    this.commands.push(command);
    switch (command.kind) {
      case "send-message": {
        if (!this.selectedRunId) {
          throw new Error("Cannot send message without a selected run");
        }
        this.messageSequence += 1;
        const messageId = `msg-${this.messageSequence}`;
        this.messages.push({
          id: `user:${messageId}`,
          kind: "user",
          timestamp: "2026-06-11T00:00:03.000Z",
          channel: `run:${this.selectedRunId}`,
          text: command.text,
        });
        if (this.autoEvents) {
          this.emitView("send-message");
        }
        return {
          selectedRunId: this.selectedRunId,
          posted: {
            message: {
              id: messageId,
              createdAt: "2026-06-11T00:00:03.000Z",
              to: `run:${this.selectedRunId}`,
              text: command.text,
            },
          },
        };
      }
      case "create-run":
        this.selectedRunId = "run-456";
        if (this.autoEvents) {
          this.emitView("create-run");
        }
        return { runId: "run-456" };
      case "resume-run":
        this.selectedRunId = command.runId === "latest" ? "run-123" : command.runId;
        if (this.autoEvents) {
          this.emitView("refresh");
        }
        return { runId: this.selectedRunId, alreadyRunning: false };
      case "stop-run": {
        const runId = command.runId ?? this.selectedRunId ?? "latest";
        if (this.autoEvents) {
          this.emitView("stop-run");
        }
        return { runId, stopped: true, processId: "run-proc-1" };
      }
      case "open-run":
        this.selectedRunId = command.runId === "latest" ? "run-123" : command.runId;
        if (this.autoEvents) {
          this.emitView("refresh");
        }
        return { selectedRunId: this.selectedRunId };
      case "refresh":
        if (this.autoEvents) {
          this.emitView("refresh");
        }
        return { selectedRunId: this.selectedRunId };
    }
  }
}

function makeController(input: {
  harness: WorkbenchHarness;
  renderer?: FakeRenderer;
}): { controller: ProjectUiController; renderer: FakeRenderer } {
  const renderer = input.renderer ?? new FakeRenderer();
  return {
    renderer,
    controller: new ProjectUiController({
      runtimeSocketPath: "/runtime-edge.sock",
      workbenchClient: input.harness,
      renderer,
      newRequestId: (() => {
        let next = 0;
        return () => `tui-test-${++next}`;
      })(),
      nowIso: (() => {
        let next = 0;
        return () => `2026-06-11T00:00:${String(++next).padStart(2, "0")}.000Z`;
      })(),
    }),
  };
}

function makeView(runId: string, conversation: ConversationItem[] = []): TuiViewModel {
  return {
    run: {
      runId,
      status: runId ? "waiting_for_io" : "created",
      stepIndex: runId ? 7 : 0,
      cwd: runId ? "/repo" : "",
      updatedAt: "2026-06-11T00:00:00.000Z",
    },
    conversation: [...conversation],
    loop: [],
    sessions: [],
    activeSkills: [],
    runBrowser: {
      isEmpty: false,
      totalCount: runId ? 1 : 0,
      rows: runId
        ? [
            {
              runId,
              status: "waiting_for_io",
              stepIndex: 7,
              cwd: "/repo",
              frameCount: 0,
              problemFrameCount: 0,
              conversationCount: conversation.length,
              sessionCount: 0,
            },
          ]
        : [],
      selected: runId
        ? {
            runId,
            detail: {
              runId,
              status: "waiting_for_io",
              stepIndex: 7,
              cwd: "/repo",
              frameCount: 0,
              problemFrameCount: 0,
              conversationCount: conversation.length,
              sessionCount: 0,
            },
          }
        : undefined,
      controlIntentDisplays: [],
    },
  };
}

describe("ProjectUiController workbench behavior", () => {
  it("treats slash-prefixed text as user input, not a hidden UI command", () => {
    expect(parseProjectUiCommand("/Users/wangchaoqun/file.txt")).toBeUndefined();
    expect(parseProjectUiCommand(":not-a-ui-command keep this")).toBeUndefined();
    expect(parseProjectUiCommand(":stop")).toEqual({ kind: "stop-run" });
  });

  it("subscribes to the realtime workbench projection", async () => {
    const harness = new WorkbenchHarness({
      selectedRunId: "run-123",
      messages: [
        {
          id: "agent:msg-1",
          kind: "agent",
          timestamp: "2026-06-11T00:00:01.000Z",
          text: "working",
          messageKind: "status",
        },
      ],
    });
    const { controller, renderer } = makeController({ harness });

    await controller.connect();

    expect(harness.subscriptions).toEqual([{ selectedRunId: undefined }]);
    expect(renderer.renders.at(-1)?.run.runId).toBe("run-123");
    expect(renderer.renders.at(-1)?.conversation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "agent", text: "working" }),
      ]),
    );
    expect(renderer.renders.at(-1)?.conversation).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("Project UI ready"),
        }),
      ]),
    );
    expect(renderer.renders.at(-1)?.notices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("Project UI ready"),
        }),
      ]),
    );
  });

  it("posts TUI user input through workbench.command send-message", async () => {
    const harness = new WorkbenchHarness({ selectedRunId: "run-123" });
    const { controller, renderer } = makeController({ harness });

    await controller.connect();
    await controller.submitUserMessage("hello from tui");

    expect(harness.commands).toEqual([
      { kind: "send-message", text: "hello from tui" },
    ]);
    expect(renderer.renders.at(-1)?.conversation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "user", text: "hello from tui" }),
      ]),
    );
  });

  it("keeps a local user echo before the next workbench event arrives", async () => {
    const harness = new WorkbenchHarness({ selectedRunId: "run-123" });
    const { controller, renderer } = makeController({ harness });

    await controller.connect();
    harness.autoEvents = false;
    await controller.submitUserMessage("do not disappear");

    expect(renderer.renders.at(-1)?.conversation).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "user", text: "do not disappear" }),
      ]),
    );
  });

  it("does not send user input when no run is selected", async () => {
    const harness = new WorkbenchHarness();
    const { controller, renderer } = makeController({ harness });

    await controller.connect();
    await controller.submitUserMessage("hello?");

    expect(harness.commands).toEqual([]);
    expect(renderer.renders.at(-1)?.conversation).toHaveLength(0);
    expect(renderer.renders.at(-1)?.notices?.at(-1)).toMatchObject({
      text: "No active run. Use :new <task> to start one or :open latest to attach an existing run.",
    });
  });

  it("creates and selects runs through workbench.command", async () => {
    const harness = new WorkbenchHarness();
    const { controller, renderer } = makeController({ harness });

    await controller.connect();
    await controller.handleInput(":new fix tests");

    expect(harness.commands).toEqual([
      { kind: "create-run", task: "fix tests" },
    ]);
    expect(renderer.renders.at(-1)?.run.runId).toBe("run-456");
    expect(renderer.renders.at(-1)?.runBrowser?.selected?.runId).toBe("run-456");
  });

  it("stops the selected run through workbench.command", async () => {
    const harness = new WorkbenchHarness({ selectedRunId: "run-123" });
    const { controller, renderer } = makeController({ harness });

    await controller.connect();
    await controller.handleInput(":stop");

    expect(harness.commands).toEqual([{ kind: "stop-run" }]);
    expect(renderer.renders.at(-1)?.notices).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "Stop requested for run run-123.",
        }),
      ]),
    );
  });
});
