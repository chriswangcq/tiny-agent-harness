import { describe, expect, it } from "vitest";
import { compactTerminalHistoryEntry } from "../../src/terminal/history.js";
import {
  buildPtyObservation,
  summarizePtyAction,
  summarizeTerminalEvent,
} from "../../src/terminal/observation.js";
import type { TerminalOwner } from "../../src/terminal/types.js";

const owner: TerminalOwner = {
  kind: "shell",
  revision: 1,
  cwd: "/repo",
  promptSeq: 1,
  lastReturnCode: 0,
  promptNonce: "nonce",
};

describe("terminal observation helpers", () => {
  it("summarizes type text with bounded preview and byte metadata", () => {
    expect(
      summarizePtyAction(
        {
          kind: "write_text",
          expectedOwnerRevision: 1,
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

  it("redacts input frame payloads from action summaries", () => {
    expect(
      summarizePtyAction({
        kind: "input_frame",
        expectedOwnerRevision: 2,
        receiverId: "rx-1",
        seq: 4,
        dataBase64: "aGVsbG8=",
      }),
    ).toEqual({
      kind: "input_frame",
      receiverId: "rx-1",
      seq: 4,
      bytes: 8,
      redacted: true,
    });
  });

  it("keeps receiver done metadata without payload content", () => {
    expect(
      summarizeTerminalEvent({
        kind: "receiver_done",
        receiverId: "rx-1",
        bytes: 1024,
        sha256: "hash",
      }),
    ).toEqual({
      kind: "receiver_done",
      receiverId: "rx-1",
      bytes: 1024,
      sha256: "hash",
    });
  });

  it("builds compact PTY observations", () => {
    const observation = buildPtyObservation({
      session: "default",
      owner,
      action: {
        kind: "input_frame",
        expectedOwnerRevision: 1,
        receiverId: "rx-1",
        seq: 0,
        dataBase64: "aGVsbG8=",
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
      outputPreview: "abcdefghij",
      limits: { maxPreviewChars: 5 },
    });

    expect(observation).toMatchObject({
      session: "default",
      result: "ok",
      action: {
        kind: "input_frame",
        receiverId: "rx-1",
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
      outputPreview: "abcd…",
    });
    expect(JSON.stringify(observation)).not.toContain("aGVsbG8=");
  });

  it("redacts payload-like fields when compacting history entries", () => {
    const entry = compactTerminalHistoryEntry(
      {
        type: "terminal_observation",
        observation: {
          session: "default",
          action: {
            kind: "input_frame",
            dataBase64: "a".repeat(100),
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
          kind: "input_frame",
          dataBase64: "[redacted]",
        },
        fullOutput: "[redacted]",
        nested: [{ content: "[redacted]" }],
        message: "mmmmmmm…",
      },
    });
  });
});
