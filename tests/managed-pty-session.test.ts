import { afterEach, describe, expect, it, vi } from "vitest";
import { ManagedPtySession } from "../src/bash/managed-session.js";
import {
  formatContinuationMarker,
  formatPromptMarker,
} from "../src/application/managed-shell.js";

const ptyMock = vi.hoisted(() => {
  type DataHandler = (data: string) => void;

  class FakePty {
    private dataHandler: DataHandler | undefined;
    readonly writes: string[] = [];

    onData(handler: DataHandler): void {
      this.dataHandler = handler;
    }

    onExit(): void {}

    write(data: string): void {
      this.writes.push(data);
    }

    kill(): void {}

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

describe("ManagedPtySession", () => {
  it("spawns an explicit managed shell and writes init snippet", () => {
    const session = new ManagedPtySession({
      id: "managed",
      promptNonce: "nonce",
      cwd: "/repo",
      env: { PATH: "/bin" },
    });

    session.spawn();

    expect(ptyMock.spawn).toHaveBeenCalledWith(
      "/bin/bash",
      ["--noprofile", "--norc", "-i"],
      expect.objectContaining({
        cwd: "/repo",
        env: {
          PATH: "/bin",
          TERM: "dumb",
        },
      }),
    );
    expect(ptyMock.spawned[0]?.writes[0]).toContain("__TAH_PROMPT__");
    expect(ptyMock.spawned[0]?.writes[0]).toContain("__TAH_CONT__");
    expect(ptyMock.spawned[0]?.writes[0]).not.toContain("__TAH_COMMAND_DONE__");
  });

  it("updates snapshot owner from prompt output", () => {
    const session = new ManagedPtySession({
      id: "managed",
      promptNonce: "nonce",
      cwd: "/repo",
    });
    session.spawn();

    ptyMock.spawned[0]?.emit(
      `${formatPromptMarker({
        nonce: "nonce",
        returnCode: 0,
        cwd: "/repo/next",
        promptSeq: 1,
      })}\n`,
    );

    expect(session.snapshot.owner).toMatchObject({
      kind: "shell",
      revision: 1,
      cwd: "/repo/next",
      promptSeq: 1,
    });
  });

  it("updates snapshot owner from continuation output", () => {
    const session = new ManagedPtySession({
      id: "managed",
      promptNonce: "nonce",
      cwd: "/repo",
    });
    session.spawn();

    ptyMock.spawned[0]?.emit(
      `${formatContinuationMarker({
        nonce: "nonce",
        reason: "quote",
        promptSeq: 2,
      })}\n`,
    );

    expect(session.snapshot.owner).toEqual({
      kind: "shell_continuation",
      revision: 1,
      reason: "quote",
      promptSeq: 2,
      promptNonce: "nonce",
    });
  });

  it("transitions to process owner from explicit silence timeout", () => {
    const session = new ManagedPtySession({
      id: "managed",
      promptNonce: "nonce",
      cwd: "/repo",
    });

    const snapshot = session.applySilenceTimeout({
      elapsedMs: 30_000,
      commandLine: "sleep 60",
      startedAt: "2026-05-27T00:00:00.000Z",
      inputPolicy: "unknown",
    });

    expect(snapshot.owner).toEqual({
      kind: "process",
      revision: 1,
      commandLine: "sleep 60",
      inputPolicy: "unknown",
      startedAt: "2026-05-27T00:00:00.000Z",
      lastOutputAt: null,
    });
  });
});
