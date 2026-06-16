import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  RESIDENT_HOST_SOCKET_PATH_MAX_BYTES,
  createResidentHostProcessRecord,
  defaultResidentSocketRoot,
  launchResidentSocketHost,
  listenResidentHostSocket,
  requestResidentHostJson,
  residentHostPaths,
  residentHostProcessId,
  residentHostSocketPath,
} from "../src/runtime/index.js";

describe("resident host contract", () => {
  it("derives stable run-owned process ids and paths", () => {
    const socketRoot = "/tmp/ta-rh-test";
    const socketScope = "/state/project";

    expect(residentHostProcessId("skill-host", "run-1")).toBe("skill-host:run-1");
    expect(residentHostProcessId("terminal-host", "run-1")).toBe("terminal-host:run-1");
    expect(residentHostProcessId("model-gateway", "run-1")).toBe("model-gateway:run-1");

    const mcpPaths = residentHostPaths({
      kind: "mcp-host",
      runId: "run-1",
      runDir: "/state/runs/run-1",
      socketRoot,
      socketScope,
    });
    expect(mcpPaths).toMatchObject({
      processId: "mcp-host:run-1",
      statePath: "/state/runs/run-1/mcp-host.json",
      logPath: "/state/runs/run-1/mcp-host.stderr.log",
    });
    expect(mcpPaths.socketPath).toMatch(/^\/tmp\/ta-rh-test\/mcp-[a-f0-9]{16}\.sock$/);
    expect(mcpPaths.socketPath).not.toContain("/state/runs/run-1");
    expect(Buffer.byteLength(mcpPaths.socketPath)).toBeLessThanOrEqual(
      RESIDENT_HOST_SOCKET_PATH_MAX_BYTES,
    );

    const terminalPaths = residentHostPaths({
      kind: "terminal-host",
      runId: "run-1",
      runDir: "/state/runs/run-1",
      socketRoot,
      socketScope,
    });
    expect(terminalPaths).toMatchObject({
      processId: "terminal-host:run-1",
      statePath: "/state/runs/run-1/terminal-host.json",
      logPath: "/state/runs/run-1/terminal-host.stderr.log",
    });
    expect(terminalPaths.socketPath).toMatch(
      /^\/tmp\/ta-rh-test\/term-[a-f0-9]{16}\.sock$/,
    );

    const modelGatewayPaths = residentHostPaths({
      kind: "model-gateway",
      runId: "run-1",
      runDir: "/state/runs/run-1",
      socketRoot,
      socketScope,
    });
    expect(modelGatewayPaths).toMatchObject({
      processId: "model-gateway:run-1",
      statePath: "/state/runs/run-1/model-gateway.json",
      logPath: "/state/runs/run-1/model-gateway.stderr.log",
    });
    expect(modelGatewayPaths.socketPath).toMatch(
      /^\/tmp\/ta-rh-test\/model-[a-f0-9]{16}\.sock$/,
    );
  });

  it("keeps resident sockets short when durable run state paths are long", () => {
    const longRunDir = path.join(
      "/state",
      "projects",
      "very-long-project-name-".repeat(5),
      "runs",
      "run-1781231813968",
    );
    const longScope = path.join(
      "/state",
      "scopes",
      "very-long-project-state-scope-".repeat(5),
    );

    const paths = residentHostPaths({
      kind: "terminal-host",
      runId: "run-1781231813968",
      runDir: longRunDir,
      socketRoot: "/tmp/ta-rh-test",
      socketScope: longScope,
    });

    expect(Buffer.byteLength(path.join(longRunDir, "terminal-host.sock"))).toBeGreaterThan(
      RESIDENT_HOST_SOCKET_PATH_MAX_BYTES,
    );
    expect(paths.socketPath).toMatch(/^\/tmp\/ta-rh-test\/term-[a-f0-9]{16}\.sock$/);
    expect(Buffer.byteLength(paths.socketPath)).toBeLessThanOrEqual(
      RESIDENT_HOST_SOCKET_PATH_MAX_BYTES,
    );
    expect(paths.socketPath).not.toContain(longRunDir);
    expect(paths.statePath).toBe(path.join(longRunDir, "terminal-host.json"));
    expect(paths.logPath).toBe(path.join(longRunDir, "terminal-host.stderr.log"));
  });

  it("uses socket scope in resident socket identity", () => {
    const shared = {
      kind: "mcp-host" as const,
      runId: "run-1",
      socketRoot: "/tmp/ta-rh-test",
    };

    const first = residentHostSocketPath({
      ...shared,
      socketScope: "/state/project-a",
    });
    const same = residentHostSocketPath({
      ...shared,
      socketScope: "/state/project-a",
    });
    const second = residentHostSocketPath({
      ...shared,
      socketScope: "/state/project-b",
    });

    expect(first).toBe(same);
    expect(first).not.toBe(second);
  });

  it("rejects resident socket paths that exceed the socket byte budget", () => {
    expect(() =>
      residentHostSocketPath({
        kind: "mcp-host",
        runId: "run-1",
        socketRoot: path.join("/tmp", "x".repeat(100)),
        socketScope: "/state/project",
      }),
    ).toThrow("exceeding 100 byte budget");
  });

  it("derives the default resident socket root from an explicit tmp directory", () => {
    expect(defaultResidentSocketRoot({ tmpDir: "/tmp" })).toBe("/tmp/ta-rh");
  });

  it("creates process records from explicit contract inputs", () => {
    const socketPath = "/tmp/ta-rh/term-1234567890abcdef.sock";
    const record = createResidentHostProcessRecord({
      kind: "terminal-host",
      runId: "run-1",
      socketPath,
      command: {
        executable: "tiny-agent",
        args: ["terminal-host", "--socket", socketPath],
        cwd: "/repo",
        envKeys: ["TAH_RUN_ID"],
      },
      now: "2026-06-12T00:00:00.000Z",
      statePath: "/state/runs/run-1/terminal-host.json",
      logPath: "/state/runs/run-1/terminal-host.stderr.log",
      metadata: { sessionsDir: "/state/runs/run-1/sessions" },
    });

    expect(record).toMatchObject({
      id: "terminal-host:run-1",
      kind: "terminal-host",
      owner: { scope: "run", runId: "run-1" },
      command: {
        executable: "tiny-agent",
        args: ["terminal-host", "--socket", socketPath],
        cwd: "/repo",
        envKeys: ["TAH_RUN_ID"],
      },
      metadata: {
        runId: "run-1",
        socketPath,
        sessionsDir: "/state/runs/run-1/sessions",
      },
    });
  });

  it("keeps non-host runtime process kinds outside the socket contract", () => {
    expect(() => residentHostProcessId("pty-session" as never, "run-1"))
      .toThrow("Unsupported resident host kind: pty-session");
  });

  it("launches supervised socket hosts through explicit ports", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resident-host-launch-"));
    const socketPath = path.join(dir, "mcp-host.sock");
    const statePath = path.join(dir, "mcp-host.json");
    const logPath = path.join(dir, "mcp-host.stderr.log");
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

    try {
      const launched = await launchResidentSocketHost({
        supervisor: {
          startProcess(input) {
            startInput = input;
            return { process: {} as never, child };
          },
        },
        kind: "mcp-host",
        processId: "mcp-host:run-1",
        owner: { scope: "run", runId: "run-1" },
        executable: "node",
        args: ["dist/cli/main.js", "mcp", "host", "--socket", socketPath],
        cwd: "/repo",
        env: { TAH_RUN_ID: "run-1" },
        socketPath,
        statePath,
        logPath,
        startupTimeoutMs: 10,
        nowEpochMs: () => 0,
        wait: async () => {},
        isSocketReady: () => true,
        metadata: { projectStateDir: dir },
      });

      expect(startInput).toMatchObject({
        kind: "mcp-host",
        owner: { scope: "run", runId: "run-1" },
        metadata: {
          runId: "run-1",
          socketPath,
          projectStateDir: dir,
        },
      });
      expect(launched.socketPath).toBe(socketPath);

      await launched.dispose();
      expect(killSignal).toBe("SIGTERM");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("roundtrips JSON over a resident host socket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resident-host-socket-"));
    const socketPath = path.join(dir, "host.sock");
    const server = await listenResidentHostSocket({
      socketPath,
      handleLine: async (line) => {
        const request = JSON.parse(line) as { id: string; value: number };
        return {
          responseLine: JSON.stringify({
            id: request.id,
            value: request.value + 1,
          }),
        };
      },
    });

    try {
      const response = await requestResidentHostJson({
        socketPath,
        timeoutMs: 1_000,
        request: { id: "req-1", value: 41 },
        parseResponse: (raw) => JSON.parse(raw) as { id: string; value: number },
      });
      expect(response).toEqual({ id: "req-1", value: 42 });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports duplex event pushes and connection close cleanup", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resident-host-duplex-"));
    const socketPath = path.join(dir, "host.sock");
    let cleanupCount = 0;
    const server = await listenResidentHostSocket({
      socketPath,
      handleLine: async (line, connection) => {
        const request = JSON.parse(line) as { id: string };
        connection.onClose(() => {
          cleanupCount += 1;
        });
        setTimeout(() => {
          connection.sendLine(JSON.stringify({ id: "event-1", type: "pushed" }));
        }, 5);
        return {
          responseLine: JSON.stringify({ id: request.id, ok: true }),
        };
      },
    });

    try {
      const lines = await new Promise<string[]>((resolve, reject) => {
        const socket = net.createConnection(socketPath);
        const received: string[] = [];
        let buffer = "";
        const timer = setTimeout(() => {
          socket.destroy();
          reject(new Error("timed out waiting for duplex lines"));
        }, 1_000);
        socket.once("connect", () => {
          socket.write(`${JSON.stringify({ id: "subscribe-1" })}\n`);
        });
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf-8");
          while (true) {
            const newlineIndex = buffer.indexOf("\n");
            if (newlineIndex < 0) {
              break;
            }
            received.push(buffer.slice(0, newlineIndex));
            buffer = buffer.slice(newlineIndex + 1);
            if (received.length === 2) {
              clearTimeout(timer);
              socket.end();
              resolve(received);
              return;
            }
          }
        });
        socket.once("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
      });

      expect(lines.map((line) => JSON.parse(line))).toEqual([
        { id: "subscribe-1", ok: true },
        { id: "event-1", type: "pushed" },
      ]);
      await eventually(() => cleanupCount === 1);
      expect(cleanupCount).toBe(1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects invalid host responses at the caller parser boundary", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resident-host-invalid-response-"));
    const socketPath = path.join(dir, "host.sock");
    const server = await listenResidentHostSocket({
      socketPath,
      handleLine: async () => ({ responseLine: "not-json" }),
    });

    try {
      await expect(
        requestResidentHostJson({
          socketPath,
          timeoutMs: 1_000,
          request: { id: "req-1" },
          parseResponse: (raw) => JSON.parse(raw) as { id: string },
        }),
      ).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects deterministically when a resident host does not answer", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resident-host-timeout-"));
    const socketPath = path.join(dir, "host.sock");
    const server = await listenResidentHostSocket({
      socketPath,
      handleLine: async () => new Promise(() => {}),
    });

    try {
      await expect(
        requestResidentHostJson({
          socketPath,
          timeoutMs: 5,
          request: { id: "req-1" },
          parseResponse: (raw) => JSON.parse(raw) as { id: string },
        }),
      ).rejects.toThrow("Timed out waiting for resident host response");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports shutdown responses that close the server and remove the socket path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resident-host-shutdown-"));
    const socketPath = path.join(dir, "host.sock");
    const server = await listenResidentHostSocket({
      socketPath,
      handleLine: async (line) => {
        const request = JSON.parse(line) as { id: string };
        return {
          responseLine: JSON.stringify({ id: request.id, ok: true }),
          close: true,
        };
      },
    });

    try {
      const closed = new Promise<void>((resolve) => server.once("close", resolve));
      const response = await requestResidentHostJson({
        socketPath,
        timeoutMs: 1_000,
        request: { id: "shutdown-1" },
        parseResponse: (raw) => JSON.parse(raw) as { id: string; ok: boolean },
      });
      expect(response).toEqual({ id: "shutdown-1", ok: true });
      await closed;
      expect(fs.existsSync(socketPath)).toBe(false);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("kills the child and unpipes stderr logging when startup readiness fails", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resident-host-startup-fail-"));
    const socketPath = path.join(dir, "mcp-host.sock");
    const logPath = path.join(dir, "mcp-host.stderr.log");
    let now = 0;
    let killSignal: NodeJS.Signals | number | undefined;
    const stderr = new PassThrough();
    const child = {
      pid: 123,
      killed: false,
      exitCode: null,
      stdin: null,
      stdout: new PassThrough(),
      stderr,
      kill(signal?: NodeJS.Signals | number) {
        killSignal = signal;
        this.killed = true;
        return true;
      },
      once() {
        return this;
      },
    };

    try {
      await expect(
        launchResidentSocketHost({
          supervisor: {
            startProcess() {
              return { process: {} as never, child };
            },
          },
          kind: "mcp-host",
          processId: "mcp-host:run-1",
          owner: { scope: "run", runId: "run-1" },
          executable: "node",
          args: ["dist/cli/main.js", "mcp", "host", "--socket", socketPath],
          cwd: "/repo",
          env: { TAH_RUN_ID: "run-1" },
          socketPath,
          logPath,
          startupTimeoutMs: 5,
          nowEpochMs: () => now,
          wait: async (ms) => {
            now += ms;
          },
          isSocketReady: () => false,
        }),
      ).rejects.toThrow(`Timed out waiting for resident host socket: ${socketPath}`);

      expect(killSignal).toBe("SIGTERM");
      expect(stderr.listenerCount("data")).toBe(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to replace non-socket paths", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "resident-host-socket-"));
    const socketPath = path.join(dir, "host.sock");
    fs.writeFileSync(socketPath, "not a socket", "utf-8");

    await expect(
      listenResidentHostSocket({
        socketPath,
        handleLine: async () => ({ responseLine: "{}" }),
      }),
    ).rejects.toThrow("Refusing to replace non-socket path");

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

async function eventually(predicate: () => boolean): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 1_000) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition was not met");
}
