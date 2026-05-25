import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { BashSessionManager } from "../src/bash/session-manager.js";

const ptyMock = vi.hoisted(() => {
  type DataHandler = (data: string) => void;
  type ExitHandler = (exitInfo: { exitCode: number; signal?: number }) => void;

  class FakePty {
    private dataHandler: DataHandler | undefined;
    private exitHandler: ExitHandler | undefined;
    private lastCommand = "";

    constructor(readonly cwd: string) {}

    onData(handler: DataHandler): void {
      this.dataHandler = handler;
    }

    onExit(handler: ExitHandler): void {
      this.exitHandler = handler;
    }

    write(data: string): void {
      if (data.includes("__TAH_COMMAND_DONE__")) {
        if (!this.lastCommand.includes("sleep")) {
          this.emit(`\n__TAH_COMMAND_DONE__ rc=0 cwd=${this.cwd}\n`);
        }
        return;
      }

      this.lastCommand = data.trim();
      this.emit(data);

      if (this.lastCommand.startsWith("printf ")) {
        this.emit(this.lastCommand.slice("printf ".length));
      }
    }

    kill(): void {
      this.exitHandler?.({ exitCode: 0 });
    }

    private emit(data: string): void {
      this.dataHandler?.(data);
    }
  }

  const spawned: FakePty[] = [];
  const spawn = vi.fn((_shell: string, _args: string[], options: { cwd: string }) => {
    const pty = new FakePty(options.cwd);
    spawned.push(pty);
    return pty;
  });

  return { spawn, spawned };
});

vi.mock("node-pty", () => ({
  spawn: ptyMock.spawn,
}));

let tmpDirs: string[] = [];
let managers: BashSessionManager[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bash-manager-test-"));
  tmpDirs.push(dir);
  return dir;
}

function makeManager(): { manager: BashSessionManager; logDir: string } {
  const logDir = path.join(makeTmpDir(), "sessions");
  const manager = new BashSessionManager({ logDir });
  managers.push(manager);
  return { manager, logDir };
}

