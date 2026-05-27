import { describe, expect, it } from "vitest";
import {
  DEFAULT_PTY_ACTION_LIMITS,
  validatePtyAction,
} from "../../src/terminal/validator.js";
import {
  createTerminalState,
  markTerminalTerminated,
} from "../../src/terminal/state.js";
import type { TerminalState } from "../../src/terminal/types.js";

function terminal(inputSeq = 1): TerminalState {
  return createTerminalState({
    inputSeq,
    cwd: "/repo",
    promptSeq: 1,
    lastReturnCode: 0,
  });
}

describe("terminal action validator", () => {
  it("accepts text input when inputSeq matches", () => {
    const result = validatePtyAction({
      terminal: terminal(7),
      action: {
        kind: "write_text",
        expectedInputSeq: 7,
        text: "echo ok\n",
      },
    });

    expect(result).toEqual({ ok: true });
  });

  it("rejects stale input sequences before writing", () => {
    const result = validatePtyAction({
      terminal: terminal(7),
      action: {
        kind: "write_text",
        expectedInputSeq: 6,
        text: "echo stale",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "INPUT_SEQ_MISMATCH",
    });
  });

  it("does not reject input based on shell/process guesses", () => {
    const state: TerminalState = {
      ...terminal(4),
      lastContinuationPrompt: {
        reason: "quote",
        promptSeq: 2,
      },
    };

    const result = validatePtyAction({
      terminal: state,
      action: {
        kind: "write_text",
        expectedInputSeq: 4,
        text: "closing quote'",
      },
    });

    expect(result).toEqual({ ok: true });
  });

  it("allows writes while sync status is unsynced because the agent owns recovery choice", () => {
    const result = validatePtyAction({
      terminal: {
        ...terminal(5),
        syncStatus: { kind: "unsynced", reason: "state_gap" },
      },
      action: {
        kind: "write_text",
        expectedInputSeq: 5,
        text: "\u0003",
      },
    });

    expect(result).toEqual({ ok: true });
  });

  it("rejects writes after terminal termination", () => {
    const result = validatePtyAction({
      terminal: markTerminalTerminated(terminal(5), {
        exitCode: null,
        reason: "terminated",
      }),
      action: {
        kind: "write_text",
        expectedInputSeq: 6,
        text: "hello",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "TERMINAL_TERMINATED",
    });
  });

  it("allows status, poll, restart, and terminate without inputSeq", () => {
    const state = terminal(5);

    expect(validatePtyAction({ terminal: state, action: { kind: "status" } })).toEqual({ ok: true });
    expect(validatePtyAction({ terminal: state, action: { kind: "poll" } })).toEqual({ ok: true });
    expect(validatePtyAction({ terminal: state, action: { kind: "restart" } })).toEqual({ ok: true });
    expect(validatePtyAction({ terminal: state, action: { kind: "terminate" } })).toEqual({ ok: true });
  });

  it("allows interrupt with a matching optional inputSeq", () => {
    expect(
      validatePtyAction({
        terminal: terminal(5),
        action: { kind: "interrupt", expectedInputSeq: 5 },
      }),
    ).toEqual({ ok: true });
  });

  it("does not impose a harness length limit on write_text", () => {
    const result = validatePtyAction({
      terminal: terminal(),
      action: {
        kind: "write_text",
        expectedInputSeq: 1,
        text: "hello".repeat(2000),
      },
    });

    expect(result).toEqual({ ok: true });
  });

  it("accepts terminal keys when inputSeq matches", () => {
    const result = validatePtyAction({
      terminal: terminal(3),
      action: {
        kind: "key",
        expectedInputSeq: 3,
        key: "enter",
      },
    });

    expect(result).toEqual({ ok: true });
  });

  it("does not expose payload-specific default limits", () => {
    expect(DEFAULT_PTY_ACTION_LIMITS).toEqual({});
  });
});
