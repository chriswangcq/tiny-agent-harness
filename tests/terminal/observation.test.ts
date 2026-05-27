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

  it("summarizes receiver stdin writes like normal PTY text", () => {
    expect(
      summarizePtyAction({
        kind: "write_text",
        expectedOwnerRevision: 2,
        text: "aGVsbG8=\n",
      }),
    ).toEqual({
      kind: "write_text",
      bytes: 9,
      preview: "aGVsbG8=\n",
      redacted: false,
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
        kind: "write_text",
        expectedOwnerRevision: 1,
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
      outputPreview: "abcdefghij",
      limits: { maxPreviewChars: 5 },
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
