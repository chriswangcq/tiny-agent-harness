import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  executeMcpClientArgv,
  type McpCliDeps,
} from "../src/mcp/cli.js";
import {
  createMcpHostExecutor,
  listenMcpHostSocket,
  requestMcpHostSocket,
  type McpHostResponse,
} from "../src/mcp/host.js";
import { launchMcpHost } from "../src/mcp/launcher.js";

function makeClientDeps(options?: {
  env?: NodeJS.ProcessEnv;
  requestHost?: McpCliDeps["requestHost"];
}): {
  deps: McpCliDeps;
  stdout: () => string;
  stderr: () => string;
} {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  return {
    deps: {
      stdout: {
        write(text: string) {
          stdoutChunks.push(text);
          return undefined;
        },
      },
      stderr: {
        write(text: string) {
          stderrChunks.push(text);
          return undefined;
        },
      },
      env: options?.env ?? {},
      cwd: "/repo",
      timeoutMs: 1000,
      newRequestId: () => "mcp-test-req",
      requestHost:
        options?.requestHost ??
        (async () => {
          throw new Error("requestHost should be injected by this test");
        }),
    },
    stdout: () => stdoutChunks.join(""),
    stderr: () => stderrChunks.join(""),
  };
}

describe("mcp host-only CLI", () => {
  it("launches a run-owned mcp-host with explicit metadata", async () => {
    let startInput: unknown;
    let killSignal: NodeJS.Signals | number | undefined;
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

    const launched = await launchMcpHost({
      supervisor: {
        startProcess(input) {
          startInput = input;
          return { process: {} as never, child };
        },
      },
      processId: "mcp-host:run-1",
      owner: { scope: "run", runId: "run-1" },
      executable: "node",
      args: ["dist/cli/main.js", "mcp", "host", "--socket", "/state/runs/run-1/mcp-host.sock"],
      cwd: "/repo",
      env: {},
      socketPath: "/state/runs/run-1/mcp-host.sock",
      projectStateDir: "/state",
      startupTimeoutMs: 10,
      nowEpochMs: () => 0,
      wait: async () => {},
      isSocketReady: () => true,
    });

    expect(startInput).toMatchObject({
      kind: "mcp-host",
      owner: { scope: "run", runId: "run-1" },
      args: ["dist/cli/main.js", "mcp", "host", "--socket", "/state/runs/run-1/mcp-host.sock"],
      metadata: {
        runId: "run-1",
        socketPath: "/state/runs/run-1/mcp-host.sock",
        projectStateDir: "/state",
      },
    });

    await launched.dispose();
    expect(killSignal).toBe("SIGTERM");
  });

  it("fails without an explicit run-scoped host socket", async () => {
    const h = makeClientDeps();

    const rc = await executeMcpClientArgv(["list", "--json"], h.deps);

    expect(rc).toBe(1);
    expect(h.stderr()).toBe("");
    const envelope = JSON.parse(h.stdout()) as Record<string, unknown>;
    expect(envelope).toMatchObject({
      ok: false,
      tool: "mcp",
      errorCode: "MCP_HOST_NOT_FOUND",
    });
  });

  it("routes public argv to the configured MCP host socket", async () => {
    let captured: unknown;
    const h = makeClientDeps({
      env: { TAH_MCP_HOST_SOCKET: "/tmp/mcp-host.sock" },
      requestHost: async (request): Promise<McpHostResponse> => {
        captured = request;
        return {
          schemaVersion: 1,
          id: request.request.id,
          ok: true,
          type: "mcp.execute.result",
          exitCode: 0,
          stdout: "{\"ok\":true}\n",
          stderr: "",
        };
      },
    });

    const rc = await executeMcpClientArgv(["--json", "list"], h.deps);

    expect(rc).toBe(0);
    expect(h.stdout()).toBe("{\"ok\":true}\n");
    expect(captured).toMatchObject({
      socketPath: "/tmp/mcp-host.sock",
      request: {
        schemaVersion: 1,
        id: "mcp-test-req",
        type: "mcp.execute",
        argv: ["--json", "list"],
      },
    });
  });

  it("executes MCP list through a real resident socket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-host-test-"));
    const socketPath = path.join(dir, "mcp-host.sock");
    const executor = createMcpHostExecutor({
      cwd: dir,
      env: { TAH_STATE_DIR: dir },
      stdout: { write: () => undefined },
      stderr: { write: () => undefined },
    });
    const server = await listenMcpHostSocket({ socketPath, executor });

    try {
      const response = await requestMcpHostSocket({
        socketPath,
        timeoutMs: 1000,
        request: {
          schemaVersion: 1,
          id: "list-1",
          type: "mcp.execute",
          argv: ["--json", "list"],
        },
      });

      expect(response).toMatchObject({
        schemaVersion: 1,
        id: "list-1",
        ok: true,
        type: "mcp.execute.result",
        exitCode: 0,
      });
      if (response.type === "mcp.execute.result") {
        const envelope = JSON.parse(response.stdout) as Record<string, unknown>;
        expect(envelope).toMatchObject({
          ok: true,
          tool: "mcp",
          servers: [],
        });
      }
    } finally {
      await server.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
