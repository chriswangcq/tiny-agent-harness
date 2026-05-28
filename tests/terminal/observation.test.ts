import { describe, expect, it } from "vitest";
import { compactTerminalHistoryEntry } from "../../src/terminal/history.js";
import {
  buildPtyObservation,
  summarizePtyAction,
  summarizeTerminalEvent,
} from "../../src/terminal/observation.js";
import { createTerminalState } from "../../src/terminal/state.js";

const terminal = createTerminalState({
  inputSeq: 1,
  cwd: "/repo",
  promptSeq: 1,
  lastReturnCode: 0,
});

describe("terminal observation helpers", () => {
  it("summarizes type text with bounded preview and byte metadata", () => {
    expect(
      summarizePtyAction(
        {
          kind: "write_text",
          expectedInputSeq: 1,
          text: "hello world",
        },
        { maxPreviewChars: 6 },
      ),
    ).toEqual({
      kind: "write_text",
      bytes: 11,
      preview: "hello…",
      redacted: true,
    });
  });

  it("summarizes payload-like writes like normal PTY text", () => {
    expect(
      summarizePtyAction({
        kind: "write_text",
        expectedInputSeq: 2,
        text: "aGVsbG8=\n",
      }),
    ).toEqual({
      kind: "write_text",
      bytes: 9,
      preview: "aGVsbG8=\n",
      redacted: false,
    });
  });

  it("summarizes prompt events without payload metadata", () => {
    expect(
      summarizeTerminalEvent({
        kind: "prompt",
        returnCode: 0,
        cwd: "/repo",
        promptSeq: 2,
        promptNonce: "nonce",
      }),
    ).toEqual({
      kind: "prompt",
    });
  });

  it("builds compact PTY observations", () => {
    const observation = buildPtyObservation({
      session: "default",
      terminal,
      action: {
        kind: "write_text",
        expectedInputSeq: 1,
        text: "aGVsbG8=\n",
      },
      result: "ok",
      events: [
        {
          kind: "output",
          bytes: 18,
          preview: "abcdefghij",
          logRef: "log-1",
        },
      ],
      outputTail: "abcdefghij",
      limits: { maxPreviewChars: 5, maxOutputTailChars: 5 },
    });

    expect(observation).toMatchObject({
      session: "default",
      result: "ok",
      action: {
        kind: "write_text",
        preview: "aGVs…",
        redacted: true,
      },
      events: [
        {
          kind: "output",
          bytes: 18,
          preview: "abcd…",
          logRef: "log-1",
        },
      ],
      outputTail: "…ghij",
      outputPreview: "…ghij",
    });
    expect(JSON.stringify(observation)).not.toContain("aGVsbG8=");
  });

  it("bounds terminal event summaries while preserving event counts", () => {
    const events = Array.from({ length: 5 }, (_, index) => ({
      kind: "output" as const,
      bytes: 20,
      preview: `line-${index}`,
    }));

    const observation = buildPtyObservation({
      session: "default",
      terminal,
      action: {
        kind: "poll",
      },
      result: "ok",
      events,
      limits: { maxEvents: 2, maxPreviewChars: 20 },
    });

    expect(observation.eventCount).toBe(5);
    expect(observation.eventsOmitted).toBe(3);
    expect(observation.events).toEqual([
      { kind: "output", bytes: 20, preview: "line-3" },
      { kind: "output", bytes: 20, preview: "line-4" },
    ]);
  });

  it("redacts payload-like fields when compacting history entries", () => {
    const entry = compactTerminalHistoryEntry(
      {
        type: "terminal_observation",
        observation: {
          session: "default",
          action: {
            kind: "write_text",
            text: `${"a".repeat(512)}\n`,
          },
          fullOutput: "x".repeat(100),
          nested: [{ content: "secret" }],
          message: "m".repeat(20),
        },
      },
      { maxStringChars: 8 },
    );

    expect(entry).toEqual({
      type: "terminal_observation",
      observation: {
        session: "default",
        action: {
          kind: "write_text",
          text: "[redacted write_text payload 513 bytes]",
        },
        fullOutput: "[redacted]",
        nested: [{ content: "[redacted]" }],
        message: "mmmmmmm…",
      },
    });
  });
});
