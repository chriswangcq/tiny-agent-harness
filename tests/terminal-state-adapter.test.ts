import { describe, expect, it } from "vitest";
import { applyPtyChunkToSnapshot } from "../src/application/terminal-state-adapter.js";
import {
  formatContinuationMarker,
  formatPromptMarker,
} from "../src/application/managed-shell.js";
import { createTerminalState } from "../src/terminal/state.js";
import type { TerminalRuntimeSnapshot } from "../src/application/terminal-ports.js";
import type { TerminalState } from "../src/terminal/index.js";

const nonce = "nonce";

function terminal(inputSeq = 1): TerminalState {
  return createTerminalState({
    inputSeq,
    cwd: "/repo",
    promptSeq: 1,
    lastReturnCode: 0,
  });
}

function snapshot(state: TerminalState = terminal()): TerminalRuntimeSnapshot {
  return {
    session: "default",
    terminal: state,
    parserState: { pending: "", totalBytes: 0 },
  };
}

describe("terminal state parsing adapter", () => {
  it("maps prompt chunks to terminal shell prompt facts", () => {
    const result = applyPtyChunkToSnapshot({
      snapshot: snapshot(terminal(1)),
      promptNonce: nonce,
      chunk: `${formatPromptMarker({
        nonce,
        returnCode: 0,
        cwd: "/repo/next",
        promptSeq: 2,
      })}\n`,
    });

    expect(result.events).toEqual([
      {
        kind: "prompt",
        returnCode: 0,
        cwd: "/repo/next",
        promptSeq: 2,
        promptNonce: nonce,
      },
    ]);
    expect(result.snapshot.terminal).toMatchObject({
      inputSeq: 2,
      alive: true,
      lastShellPrompt: {
        cwd: "/repo/next",
        promptSeq: 2,
      },
      lastContinuationPrompt: null,
    });
  });

  it("maps continuation chunks to terminal continuation facts", () => {
    const result = applyPtyChunkToSnapshot({
      snapshot: snapshot(terminal(4)),
      promptNonce: nonce,
      chunk: `${formatContinuationMarker({
        nonce,
        reason: "quote",
        promptSeq: 3,
      })}\n`,
    });

    expect(result.snapshot.terminal).toMatchObject({
      inputSeq: 5,
      lastContinuationPrompt: {
        reason: "quote",
        promptSeq: 3,
      },
    });
  });

  it("advances inputSeq for accepted input even without parsed output", () => {
    const result = applyPtyChunkToSnapshot({
      snapshot: snapshot(terminal(8)),
      promptNonce: nonce,
      chunk: "",
      inputAccepted: true,
    });

    expect(result.events).toEqual([]);
    expect(result.snapshot.terminal.inputSeq).toBe(9);
  });

  it("advances inputSeq for partial terminal output without a newline", () => {
    const result = applyPtyChunkToSnapshot({
      snapshot: snapshot(terminal(8)),
      promptNonce: nonce,
      chunk: ">>> ",
    });

    expect(result.events).toEqual([]);
    expect(result.snapshot.parserState.pending).toBe(">>> ");
    expect(result.snapshot.terminal.inputSeq).toBe(9);
  });

  it("maps nonce mismatch to unsynced terminal facts", () => {
    const result = applyPtyChunkToSnapshot({
      snapshot: snapshot(terminal(7)),
      promptNonce: nonce,
      chunk: "__TAH_PROMPT__ nonce=wrong rc=0 cwd=%2Frepo seq=2\n",
    });

    expect(result.events).toEqual([
      {
        kind: "unsynced",
        reason: "prompt_spoof_suspected",
      },
    ]);
    expect(result.snapshot.terminal).toMatchObject({
      inputSeq: 8,
      syncStatus: {
        kind: "unsynced",
        reason: "prompt_spoof_suspected",
      },
    });
  });
});
