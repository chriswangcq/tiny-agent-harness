import { describe, expect, it } from "vitest";
import { createTerminalState } from "../src/terminal/state.js";
import type {
  TerminalRuntimeSnapshot,
  TerminalServicePorts,
} from "../src/application/terminal-ports.js";

describe("terminal application ports", () => {
  it("supports fake ports and explicit snapshots", async () => {
    const snapshot: TerminalRuntimeSnapshot = {
      session: "default",
      terminal: createTerminalState({
        cwd: "/repo",
        promptSeq: 1,
        lastReturnCode: 0,
      }),
      parserState: { pending: "", totalBytes: 0 },
    };
    const saved: TerminalRuntimeSnapshot[] = [];
    let currentSession = "default";

    const ports: TerminalServicePorts = {
      pty: {
        write: async () => {},
        read: async () => ({
          chunk: "hello\n",
          screen: {
            text: "hello\n",
            rows: 24,
            cols: 80,
            truncated: false,
            logRef: { path: "test-log://default" },
          },
        }),
        interrupt: async () => {},
        terminate: async () => {},
        restart: async () => snapshot,
      },
      sessions: {
        getCurrent: async () => currentSession,
        setCurrent: async (session) => {
          currentSession = session;
        },
        list: async () => [snapshot],
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
    await ports.sessions.setCurrent("build");
    expect(await ports.sessions.getCurrent()).toBe("build");
    await expect(ports.sessions.list()).resolves.toEqual([snapshot]);
    await ports.sessions.save(snapshot);
    expect(saved).toEqual([snapshot]);
    await expect(ports.pty.read("default")).resolves.toMatchObject({
      chunk: "hello\n",
      screen: { text: "hello\n" },
    });
  });
});
