import { describe, expect, it } from "vitest";
import {
  applyPtyChunkToSnapshot,
  applySilenceTimeoutToSnapshot,
} from "../src/application/pty-owner-adapter.js";
import {
  formatContinuationMarker,
  formatPromptMarker,
  formatReceiverReadyMarker,
} from "../src/application/managed-shell.js";
import type { TerminalRuntimeSnapshot } from "../src/application/terminal-ports.js";
import type { TerminalOwner } from "../src/terminal/index.js";

const nonce = "nonce";

function shell(revision = 1): TerminalOwner {
  return {
    kind: "shell",
    revision,
    cwd: "/repo",
    promptSeq: 1,
    lastReturnCode: 0,
    promptNonce: nonce,
  };
}

function snapshot(owner: TerminalOwner = shell()): TerminalRuntimeSnapshot {
  return {
    session: "default",
    owner,
    parserState: { pending: "", totalBytes: 0 },
  };
}

describe("fake PTY owner parsing adapter", () => {
  it("maps prompt chunks to shell owner snapshots", () => {
    const result = applyPtyChunkToSnapshot({
      snapshot: snapshot(shell(1)),
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
    expect(result.snapshot.owner).toMatchObject({
      kind: "shell",
      revision: 2,
      cwd: "/repo/next",
      promptSeq: 2,
    });
  });

  it("maps continuation chunks to shell continuation owner snapshots", () => {
    const result = applyPtyChunkToSnapshot({
      snapshot: snapshot(shell(4)),
      promptNonce: nonce,
      chunk: `${formatContinuationMarker({
        nonce,
        reason: "quote",
        promptSeq: 3,
      })}\n`,
    });

    expect(result.snapshot.owner).toEqual({
      kind: "shell_continuation",
      revision: 5,
      reason: "quote",
      promptSeq: 3,
      promptNonce: nonce,
    });
  });

  it("maps receiver-ready chunks to receiver owner snapshots", () => {
    const result = applyPtyChunkToSnapshot({
      snapshot: snapshot(shell(2)),
      promptNonce: nonce,
      chunk: `${formatReceiverReadyMarker({
        nonce,
        receiverId: "rx-1",
        mode: "base64",
        maxFrameBytes: 4096,
        nextSeq: 0,
        commandLine: "receiver start",
      })}\n`,
    });

    expect(result.snapshot.owner).toMatchObject({
      kind: "receiver",
      revision: 3,
      receiverId: "rx-1",
      nextSeq: 0,
      bytesReceived: 0,
      maxFrameBytes: 4096,
    });
  });

  it("does not guess shell readiness after receiver done", () => {
    const receiver: TerminalOwner = {
      kind: "receiver",
      revision: 3,
      receiverId: "rx-1",
      commandLine: "receiver start",
      mode: "base64",
      nextSeq: 1,
      bytesReceived: 5,
      maxFrameBytes: 4096,
    };

    const result = applyPtyChunkToSnapshot({
      snapshot: snapshot(receiver),
      promptNonce: nonce,
      chunk: "__TAH_RECEIVER_DONE__ nonce=nonce id=rx-1 bytes=5 sha256=hash\n",
    });

    expect(result.snapshot.owner).toEqual({
      kind: "unknown",
      revision: 4,
      reason: "state_gap",
    });
  });

  it("maps silence timeout to process owner with explicit inputs", () => {
    const result = applySilenceTimeoutToSnapshot({
      snapshot: snapshot(shell(5)),
      elapsedMs: 30_000,
      commandLine: "sleep 60",
      startedAt: "2026-05-27T00:00:00.000Z",
      stdinMode: "unknown",
    });

    expect(result.snapshot.owner).toEqual({
      kind: "process",
      revision: 6,
      commandLine: "sleep 60",
      stdinMode: "unknown",
      startedAt: "2026-05-27T00:00:00.000Z",
      lastOutputAt: null,
    });
  });

  it("maps nonce mismatch to unknown owner snapshots", () => {
    const result = applyPtyChunkToSnapshot({
      snapshot: snapshot(shell(7)),
      promptNonce: nonce,
      chunk: "__TAH_PROMPT__ nonce=wrong rc=0 cwd=%2Frepo seq=2\n",
    });

    expect(result.events).toEqual([
      {
        kind: "unsynced",
        reason: "prompt_spoof_suspected",
      },
    ]);
    expect(result.snapshot.owner).toEqual({
      kind: "unknown",
      revision: 8,
      reason: "prompt_spoof_suspected",
    });
  });
});
