import { describe, expect, it } from "vitest";
import { applyReceiverFrame } from "../../src/terminal/frame.js";
import type { ReceiverOwner } from "../../src/terminal/types.js";

function receiver(overrides: Partial<ReceiverOwner> = {}): ReceiverOwner {
  return {
    kind: "receiver",
    revision: 3,
    receiverId: "rx-1",
    commandLine: "receiver start",
    mode: "base64",
    nextSeq: 0,
    bytesReceived: 0,
    maxFrameBytes: 1024,
    expectedSha256: "expected",
    ...overrides,
  };
}

describe("receiver frame validation", () => {
  it("advances receiver state for valid input frames", () => {
    const result = applyReceiverFrame({
      receiver: receiver(),
      action: {
        kind: "frame",
        receiverId: "rx-1",
        seq: 0,
        dataBase64: "aGVsbG8=",
      },
    });

    expect(result).toEqual({
      ok: true,
      receiver: {
        ...receiver(),
        nextSeq: 1,
        bytesReceived: 5,
      },
      done: false,
      decodedBytes: 5,
    });
  });

  it("rejects receiver id mismatches", () => {
    const result = applyReceiverFrame({
      receiver: receiver(),
      action: {
        kind: "frame",
        receiverId: "rx-2",
        seq: 0,
        dataBase64: "YQ==",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "OWNER_REJECTED",
    });
  });

  it("rejects frame sequence mismatches", () => {
    const result = applyReceiverFrame({
      receiver: receiver({ nextSeq: 2 }),
      action: {
        kind: "frame",
        receiverId: "rx-1",
        seq: 1,
        dataBase64: "YQ==",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "RECEIVER_SEQ_MISMATCH",
    });
  });

  it("rejects oversized frame strings", () => {
    const result = applyReceiverFrame({
      receiver: receiver(),
      limits: { maxFrameBytes: 4 },
      action: {
        kind: "frame",
        receiverId: "rx-1",
        seq: 0,
        dataBase64: "aGVsbG8=",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "RECEIVER_FRAME_TOO_LARGE",
    });
  });

  it("rejects invalid base64", () => {
    const result = applyReceiverFrame({
      receiver: receiver(),
      action: {
        kind: "frame",
        receiverId: "rx-1",
        seq: 0,
        dataBase64: "not base64",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "RECEIVER_INVALID_BASE64",
    });
  });

  it("accepts end input when frame count, bytes, and expected sha match", () => {
    const owner = receiver({ nextSeq: 2, bytesReceived: 8 });
    const result = applyReceiverFrame({
      receiver: owner,
      action: {
        kind: "end",
        receiverId: "rx-1",
        frames: 2,
        bytes: 8,
        sha256: "expected",
      },
    });

    expect(result).toEqual({
      ok: true,
      receiver: owner,
      done: true,
      bytes: 8,
      sha256: "expected",
    });
  });

  it("rejects end input frame-count mismatches", () => {
    const result = applyReceiverFrame({
      receiver: receiver({ nextSeq: 2, bytesReceived: 8 }),
      action: {
        kind: "end",
        receiverId: "rx-1",
        frames: 1,
        bytes: 8,
        sha256: "expected",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "RECEIVER_SEQ_MISMATCH",
    });
  });

  it("rejects end input byte mismatches", () => {
    const result = applyReceiverFrame({
      receiver: receiver({ nextSeq: 2, bytesReceived: 8 }),
      action: {
        kind: "end",
        receiverId: "rx-1",
        frames: 2,
        bytes: 7,
        sha256: "expected",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "RECEIVER_BYTES_MISMATCH",
    });
  });

  it("rejects end input expected sha mismatches", () => {
    const result = applyReceiverFrame({
      receiver: receiver({ nextSeq: 2, bytesReceived: 8 }),
      action: {
        kind: "end",
        receiverId: "rx-1",
        frames: 2,
        bytes: 8,
        sha256: "actual",
      },
    });

    expect(result).toMatchObject({
      ok: false,
      code: "RECEIVER_HASH_MISMATCH",
    });
  });
});
