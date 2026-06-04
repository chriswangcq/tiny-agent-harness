import { describe, expect, it } from "vitest";
import {
  buildManagedShellInitSnippet,
  formatContinuationMarker,
  formatPromptMarker,
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

  it("builds a shell init snippet with quoted encoded nonce and marker prompts", () => {
    const snippet = buildManagedShellInitSnippet({ nonce: "nonce ' space" });

    expect(snippet.split("\n")[0]).toBe("set +H");
    expect(snippet).toContain("export TAH_PROMPT_NONCE='nonce%20%27%20space'");
    expect(snippet).toContain("export TAH_PROMPT_RC=0");
    expect(snippet).toContain(
      "export PROMPT_COMMAND='TAH_PROMPT_RC=$?; TAH_PROMPT_SEQ=$((TAH_PROMPT_SEQ + 1))'",
    );
    expect(snippet).toContain("__TAH_PROMPT__");
    expect(snippet).toContain("__TAH_CONT__");
    expect(snippet).toContain("seq=${TAH_PROMPT_SEQ}");
    expect(snippet).toContain("rc=${TAH_PROMPT_RC}");
    expect(snippet).toContain("PS1=");
    expect(snippet).toContain("PS2=");
    expect(snippet).toContain("[\\u@\\h:\\w]\\$ ");
  });
});
