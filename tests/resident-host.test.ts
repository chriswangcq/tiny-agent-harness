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
  });

  it("creates process records from explicit contract inputs", () => {
    const record = createResidentHostProcessRecord({
      kind: "skill-host",
      runId: "run-1",
      socketPath: "/state/runs/run-1/skill-host.sock",
      command: {
        executable: "tiny-agent",
        args: ["skill", "host", "--socket", "/state/runs/run-1/skill-host.sock"],
        cwd: "/repo",
        envKeys: ["TAH_RUN_ID"],
      },
      now: "2026-06-12T00:00:00.000Z",
      statePath: "/state/runs/run-1/skill-host.json",
      logPath: "/state/runs/run-1/skill-host.stderr.log",
      metadata: { skillsDir: "/state/skills" },
    });

    expect(record).toMatchObject({
      id: "skill-host:run-1",
      kind: "skill-host",
      owner: { scope: "run", runId: "run-1" },
      command: {
        executable: "tiny-agent",
        args: ["skill", "host", "--socket", "/state/runs/run-1/skill-host.sock"],
        cwd: "/repo",
        envKeys: ["TAH_RUN_ID"],
      },
      metadata: {
        runId: "run-1",
        socketPath: "/state/runs/run-1/skill-host.sock",
        skillsDir: "/state/skills",
      },
    });
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
