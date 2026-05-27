import { describe, expect, it } from "vitest";
import {
  buildManagedShellInitSnippet,
  formatContinuationMarker,
  formatPromptMarker,
  formatReceiverReadyMarker,
} from "../src/application/managed-shell.js";
import { parseTerminalChunk } from "../src/terminal/parser.js";

describe("managed shell marker formatting", () => {
  it("formats prompt markers that the parser can read", () => {
    const marker = formatPromptMarker({
      nonce: "nonce with spaces",
      returnCode: 7,
      cwd: "/repo/with space",
      promptSeq: 3,
    });

    const parsed = parseTerminalChunk({
      promptNonce: "nonce with spaces",
      chunk: `${marker}\n`,
    });

    expect(parsed.events).toEqual([
      {
        kind: "prompt",
        returnCode: 7,
        cwd: "/repo/with space",
        promptSeq: 3,
        promptNonce: "nonce with spaces",
      },
    ]);
  });

  it("formats continuation markers that the parser can read", () => {
    const marker = formatContinuationMarker({
      nonce: "nonce with spaces",
      reason: "quote",
      promptSeq: 4,
    });

    const parsed = parseTerminalChunk({
      promptNonce: "nonce with spaces",
      chunk: `${marker}\n`,
    });

    expect(parsed.events).toEqual([
      {
        kind: "continuation_prompt",
        reason: "quote",
        promptSeq: 4,
        promptNonce: "nonce with spaces",
      },
    ]);
  });

  it("formats receiver ready markers that the parser can read", () => {
    const marker = formatReceiverReadyMarker({
      nonce: "nonce",
      receiverId: "rx-1",
      mode: "base64",
      maxFrameBytes: 4096,
      nextSeq: 2,
      commandLine: "node dist/cli/main.js receiver start",
      bytesReceived: 12,
      expectedSha256: "hash",
    });

    const parsed = parseTerminalChunk({
      promptNonce: "nonce",
      chunk: `${marker}\n`,
    });

    expect(parsed.events).toEqual([
      {
        kind: "receiver_ready",
        receiverId: "rx-1",
        commandLine: "node dist/cli/main.js receiver start",
        mode: "base64",
        maxFrameBytes: 4096,
        nextSeq: 2,
        bytesReceived: 12,
        expectedSha256: "hash",
      },
    ]);
  });

  it("builds a shell init snippet with quoted encoded nonce and marker prompts", () => {
    const snippet = buildManagedShellInitSnippet({ nonce: "nonce ' space" });

    expect(snippet).toContain("export TAH_PROMPT_NONCE='nonce%20%27%20space'");
    expect(snippet).toContain("__TAH_PROMPT__");
    expect(snippet).toContain("__TAH_CONT__");
    expect(snippet).toContain("PS1=");
    expect(snippet).toContain("PS2=");
  });
});
