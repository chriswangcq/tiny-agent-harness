import { afterEach, describe, expect, it, vi } from "vitest";
import { formatPromptMarker } from "../src/application/managed-shell.js";
import { ManagedTerminalRuntime } from "../src/bash/managed-terminal-runtime.js";
import type { ForegroundInspector } from "../src/bash/managed-session.js";

const ptyMock = vi.hoisted(() => {
  type DataHandler = (data: string) => void;

  class FakePty {
    private dataHandler: DataHandler | undefined;
    readonly writes: string[] = [];
    killed = false;
    readonly pid = 99999;

    onData(handler: DataHandler): void {
      this.dataHandler = handler;
    }

    onExit(): void {}

    write(data: string): void {
      this.writes.push(data);
    }

    kill(): void {
      this.killed = true;
    }

    emit(data: string): void {
      this.dataHandler?.(data);
    }
  }

  const spawned: FakePty[] = [];
  const spawn = vi.fn((_shell: string, _args: string[], _options: unknown) => {
    const pty = new FakePty();
    spawned.push(pty);
    return pty;
  });

  return { spawn, spawned };
});

vi.mock("node-pty", () => ({
  spawn: ptyMock.spawn,
}));

afterEach(() => {
  ptyMock.spawn.mockClear();
  ptyMock.spawned.length = 0;
});

function makeRuntime(options: {
  postWriteReadDelayMs?: number;
  startupReadDelayMs?: number;
  foregroundInspector?: ForegroundInspector;
} = {}): ManagedTerminalRuntime {
  return new ManagedTerminalRuntime({
    defaultSessionId: "default",
    cwd: "/repo",
    promptNonce: "nonce",
    screenRows: 24,
    screenCols: 80,
    postWriteReadDelayMs: options.postWriteReadDelayMs ?? 0,
    startupReadDelayMs: options.startupReadDelayMs ?? 0,
    foregroundInspector: options.foregroundInspector ?? (() => null),
  });
}

