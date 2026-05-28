import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedTerminalRuntime } from "../src/bash/managed-terminal-runtime.js";
import { formatPromptMarker } from "../src/application/managed-shell.js";

const ptyMock = vi.hoisted(() => {
  type DataHandler = (data: string) => void;

  class FakePty {
    private dataHandler: DataHandler | undefined;
    readonly writes: string[] = [];
    killed = false;

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
} = {}): ManagedTerminalRuntime {
  return new ManagedTerminalRuntime({
    defaultSessionId: "default",
    cwd: "/repo",
    promptNonce: "nonce",
    actionLimits: {},
    observationLimits: {
      maxPreviewChars: 80,
      maxEvents: 50,
    },
    postWriteReadDelayMs: options.postWriteReadDelayMs ?? 0,
    startupReadDelayMs: options.startupReadDelayMs ?? 0,
    nowIso: () => "2026-05-27T00:00:00.000Z",
    monotonicMs: () => 1,
    newId: (prefix) => `${prefix}-1`,
    newNonce: () => "nonce",
  });
}

describe("ManagedTerminalRuntime", () => {
  it("creates a live managed PTY for status and observes later prompt output", async () => {
    const port = makeRuntime().createRunPort();

    const first = await port.execute({ action: { kind: "status" } });

    expect(first).toMatchObject({
      result: "ok",
      terminal: {
        inputSeq: 0,
        alive: true,
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

    const second = await port.execute({ action: { kind: "status" } });

    expect(second).toMatchObject({
      result: "ok",
      terminal: {
        inputSeq: 1,
        lastShellPrompt: {
          promptSeq: 1,
        },
      },
      events: [{ kind: "prompt" }],
    });
  });

  it("drains managed shell startup output before the first observation", async () => {
    const port = makeRuntime({ startupReadDelayMs: 20 }).createRunPort();

    const pending = port.execute({ action: { kind: "status" } });
    setTimeout(() => {
      ptyMock.spawned[0]?.emit(
        [
          "export TAH_PROMPT_NONCE='nonce'",
          formatPromptMarker({
            nonce: "nonce",
            returnCode: 0,
            cwd: "/repo",
            promptSeq: 1,
          }),
          "",
        ].join("\n"),
      );
    }, 5);

    const observation = await pending;

    expect(observation).toMatchObject({
      result: "ok",
      terminal: {
        inputSeq: 1,
        lastShellPrompt: {
          cwd: "/repo",
          promptSeq: 1,
        },
      },
      events: [],
    });
    expect(observation.outputPreview).toBeUndefined();
  });

  it("writes write_text input through the managed PTY", async () => {
    const port = makeRuntime().createRunPort();
    await port.execute({ action: { kind: "status" } });

    const observation = await port.execute({
      action: {
        kind: "write_text",
        expectedInputSeq: 0,
        text: "pwd\n",
      },
    });

    expect(observation.result).toBe("ok");
    expect(ptyMock.spawned[0]?.writes.at(-1)).toBe("pwd\n");
  });

  it("waits briefly after write_text so immediate PTY output lands in the observation", async () => {
    const port = makeRuntime({ postWriteReadDelayMs: 20 }).createRunPort();
    await port.execute({ action: { kind: "status" } });

    const pending = port.execute({
      action: {
        kind: "write_text",
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
      eventCount: 1,
      events: [{ kind: "output", preview: "/repo" }],
    });
    expect(observation.outputPreview).toContain("/repo");
    expect(observation.outputTail).toContain("/repo");
  });

  it("keeps tail success output and prompt after noisy multiline PTY output", async () => {
    const port = makeRuntime({ postWriteReadDelayMs: 20 }).createRunPort();
    await port.execute({ action: { kind: "status" } });

    const pending = port.execute({
      action: {
        kind: "write_text",
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

    expect(observation.eventCount).toBeGreaterThan(50);
    expect(observation.eventsOmitted).toBeGreaterThan(0);
    expect(observation.events.at(-1)).toEqual({ kind: "prompt" });
    expect(observation.outputTail).toContain("ok=true");
    expect(observation.outputTail).toContain("id=agent-1");
    expect(observation.outputTail).not.toContain("__TAH_PROMPT__");
  });

  it("paces large write_text input into PTY chunks without dropping bytes", async () => {
    const port = makeRuntime().createRunPort();
    await port.execute({ action: { kind: "status" } });
    const largeText = `${"a".repeat(1300)}${"你".repeat(300)}\n`;

    const observation = await port.execute({
      action: {
        kind: "write_text",
        expectedInputSeq: 0,
        text: largeText,
      },
    });

    const writes = ptyMock.spawned[0]?.writes.slice(1) ?? [];
    expect(observation.result).toBe("ok");
    expect(writes.length).toBeGreaterThan(1);
    expect(writes.join("")).toBe(largeText);
    for (const chunk of writes) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(256);
    }
  });

  it("uses protected pacing for heredocs even below the large-write threshold", async () => {
    const port = makeRuntime().createRunPort();
    await port.execute({ action: { kind: "status" } });
    const heredoc =
      "cat > note.md <<'EOF'\n" +
      `${"中文✅".repeat(60)}\n` +
      "EOF\n";

    const observation = await port.execute({
      action: {
        kind: "write_text",
        expectedInputSeq: 0,
        text: heredoc,
      },
    });

    const writes = ptyMock.spawned[0]?.writes.slice(1) ?? [];
    expect(observation.result).toBe("ok");
    expect(Buffer.byteLength(heredoc, "utf8")).toBeLessThanOrEqual(1024);
    expect(writes.length).toBeGreaterThan(1);
    expect(writes.join("")).toBe(heredoc);
    for (const chunk of writes) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(256);
    }
  });

  it("restarts by killing the old PTY and spawning a fresh shell", async () => {
    const port = makeRuntime().createRunPort();
    await port.execute({ action: { kind: "status" } });

    const observation = await port.execute({
      action: {
        kind: "restart",
        cwd: "/tmp",
      },
    });

    expect(ptyMock.spawned[0]?.killed).toBe(true);
    expect(ptyMock.spawn).toHaveBeenCalledTimes(2);
    expect(ptyMock.spawn).toHaveBeenLastCalledWith(
      "/bin/bash",
      ["--noprofile", "--norc", "-i"],
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
