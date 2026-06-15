import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
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
