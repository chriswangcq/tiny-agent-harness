import { describe, expect, it } from "vitest";
import {
  DEFAULT_TERMINAL_MARKERS,
  parseTerminalChunk,
} from "../../src/terminal/parser.js";

const nonce = "nonce-1";

describe("terminal marker parser", () => {
  it("parses prompt markers", () => {
    const result = parseTerminalChunk({
      promptNonce: nonce,
      chunk: "__TAH_PROMPT__ nonce=nonce-1 rc=7 cwd=%2Frepo%2Fsrc seq=42\n",
    });

    expect(result.events).toEqual([
      {
        kind: "prompt",
        returnCode: 7,
        cwd: "/repo/src",
        promptSeq: 42,
        promptNonce: nonce,
      },
    ]);
    expect(result.state.pending).toBe("");
  });

  it("parses continuation markers", () => {
    const result = parseTerminalChunk({
      promptNonce: nonce,
      chunk: "__TAH_CONT__ nonce=nonce-1 reason=heredoc seq=43\n",
    });

    expect(result.events).toEqual([
      {
        kind: "continuation_prompt",
        reason: "heredoc",
        promptSeq: 43,
        promptNonce: nonce,
      },
    ]);
  });

  it("emits output events for ordinary output lines", () => {
    const result = parseTerminalChunk({
      promptNonce: nonce,
      chunk: "hello\n世界\n",
    });

    expect(result.events).toEqual([
      {
        kind: "output",
        bytes: 5,
        preview: "hello",
      },
      {
        kind: "output",
        bytes: 6,
        preview: "世界",
      },
    ]);
  });

  it("preserves incomplete trailing chunks", () => {
    const first = parseTerminalChunk({
      promptNonce: nonce,
      chunk: "__TAH_PROMPT__ nonce=nonce-1 rc=0 cwd=%2Fre",
    });
    expect(first.events).toEqual([]);
    expect(first.state.pending).toBe("__TAH_PROMPT__ nonce=nonce-1 rc=0 cwd=%2Fre");

    const second = parseTerminalChunk({
      promptNonce: nonce,
      state: first.state,
      chunk: "po seq=3\n",
    });

    expect(second.events).toEqual([
      {
        kind: "prompt",
        returnCode: 0,
        cwd: "/repo",
        promptSeq: 3,
        promptNonce: nonce,
      },
    ]);
    expect(second.state.pending).toBe("");
  });

  it("emits unsynced events when marker nonce does not match", () => {
    const result = parseTerminalChunk({
      promptNonce: nonce,
      chunk: "__TAH_PROMPT__ nonce=wrong rc=0 cwd=%2Frepo seq=3\n",
    });

    expect(result.events).toEqual([
      {
        kind: "unsynced",
        reason: "prompt_spoof_suspected",
      },
    ]);
  });

  it("emits unsynced events for malformed trusted markers", () => {
    const result = parseTerminalChunk({
      promptNonce: nonce,
      chunk: "__TAH_PROMPT__ nonce=nonce-1 rc=nope cwd=%2Frepo seq=3\n",
    });

    expect(result.events).toEqual([
      {
        kind: "unsynced",
        reason: "unparsed_output",
      },
    ]);
  });

  it("supports custom marker names", () => {
    const result = parseTerminalChunk({
      promptNonce: nonce,
      markers: { prompt: "[[PROMPT]]" },
      chunk: "[[PROMPT]] nonce=nonce-1 rc=0 cwd=%2Frepo seq=1\n",
    });

    expect(result.events[0]).toMatchObject({ kind: "prompt" });
    expect(DEFAULT_TERMINAL_MARKERS.prompt).toBe("__TAH_PROMPT__");
  });
});
