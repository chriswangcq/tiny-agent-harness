import { describe, expect, it } from "vitest";
import {
  DEFAULT_PTY_ACTION_LIMITS,
  validatePtyAction,
} from "../../src/terminal/validator.js";
import type { TerminalOwner } from "../../src/terminal/types.js";

function shell(revision = 1): TerminalOwner {
  return {
    kind: "shell",
    revision,
    cwd: "/repo",
    promptSeq: 1,
    lastReturnCode: 0,
    promptNonce: "nonce",
  };
}

function processOwner(stdinMode: "none" | "interactive" | "unknown" = "unknown"): TerminalOwner {
  return {
    kind: "process",
    revision: 2,
    commandLine: "node repl.js",
    stdinMode,
    startedAt: "2026-05-27T00:00:00.000Z",
    lastOutputAt: null,
  };
}

describe("terminal action validator", () => {
  it("accepts shell text input with explicit newline when owner revision matches", () => {
    const result = validatePtyAction({
      owner: shell(7),
      action: {
        kind: "write_text",
        expectedOwnerRevision: 7,
        text: "echo ok\n",
      },
    });

    expect(result).toEqual({ ok: true });
  });

  it("rejects stale owner revisions before writing", () => {
    const result = validatePtyAction({
      owner: shell(7),
      action: {
        kind: "write_text",
        expectedOwnerRevision: 6,
        text: "echo stale",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "OWNER_MISMATCH",
    });
  });

  it("allows continuation text while shell continuation owns the terminal", () => {
    const owner: TerminalOwner = {
      kind: "shell_continuation",
      revision: 4,
      reason: "quote",
      promptSeq: 2,
      promptNonce: "nonce",
    };

    const result = validatePtyAction({
      owner,
      action: {
        kind: "write_text",
        expectedOwnerRevision: 4,
        text: "closing quote'",
      },
    });

    expect(result).toEqual({ ok: true });
  });

  it("rejects process text input when stdin mode is unknown", () => {
    const result = validatePtyAction({
      owner: processOwner("unknown"),
      action: {
        kind: "write_text",
        expectedOwnerRevision: 2,
        text: "ls",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "OWNER_REJECTED",
    });
  });

  it("allows explicit process text input when process stdin may accept input", () => {
    const result = validatePtyAction({
      owner: processOwner("interactive"),
      action: {
        kind: "write_text",
        expectedOwnerRevision: 2,
        text: "y\n",
      },
    });

    expect(result).toEqual({ ok: true });
  });

  it("rejects process text input when stdin is none", () => {
    const result = validatePtyAction({
      owner: processOwner("none"),
      action: {
        kind: "write_text",
        expectedOwnerRevision: 2,
        text: "y\n",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "OWNER_REJECTED",
    });
  });

  it("rejects writes while owner is unknown", () => {
    const result = validatePtyAction({
      owner: { kind: "unknown", revision: 5, reason: "state_gap" },
      action: {
        kind: "write_text",
        expectedOwnerRevision: 5,
        text: "hello",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "TERMINAL_UNSYNCED",
    });
  });

  it("allows status, poll, restart, terminate, and interrupt without shell ownership", () => {
    const owner: TerminalOwner = { kind: "unknown", revision: 5, reason: "state_gap" };

    expect(validatePtyAction({ owner, action: { kind: "status" } })).toEqual({ ok: true });
    expect(validatePtyAction({ owner, action: { kind: "poll" } })).toEqual({ ok: true });
    expect(validatePtyAction({ owner, action: { kind: "restart" } })).toEqual({ ok: true });
    expect(validatePtyAction({ owner, action: { kind: "terminate" } })).toEqual({ ok: true });
    expect(
      validatePtyAction({
        owner,
        action: { kind: "interrupt", expectedOwnerRevision: 5 },
      }),
    ).toEqual({ ok: true });
  });

  it("does not impose a harness length limit on shell write_text", () => {
    const result = validatePtyAction({
      owner: shell(),
      action: {
        kind: "write_text",
        expectedOwnerRevision: 1,
        text: "hello".repeat(2000),
      },
    });

    expect(result).toEqual({ ok: true });
  });

  it("accepts terminal keys while shell owns the terminal", () => {
    const result = validatePtyAction({
      owner: shell(3),
      action: {
        kind: "key",
        expectedOwnerRevision: 3,
        key: "enter",
      },
    });

    expect(result).toEqual({ ok: true });
  });

  it("does not expose payload-specific default limits", () => {
    expect(DEFAULT_PTY_ACTION_LIMITS).toEqual({});
  });
});
