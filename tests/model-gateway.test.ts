import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import * as net from "node:net";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  handleModelGatewayRequest,
  listenModelGatewaySocket,
  launchModelGateway,
  createModelGatewayPort,
  parseModelGatewayRequest,
  parseModelGatewayResponse,
  requestModelGatewaySocket,
  serializeModelGatewayRequest,
} from "../src/model/index.js";
import type { FimStepOutput } from "../src/types/index.js";
import type {
  SpawnedProcessPort,
  StartManagedProcessInput,
} from "../src/runtime/index.js";

const output: FimStepOutput = {
  thinking: { content: "thinking" },
  rawDecision: "{}",
  turn: {
    kind: "invalid_output",
    message: "test",
  },
};

describe("model gateway protocol", () => {
  it("serializes and parses generate requests", () => {
    const raw = serializeModelGatewayRequest({
      schemaVersion: 1,
      id: "req-1",
      type: "model.generateTurn",
      context: {
        runId: "run-1",
        stepIndex: 0,
        messages: [],
      },
      tools: [],
    });

    expect(parseModelGatewayRequest(raw)).toMatchObject({
      id: "req-1",
      type: "model.generateTurn",
      context: {
        runId: "run-1",
      },
    });
    expect(
      parseModelGatewayResponse(
        JSON.stringify({
          schemaVersion: 1,
          id: "req-1",
          ok: true,
          type: "model.generateTurn.result",
          output,
        }),
        "req-1",
      ),
    ).toMatchObject({
      id: "req-1",
      type: "model.generateTurn.result",
    });
  });

  it("rejects responses with mismatched ids", () => {
    expect(() =>
      parseModelGatewayResponse(
        JSON.stringify({
          schemaVersion: 1,
          id: "other",
          ok: true,
          type: "model.shutdown.result",
        }),
        "req-1",
      ),
    ).toThrow("expected id req-1");
  });
});

describe("createModelGatewayPort", () => {
  it("adapts ModelPort calls to an injected transport", async () => {
    const sent: unknown[] = [];
    const port = createModelGatewayPort({
      newRequestId: () => "req-1",
      transport: {
        async request(request) {
          sent.push(request);
          return {
            schemaVersion: 1,
            id: request.id,
            ok: true,
            type: "model.generateTurn.result",
            output,
          };
        },
      },
    });

    await expect(
      port.generateTurn(
        { runId: "run-1", stepIndex: 0, messages: [] },
        { tools: [] },
      ),
    ).resolves.toBe(output);
    expect(sent).toEqual([
      {
        schemaVersion: 1,
        id: "req-1",
        type: "model.generateTurn",
        context: {
          runId: "run-1",
          stepIndex: 0,
          messages: [],
        },
        tools: [],
      },
    ]);
  });

  it("relays model progress through the injected transport boundary", async () => {
    const progress: unknown[] = [];
    const port = createModelGatewayPort({
      newRequestId: () => "req-1",
      transport: {
        async request(request, options) {
          await options?.onProgress?.({
            type: "thinking_delta",
            content: "streamed",
            sequence: 0,
          });
          return {
            schemaVersion: 1,
            id: request.id,
            ok: true,
            type: "model.generateTurn.result",
            output,
          };
        },
      },
    });

    await expect(
      port.generateTurn(
        { runId: "run-1", stepIndex: 0, messages: [] },
        {
          tools: [],
          onProgress: (event) => {
            progress.push(event);
          },
        },
      ),
    ).resolves.toBe(output);
    expect(progress).toEqual([
      {
        type: "thinking_delta",
        content: "streamed",
        sequence: 0,
      },
    ]);
  });

  it("raises structured gateway errors", async () => {
    const port = createModelGatewayPort({
      newRequestId: () => "req-1",
      transport: {
        async request(request) {
          return {
            schemaVersion: 1,
            id: request.id,
            ok: false,
            type: "model.error",
            error: {
              code: "CANCELLED",
              message: "cancelled",
            },
          };
        },
      },
    });

    await expect(
      port.generateTurn(
        { runId: "run-1", stepIndex: 0, messages: [] },
        { tools: [] },
      ),
    ).rejects.toThrow(/CANCELLED/);
  });
});

