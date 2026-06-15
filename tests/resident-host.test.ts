import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  createResidentHostProcessRecord,
  launchResidentSocketHost,
  listenResidentHostSocket,
  requestResidentHostJson,
  residentHostPaths,
  residentHostProcessId,
} from "../src/runtime/index.js";

describe("resident host contract", () => {
  it("derives stable run-owned process ids and paths", () => {
    expect(residentHostProcessId("skill-host", "run-1")).toBe("skill-host:run-1");
    expect(residentHostProcessId("terminal-host", "run-1")).toBe("terminal-host:run-1");
    expect(residentHostProcessId("model-gateway", "run-1")).toBe("model-gateway:run-1");
    expect(residentHostProcessId("im-host", "run-1")).toBe("im-host:run-1");
    expect(
      residentHostPaths({
        kind: "mcp-host",
        runId: "run-1",
        runDir: "/state/runs/run-1",
      }),
    ).toEqual({
      processId: "mcp-host:run-1",
      socketPath: "/state/runs/run-1/mcp-host.sock",
      statePath: "/state/runs/run-1/mcp-host.json",
      logPath: "/state/runs/run-1/mcp-host.stderr.log",
    });
    expect(
      residentHostPaths({
        kind: "terminal-host",
        runId: "run-1",
        runDir: "/state/runs/run-1",
      }),
    ).toEqual({
      processId: "terminal-host:run-1",
      socketPath: "/state/runs/run-1/terminal-host.sock",
      statePath: "/state/runs/run-1/terminal-host.json",
      logPath: "/state/runs/run-1/terminal-host.stderr.log",
    });
    expect(
      residentHostPaths({
        kind: "im-host",
        runId: "run-1",
        runDir: "/state/runs/run-1",
      }),
    ).toEqual({
      processId: "im-host:run-1",
      socketPath: "/state/runs/run-1/im-host.sock",
      statePath: "/state/runs/run-1/im-host.json",
      logPath: "/state/runs/run-1/im-host.stderr.log",
    });
    expect(
      residentHostPaths({
        kind: "model-gateway",
        runId: "run-1",
        runDir: "/state/runs/run-1",
      }),
    ).toEqual({
      processId: "model-gateway:run-1",
      socketPath: "/state/runs/run-1/model-gateway.sock",
      statePath: "/state/runs/run-1/model-gateway.json",
      logPath: "/state/runs/run-1/model-gateway.stderr.log",
    });
  });

  it("creates process records from explicit contract inputs", () => {
    const record = createResidentHostProcessRecord({
      kind: "terminal-host",
      runId: "run-1",
      socketPath: "/state/runs/run-1/terminal-host.sock",
      command: {
        executable: "tiny-agent",
        args: ["terminal-host", "--socket", "/state/runs/run-1/terminal-host.sock"],
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
        args: ["terminal-host", "--socket", "/state/runs/run-1/terminal-host.sock"],
        cwd: "/repo",
        envKeys: ["TAH_RUN_ID"],
      },
      metadata: {
        runId: "run-1",
        socketPath: "/state/runs/run-1/terminal-host.sock",
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
