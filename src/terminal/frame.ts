import type { ReceiverOwner, TerminalErrorCode, ValidationResult } from "./types.js";

export type ReceiverFrameLimits = {
  maxFrameBytes: number;
};

export type ReceiverFrameAction =
  | {
      kind: "frame";
      receiverId: string;
      seq: number;
      dataBase64: string;
    }
  | {
      kind: "end";
      receiverId: string;
      frames: number;
      bytes: number;
      sha256: string;
    };

export type ReceiverFrameResult =
  | {
      ok: true;
      receiver: ReceiverOwner;
      done: false;
      decodedBytes: number;
    }
  | {
      ok: true;
      receiver: ReceiverOwner;
      done: true;
      bytes: number;
      sha256: string;
    }
  | Extract<ValidationResult, { ok: false }>;

export function applyReceiverFrame(input: {
  receiver: ReceiverOwner;
  action: ReceiverFrameAction;
  limits?: Partial<ReceiverFrameLimits>;
}): ReceiverFrameResult {
  const limits = {
    maxFrameBytes: input.receiver.maxFrameBytes,
    ...input.limits,
  };

  if (input.action.receiverId !== input.receiver.receiverId) {
    return reject(
      input.receiver,
      "OWNER_REJECTED",
      `Receiver id mismatch: expected ${input.receiver.receiverId}, got ${input.action.receiverId}.`,
    );
  }

  if (input.action.kind === "frame") {
    return applyInputFrame(input.receiver, input.action, limits);
  }

  return applyEndInput(input.receiver, input.action);
}

function applyInputFrame(
  receiver: ReceiverOwner,
  action: Extract<ReceiverFrameAction, { kind: "frame" }>,
  limits: ReceiverFrameLimits,
): ReceiverFrameResult {
  if (action.seq !== receiver.nextSeq) {
    return reject(
      receiver,
      "RECEIVER_SEQ_MISMATCH",
      `Expected receiver frame seq ${receiver.nextSeq}, got ${action.seq}.`,
    );
  }

  if (asciiBytes(action.dataBase64) > limits.maxFrameBytes) {
    return reject(receiver, "RECEIVER_FRAME_TOO_LARGE", "Receiver frame exceeds maxFrameBytes.");
  }

  const decodedBytes = decodedBase64Bytes(action.dataBase64);
  if (decodedBytes === undefined) {
    return reject(receiver, "RECEIVER_INVALID_BASE64", "Receiver frame is not valid base64.");
  }

  return {
    ok: true,
    receiver: {
      ...receiver,
      nextSeq: receiver.nextSeq + 1,
      bytesReceived: receiver.bytesReceived + decodedBytes,
    },
    done: false,
    decodedBytes,
  };
}

function applyEndInput(
  receiver: ReceiverOwner,
  action: Extract<ReceiverFrameAction, { kind: "end" }>,
): ReceiverFrameResult {
  if (action.frames !== receiver.nextSeq) {
    return reject(
      receiver,
      "RECEIVER_SEQ_MISMATCH",
      `Expected ${receiver.nextSeq} frame(s), got ${action.frames}.`,
    );
  }

  if (action.bytes !== receiver.bytesReceived) {
    return reject(
      receiver,
      "RECEIVER_BYTES_MISMATCH",
      `Expected ${receiver.bytesReceived} byte(s), got ${action.bytes}.`,
    );
  }

  if (receiver.expectedSha256 !== undefined && action.sha256 !== receiver.expectedSha256) {
    return reject(receiver, "RECEIVER_HASH_MISMATCH", "Receiver sha256 does not match.");
  }

  return {
    ok: true,
    receiver,
    done: true,
    bytes: action.bytes,
    sha256: action.sha256,
  };
}

function decodedBase64Bytes(value: string): number | undefined {
  if (value.length === 0) {
    return 0;
  }

  if (value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)) {
    return undefined;
  }

  const firstPadding = value.indexOf("=");
  if (firstPadding !== -1 && !/^=+$/u.test(value.slice(firstPadding))) {
    return undefined;
  }

  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

function asciiBytes(value: string): number {
  return value.length;
}

function reject(
  receiver: ReceiverOwner,
  code: TerminalErrorCode,
  message: string,
): Extract<ValidationResult, { ok: false }> {
  return { ok: false, code, message, owner: receiver };
}
