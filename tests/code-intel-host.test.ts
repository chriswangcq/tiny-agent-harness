import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createCodeIntelHostRuntime,
  handleCodeIntelHostRequest,
  launchCodeIntelHost,
  listenCodeIntelHostSocket,
  parseCodeIntelHostRequest,
  requestCodeIntelHostSocket,
  runCodeIntelHostCli,
} from "../src/code-intel/index.js";
import { defaultConfig } from "../src/code-intel/config.js";
import type { CodeIntelBackend } from "../src/code-intel/index.js";
import type { CodeIntelRuntime } from "../src/code-intel/commands.js";

function makeRuntime(): CodeIntelRuntime {
  return {
    cwd: "/repo",
    workspaceRoot: "/repo",
    config: defaultConfig(),
    createBackend() {
      throw new Error("backend should not be used for capabilities");
    },
    collectWorkspaceDiagnostics() {
      return { diagnostics: [], truncated: false, omittedResults: 0 };
    },
  };
}

describe("code-intel host process planning", () => {
  it("requires an explicit resident socket for codeq host", async () => {
    await expect(runCodeIntelHostCli(["--cwd", "/repo"])).rejects.toThrow(
      "Usage: tiny-agent codeq host --socket <path>",
    );
  });

  it("launches a run-owned codeq-host and waits for socket readiness", async () => {
    let startInput: unknown;
    let killSignal: NodeJS.Signals | number | undefined;
    const socketPath = "/tmp/ta-rh/codeq-1234567890abcdef.sock";
    const child = {
      pid: 123,
      killed: false,
      exitCode: null,
      stdin: null,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill(signal?: NodeJS.Signals | number) {
        killSignal = signal;
        this.killed = true;
        return true;
      },
      once() {
        return this;
      },
    };
    const launched = await launchCodeIntelHost({
      supervisor: {
        startProcess(input) {
          startInput = input;
          return {
            process: {} as never,
            child,
          };
        },
      },
      processId: "codeq-host:run-1",
      owner: { scope: "run", runId: "run-1" },
      executable: "node",
      args: [
        "dist/cli/main.js",
        "codeq",
        "host",
        "--cwd",
        "/repo",
        "--socket",
        socketPath,
      ],
      cwd: "/repo",
      env: {},
      workspaceRoot: "/repo",
      socketPath,
      statePath: "/state/runs/run-1/codeq-host.json",
      startupTimeoutMs: 10,
      nowEpochMs: () => 0,
      wait: async () => {},
      isSocketReady: () => true,
    });

    expect(startInput).toMatchObject({
      kind: "codeq-host",
      owner: { scope: "run", runId: "run-1" },
      args: [
        "dist/cli/main.js",
        "codeq",
        "host",
        "--cwd",
        "/repo",
        "--socket",
        socketPath,
      ],
      metadata: {
        runId: "run-1",
        workspaceRoot: "/repo",
        socketPath,
      },
    });
    expect(launched.socketPath).toBe(socketPath);

    await launched.dispose();
    expect(killSignal).toBe("SIGTERM");
  });
});

