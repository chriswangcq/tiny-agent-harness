import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  PublicImService,
  createInMemoryImStore,
  handleRuntimeImRequest,
  parseRuntimeImRequest,
  parseRuntimeImResponse,
  type PublicImServicePorts,
} from "../src/im/index.js";
import {
  DEFAULT_WORKBENCH_REFRESH_INTERVAL_MS,
  cleanupProjectUiEdgeRuntimeReplicas,
  launchRuntimeReplica,
  listenRuntimeReplicaSocket,
  requestRuntimeReplica,
  requestRuntimeReplicaAny,
  requestRuntimeReplicaIm,
  type RuntimeProjectServices,
} from "../src/runtime/runtime-replica.js";
import type { SpawnedProcessPort } from "../src/runtime/run-supervisor.js";
import {
  createRuntimeProcess,
  markProcessExited,
  markProcessRunning,
  type RuntimeProcessRecord,
  type RuntimeProcessSnapshot,
} from "../src/runtime/process-registry.js";
import { parseWorkbenchServerMessage } from "../src/runtime/project-workbench.js";
import type { TuiViewModel } from "../src/tui/types.js";

function makeService(): PublicImService {
  const store = createInMemoryImStore();
  const ports: PublicImServicePorts = {
    store,
    clock: { nowIso: () => "2026-06-14T00:00:00.000Z" },
    ids: { newMessageId: (seed) => `msg-${seed}` },
  };
  return new PublicImService(ports);
}

function makeView(runId: string): TuiViewModel {
  return {
    run: {
      runId,
      status: "running",
      stepIndex: 7,
      cwd: "/work",
      updatedAt: "2026-06-14T00:00:00.000Z",
    },
    conversation: [
      {
        id: "msg-1",
        kind: "system",
        timestamp: "2026-06-14T00:00:00.000Z",
        text: "ready",
      },
    ],
    loop: [],
    sessions: [],
    activeSkills: [],
  };
}

type RuntimeLineSocket = {
  send(request: unknown): void;
  readLines(count: number): Promise<string[]>;
  close(): void;
};

async function openRuntimeLineSocket(socketPath: string): Promise<RuntimeLineSocket> {
  const socket = net.createConnection(socketPath);
  const lines: string[] = [];
  const waiters: Array<{
    count: number;
    resolve: (lines: string[]) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  let buffer = "";

  const drain = () => {
    for (let index = 0; index < waiters.length; index += 1) {
      const waiter = waiters[index]!;
      if (lines.length < waiter.count) {
        continue;
      }
      waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(lines.splice(0, waiter.count));
      index -= 1;
    }
  };

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    while (true) {
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) {
        break;
      }
      lines.push(buffer.slice(0, newlineIndex));
      buffer = buffer.slice(newlineIndex + 1);
    }
    drain();
  });

  socket.once("error", (error) => {
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  });

  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });

  return {
    send(request) {
      socket.write(`${JSON.stringify(request)}\n`);
    },
    readLines(count) {
      return new Promise<string[]>((resolve, reject) => {
        const waiter = {
          count,
          resolve,
          reject,
          timer: setTimeout(() => {
            const index = waiters.indexOf(waiter);
            if (index >= 0) {
              waiters.splice(index, 1);
            }
            reject(new Error(`Timed out waiting for ${count} runtime socket lines`));
          }, 1_000),
        };
        waiters.push(waiter);
        drain();
      });
    },
    close() {
      socket.end();
    },
  };
}