describe("model gateway host", () => {
  it("handles generateTurn requests through an explicit ModelPort", async () => {
    const response = await handleModelGatewayRequest(
      {
        async generateTurn() {
          return output;
        },
      },
      {
        schemaVersion: 1,
        id: "req-1",
        type: "model.generateTurn",
        context: { runId: "run-1", stepIndex: 0, messages: [] },
        tools: [],
      },
    );

    expect(response).toEqual({
      schemaVersion: 1,
      id: "req-1",
      ok: true,
      type: "model.generateTurn.result",
      output,
    });
  });

  it("serves generateTurn and shutdown requests over the resident socket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-gateway-socket-"));
    const socketPath = path.join(dir, "model-gateway.sock");
    const server = await listenModelGatewaySocket({
      socketPath,
      model: {
        async generateTurn() {
          return output;
        },
      },
    });

    try {
      await expect(
        requestModelGatewaySocket({
          socketPath,
          timeoutMs: 1_000,
          request: {
            schemaVersion: 1,
            id: "generate-1",
            type: "model.generateTurn",
            context: { runId: "run-1", stepIndex: 0, messages: [] },
            tools: [],
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
        type: "model.generateTurn.result",
      });

      const closed = new Promise<void>((resolve) => server.once("close", resolve));
      await expect(
        requestModelGatewaySocket({
          socketPath,
          timeoutMs: 1_000,
          request: {
            schemaVersion: 1,
            id: "shutdown-1",
            type: "model.shutdown",
            reason: "test",
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
        type: "model.shutdown.result",
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

  it("streams generateTurn progress over the resident socket before the terminal result", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-gateway-progress-socket-"));
    const socketPath = path.join(dir, "model-gateway.sock");
    const server = await listenModelGatewaySocket({
      socketPath,
      model: {
        async generateTurn(_context, options) {
          await options.onProgress?.({
            type: "thinking_delta",
            content: "alpha",
            sequence: 0,
          });
          await options.onProgress?.({
            type: "thinking_delta",
            content: "beta",
            sequence: 1,
          });
          return output;
        },
      },
    });
    const progress: unknown[] = [];

    try {
      await expect(
        requestModelGatewaySocket({
          socketPath,
          timeoutMs: 1_000,
          request: {
            schemaVersion: 1,
            id: "generate-progress-1",
            type: "model.generateTurn",
            context: { runId: "run-1", stepIndex: 0, messages: [] },
            tools: [],
          },
          onProgress: (event) => {
            progress.push(event);
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
        type: "model.generateTurn.result",
      });
      expect(progress).toEqual([
        {
          type: "thinking_delta",
          content: "alpha",
          sequence: 0,
        },
        {
          type: "thinking_delta",
          content: "beta",
          sequence: 1,
        },
      ]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns model errors over the resident socket with the request id", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-gateway-error-socket-"));
    const socketPath = path.join(dir, "model-gateway.sock");
    const server = await listenModelGatewaySocket({
      socketPath,
      model: {
        async generateTurn() {
          throw new Error("provider failed");
        },
      },
    });

    try {
      await expect(
        requestModelGatewaySocket({
          socketPath,
          timeoutMs: 1_000,
          request: {
            schemaVersion: 1,
            id: "generate-error-1",
            type: "model.generateTurn",
            context: { runId: "run-1", stepIndex: 0, messages: [] },
            tools: [],
          },
        }),
      ).resolves.toMatchObject({
        id: "generate-error-1",
        ok: false,
        type: "model.error",
        error: {
          code: "MODEL_ERROR",
          message: "provider failed",
        },
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("model gateway socket stream ordering", () => {
  it("drains progress lines before resolving a result from the same socket chunk", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mgw-order-"));
    const socketPath = path.join(dir, "model-gateway.sock");
    const server = await listenRawModelGatewaySocket(socketPath, "req-1", [
      progressLine("req-1", "alpha", 0),
      progressLine("req-1", "beta", 1),
      resultLine("req-1"),
    ]);
    const progress: string[] = [];

    try {
      await expect(
        requestModelGatewaySocket({
          socketPath,
          timeoutMs: 1_000,
          request: generateRequest("req-1"),
          onProgress: (event) => {
            progress.push(event.content);
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
        type: "model.generateTurn.result",
      });
      expect(progress).toEqual(["alpha", "beta"]);
    } finally {
      await closeServer(server);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waits for a slow progress handler before resolving the terminal result", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mgw-slow-"));
    const socketPath = path.join(dir, "model-gateway.sock");
    const server = await listenRawModelGatewaySocket(socketPath, "req-2", [
      progressLine("req-2", "slow", 0),
      resultLine("req-2"),
    ]);
    let releaseProgress!: () => void;
    const progressGate = new Promise<void>((resolve) => {
      releaseProgress = resolve;
    });
    let progressStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      progressStarted = resolve;
    });
    let resolved = false;

    try {
      const request = requestModelGatewaySocket({
        socketPath,
        timeoutMs: 1_000,
        request: generateRequest("req-2"),
        onProgress: async () => {
          progressStarted();
          await progressGate;
        },
      }).then((response) => {
        resolved = true;
        return response;
      });

      await started;
      await Promise.resolve();
      expect(resolved).toBe(false);

      releaseProgress();
      await expect(request).resolves.toMatchObject({
        ok: true,
        type: "model.generateTurn.result",
      });
      expect(resolved).toBe(true);
    } finally {
      await closeServer(server);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects progress that appears after a terminal response in the same stream batch", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mgw-late-"));
    const socketPath = path.join(dir, "model-gateway.sock");
    const server = await listenRawModelGatewaySocket(socketPath, "req-3", [
      resultLine("req-3"),
      progressLine("req-3", "late", 0),
    ]);

    try {
      await expect(
        requestModelGatewaySocket({
          socketPath,
          timeoutMs: 1_000,
          request: generateRequest("req-3"),
        }),
      ).rejects.toThrow("progress received after terminal response");
    } finally {
      await closeServer(server);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

async function listenRawModelGatewaySocket(
  socketPath: string,
  requestId: string,
  responseLines: string[],
): Promise<net.Server> {
  const server = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      const request = JSON.parse(chunk.toString("utf-8").trim()) as { id?: string };
      if (request.id !== requestId) {
        socket.write(
          `${JSON.stringify({
            schemaVersion: 1,
            id: request.id ?? "unknown",
            ok: false,
            type: "model.error",
            error: {
              code: "BAD_REQUEST",
              message: `expected ${requestId}`,
            },
          })}\n`,
        );
        return;
      }
      socket.write(`${responseLines.join("\n")}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return server;
}

async function closeServer(server: net.Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

function generateRequest(id: string) {
  return {
    schemaVersion: 1 as const,
    id,
    type: "model.generateTurn" as const,
    context: { runId: "run-1", stepIndex: 0, messages: [] },
    tools: [],
  };
}

function progressLine(id: string, content: string, sequence: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    id,
    ok: true,
    type: "model.generateTurn.progress",
    progress: {
      type: "thinking_delta",
      content,
      sequence,
    },
  });
}

function resultLine(id: string): string {
  return JSON.stringify({
    schemaVersion: 1,
    id,
    ok: true,
    type: "model.generateTurn.result",
    output,
  });
}

class FakeChild extends EventEmitter implements SpawnedProcessPort {
  pid = 123;
  killed = false;
  exitCode: number | null = null;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe("launchModelGateway", () => {
  it("starts a supervisor-recorded model-gateway process and speaks over the resident socket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "model-gateway-launcher-"));
    const socketPath = path.join(dir, "model-gateway.sock");
    const server = await listenModelGatewaySocket({
      socketPath,
      model: {
        async generateTurn() {
          return output;
        },
      },
    });
    const child = new FakeChild();
    const starts: StartManagedProcessInput[] = [];
    let sequence = 0;

    try {
      const launched = await launchModelGateway({
        supervisor: {
          startProcess(input) {
            starts.push(input);
            return {
              process: {
                schemaVersion: 1,
                id: input.processId,
                kind: "model-gateway",
                owner: input.owner,
                status: "running",
                command: {
                  executable: input.executable,
                  args: input.args,
                },
                createdAt: "2026-06-11T00:00:00.000Z",
                updatedAt: "2026-06-11T00:00:00.000Z",
                pid: child.pid,
              },
              child,
            };
          },
        },
        processId: "model-gateway:run-1",
        owner: { scope: "run", runId: "run-1" },
        executable: "node",
        args: ["dist/cli/main.js", "model-gateway", "--socket", socketPath],
        cwd: "/repo",
        env: {},
        socketPath,
        newRequestId: () => `req-${++sequence}`,
      });

      await expect(
        launched.model.generateTurn(
          { runId: "run-1", stepIndex: 0, messages: [] },
          { tools: [] },
        ),
      ).resolves.toEqual(output);
      expect(starts[0]).toMatchObject({
        processId: "model-gateway:run-1",
        kind: "model-gateway",
        stdio: ["ignore", "pipe", "pipe"],
        owner: { scope: "run", runId: "run-1" },
        metadata: {
          runId: "run-1",
          socketPath,
        },
      });
      expect(starts[0]?.args).toEqual([
        "dist/cli/main.js",
        "model-gateway",
        "--socket",
        socketPath,
      ]);
      expect(launched.socketPath).toBe(socketPath);

      await launched.dispose();
      expect(child.killed).toBe(true);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps CLI main from directly constructing DeepSeekFimAdapter", () => {
    const main = fs.readFileSync(path.resolve("src/cli/main.ts"), "utf-8");
    expect(main).not.toContain("new DeepSeekFimAdapter");
    expect(main).toContain("launchModelGateway");
  });
});
