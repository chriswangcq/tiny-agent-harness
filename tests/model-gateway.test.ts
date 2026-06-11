import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  handleModelGatewayRequest,
  launchModelGateway,
  createModelGatewayPort,
  createModelGatewayProcessRecord,
  parseModelGatewayRequest,
  serializeModelGatewayRequest,
  type ModelGatewayResponse,
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

describe("model gateway process planning", () => {
  it("creates project-owned model-gateway process records", () => {
    const record = createModelGatewayProcessRecord({
      projectId: "project-1",
      modelId: "deepseek-test",
      now: "2026-06-11T00:00:00.000Z",
      statePath: "/state/model/state.json",
      logPath: "/state/model/output.log",
    });

    expect(record).toMatchObject({
      id: "model-gateway:project-1:deepseek-test",
      kind: "model-gateway",
      owner: {
        scope: "project",
        projectId: "project-1",
      },
      status: "planned",
      command: {
        executable: "tiny-agent",
        args: ["model-gateway", "--model", "deepseek-test"],
      },
      metadata: {
        modelId: "deepseek-test",
      },
    });
  });
});

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
});

class FakeChild extends EventEmitter implements SpawnedProcessPort {
  pid = 123;
  killed = false;
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();

  kill(): boolean {
    this.killed = true;
    return true;
  }
}

describe("launchModelGateway", () => {
  it("starts a supervisor-recorded model-gateway process and speaks JSONL IPC", async () => {
    const child = new FakeChild();
    const starts: StartManagedProcessInput[] = [];
    child.stdin.on("data", (chunk) => {
      const request = JSON.parse(chunk.toString()) as { id: string; type: string };
      const response: ModelGatewayResponse =
        request.type === "model.shutdown"
          ? {
              schemaVersion: 1,
              id: request.id,
              ok: true,
              type: "model.shutdown.result",
            }
          : {
              schemaVersion: 1,
              id: request.id,
              ok: true,
              type: "model.generateTurn.result",
              output,
            };
      child.stdout.write(`${JSON.stringify(response)}\n`);
    });

    const launched = launchModelGateway({
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
      processId: "model-gateway:run-1:deepseek",
      owner: { scope: "run", runId: "run-1" },
      executable: "node",
      args: ["dist/cli/main.js", "model-gateway"],
      cwd: "/repo",
      env: {},
      newRequestId: () => "req-1",
    });

    await expect(
      launched.model.generateTurn(
        { runId: "run-1", stepIndex: 0, messages: [] },
        { tools: [] },
      ),
    ).resolves.toEqual(output);
    expect(starts[0]).toMatchObject({
      processId: "model-gateway:run-1:deepseek",
      kind: "model-gateway",
      stdio: ["pipe", "pipe", "pipe"],
      owner: { scope: "run", runId: "run-1" },
    });

    await launched.dispose();
    expect(child.killed).toBe(false);
  });

  it("keeps CLI main from directly constructing DeepSeekFimAdapter", () => {
    const main = fs.readFileSync(path.resolve("src/cli/main.ts"), "utf-8");
    expect(main).not.toContain("new DeepSeekFimAdapter");
    expect(main).toContain("launchModelGateway");
  });
});
