import { describe, expect, it } from "vitest";
import type { TerminalOwner } from "../src/terminal/index.js";
import type {
  TerminalRuntimeSnapshot,
  TerminalServicePorts,
} from "../src/application/terminal-ports.js";

function shellOwner(): TerminalOwner {
  return {
    kind: "shell",
    revision: 0,
    cwd: "/repo",
    promptSeq: 1,
    lastReturnCode: 0,
    promptNonce: "nonce",
  };
}

describe("terminal application ports", () => {
  it("supports fake ports and explicit snapshots", async () => {
    const snapshot: TerminalRuntimeSnapshot = {
      session: "default",
      owner: shellOwner(),
      parserState: { pending: "", totalBytes: 0 },
    };
    const saved: TerminalRuntimeSnapshot[] = [];

    const ports: TerminalServicePorts = {
      clock: {
        nowIso: () => "2026-05-27T00:00:00.000Z",
        monotonicMs: () => 123,
      },
      ids: {
        newId: (prefix) => `${prefix}-1`,
        newNonce: () => "nonce",
      },
      pty: {
        write: async () => {},
        read: async () => ({ chunk: "hello\n" }),
        interrupt: async () => {},
        terminate: async () => {},
      },
      sessions: {
        load: async () => snapshot,
        save: async (next) => {
          saved.push(next);
        },
      },
      logger: {
        event: () => {},
      },
    };

    expect(await ports.sessions.load("default")).toBe(snapshot);
    await ports.sessions.save(snapshot);
    expect(saved).toEqual([snapshot]);
    await expect(ports.pty.read("default")).resolves.toEqual({ chunk: "hello\n" });
  });
});