describe("runtime replica protocol", () => {
  it("keeps the default workbench refresh cadence responsive enough for streaming UI", () => {
    expect(DEFAULT_WORKBENCH_REFRESH_INTERVAL_MS).toBeLessThanOrEqual(100);
  });

  it("parses typed runtime IM requests and rejects hidden default context", () => {
    expect(
      parseRuntimeImRequest(
        JSON.stringify({
          schemaVersion: 1,
          id: "req-1",
          type: "im.send",
          from: "run:run-1",
          to: "user:main",
          kind: "status",
          text: "hello",
        }),
      ),
    ).toMatchObject({
      id: "req-1",
      type: "im.send",
      from: "run:run-1",
      to: "user:main",
      kind: "status",
      text: "hello",
    });

    expect(() =>
      parseRuntimeImRequest(JSON.stringify({ schemaVersion: 2, id: "bad", type: "im.recv" })),
    ).toThrow("schemaVersion must be 1");
    expect(() =>
      parseRuntimeImRequest(JSON.stringify({
        schemaVersion: 1,
        id: "bad",
        type: "im.send",
        from: "run:run-1",
        to: "user:main",
        kind: "message",
        text: "x",
      })),
    ).toThrow("kind must be status or error");
    expect(() =>
      parseRuntimeImRequest(JSON.stringify({ schemaVersion: 1, id: "bad", type: "im.post", text: "x" })),
    ).toThrow("from must be non-empty string");
  });

  it("rejects mismatched runtime IM response ids at the parser boundary", () => {
    expect(() =>
      parseRuntimeImResponse(
        JSON.stringify({
          schemaVersion: 1,
          id: "actual",
          ok: true,
          type: "im.result",
          command: "im.recv",
          data: {},
        }),
        "expected",
      ),
    ).toThrow("expected id expected, got actual");
  });

  it("executes IM requests only from explicit request fields", async () => {
    const service = makeService();

    const bind = await handleRuntimeImRequest(service, { stateRoot: "/state" }, {
      schemaVersion: 1,
      id: "bind-1",
      type: "im.bind",
      runId: "run-1",
      self: "run:run-1",
      peer: "user:main",
    });
    expect(bind.ok).toBe(true);

    const posted = await handleRuntimeImRequest(service, { stateRoot: "/state" }, {
      schemaVersion: 1,
      id: "post-1",
      type: "im.post",
      from: "user:main",
      to: "run:run-1",
      text: "hello",
    });
    expect(posted.ok).toBe(true);
    expect((posted as any).data).toMatchObject({
      from: "user:main",
      to: "run:run-1",
    });

    const received = await handleRuntimeImRequest(service, { stateRoot: "/state" }, {
      schemaVersion: 1,
      id: "recv-1",
      type: "im.recv",
      as: "run:run-1",
      with: "user:main",
    });
    expect(received.ok).toBe(true);
    expect((received as any).data).toMatchObject({
      as: "run:run-1",
      with: "user:main",
      count: 1,
    });
  });

  it("roundtrips runtime and IM requests over a run-owned runtime replica socket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-replica-socket-"));
    const socketPath = path.join(dir, "runtime.sock");
    const server = await listenRuntimeReplicaSocket({
      socketPath,
      stateRoot: "/state",
      identity: { mode: "run", runId: "run-1" },
      imService: makeService(),
    });

    try {
      const health = await requestRuntimeReplica({
        socketPath,
        timeoutMs: 1_000,
        request: {
          schemaVersion: 1,
          id: "health-1",
          type: "runtime.health",
        },
      });
      expect(health).toMatchObject({
        schemaVersion: 1,
        id: "health-1",
        ok: true,
        type: "runtime.result",
        data: {
          mode: "active-active-replica",
          replicaMode: "run",
          runId: "run-1",
          identity: { mode: "run", runId: "run-1" },
          stateRoot: "/state",
        },
      });

      const response = await requestRuntimeReplicaIm({
        socketPath,
        timeoutMs: 1_000,
        request: {
          schemaVersion: 1,
          id: "send-1",
          type: "im.send",
          from: "run:run-1",
          to: "user:main",
          kind: "status",
          text: "ready",
        },
      });
      expect(response).toMatchObject({
        schemaVersion: 1,
        id: "send-1",
        ok: true,
        type: "im.result",
        command: "im.send",
      });
      expect((response as any).data).toMatchObject({
        from: "run:run-1",
        to: "user:main",
        kind: "status",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("advertises and routes project protocol requests over the runtime replica socket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-replica-project-"));
    const socketPath = path.join(dir, "runtime.sock");
    const calls: string[] = [];
    const projectServices: RuntimeProjectServices = {
      async snapshot(input) {
        calls.push(`snapshot:${input.selectedRunId ?? "latest"}`);
        return {
          selectedRunId: input.selectedRunId ?? "run-1",
          view: makeView(input.selectedRunId ?? "run-1"),
        };
      },
      async createRun(input) {
        calls.push(`create:${input.task ?? ""}`);
        return { runId: "run-created" };
      },
      async startRun(input) {
        calls.push(`resume:${input.runId}`);
        return { runId: input.runId, alreadyRunning: true };
      },
      async stopRun(input) {
        calls.push(`stop:${input.runId}`);
        return { runId: input.runId, stopped: true, processId: "proc-1" };
      },
    };
    const server = await listenRuntimeReplicaSocket({
      socketPath,
      stateRoot: "/state",
      identity: { mode: "edge", edgeId: "project-ui" },
      imService: makeService(),
      projectServices,
    });

    try {
      const capabilities = await requestRuntimeReplica({
        socketPath,
        timeoutMs: 1_000,
        request: {
          schemaVersion: 1,
          id: "caps-project",
          type: "runtime.capabilities",
        },
      });
      expect(capabilities.ok).toBe(true);
      expect((capabilities as any).data.capabilities).toEqual(
        expect.arrayContaining([
          "project.snapshot",
          "run.create",
          "run.resume",
          "run.stop",
          "workbench.connect",
          "workbench.subscribe",
          "workbench.replay",
          "workbench.snapshot",
          "workbench.command",
        ]),
      );

      const snapshot = await requestRuntimeReplica({
        socketPath,
        timeoutMs: 1_000,
        request: {
          schemaVersion: 1,
          id: "snapshot-1",
          type: "project.snapshot",
          selectedRunId: "run-2",
        },
      });
      expect(snapshot).toMatchObject({
        schemaVersion: 1,
        id: "snapshot-1",
        ok: true,
        type: "runtime.result",
        command: "project.snapshot",
        data: {
          selectedRunId: "run-2",
          view: {
            run: { runId: "run-2" },
          },
        },
      });

      await requestRuntimeReplica({
        socketPath,
        timeoutMs: 1_000,
        request: {
          schemaVersion: 1,
          id: "create-1",
          type: "run.create",
          task: "fix tests",
        },
      });
      await requestRuntimeReplica({
        socketPath,
        timeoutMs: 1_000,
        request: {
          schemaVersion: 1,
          id: "resume-1",
          type: "run.resume",
          runId: "run-2",
        },
      });
      await requestRuntimeReplica({
        socketPath,
        timeoutMs: 1_000,
        request: {
          schemaVersion: 1,
          id: "stop-1",
          type: "run.stop",
          runId: "run-2",
        },
      });
      expect(calls).toEqual([
        "snapshot:run-2",
        "create:fix tests",
        "resume:run-2",
        "stop:run-2",
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("routes realtime workbench responses and events over one runtime replica socket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-replica-workbench-"));
    const socketPath = path.join(dir, "runtime.sock");
    const calls: string[] = [];
    const imService = makeService();
    const projectServices: RuntimeProjectServices = {
      async snapshot(input) {
        calls.push(`snapshot:${input.selectedRunId ?? "latest"}`);
        return {
          selectedRunId: input.selectedRunId ?? "run-1",
          view: makeView(input.selectedRunId ?? "run-1"),
        };
      },
      async createRun(input) {
        calls.push(`create:${input.task ?? ""}`);
        return { runId: "run-created" };
      },
      async startRun(input) {
        calls.push(`resume:${input.runId}`);
        return { runId: input.runId, alreadyRunning: true };
      },
      async stopRun(input) {
        calls.push(`stop:${input.runId}`);
        return { runId: input.runId, stopped: true };
      },
    };
    const server = await listenRuntimeReplicaSocket({
      socketPath,
      stateRoot: "/state",
      identity: { mode: "edge", edgeId: "project-ui" },
      imService,
      projectServices,
    });

    const client = await openRuntimeLineSocket(socketPath);
    try {
      client.send({
        schemaVersion: 1,
        id: "wb-sub-1",
        type: "workbench.subscribe",
        clientId: "client-a",
        selectedRunId: "run-1",
      });
      const subscribeLines = await client.readLines(2);
      expect(parseWorkbenchServerMessage(subscribeLines[0]!, "wb-sub-1")).toMatchObject({
        ok: true,
        type: "workbench.result",
        command: "workbench.subscribe",
        data: {
          clientId: "client-a",
          selectedRunId: "run-1",
          cursor: "1",
        },
      });
      expect(parseWorkbenchServerMessage(subscribeLines[1]!)).toMatchObject({
        type: "workbench.event",
        eventSeq: 1,
        cursor: "1",
        event: {
          kind: "view.updated",
          reason: "subscribe",
          selectedRunId: "run-1",
        },
      });

      client.send({
        schemaVersion: 1,
        id: "wb-send-1",
        type: "workbench.command",
        clientId: "client-a",
        command: { kind: "send-message", text: "hello from tui" },
      });
      const commandLines = await client.readLines(2);
      expect(parseWorkbenchServerMessage(commandLines[0]!, "wb-send-1")).toMatchObject({
        ok: true,
        type: "workbench.result",
        command: "workbench.command",
        data: {
          clientId: "client-a",
          selectedRunId: "run-1",
          cursor: "2",
        },
      });
      expect(parseWorkbenchServerMessage(commandLines[1]!)).toMatchObject({
        type: "workbench.event",
        eventSeq: 2,
        cursor: "2",
        event: {
          kind: "view.updated",
          reason: "send-message",
          selectedRunId: "run-1",
        },
      });

      const received = await handleRuntimeImRequest(
        imService,
        { stateRoot: "/state" },
        {
          schemaVersion: 1,
          id: "recv-after-workbench",
          type: "im.recv",
          as: "run:run-1",
          with: "user:main",
        },
      );
      expect(received).toMatchObject({
        ok: true,
        type: "im.result",
        data: {
          count: 1,
          messages: [
            {
              from: "user:main",
              to: "run:run-1",
              text: "hello from tui",
            },
          ],
        },
      });
      expect(calls).toEqual(["snapshot:run-1", "snapshot:run-1"]);
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("pushes realtime workbench refresh events when the selected projection changes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-replica-workbench-refresh-"));
    const socketPath = path.join(dir, "runtime.sock");
    let stepIndex = 1;
    const projectServices: RuntimeProjectServices = {
      async snapshot(input) {
        return {
          selectedRunId: input.selectedRunId ?? "run-1",
          view: {
            ...makeView(input.selectedRunId ?? "run-1"),
            run: {
              ...makeView(input.selectedRunId ?? "run-1").run,
              stepIndex,
            },
          },
        };
      },
      async createRun() {
        return { runId: "run-created" };
      },
      async startRun(input) {
        return { runId: input.runId, alreadyRunning: true };
      },
      async stopRun(input) {
        return { runId: input.runId, stopped: true };
      },
    };
    const server = await listenRuntimeReplicaSocket({
      socketPath,
      stateRoot: "/state",
      identity: { mode: "edge", edgeId: "project-ui" },
      imService: makeService(),
      projectServices,
      workbenchRefreshIntervalMs: 10,
    });

    const client = await openRuntimeLineSocket(socketPath);
    try {
      client.send({
        schemaVersion: 1,
        id: "wb-sub-refresh",
        type: "workbench.subscribe",
        clientId: "client-a",
        selectedRunId: "run-1",
      });
      await client.readLines(2);

      stepIndex = 2;
      const [refreshLine] = await client.readLines(1);
      expect(parseWorkbenchServerMessage(refreshLine!)).toMatchObject({
        type: "workbench.event",
        event: {
          kind: "view.updated",
          reason: "refresh",
          selectedRunId: "run-1",
          view: {
            run: {
              stepIndex: 2,
            },
          },
        },
      });
    } finally {
      client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid project protocol requests at the socket boundary", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-replica-project-bad-"));
    const socketPath = path.join(dir, "runtime.sock");
    const server = await listenRuntimeReplicaSocket({
      socketPath,
      stateRoot: "/state",
      identity: { mode: "edge", edgeId: "project-ui" },
      imService: makeService(),
      projectServices: {
        async snapshot() {
          throw new Error("snapshot should not be called");
        },
        async createRun() {
          throw new Error("create should not be called");
        },
        async startRun() {
          throw new Error("resume should not be called");
        },
        async stopRun() {
          throw new Error("stop should not be called");
        },
      },
    });

    try {
      const response = await requestRuntimeReplica({
        socketPath,
        timeoutMs: 1_000,
        request: {
          schemaVersion: 1,
          id: "bad-resume",
          type: "run.resume",
        } as any,
      });
      expect(response).toEqual({
        schemaVersion: 1,
        id: "bad-resume",
        ok: false,
        type: "runtime.error",
        error: {
          code: "BAD_REQUEST",
          message: "Invalid run.resume request: runId must be non-empty string",
        },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid workbench requests at the socket boundary", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-replica-workbench-bad-"));
    const socketPath = path.join(dir, "runtime.sock");
    const server = await listenRuntimeReplicaSocket({
      socketPath,
      stateRoot: "/state",
      identity: { mode: "edge", edgeId: "project-ui" },
      imService: makeService(),
      projectServices: {
        async snapshot() {
          throw new Error("snapshot should not be called");
        },
        async createRun() {
          throw new Error("create should not be called");
        },
        async startRun() {
          throw new Error("resume should not be called");
        },
        async stopRun() {
          throw new Error("stop should not be called");
        },
      },
    });

    try {
      const response = await requestRuntimeReplicaAny({
        socketPath,
        timeoutMs: 1_000,
        request: {
          schemaVersion: 1,
          id: "bad-workbench",
          type: "workbench.command",
          command: { kind: "send-message", text: "" },
        } as any,
      });
      expect(response).toEqual({
        schemaVersion: 1,
        id: "bad-workbench",
        ok: false,
        type: "workbench.error",
        error: {
          code: "BAD_REQUEST",
          message: "Invalid send-message command: text must be non-empty string",
        },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("uses one socket request helper for runtime and IM commands", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-replica-any-"));
    const socketPath = path.join(dir, "runtime.sock");
    const server = await listenRuntimeReplicaSocket({
      socketPath,
      stateRoot: "/state",
      identity: { mode: "edge", edgeId: "project-ui" },
      imService: makeService(),
      projectServices: {
        async snapshot() {
          return { selectedRunId: "run-1", view: makeView("run-1") };
        },
        async createRun() {
          return { runId: "run-1" };
        },
        async startRun(input) {
          return { runId: input.runId };
        },
        async stopRun(input) {
          return { runId: input.runId, stopped: true };
        },
      },
    });

    try {
      const snapshot = await requestRuntimeReplicaAny({
        socketPath,
        timeoutMs: 1_000,
        request: {
          schemaVersion: 1,
          id: "any-snapshot",
          type: "project.snapshot",
        },
      });
      expect(snapshot).toMatchObject({
        ok: true,
        type: "runtime.result",
        command: "project.snapshot",
      });

      const im = await requestRuntimeReplicaAny({
        socketPath,
        timeoutMs: 1_000,
        request: {
          schemaVersion: 1,
          id: "any-im",
          type: "im.post",
          from: "user:main",
          to: "run:run-1",
          text: "hello",
        },
      });
      expect(im).toMatchObject({
        ok: true,
        type: "im.result",
        command: "im.post",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports shutdown responses that close the runtime replica socket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-replica-shutdown-"));
    const socketPath = path.join(dir, "runtime.sock");
    const server = await listenRuntimeReplicaSocket({
      socketPath,
      stateRoot: "/state",
      identity: { mode: "run", runId: "run-1" },
      imService: makeService(),
    });

    try {
      const closed = new Promise<void>((resolve) => server.once("close", resolve));
      const response = await requestRuntimeReplica({
        socketPath,
        timeoutMs: 1_000,
        request: {
          schemaVersion: 1,
          id: "shutdown-1",
          type: "runtime.shutdown",
        },
      });
      expect(response).toEqual({
        schemaVersion: 1,
        id: "shutdown-1",
        ok: true,
        type: "runtime.shutdown.result",
      });
      await closed;
      expect(fs.existsSync(socketPath)).toBe(false);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("disposes owned runtime replicas through runtime.shutdown before fallback kill", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-replica-dispose-"));
    const socketPath = path.join(dir, "runtime.sock");
    let shutdownCount = 0;
    const server = await listenRuntimeReplicaSocket({
      socketPath,
      stateRoot: "/state",
      identity: { mode: "edge", edgeId: "project-ui-123" },
      imService: makeService(),
      onShutdown: () => {
        shutdownCount += 1;
      },
    });
    const child = new FakeRuntimeChild();

    try {
      const launched = await launchRuntimeReplica({
        supervisor: {
          startProcess() {
            return {
              process: makeEdgeProcess("project-ui-123", {
                projectId: "project-1",
                replicaPid: child.pid!,
              }),
              child,
            };
          },
        },
        processId: "runtime-replica:edge:project-ui-123",
        identity: { mode: "edge", edgeId: "project-ui-123" },
        owner: { scope: "project", projectId: "project-1" },
        executable: "tiny-agent",
        args: ["runtime", "replica"],
        cwd: "/repo",
        env: {},
        socketPath,
        statePath: path.join(dir, "runtime-replica.json"),
        logPath: path.join(dir, "runtime-replica.stderr.log"),
        startupTimeoutMs: 1_000,
      });

      await launched.dispose();
      expect(shutdownCount).toBe(1);
      expect(child.killed).toBe(true);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports edge replica identity for external socket clients", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-replica-edge-"));
    const socketPath = path.join(dir, "runtime.sock");
    const server = await listenRuntimeReplicaSocket({
      socketPath,
      stateRoot: "/state",
      identity: { mode: "edge", edgeId: "tui-run-1" },
      imService: makeService(),
    });

    try {
      const health = await requestRuntimeReplica({
        socketPath,
        timeoutMs: 1_000,
        request: {
          schemaVersion: 1,
          id: "edge-health-1",
          type: "runtime.health",
        },
      });
      expect(health).toMatchObject({
        schemaVersion: 1,
        id: "edge-health-1",
        ok: true,
        type: "runtime.result",
        data: {
          mode: "active-active-replica",
          replicaMode: "edge",
          edgeId: "tui-run-1",
          identity: { mode: "edge", edgeId: "tui-run-1" },
          stateRoot: "/state",
        },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleans up responsive orphaned project-ui edge replicas through runtime.shutdown", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-replica-cleanup-"));
    const socketPath = path.join(dir, "runtime.sock");
    let shutdownCount = 0;
    const server = await listenRuntimeReplicaSocket({
      socketPath,
      stateRoot: "/state",
      identity: { mode: "edge", edgeId: "project-ui-111" },
      imService: makeService(),
      onShutdown: () => {
        shutdownCount += 1;
      },
    });
    const records = new Map<string, RuntimeProcessRecord>();
    records.set(
      "runtime-replica:edge:project-ui-111",
      makeEdgeProcess("project-ui-111", {
        ownerPid: 111,
        replicaPid: 222,
        projectId: "project-1",
        socketPath,
      }),
    );
    const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const store = makeProcessStore(records);

    try {
      const closed = new Promise<void>((resolve) => server.once("close", resolve));
      const cleaned = await cleanupProjectUiEdgeRuntimeReplicas({
        store,
        projectId: "project-1",
        currentEdgeId: "project-ui-999",
        nowIso: () => "2026-06-15T00:00:01.000Z",
        processControl: {
          isAlive: () => false,
          signal(pid, signal) {
            signalled.push({ pid, signal });
            return true;
          },
        },
      });

      expect(cleaned).toEqual([
        {
          processId: "runtime-replica:edge:project-ui-111",
          edgeId: "project-ui-111",
          ownerPid: 111,
          replicaPid: 222,
          shutdownRequested: true,
          exitedAfterShutdown: true,
          signalled: false,
          exitedAfterSignal: false,
          forceSignalled: false,
          exitedAfterForceSignal: false,
        },
      ]);
      await closed;
      expect(shutdownCount).toBe(1);
      expect(signalled).toEqual([]);
      expect(records.get("runtime-replica:edge:project-ui-111")).toMatchObject({
        status: "exited",
        exit: {
          exitCode: 0,
          signal: null,
        },
      });
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("force signals a responsive orphaned project-ui edge replica when shutdown and SIGTERM do not exit the pid", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runtime-replica-stuck-cleanup-"));
    const socketPath = path.join(dir, "runtime.sock");
    let shutdownCount = 0;
    const server = await listenRuntimeReplicaSocket({
      socketPath,
      stateRoot: "/state",
      identity: { mode: "edge", edgeId: "project-ui-111" },
      imService: makeService(),
      onShutdown: () => {
        shutdownCount += 1;
      },
    });
    const records = new Map<string, RuntimeProcessRecord>();
    records.set(
      "runtime-replica:edge:project-ui-111",
      makeEdgeProcess("project-ui-111", {
        ownerPid: 111,
        replicaPid: 222,
        projectId: "project-1",
        socketPath,
      }),
    );
    const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const store = makeProcessStore(records);
    let now = 1_000;

    try {
      const closed = new Promise<void>((resolve) => server.once("close", resolve));
      const cleaned = await cleanupProjectUiEdgeRuntimeReplicas({
        store,
        projectId: "project-1",
        currentEdgeId: "project-ui-999",
        nowIso: () => "2026-06-15T00:00:01.000Z",
        nowEpochMs: () => now,
        exitWaitMs: 1,
        pollIntervalMs: 1,
        wait: async (ms) => {
          now += ms + 1;
        },
        processControl: {
          isAlive: (pid) => pid === 222,
          signal(pid, signal) {
            signalled.push({ pid, signal });
            return true;
          },
        },
      });

      expect(cleaned).toEqual([
        {
          processId: "runtime-replica:edge:project-ui-111",
          edgeId: "project-ui-111",
          ownerPid: 111,
          replicaPid: 222,
          shutdownRequested: true,
          exitedAfterShutdown: false,
          signalled: true,
          exitedAfterSignal: false,
          forceSignalled: true,
          exitedAfterForceSignal: false,
        },
      ]);
      await closed;
      expect(shutdownCount).toBe(1);
      expect(signalled).toEqual([
        { pid: 222, signal: "SIGTERM" },
        { pid: 222, signal: "SIGKILL" },
      ]);
      expect(records.get("runtime-replica:edge:project-ui-111")).toMatchObject({
        status: "crashed",
        exit: {
          signal: "SIGKILL",
          message: "project UI owner pid 111 is not alive",
        },
      });
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("cleans up a live orphaned project-ui edge replica even when the stale registry record is already closed", async () => {
    const records = new Map<string, RuntimeProcessRecord>();
    const staleRecord = markProcessExited(
      makeEdgeProcess("project-ui-111", {
        ownerPid: 111,
        replicaPid: 222,
        projectId: "project-1",
      }),
      {
        now: "2026-06-15T00:00:00.500Z",
        exitCode: 0,
        signal: null,
      },
    );
    records.set(staleRecord.id, staleRecord);
    const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const store = makeProcessStore(records);
    let replicaAlive = true;

    const cleaned = await cleanupProjectUiEdgeRuntimeReplicas({
      store,
      projectId: "project-1",
      currentEdgeId: "project-ui-999",
      nowIso: () => "2026-06-15T00:00:01.000Z",
      requestTimeoutMs: 1,
      processControl: {
        isAlive: (pid) => pid === 222 && replicaAlive,
        signal(pid, signal) {
          signalled.push({ pid, signal });
          replicaAlive = false;
          return true;
        },
      },
    });

    expect(cleaned).toEqual([
      {
        processId: "runtime-replica:edge:project-ui-111",
        edgeId: "project-ui-111",
        ownerPid: 111,
        replicaPid: 222,
        shutdownRequested: false,
        exitedAfterShutdown: false,
        signalled: true,
        exitedAfterSignal: true,
        forceSignalled: false,
        exitedAfterForceSignal: false,
      },
    ]);
    expect(signalled).toEqual([{ pid: 222, signal: "SIGTERM" }]);
    expect(records.get("runtime-replica:edge:project-ui-111")).toMatchObject({
      status: "crashed",
      exit: {
        signal: "SIGTERM",
        message: "project UI owner pid 111 is not alive",
      },
    });
  });

  it("cleans up only orphaned project-ui edge replicas for the current project", async () => {
    const records = new Map<string, RuntimeProcessRecord>();
    for (const record of [
      makeEdgeProcess("project-ui-111", {
        ownerPid: 111,
        replicaPid: 222,
        projectId: "project-1",
      }),
      makeEdgeProcess("project-ui-333", {
        ownerPid: 333,
        replicaPid: 444,
        projectId: "project-1",
      }),
      makeEdgeProcess("project-ui-999", {
        ownerPid: 999,
        replicaPid: 555,
        projectId: "project-1",
      }),
      makeEdgeProcess("custom-edge", {
        replicaPid: 666,
        projectId: "project-1",
      }),
      makeEdgeProcess("project-ui-777", {
        ownerPid: 777,
        replicaPid: 888,
        projectId: "project-2",
      }),
    ]) {
      records.set(record.id, record);
    }
    const signalled: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const store = makeProcessStore(records);

    const cleaned = await cleanupProjectUiEdgeRuntimeReplicas({
      store,
      projectId: "project-1",
      currentEdgeId: "project-ui-999",
      nowIso: () => "2026-06-15T00:00:01.000Z",
      processControl: {
        isAlive: (pid) => pid === 333 || pid === 999,
        signal(pid, signal) {
          signalled.push({ pid, signal });
          return true;
        },
      },
    });

    expect(cleaned).toEqual([
      {
        processId: "runtime-replica:edge:project-ui-111",
        edgeId: "project-ui-111",
        ownerPid: 111,
        replicaPid: 222,
        shutdownRequested: false,
        exitedAfterShutdown: false,
        signalled: true,
        exitedAfterSignal: true,
        forceSignalled: false,
        exitedAfterForceSignal: false,
      },
    ]);
    expect(signalled).toEqual([{ pid: 222, signal: "SIGTERM" }]);
    expect(records.get("runtime-replica:edge:project-ui-111")).toMatchObject({
      status: "crashed",
      exit: {
        signal: "SIGTERM",
        message: "project UI owner pid 111 is not alive",
      },
    });
    expect(records.get("runtime-replica:edge:project-ui-333")?.status).toBe("running");
    expect(records.get("runtime-replica:edge:project-ui-999")?.status).toBe("running");
    expect(records.get("runtime-replica:edge:custom-edge")?.status).toBe("running");
    expect(records.get("runtime-replica:edge:project-ui-777")?.status).toBe("running");
  });
});

class FakeRuntimeChild implements SpawnedProcessPort {
  pid = 12345;
  killed = false;
  exitCode: number | null = null;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();

  kill(): boolean {
    this.killed = true;
    return true;
  }

  once(): this {
    return this;
  }
}

function makeEdgeProcess(
  edgeId: string,
  input: {
    replicaPid: number;
    projectId: string;
    ownerPid?: number;
    socketPath?: string;
  },
): RuntimeProcessRecord {
  void input.ownerPid;
  return markProcessRunning(
    createRuntimeProcess({
      id: `runtime-replica:edge:${edgeId}`,
      kind: "runtime-replica",
      owner: { scope: "project", projectId: input.projectId },
      command: {
        executable: "tiny-agent",
        args: ["runtime", "replica", "--mode", "edge", "--edge-id", edgeId],
      },
      now: "2026-06-15T00:00:00.000Z",
      metadata: {
        mode: "edge",
        edgeId,
        socketPath: input.socketPath ?? `/tmp/${edgeId}.sock`,
      },
    }),
    {
      now: "2026-06-15T00:00:00.000Z",
      pid: input.replicaPid,
    },
  );
}

function makeProcessStore(records: Map<string, RuntimeProcessRecord>) {
  return {
    list: () => [...records.values()],
    upsert: (record: RuntimeProcessRecord): RuntimeProcessSnapshot => {
      records.set(record.id, record);
      return {
        schemaVersion: 1,
        version: 1,
        updatedAt: "2026-06-15T00:00:01.000Z",
        processes: [...records.values()],
      };
    },
  };
}
