import { describe, expect, it } from "vitest";
import {
  ProjectWorkbenchService,
  parseWorkbenchRequest,
  parseWorkbenchServerMessage,
  type WorkbenchBackendPort,
  type WorkbenchClientPort,
  type WorkbenchServerMessage,
} from "../src/runtime/project-workbench.js";
import type { TuiViewModel } from "../src/tui/types.js";

function makeView(runId = ""): TuiViewModel {
  return {
    run: {
      runId,
      status: runId ? "running" : "created",
      stepIndex: runId ? 3 : 0,
      cwd: runId ? "/repo" : "",
    },
    conversation: [],
    loop: [],
    sessions: [],
    activeSkills: [],
  };
}

function makeBackend(): WorkbenchBackendPort & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    async snapshot(input) {
      calls.push(`snapshot:${input.selectedRunId ?? ""}`);
      return {
        selectedRunId: input.selectedRunId,
        view: makeView(input.selectedRunId),
      };
    },
    async postUserMessage(input) {
      calls.push(`post:${input.runId}:${input.text}:${input.from}->${input.to}`);
      return {
        message: {
          id: "msg-1",
          text: input.text,
          to: input.to,
        },
      };
    },
    async createRun(input) {
      calls.push(`create:${input.task ?? ""}`);
      return { runId: "run-created" };
    },
    async startRun(input) {
      calls.push(`resume:${input.runId}`);
      return { runId: input.runId, alreadyRunning: false };
    },
    async stopRun(input) {
      calls.push(`stop:${input.runId}`);
      return { runId: input.runId, stopped: true, processId: "proc-1" };
    },
  };
}

function makeService(input: { backend?: WorkbenchBackendPort } = {}): {
  service: ProjectWorkbenchService;
  backend: WorkbenchBackendPort & { calls: string[] };
} {
  const backend = input.backend ?? makeBackend();
  let clientSeq = 0;
  let eventSeq = 0;
  return {
    backend: backend as WorkbenchBackendPort & { calls: string[] },
    service: new ProjectWorkbenchService({
      backend,
      userEndpoint: "user:main",
      runEndpoint: (runId) => `run:${runId}`,
      nowIso: () => "2026-06-15T00:00:00.000Z",
      newClientId: () => `client-${++clientSeq}`,
      newEventId: () => `event-${++eventSeq}`,
      maxEventLogSize: 10,
    }),
  };
}

function makeClientPort(): WorkbenchClientPort & {
  messages: WorkbenchServerMessage[];
  close(): void;
} {
  const messages: WorkbenchServerMessage[] = [];
  const closeHandlers: Array<() => void> = [];
  return {
    messages,
    send(message) {
      messages.push(message);
    },
    onClose(handler) {
      closeHandlers.push(handler);
    },
    close() {
      for (const handler of closeHandlers) {
        handler();
      }
    },
  };
}

