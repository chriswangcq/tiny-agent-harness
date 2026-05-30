import { describe, expect, it } from "vitest";
import { toCompactTerminalHistoryEntry } from "../src/application/terminal-history.js";

describe("terminal compact history helper", () => {
  it("returns the current terminal observation shape", () => {
    const entry = toCompactTerminalHistoryEntry({
      currentSession: "default",
      observedSession: "default",
      result: "ok",
      request: "session_observe",
      screen: {
        text: "ready",
        rows: 24,
        cols: 80,
        truncated: false,
        logRef: { path: "managed-pty://default" },
      },
    });

    expect(entry.type).toBe("observation");
    expect(entry.observation).toMatchObject({
      currentSession: "default",
      observedSession: "default",
      result: "ok",
      request: "session_observe",
      screen: {
        text: "ready",
        logRef: { path: "managed-pty://default" },
      },
    });
  });

  it("redacts terminal_write payload-like fields before history storage", () => {
    const entry = toCompactTerminalHistoryEntry(
      {
        currentSession: "default",
        observedSession: "default",
        result: "ok",
        request: "terminal_write",
        requestPayload: {
          kind: "terminal_write",
          text: `${"a".repeat(512)}\n`,
        },
        fullOutput: "full output should not survive",
        nested: {
          transcript: "long transcript should not survive",
        },
        message: "m".repeat(20),
      },
      { maxStringChars: 10 },
    );

    expect(entry).toEqual({
      type: "observation",
      observation: {
        currentSession: "default",
        observedSession: "default",
        result: "ok",
        request: "terminal_write",
        requestPayload: {
          kind: "terminal_write",
          text: "[redacted terminal_write payload 513 bytes]",
        },
        fullOutput: "[redacted]",
        nested: {
          transcript: "[redacted]",
        },
        message: "mmmmmmmmm…",
      },
    });
    expect(JSON.stringify(entry)).not.toContain("aaaaaaaaaa");
    expect(JSON.stringify(entry)).not.toContain("full output should not survive");
  });
});