describe("code-intel host protocol", () => {
  it("parses execute requests", () => {
    const request = parseCodeIntelHostRequest(
      JSON.stringify({
        schemaVersion: 1,
        id: "req-1",
        type: "codeq.execute",
        command: { kind: "capabilities" },
      }),
    );

    expect(request).toMatchObject({
      id: "req-1",
      type: "codeq.execute",
      command: { kind: "capabilities" },
    });
  });

  it("executes requests against an explicit runtime", async () => {
    const executor = createCodeIntelHostRuntime(makeRuntime());
    const response = await handleCodeIntelHostRequest(executor, {
      schemaVersion: 1,
      id: "req-1",
      type: "codeq.execute",
      command: { kind: "capabilities" },
    });

    expect(response).toMatchObject({
      schemaVersion: 1,
      id: "req-1",
      ok: true,
      type: "codeq.execute.result",
    });
    if (response.type === "codeq.execute.result") {
      expect(response.envelope.ok).toBe(true);
    }
    await executor.dispose();
  });

  it("reuses one backend across repeated host requests", async () => {
    let createBackendCount = 0;
    let symbolsCount = 0;
    let disposeCount = 0;
    const runtime: CodeIntelRuntime = {
      cwd: "/repo",
      workspaceRoot: "/repo",
      config: defaultConfig(),
      createBackend() {
        createBackendCount += 1;
        return makeBackend({
          symbols: async (path) => {
            symbolsCount += 1;
            return { path, symbols: [] };
          },
          dispose: async () => {
            disposeCount += 1;
          },
        });
      },
      collectWorkspaceDiagnostics() {
        return { diagnostics: [], truncated: false, omittedResults: 0 };
      },
    };
    const executor = createCodeIntelHostRuntime(runtime);

    const first = await handleCodeIntelHostRequest(executor, {
      schemaVersion: 1,
      id: "symbols-1",
      type: "codeq.execute",
      command: { kind: "symbols", path: "src/a.ts" },
    });
    const second = await handleCodeIntelHostRequest(executor, {
      schemaVersion: 1,
      id: "symbols-2",
      type: "codeq.execute",
      command: { kind: "symbols", path: "src/b.ts" },
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(createBackendCount).toBe(1);
    expect(symbolsCount).toBe(2);
    expect(disposeCount).toBe(0);

    await executor.dispose();
    expect(disposeCount).toBe(1);
  });

  it("serializes backend requests inside one host runtime", async () => {
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      markFirstStarted = resolve;
    });
    const runtime: CodeIntelRuntime = {
      cwd: "/repo",
      workspaceRoot: "/repo",
      config: defaultConfig(),
      createBackend() {
        return makeBackend({
          symbols: async (path) => {
            events.push(`start:${path}`);
            if (path === "src/a.ts") {
              markFirstStarted?.();
              await new Promise<void>((release) => {
                releaseFirst = release;
              });
            }
            events.push(`finish:${path}`);
            return { path, symbols: [] };
          },
        });
      },
      collectWorkspaceDiagnostics() {
        return { diagnostics: [], truncated: false, omittedResults: 0 };
      },
    };
    const executor = createCodeIntelHostRuntime(runtime);

    const first = handleCodeIntelHostRequest(executor, {
      schemaVersion: 1,
      id: "symbols-1",
      type: "codeq.execute",
      command: { kind: "symbols", path: "src/a.ts" },
    });

    await firstStarted;
    const second = handleCodeIntelHostRequest(executor, {
      schemaVersion: 1,
      id: "symbols-2",
      type: "codeq.execute",
      command: { kind: "symbols", path: "src/b.ts" },
    });
    await Promise.resolve();

    expect(events).toEqual(["start:src/a.ts"]);
    releaseFirst?.();

    const responses = await Promise.all([first, second]);
    expect(responses.every((response) => response.ok)).toBe(true);
    expect(events).toEqual([
      "start:src/a.ts",
      "finish:src/a.ts",
      "start:src/b.ts",
      "finish:src/b.ts",
    ]);

    await executor.dispose();
  });
});

describe("code-intel host socket transport", () => {
  it("roundtrips one-shot client requests over a Unix socket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeq-host-socket-"));
    const socketPath = path.join(dir, "codeq.sock");
    const server = await listenCodeIntelHostSocket({
      socketPath,
      handleRequest: async (request) =>
        handleCodeIntelHostRequest(createCodeIntelHostRuntime(makeRuntime()), request),
    });

    try {
      const response = await requestCodeIntelHostSocket({
        socketPath,
        timeoutMs: 1_000,
        request: {
          schemaVersion: 1,
          id: "socket-req-1",
          type: "codeq.execute",
          command: { kind: "capabilities" },
        },
      });

      expect(response).toMatchObject({
        schemaVersion: 1,
        id: "socket-req-1",
        ok: true,
        type: "codeq.execute.result",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not replace non-socket files at the socket path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeq-host-socket-"));
    const socketPath = path.join(dir, "codeq.sock");
    fs.writeFileSync(socketPath, "not a socket");

    await expect(
      listenCodeIntelHostSocket({
        socketPath,
        handleRequest: async (request) =>
          handleCodeIntelHostRequest(createCodeIntelHostRuntime(makeRuntime()), request),
      }),
    ).rejects.toThrow("Refusing to replace non-socket path");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

function makeBackend(
  overrides: Partial<CodeIntelBackend>,
): CodeIntelBackend {
  return {
    info() {
      return {
        languageId: "typescript",
        server: "fake-ts",
        serverCommand: ["fake-ts"],
        capabilities: [],
        source: "lsp",
      };
    },
    async diagnostics() {
      return { diagnostics: [] };
    },
    async symbols(path) {
      return { path, symbols: [] };
    },
    async workspaceSymbols(query) {
      return { query, symbols: [] };
    },
    async definition() {
      return { definitions: [] };
    },
    async references() {
      return { references: [] };
    },
    async implementations() {
      return { implementations: [] };
    },
    async incomingCalls() {
      return { items: [], incomingCalls: [] };
    },
    async outgoingCalls() {
      return { items: [], outgoingCalls: [] };
    },
    async hover() {
      return { contents: [] };
    },
    async dispose() {},
    ...overrides,
  };
}
