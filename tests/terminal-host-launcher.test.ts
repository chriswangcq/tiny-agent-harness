import { describe, expect, it } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  listenTerminalHostSocket,
  launchTerminalHost,
} from "../src/terminal-host/index.js";
import type {
  SpawnedProcessPort,
  StartManagedProcessInput,
} from "../src/runtime/index.js";
import type { ToolObservation, ToolRequest } from "../src/types/index.js";

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

  emitExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.emit("exit", code, signal);
  }
}

function makeRequest(): ToolRequest {
  return {
    kind: "terminal_tool",
    toolCallId: "tc-1",
    toolName: "session_observe",
    request: { kind: "session_observe" },
  };
}

function makeObservation(): ToolObservation {
  return {
    currentSession: "default",
    observedSession: "default",
    terminal: {
      inputSeq: 1,
      alive: true,
      syncStatus: { kind: "trusted" },
      lastShellPrompt: null,
      lastContinuationPrompt: null,
      termination: null,
      foregroundProcess: null,
    },
    request: "session_observe",
    result: "ok",
    returnedToPrompt: false,
    screen: {
      text: "",
      rows: 24,
      cols: 80,
      window: {
        startLine: 0,
        endLine: 0,
        totalLines: 0,
        cols: 80,
        rows: 24,
        hasOlder: false,
        hasNewer: false,
      },
      truncated: false,
      logRef: { path: "managed-pty://default" },
    },
  };
}

describe("launchTerminalHost", () => {
  it("starts a supervisor-recorded terminal-host process and speaks over the resident socket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-host-launcher-"));
    const socketPath = path.join(dir, "terminal-host.sock");
    const server = await listenTerminalHostSocket({
      socketPath,
      terminal: {
        async execute() {
          return makeObservation();
        },
      },
    });
    const child = new FakeChild();
    const starts: StartManagedProcessInput[] = [];
    let sequence = 0;

    try {
      const launched = await launchTerminalHost({
        supervisor: {
          startProcess(input) {
            starts.push(input);
            return {
              process: {
                schemaVersion: 1,
                id: input.processId,
                kind: "terminal-host",
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
        processId: "terminal-host:run-1",
        owner: { scope: "run", runId: "run-1" },
        executable: "node",
        args: ["dist/cli/main.js", "terminal-host", "--socket", socketPath],
        cwd: "/repo",
        env: {},
        socketPath,
        newRequestId: () => `req-${++sequence}`,
      });

      await expect(launched.terminal.execute(makeRequest())).resolves.toMatchObject({
        result: "ok",
        request: "session_observe",
      });
      expect(starts[0]).toMatchObject({
        processId: "terminal-host:run-1",
        kind: "terminal-host",
        stdio: ["ignore", "pipe", "pipe"],
        owner: { scope: "run", runId: "run-1" },
        metadata: {
          runId: "run-1",
          socketPath,
        },
      });
      expect(starts[0]?.args).toEqual([
        "dist/cli/main.js",
        "terminal-host",
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

  it("keeps CLI main from directly constructing ManagedTerminalRuntime", () => {
    const main = fs.readFileSync(
      path.resolve("src/cli/main.ts"),
      "utf-8",
    );
    expect(main).not.toContain("new ManagedTerminalRuntime");
    expect(main).toContain("launchTerminalHost");
  });
});