describe("ProjectWorkbenchService", () => {
  it("parses typed workbench requests and rejects invalid command inputs", () => {
    expect(
      parseWorkbenchRequest(
        JSON.stringify({
          schemaVersion: 1,
          id: "req-1",
          type: "workbench.command",
          command: { kind: "send-message", text: "hello" },
        }),
      ),
    ).toMatchObject({
      id: "req-1",
      type: "workbench.command",
      command: { kind: "send-message", text: "hello" },
    });

    expect(() =>
      parseWorkbenchRequest(
        JSON.stringify({
          schemaVersion: 1,
          id: "bad",
          type: "workbench.command",
          command: { kind: "send-message", text: "" },
        }),
      ),
    ).toThrow("text must be non-empty string");
  });

  it("subscribes a client, emits an ordered view event, and replays after cursor", async () => {
    const { service } = makeService();
    const port = makeClientPort();
    const subscribed = await service.handleRequest(
      {
        schemaVersion: 1,
        id: "sub-1",
        type: "workbench.subscribe",
        clientId: "client-a",
        selectedRunId: "run-1",
      },
      port,
    );

    expect(subscribed.response).toMatchObject({
      ok: true,
      type: "workbench.result",
      data: {
        clientId: "client-a",
        selectedRunId: "run-1",
        cursor: "1",
        eventCount: 1,
      },
    });
    expect(port.messages).toHaveLength(0);
    expect(subscribed.events).toHaveLength(1);
    expect(subscribed.events[0]).toMatchObject({
      type: "workbench.event",
      eventSeq: 1,
      cursor: "1",
      event: {
        kind: "view.updated",
        reason: "subscribe",
        selectedRunId: "run-1",
      },
    });

    await service.handleRequest({
      schemaVersion: 1,
      id: "snap-1",
      type: "workbench.snapshot",
      selectedRunId: "run-2",
    });
    const replay = await service.handleRequest({
      schemaVersion: 1,
      id: "replay-1",
      type: "workbench.replay",
      cursor: "1",
    });

    expect(replay.response).toMatchObject({
      ok: true,
      type: "workbench.result",
      data: {
        cursor: "2",
        eventCount: 1,
      },
    });
    expect((replay.response as any).data.events[0]).toMatchObject({
      eventSeq: 2,
      event: { selectedRunId: "run-2" },
    });
  });

  it("dispatches workbench commands through explicit backend ports", async () => {
    const { service, backend } = makeService();
    await service.handleRequest({
      schemaVersion: 1,
      id: "sub-1",
      type: "workbench.subscribe",
      clientId: "client-a",
      selectedRunId: "run-1",
    });

    const sent = await service.handleRequest({
      schemaVersion: 1,
      id: "send-1",
      type: "workbench.command",
      clientId: "client-a",
      command: { kind: "send-message", text: "hello" },
    });
    const created = await service.handleRequest({
      schemaVersion: 1,
      id: "create-1",
      type: "workbench.command",
      clientId: "client-a",
      command: { kind: "create-run", task: "fix tests" },
    });
    const resumed = await service.handleRequest({
      schemaVersion: 1,
      id: "resume-1",
      type: "workbench.command",
      clientId: "client-a",
      command: { kind: "resume-run", runId: "run-2" },
    });
    const stopped = await service.handleRequest({
      schemaVersion: 1,
      id: "stop-1",
      type: "workbench.command",
      clientId: "client-a",
      command: { kind: "stop-run" },
    });

    expect(sent.response).toMatchObject({ ok: true });
    expect(created.response).toMatchObject({
      ok: true,
      data: { runId: "run-created" },
    });
    expect(resumed.response).toMatchObject({
      ok: true,
      data: { runId: "run-2" },
    });
    expect(stopped.response).toMatchObject({
      ok: true,
      data: { runId: "run-2", stopped: true },
    });
    expect(backend.calls).toEqual([
      "snapshot:run-1",
      "post:run-1:hello:user:main->run:run-1",
      "snapshot:run-1",
      "create:fix tests",
      "snapshot:run-created",
      "resume:run-2",
      "snapshot:run-2",
      "stop:run-2",
      "snapshot:run-2",
    ]);
  });

  it("refreshes subscribed clients only when the materialized view changes", async () => {
    let stepIndex = 1;
    const backend = makeBackend();
    backend.snapshot = async (input) => {
      backend.calls.push(`snapshot:${input.selectedRunId ?? ""}:${stepIndex}`);
      return {
        selectedRunId: input.selectedRunId,
        view: {
          ...makeView(input.selectedRunId),
          run: {
            ...makeView(input.selectedRunId).run,
            stepIndex,
          },
        },
      };
    };
    const { service } = makeService({ backend });
    const port = makeClientPort();
    await service.handleRequest(
      {
        schemaVersion: 1,
        id: "sub-1",
        type: "workbench.subscribe",
        clientId: "client-a",
        selectedRunId: "run-1",
      },
      port,
    );

    expect(await service.refreshSubscribedViews()).toEqual([]);
    stepIndex = 2;
    const deliveries = await service.refreshSubscribedViews();

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({
      clientId: "client-a",
      event: {
        type: "workbench.event",
        eventSeq: 2,
        event: {
          reason: "refresh",
          view: {
            run: {
              stepIndex: 2,
            },
          },
        },
      },
    });
    expect(port.messages).toHaveLength(0);
  });

  it("rejects send-message when no run is selected", async () => {
    const { service, backend } = makeService();
    const response = await service.handleRequest({
      schemaVersion: 1,
      id: "send-1",
      type: "workbench.command",
      clientId: "client-a",
      command: { kind: "send-message", text: "hello" },
    });

    expect(response.response).toEqual({
      schemaVersion: 1,
      id: "send-1",
      ok: false,
      type: "workbench.error",
      error: {
        code: "BAD_REQUEST",
        message: "Cannot send message without a selected run",
      },
    });
    expect(backend.calls).toEqual([]);
  });

  it("parses workbench server messages at the client boundary", () => {
    expect(
      parseWorkbenchServerMessage(
        JSON.stringify({
          schemaVersion: 1,
          id: "event-1",
          type: "workbench.event",
          eventSeq: 1,
          cursor: "1",
          event: {
            kind: "view.updated",
            reason: "refresh",
            view: makeView("run-1"),
          },
        }),
      ),
    ).toMatchObject({ type: "workbench.event", cursor: "1" });

    expect(() =>
      parseWorkbenchServerMessage(
        JSON.stringify({
          schemaVersion: 1,
          id: "actual",
          ok: true,
          type: "workbench.result",
          command: "workbench.connect",
          data: {},
        }),
        "expected",
      ),
    ).toThrow("expected id expected, got actual");
  });
});
