import { describe, expect, it } from "vitest";
import { toCompactTerminalHistoryEntry } from "../src/application/terminal-history.js";

describe("terminal compact history helper", () => {
  it("returns the current run-history observation shape", () => {
    const entry = toCompactTerminalHistoryEntry({
      session: "default",
      result: "ok",
      action: { kind: "status" },
    });

    expect(entry.type).toBe("observation");
    expect(entry.observation).toMatchObject({
      session: "default",
      result: "ok",
      action: { kind: "status" },
    });
  });

  it("redacts payload-like fields before history storage", () => {
    const entry = toCompactTerminalHistoryEntry(
      {
        session: "default",
        action: {
          kind: "input_frame",
          dataBase64: "secret-payload",
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
        session: "default",
        action: {
          kind: "input_frame",
          dataBase64: "[redacted]",
        },
        fullOutput: "[redacted]",
        nested: {
          transcript: "[redacted]",
        },
        message: "mmmmmmmmm…",
      },
    });
    expect(JSON.stringify(entry)).not.toContain("secret-payload");
    expect(JSON.stringify(entry)).not.toContain("full output should not survive");
  });
});
