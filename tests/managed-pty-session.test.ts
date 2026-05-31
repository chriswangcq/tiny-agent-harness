import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildManagedPtyEnv,
  ManagedPtySession,
} from "../src/bash/managed-session.js";
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
      ["--noprofile", "--norc", "--noediting", "-i"],
      expect.objectContaining({
        cwd: "/repo",
        env: expect.objectContaining({
          PATH: "/bin",
          TERM: "dumb",
          PAGER: "cat",
          GIT_PAGER: "cat",
          MANPAGER: "cat",
          LESS: "FRX",
          LANG: expect.stringMatching(/utf-?8/iu),
        }),
      }),
    );
    expect(ptyMock.spawned[0]?.writes[0]).toContain("__TAH_PROMPT__");
    expect(ptyMock.spawned[0]?.writes[0]).toContain("__TAH_CONT__");
    expect(ptyMock.spawned[0]?.writes[0]).not.toContain("__TAH_COMMAND_DONE__");
  });

  it("uses a supplied env snapshot without leaking ambient process env", () => {
    const previous = process.env.TAH_AMBIENT_ONLY;
    process.env.TAH_AMBIENT_ONLY = "should-not-leak";
    try {
      const session = new ManagedPtySession({
        id: "managed",
        promptNonce: "nonce",
        cwd: "/repo",
        env: { PATH: "/bin" },
      });

      session.spawn();

      const options = ptyMock.spawn.mock.calls[0]?.[2] as
        | { env?: Record<string, string> }
        | undefined;
      expect(options?.env).toMatchObject({
        PATH: "/bin",
        TERM: "dumb",
        PAGER: "cat",
        GIT_PAGER: "cat",
        MANPAGER: "cat",
        LESS: "FRX",
      });
      expect(options?.env?.TAH_AMBIENT_ONLY).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.TAH_AMBIENT_ONLY;
      } else {
        process.env.TAH_AMBIENT_ONLY = previous;
      }
    }
  });

  it("builds a deterministic managed PTY env over caller input", () => {
    expect(
      buildManagedPtyEnv({
        PATH: "/bin",
        TERM: "xterm-256color",
        PAGER: "less",
        GIT_PAGER: "less",
        MANPAGER: "less",
        LESS: "R",
      }),
    ).toMatchObject({
      PATH: "/bin",
      TERM: "dumb",
      PAGER: "cat",
      GIT_PAGER: "cat",
      MANPAGER: "cat",
      LESS: "FRX",
      LANG: expect.stringMatching(/utf-?8/iu),
    });
  });

  it("updates terminal facts from prompt output", () => {
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

    expect(session.snapshot.terminal).toMatchObject({
      inputSeq: 1,
      alive: true,
      lastShellPrompt: {
        cwd: "/repo/next",
        promptSeq: 1,
      },
      lastContinuationPrompt: null,
    });
  });

  it("updates terminal facts from continuation output", () => {
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

    expect(session.snapshot.terminal).toMatchObject({
      inputSeq: 1,
      lastContinuationPrompt: {
        reason: "quote",
        promptSeq: 2,
      },
    });
  });

  it("marks the terminal as terminated when the PTY is killed", () => {
    const session = new ManagedPtySession({
      id: "managed",
      promptNonce: "nonce",
      cwd: "/repo",
    });
    session.spawn();

    session.terminate();

    expect(session.snapshot.terminal).toMatchObject({
      inputSeq: 1,
      alive: false,
      termination: {
        exitCode: null,
        reason: "terminated",
      },
    });
  });
});