describe("ManagedTerminalRuntime", () => {
  it("creates a live default session and observes prompt output as one screen", async () => {
    const port = makeRuntime().createRunPort();

    const first = await port.execute({ request: { kind: "session_observe" } });

    expect(first).toMatchObject({
      result: "ok",
      currentSession: "default",
      observedSession: "default",
      terminal: {
        inputSeq: 0,
        alive: true,
      },
      screen: {
        rows: 24,
        cols: 80,
        logRef: { path: "managed-pty://default" },
      },
    });
    expect(ptyMock.spawn).toHaveBeenCalledTimes(1);

    ptyMock.spawned[0]?.emit(
      `${formatPromptMarker({
        nonce: "nonce",
        returnCode: 0,
        cwd: "/repo",
        promptSeq: 1,
      })}\n`,
    );

    const second = await port.execute({ request: { kind: "session_observe" } });

    expect(second).toMatchObject({
      result: "ok",
      terminal: {
        inputSeq: 1,
        lastShellPrompt: {
          promptSeq: 1,
        },
      },
      returnedToPrompt: true,
      screen: {
        logRef: { path: "managed-pty://default" },
      },
    });
    if ("terminal" in second) {
      expect(second.terminal.foregroundProcess).toBeNull();
    }
  });

  it("resolves foregroundProcess via injected inspector", async () => {
    const inspector = vi.fn((_pid: number) => "sleep");
    const runtime = makeRuntime({ foregroundInspector: inspector });
    const port = runtime.createRunPort();
    const obs = await port.execute({ request: { kind: "session_observe" } });
    expect("terminal" in obs && obs.terminal.foregroundProcess).toBe("sleep");
    expect(inspector).toHaveBeenCalledWith(99999);
  });

  it("focuses sessions, lists them, and writes to the current session", async () => {
    const port = makeRuntime().createRunPort();
    await port.execute({ request: { kind: "session_observe" } });

    const focus = await port.execute({
      request: {
        kind: "session_focus",
        session: "build",
        create: true,
        cwd: "/repo/build",
      },
    });
    const list = await port.execute({ request: { kind: "session_list" } });
    const write = await port.execute({
      request: {
        kind: "terminal_write",
        expectedInputSeq: 0,
        text: "pwd\n",
      },
    });

    expect(focus).toMatchObject({
      currentSession: "build",
      observedSession: "build",
      result: "ok",
    });
    expect(ptyMock.spawn).toHaveBeenCalledTimes(2);
    expect(ptyMock.spawn).toHaveBeenLastCalledWith(
      "/bin/bash",
      ["--noprofile", "--norc", "--noediting", "-i"],
      expect.objectContaining({ cwd: "/repo/build" }),
    );
    expect(list).toMatchObject({ currentSession: "build" });
    if ("sessions" in list) {
      expect(list.sessions.map((session) => session.session).sort()).toEqual([
        "build",
        "default",
      ]);
    }
    expect(write).toMatchObject({ currentSession: "build", result: "ok" });
    expect(ptyMock.spawned[1]?.writes.at(-1)).toBe("pwd\n");
  });

  it("observes a named session without changing focus", async () => {
    const port = makeRuntime().createRunPort();
    await port.execute({ request: { kind: "session_observe" } });
    await port.execute({
      request: {
        kind: "session_focus",
        session: "build",
        create: true,
      },
    });
    ptyMock.spawned[0]?.emit("default-output\n");

    const observed = await port.execute({
      request: {
        kind: "session_observe",
        session: "default",
      },
    });
    const list = await port.execute({ request: { kind: "session_list" } });

    expect(observed).toMatchObject({
      currentSession: "build",
      observedSession: "default",
      screen: { text: expect.stringContaining("default-output") },
    });
    expect(list).toMatchObject({ currentSession: "build" });
  });

  it("waits briefly after terminal_write so immediate PTY output lands in screen.text", async () => {
    const port = makeRuntime({ postWriteReadDelayMs: 20 }).createRunPort();
    await port.execute({ request: { kind: "session_observe" } });

    const pending = port.execute({
      request: {
        kind: "terminal_write",
        expectedInputSeq: 0,
        text: "pwd\n",
      },
    });
    setTimeout(() => {
      ptyMock.spawned[0]?.emit("/repo\n");
    }, 5);

    const observation = await pending;

    expect(observation).toMatchObject({
      result: "ok",
      returnedToPrompt: false,
      screen: {
        text: expect.stringContaining("/repo"),
      },
    });
  });

  it("keeps success output and prompt in screen.text after noisy multiline PTY output", async () => {
    const port = makeRuntime({ postWriteReadDelayMs: 20 }).createRunPort();
    await port.execute({ request: { kind: "session_observe" } });

    const pending = port.execute({
      request: {
        kind: "terminal_write",
        expectedInputSeq: 0,
        text:
          "node dist/cli/main.js im send --channel default --kind status --text-stdin <<'IM'\n" +
          "body\n" +
          "IM\n",
      },
    });
    setTimeout(() => {
      ptyMock.spawned[0]?.emit(
        [
          "$ node dist/cli/main.js im send --channel default --kind status --text-stdin <<'IM'",
          ...Array.from({ length: 60 }, (_, index) => `> line-${index}`),
          "ok=true",
          "id=agent-1",
          formatPromptMarker({
            nonce: "nonce",
            returnCode: 0,
            cwd: "/repo",
            promptSeq: 2,
          }),
          "$ ",
        ].join("\n"),
      );
    }, 5);

    const observation = await pending;

    expect(observation).toMatchObject({
      returnedToPrompt: true,
      screen: {
        text: expect.stringContaining("ok=true"),
      },
    });
    if ("screen" in observation) {
      expect(observation.screen.text).toContain("id=agent-1");
      expect(observation.screen.text).not.toContain("line-0");
      expect(observation.screen.text.split("\n")).toHaveLength(24);
      expect(observation.screen.text).not.toContain("__TAH_PROMPT__");
      expect(["output", "Tail"].join("") in observation).toBe(false);
    }
  });

  it("observes the terminal viewport after carriage-return redraws", async () => {
    const port = makeRuntime({ postWriteReadDelayMs: 20 }).createRunPort();
    await port.execute({ request: { kind: "session_observe" } });

    const pending = port.execute({
      request: {
        kind: "terminal_write",
        expectedInputSeq: 0,
        text: "node dist/cli/main.js im send --channel default --text-stdin\n",
      },
    });
    setTimeout(() => {
      ptyMock.spawned[0]?.emit(
        [
          "<经验沉淀：lessons 写回 skil\r",
          "<经验沉淀：lessons 写回 skill\r",
          "<经验沉淀：lessons 写回 skill 定义。\r\n",
          "ok=true\r\n",
          "id=agent-1\r\n",
          `${formatPromptMarker({
            nonce: "nonce",
            returnCode: 0,
            cwd: "/repo",
            promptSeq: 2,
          })}\r\n`,
          "$ ",
        ].join(""),
      );
    }, 5);

    const observation = await pending;

    expect(observation.screen.text).toContain("<经验沉淀：lessons 写回 skill 定义。");
    expect(observation.screen.text).not.toContain("写回 skil\n");
    expect(observation.screen.text).not.toContain("__TAH_PROMPT__");
    expect(observation.screen.text).toContain("id=agent-1");
  });

  it("paces large terminal_write input into PTY chunks without dropping bytes", async () => {
    const port = makeRuntime().createRunPort();
    await port.execute({ request: { kind: "session_observe" } });
    const largeText = `${"a".repeat(1300)}${"你".repeat(300)}\n`;

    const observation = await port.execute({
      request: {
        kind: "terminal_write",
        expectedInputSeq: 0,
        text: largeText,
      },
    });

    const writes = ptyMock.spawned[0]?.writes.slice(1) ?? [];
    expect(observation).toMatchObject({ result: "ok" });
    expect(writes.length).toBeGreaterThan(1);
    expect(writes.join("")).toBe(largeText);
    for (const chunk of writes) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(128);
    }
  });

  it("restarts by killing the old PTY and spawning a fresh shell", async () => {
    const port = makeRuntime().createRunPort();
    await port.execute({ request: { kind: "session_observe" } });

    const observation = await port.execute({
      request: {
        kind: "session_restart",
        cwd: "/tmp",
      },
    });

    expect(ptyMock.spawned[0]?.killed).toBe(true);
    expect(ptyMock.spawn).toHaveBeenCalledTimes(2);
    expect(ptyMock.spawn).toHaveBeenLastCalledWith(
      "/bin/bash",
      ["--noprofile", "--norc", "--noediting", "-i"],
      expect.objectContaining({ cwd: "/tmp" }),
    );
    expect(observation).toMatchObject({
      result: "ok",
      terminal: {
        inputSeq: 0,
      },
    });
  });
});
