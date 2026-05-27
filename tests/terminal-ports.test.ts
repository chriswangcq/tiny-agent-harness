import { describe, expect, it } from "vitest";
import type {
  PayloadRef,
  TerminalOwner,
} from "../src/terminal/index.js";
import type {
  PayloadCommitResult,
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
    const payloadRef: PayloadRef = {
      kind: "payload",
      ref: "payload-1",
      bytes: 3,
      sha256: "hash",
    };

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
      payloads: {
        put: async () => payloadRef,
        commit: async (ref, target): Promise<PayloadCommitResult> => ({ ref, target }),
      },
      logger: {
        event: () => {},
      },
    };

    expect(await ports.sessions.load("default")).toBe(snapshot);
    await ports.sessions.save(snapshot);
    expect(saved).toEqual([snapshot]);
    await expect(ports.pty.read("default")).resolves.toEqual({ chunk: "hello\n" });
    await expect(
      ports.payloads.commit(payloadRef, { kind: "temp", name: "payload" }),
    ).resolves.toEqual({
      ref: payloadRef,
      target: { kind: "temp", name: "payload" },
    });
  });
});