afterEach(() => {
  for (const manager of managers) {
    manager.terminateAll();
  }
  managers = [];
  ptyMock.spawn.mockClear();
  ptyMock.spawned.length = 0;

  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("BashSessionManager", () => {
  it("creates, lists, and reports status for a session", async () => {
    const { manager, logDir } = makeManager();

    const created = manager.createSession("default", {
      cwd: process.cwd(),
      defaultTimeoutMs: 500,
      maxObservationBytes: 2000,
    });

    expect(created).toMatchObject({
      session: "default",
      state: "idle",
      returnCode: null,
      output: "",
      outputTruncated: false,
      control: "create",
      message: 'Session "default" created.',
    });
    expect(created.outputLogPath).toBe(path.join(logDir, "default.log"));
    expect(manager.hasSession("default")).toBe(true);
    expect(ptyMock.spawn).toHaveBeenCalledWith(
      "/bin/bash",
      [],
      expect.objectContaining({
        name: "dumb",
        cwd: process.cwd(),
      }),
    );

    const listed = await manager.handleControl({ control: "list" });
    expect(listed).toMatchObject({
      session: null,
      control: "list",
      message: "1 session(s).",
      sessions: [
        expect.objectContaining({
          id: "default",
          state: "idle",
          outputLogPath: path.join(logDir, "default.log"),
        }),
      ],
    });

    const status = await manager.handleControl({
      control: "status",
      session: "default",
    });
    expect(status).toMatchObject({
      session: "default",
      state: "idle",
      returnCode: null,
      control: "status",
      message: 'Session "default" is idle.',
    });
  });

  it("returns a structured create observation when the session already exists", () => {
    const { manager } = makeManager();

    manager.createSession("default");
    const duplicate = manager.createSession("default");

    expect(duplicate).toEqual({
      session: "default",
      state: "idle",
      returnCode: null,
      output: "",
      outputTruncated: false,
      control: "create",
      message: 'Session "default" already exists.',
    });
    expect(ptyMock.spawn).toHaveBeenCalledTimes(1);
  });

  it("auto-creates a session and executes a short command", async () => {
    const { manager, logDir } = makeManager();

    const observation = await manager.executeCommandAutoCreate(
      "default",
      "printf tiny-agent",
      2_000,
    );

    expect(observation).toMatchObject({
      session: "default",
      state: "idle",
      returnCode: 0,
      timedOut: undefined,
      focusReleased: undefined,
      outputTruncated: false,
      outputLogPath: path.join(logDir, "default.log"),
    });
    expect(observation.output).toContain("tiny-agent");
    expect(manager.hasSession("default")).toBe(true);
    expect(fs.readFileSync(path.join(logDir, "default.log"), "utf-8")).toContain(
      "tiny-agent",
    );
  });

  it("poll returns only newly observed output window metadata", async () => {
    const { manager } = makeManager();
    await manager.executeCommandAutoCreate("default", "printf poll-test", 2_000);

    const poll = await manager.handleControl({
      control: "poll",
      session: "default",
    });

    expect(poll).toMatchObject({
      session: "default",
      state: "idle",
      returnCode: 0,
      output: "",
      outputTruncated: false,
      control: "poll",
    });
    expect(poll.outputStartOffset).toBe(poll.outputEndOffset);
  });

  it("terminate keeps the session addressable and sendInput reports failure", async () => {
    const { manager } = makeManager();
    manager.createSession("default");

    const terminated = await manager.handleControl({
      control: "terminate",
      session: "default",
    });
    expect(terminated).toMatchObject({
      session: "default",
      state: "terminated",
      control: "terminate",
      message: 'Session "default" terminated.',
    });
    expect(manager.getSession("default")?.state).toBe("terminated");

    const sendInput = await manager.handleControl({
      control: "sendInput",
      session: "default",
      input: "y\n",
    });
    expect(sendInput).toMatchObject({
      session: "default",
      state: "terminated",
      returnCode: null,
      output: "",
      outputTruncated: false,
      control: "sendInput",
    });
    expect(sendInput.message).toContain("Failed to send input");
  });

  it("restart creates a fresh session using existing options", async () => {
    const { manager } = makeManager();
    manager.createSession("server", {
      cwd: process.cwd(),
      env: { TAH_TEST_ENV: "yes" },
      defaultTimeoutMs: 1234,
      maxObservationBytes: 4321,
    });
    const previous = manager.getSession("server")!;

    const restarted = await manager.handleControl({
      control: "restart",
      session: "server",
    });

    const current = manager.getSession("server")!;
    expect(restarted).toMatchObject({
      session: "server",
      state: "idle",
      control: "create",
      message: 'Session "server" created.',
    });
    expect(current).not.toBe(previous);
    expect(current.cwd).toBe(previous.cwd);
    expect(current.env).toEqual({ TAH_TEST_ENV: "yes" });
    expect(current.defaultTimeoutMs).toBe(1234);
    expect(current.maxObservationBytes).toBe(4321);
  });

  it("throws a clear error for controls targeting a missing session", async () => {
    const { manager } = makeManager();

    await expect(
      manager.handleControl({ control: "status", session: "missing" }),
    ).rejects.toThrow(
      'Session "missing" does not exist. Use the "create" control or send a command to auto-create it.',
    );
  });

  it("timeout releases focus while leaving the session running", async () => {
    const { manager } = makeManager();

    const observation = await manager.executeCommandAutoCreate(
      "slow",
      "sleep 0.2; printf late",
      10,
    );

    expect(observation).toMatchObject({
      session: "slow",
      state: "running",
      returnCode: null,
      timedOut: true,
      focusReleased: true,
      outputTruncated: false,
    });
    expect(manager.getSession("slow")?.currentCommand?.status).toBe("timed_out");

    await manager.handleControl({ control: "terminate", session: "slow" });
  });
});
