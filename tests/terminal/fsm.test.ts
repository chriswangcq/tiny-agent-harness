import { describe, expect, it } from "vitest";
import {
  createShellOwner,
  ownerMatchesRevision,
  transitionOwner,
  transitionOwnerMany,
} from "../../src/terminal/fsm.js";
import type { TerminalEvent, TerminalOwner } from "../../src/terminal/types.js";

function shell(revision = 0): TerminalOwner {
  return createShellOwner({
    revision,
    cwd: "/repo",
    promptSeq: 1,
    lastReturnCode: 0,
    promptNonce: "nonce-1",
  });
}

describe("terminal owner FSM", () => {
  it("creates a shell owner from explicit inputs", () => {
    expect(shell()).toEqual({
      kind: "shell",
      revision: 0,
      cwd: "/repo",
      promptSeq: 1,
      lastReturnCode: 0,
      promptNonce: "nonce-1",
    });
  });

  it("moves to shell and increments revision on prompt events", () => {
    const result = transitionOwner(shell(), {
      kind: "prompt",
      cwd: "/repo/src",
      promptSeq: 2,
      returnCode: 7,
      promptNonce: "nonce-1",
    });

    expect(result.changed).toBe(true);
    expect(result.owner).toEqual({
      kind: "shell",
      revision: 1,
      cwd: "/repo/src",
      promptSeq: 2,
      lastReturnCode: 7,
      promptNonce: "nonce-1",
    });
  });

  it("leaves revision unchanged for output-only events", () => {
    const owner = shell(3);
    const result = transitionOwner(owner, {
      kind: "output",
      bytes: 12,
      preview: "hello",
      logRef: "log-1",
    });

    expect(result.changed).toBe(false);
    expect(result.owner).toBe(owner);
  });

  it("moves to shell continuation for continuation prompts", () => {
    const result = transitionOwner(shell(4), {
      kind: "continuation_prompt",
      reason: "quote",
      promptSeq: 3,
      promptNonce: "nonce-1",
    });

    expect(result.owner).toEqual({
      kind: "shell_continuation",
      revision: 5,
      reason: "quote",
      promptSeq: 3,
      promptNonce: "nonce-1",
    });
  });

  it("moves to receiver when a receiver ready event appears", () => {
    const result = transitionOwner(shell(1), {
      kind: "receiver_ready",
      receiverId: "rx-1",
      commandLine: "node dist/cli/main.js receiver start",
      mode: "base64",
      maxFrameBytes: 3072,
      nextSeq: 0,
      expectedSha256: "abc123",
    });

    expect(result.owner).toEqual({
      kind: "receiver",
      revision: 2,
      receiverId: "rx-1",
      commandLine: "node dist/cli/main.js receiver start",
      mode: "base64",
      nextSeq: 0,
      bytesReceived: 0,
      maxFrameBytes: 3072,
      expectedSha256: "abc123",
    });
  });

  it("does not guess shell readiness after receiver done", () => {
    const receiver: TerminalOwner = {
      kind: "receiver",
      revision: 2,
      receiverId: "rx-1",
      commandLine: "receiver start",
      mode: "base64",
      nextSeq: 2,
      bytesReceived: 12,
      maxFrameBytes: 1024,
    };

    const result = transitionOwner(receiver, {
      kind: "receiver_done",
      receiverId: "rx-1",
      bytes: 12,
      sha256: "hash",
    });

    expect(result.owner).toEqual({
      kind: "unknown",
      revision: 3,
      reason: "state_gap",
    });
  });

  it("advances receiver owner state on ack events", () => {
    const receiver: TerminalOwner = {
      kind: "receiver",
      revision: 2,
      receiverId: "rx-1",
      commandLine: "receiver start",
      mode: "base64",
      nextSeq: 0,
      bytesReceived: 0,
      maxFrameBytes: 1024,
    };

    const result = transitionOwner(receiver, {
      kind: "receiver_ack",
      receiverId: "rx-1",
      seq: 0,
      bytes: 5,
    });

    expect(result.changed).toBe(true);
    expect(result.owner).toEqual({
      ...receiver,
      revision: 3,
      nextSeq: 1,
      bytesReceived: 5,
    });
  });

  it("moves to process after a silence timeout", () => {
    const result = transitionOwner(shell(8), {
      kind: "silence_timeout",
      elapsedMs: 30_000,
      commandLine: "sleep 60",
      startedAt: "2026-05-27T00:00:00.000Z",
      stdinMode: "unknown",
    });

    expect(result.owner).toEqual({
      kind: "process",
      revision: 9,
      commandLine: "sleep 60",
      stdinMode: "unknown",
      startedAt: "2026-05-27T00:00:00.000Z",
      lastOutputAt: null,
    });
  });

  it("moves to unknown on unsynced events", () => {
    const result = transitionOwner(shell(2), {
      kind: "unsynced",
      reason: "prompt_spoof_suspected",
    });

    expect(result.owner).toEqual({
      kind: "unknown",
      revision: 3,
      reason: "prompt_spoof_suspected",
    });
  });

  it("moves to terminated on terminal exit", () => {
    const result = transitionOwner(shell(2), {
      kind: "terminated",
      exitCode: 130,
      reason: "interrupt",
    });

    expect(result.owner).toEqual({
      kind: "terminated",
      revision: 3,
      exitCode: 130,
      reason: "interrupt",
    });
  });

  it("reduces multiple terminal events in order", () => {
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

    const result = transitionOwnerMany(shell(), events);

    expect(result.changed).toBe(true);
    expect(result.owner).toEqual({
      kind: "shell_continuation",
      revision: 2,
      reason: "heredoc",
      promptSeq: 3,
      promptNonce: "nonce-1",
    });
  });

  it("checks owner revision explicitly", () => {
    const owner = shell(11);

    expect(ownerMatchesRevision(owner, 11)).toBe(true);
    expect(ownerMatchesRevision(owner, 10)).toBe(false);
  });
});
