import { describe, expect, it } from "vitest";
import {
  createTerminalState,
  markTerminalTerminated,
  terminalMatchesInputSeq,
  transitionTerminalStateMany,
} from "../../src/terminal/state.js";
import type { TerminalEvent, TerminalState } from "../../src/terminal/types.js";

function terminal(inputSeq = 0): TerminalState {
  return createTerminalState({
    inputSeq,
    cwd: "/repo",
    promptSeq: 1,
    lastReturnCode: 0,
  });
}

describe("terminal state", () => {
  it("creates terminal facts from explicit inputs", () => {
    expect(terminal()).toEqual({
      inputSeq: 0,
      alive: true,
      syncStatus: { kind: "trusted" },
      lastShellPrompt: {
        cwd: "/repo",
        promptSeq: 1,
        lastReturnCode: 0,
      },
      lastContinuationPrompt: null,
      termination: null,
      foregroundProcess: null,
    });
  });

  it("updates shell prompt facts and advances inputSeq once for a prompt batch", () => {
    const result = transitionTerminalStateMany(terminal(), [
      {
        kind: "prompt",
        cwd: "/repo/src",
        promptSeq: 2,
        returnCode: 7,
        promptNonce: "nonce-1",
      },
    ]);

    expect(result.changed).toBe(true);
    expect(result.terminal).toMatchObject({
      inputSeq: 1,
      alive: true,
      syncStatus: { kind: "trusted" },
      lastShellPrompt: {
        cwd: "/repo/src",
        promptSeq: 2,
        lastReturnCode: 7,
      },
      lastContinuationPrompt: null,
    });
  });

  it("advances inputSeq for output-only batches because screen contents changed", () => {
    const result = transitionTerminalStateMany(terminal(3), [
      {
        kind: "output",
        bytes: 12,
        preview: ">>> ",
        logRef: "log-1",
      },
    ]);

    expect(result.changed).toBe(true);
    expect(result.terminal.inputSeq).toBe(4);
    expect(result.terminal.lastShellPrompt?.cwd).toBe("/repo");
  });

  it("advances inputSeq for accepted input even when no output is parsed", () => {
    const result = transitionTerminalStateMany(terminal(8), [], {
      inputAccepted: true,
    });

    expect(result.changed).toBe(true);
    expect(result.terminal.inputSeq).toBe(9);
  });

  it("records continuation prompts as terminal facts", () => {
    const result = transitionTerminalStateMany(terminal(4), [
      {
        kind: "continuation_prompt",
        reason: "quote",
        promptSeq: 3,
        promptNonce: "nonce-1",
      },
    ]);

    expect(result.terminal).toMatchObject({
      inputSeq: 5,
      syncStatus: { kind: "trusted" },
      lastContinuationPrompt: {
        reason: "quote",
        promptSeq: 3,
      },
    });
  });

  it("marks unsynced parser output as a terminal fact", () => {
    const result = transitionTerminalStateMany(terminal(2), [
      {
        kind: "unsynced",
        reason: "prompt_spoof_suspected",
      },
    ]);

    expect(result.terminal).toMatchObject({
      inputSeq: 3,
      syncStatus: {
        kind: "unsynced",
        reason: "prompt_spoof_suspected",
      },
    });
  });

  it("marks terminal termination and advances inputSeq", () => {
    const result = markTerminalTerminated(terminal(2), {
      exitCode: 130,
      reason: "interrupt",
    });

    expect(result).toMatchObject({
      inputSeq: 3,
      alive: false,
      termination: {
        exitCode: 130,
        reason: "interrupt",
      },
    });
  });

  it("reduces multiple terminal events with one inputSeq advance", () => {
    const events: TerminalEvent[] = [
      {
        kind: "output",
        bytes: 4,
        preview: "work",
      },
      {
        kind: "prompt",
        cwd: "/repo",
        promptSeq: 2,
        returnCode: 0,
        promptNonce: "nonce-1",
      },
      {
        kind: "continuation_prompt",
        reason: "heredoc",
        promptSeq: 3,
        promptNonce: "nonce-1",
      },
    ];

    const result = transitionTerminalStateMany(terminal(), events);

    expect(result.changed).toBe(true);
    expect(result.terminal).toMatchObject({
      inputSeq: 1,
      lastShellPrompt: {
        cwd: "/repo",
        promptSeq: 2,
        lastReturnCode: 0,
      },
      lastContinuationPrompt: {
        reason: "heredoc",
        promptSeq: 3,
      },
    });
  });

  it("checks inputSeq explicitly", () => {
    const state = terminal(11);

    expect(terminalMatchesInputSeq(state, 11)).toBe(true);
    expect(terminalMatchesInputSeq(state, 10)).toBe(false);
  });
});
