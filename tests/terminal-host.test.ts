import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTerminalHostRunPort,
  handleTerminalHostRequest,
  listenTerminalHostSocket,
  parseTerminalHostRequest,
  parseTerminalHostResponse,
  requestTerminalHostSocket,
  serializeTerminalHostResponse,
} from "../src/terminal-host/index.js";
import type { ToolObservation, ToolRequest } from "../src/types/tools.js";

function makeRequest(): ToolRequest {
  return {
    kind: "terminal_tool",
    toolCallId: "tc-1",
    toolName: "session_observe",
    request: {
      kind: "session_observe",
      session: "default",
      startLine: 0,
      lineCount: 10,
    },
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

describe("terminal host protocol", () => {
  it("parses execute requests and serializes responses as JSONL", () => {
    const parsed = parseTerminalHostRequest(
      JSON.stringify({
        schemaVersion: 1,
        id: "req-1",
        type: "terminal.execute",
        request: makeRequest(),
      }),
    );

    expect(parsed).toMatchObject({
      id: "req-1",
      type: "terminal.execute",
    });
    expect(
      parseTerminalHostResponse(
        JSON.stringify({
          schemaVersion: 1,
          id: "req-1",
          ok: true,
          type: "terminal.execute.result",
          observation: makeObservation(),
        }),
        "req-1",
      ),
    ).toMatchObject({
      id: "req-1",
      type: "terminal.execute.result",
    });
    expect(
      serializeTerminalHostResponse({
        schemaVersion: 1,
        id: "req-1",
        ok: true,
        type: "terminal.shutdown.result",
      }),
    ).toBe(
      '{"schemaVersion":1,"id":"req-1","ok":true,"type":"terminal.shutdown.result"}\n',
    );
  });

  it("rejects non-terminal execute payloads", () => {
    expect(() =>
      parseTerminalHostRequest(
        JSON.stringify({
          schemaVersion: 1,
          id: "bad",
          type: "terminal.execute",
          request: { kind: "agent_tool" },
        }),
      ),
    ).toThrow(/terminal_tool/);
  });

  it("rejects responses with mismatched ids", () => {
    expect(() =>
      parseTerminalHostResponse(
        JSON.stringify({
          schemaVersion: 1,
          id: "other",
          ok: true,
          type: "terminal.shutdown.result",
        }),
        "req-1",
      ),
    ).toThrow("expected id req-1");
  });
});

describe("createTerminalHostRunPort", () => {
  it("adapts TerminalPort requests to a host transport", async () => {
    const sent: unknown[] = [];
    const observation = makeObservation();
    const port = createTerminalHostRunPort({
      newRequestId: () => "req-1",
      transport: {
        async request(request) {
          sent.push(request);
          return {
            schemaVersion: 1,
            id: request.id,
            ok: true,
            type: "terminal.execute.result",
            observation,
          };
        },
      },
    });

    await expect(port.execute(makeRequest())).resolves.toBe(observation);
    expect(sent).toEqual([
      {
        schemaVersion: 1,
        id: "req-1",
        type: "terminal.execute",
        request: makeRequest(),
      },
    ]);
  });
});

describe("handleTerminalHostRequest", () => {
  it("returns terminal execution errors as protocol errors", async () => {
    const response = await handleTerminalHostRequest(
      {
        async execute() {
          throw new Error("pty failed");
        },
      },
      {
        schemaVersion: 1,
        id: "req-1",
        type: "terminal.execute",
        request: makeRequest(),
      },
    );

    expect(response).toMatchObject({
      ok: false,
      id: "req-1",
      type: "terminal.error",
      error: {
        code: "TERMINAL_ERROR",
        message: "pty failed",
      },
    });
  });
});

describe("listenTerminalHostSocket", () => {
  it("serves execute and shutdown requests over the resident socket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "terminal-host-socket-"));
    const socketPath = path.join(dir, "terminal-host.sock");
    const server = await listenTerminalHostSocket({
      socketPath,
      terminal: {
        async execute() {
          return makeObservation();
        },
      },
    });

    try {
      await expect(
        requestTerminalHostSocket({
          socketPath,
          timeoutMs: 1_000,
          request: {
            schemaVersion: 1,
            id: "execute-1",
            type: "terminal.execute",
            request: makeRequest(),
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
        type: "terminal.execute.result",
      });

      const closed = new Promise<void>((resolve) => server.once("close", resolve));
      await expect(
        requestTerminalHostSocket({
          socketPath,
          timeoutMs: 1_000,
          request: {
            schemaVersion: 1,
            id: "shutdown-1",
            type: "terminal.shutdown",
            reason: "test",
          },
        }),
      ).resolves.toMatchObject({
        ok: true,
        type: "terminal.shutdown.result",
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
});
