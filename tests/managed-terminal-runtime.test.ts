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

function makeRuntime(): ManagedTerminalRuntime {
  return new ManagedTerminalRuntime({
    defaultSessionId: "default",
    cwd: "/repo",
    promptNonce: "nonce",
    actionLimits: {},
    observationLimits: {
      maxPreviewChars: 80,
    },
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
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(1024);
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
