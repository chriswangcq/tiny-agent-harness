import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { formatReceiverReadyMarker } from "../application/managed-shell.js";
import { applyReceiverFrame } from "../terminal/frame.js";
import type { ReceiverMode, ReceiverOwner } from "../terminal/types.js";

export type ReceiverTarget =
  | { kind: "file"; path: string }
  | { kind: "im"; channel: string; messageKind: "status" | "error"; runId?: string };

export type ReceiverState = {
  version: 1;
  receiverId: string;
  promptNonce: string;
  commandLine: string;
  mode: ReceiverMode;
  maxFrameBytes: number;
  nextSeq: number;
  bytesReceived: number;
  expectedSha256?: string;
  target: ReceiverTarget;
  payloadFile: string;
  createdAt: string;
  finalizedAt?: string;
};

export type ReceiverStartInput = {
  receiverId?: string;
  promptNonce: string;
  commandLine: string;
  mode?: ReceiverMode;
  maxFrameBytes: number;
  expectedSha256?: string;
  target: ReceiverTarget;
};

export type ReceiverStartResult = {
  state: ReceiverState;
  readyMarker: string;
};

export type ReceiverFinalizeResult = {
  state: ReceiverState;
  payloadPath: string;
  bytes: Buffer;
  sha256: string;
};

export class ReceiverStore {
  constructor(
    private readonly options: {
      rootDir: string;
      nowIso?: () => string;
      newId?: () => string;
    },
  ) {}

  start(input: ReceiverStartInput): ReceiverStartResult {
    const receiverId = input.receiverId ?? this.newReceiverId();
    assertSafeReceiverId(receiverId);
    const dir = this.receiverDir(receiverId);
    if (fs.existsSync(dir)) {
      throw new Error(`receiver already exists: ${receiverId}`);
    }

    fs.mkdirSync(dir, { recursive: true });
    const payloadFile = path.join(dir, "payload.bin");
    fs.writeFileSync(payloadFile, "");

    const state: ReceiverState = {
      version: 1,
      receiverId,
      promptNonce: input.promptNonce,
      commandLine: input.commandLine,
      mode: input.mode ?? "base64",
      maxFrameBytes: input.maxFrameBytes,
      nextSeq: 0,
      bytesReceived: 0,
      expectedSha256: input.expectedSha256,
      target: input.target,
      payloadFile,
      createdAt: this.nowIso(),
    };
    this.writeState(state);

    return {
      state,
      readyMarker: formatReceiverReadyMarker({
        nonce: state.promptNonce,
        receiverId: state.receiverId,
        mode: state.mode,
        maxFrameBytes: state.maxFrameBytes,
        nextSeq: state.nextSeq,
        commandLine: state.commandLine,
        bytesReceived: state.bytesReceived,
        expectedSha256: state.expectedSha256,
      }),
    };
  }

  appendFrame(input: {
    receiverId: string;
    seq: number;
    dataBase64: string;
  }): ReceiverState {
    const state = this.readState(input.receiverId);
    const validation = applyReceiverFrame({
      receiver: toReceiverOwner(state),
      action: {
        kind: "frame",
        receiverId: input.receiverId,
        seq: input.seq,
        dataBase64: input.dataBase64,
      },
      limits: { maxFrameBytes: state.maxFrameBytes },
    });
    if (!validation.ok) {
      throw new Error(`${validation.code}: ${validation.message}`);
    }
    if (validation.done) {
      throw new Error("unexpected receiver done result for input frame");
    }

    const decoded = Buffer.from(input.dataBase64, "base64");
    fs.appendFileSync(state.payloadFile, decoded);
    const nextState: ReceiverState = {
      ...state,
      nextSeq: validation.receiver.nextSeq,
      bytesReceived: validation.receiver.bytesReceived,
    };
    this.writeState(nextState);
    return nextState;
  }

  finalize(input: {
    receiverId: string;
    frames: number;
    bytes: number;
    sha256: string;
  }): ReceiverFinalizeResult {
    const state = this.readState(input.receiverId);
    const validation = applyReceiverFrame({
      receiver: toReceiverOwner(state),
      action: {
        kind: "end",
        receiverId: input.receiverId,
        frames: input.frames,
        bytes: input.bytes,
        sha256: input.sha256,
      },
    });
    if (!validation.ok) {
      throw new Error(`${validation.code}: ${validation.message}`);
    }

    const bytes = fs.readFileSync(state.payloadFile);
    const actualSha = sha256(bytes);
    if (actualSha !== input.sha256) {
      throw new Error(
        `RECEIVER_HASH_MISMATCH: payload sha256 ${actualSha} does not match ${input.sha256}`,
      );
    }

    const nextState: ReceiverState = {
      ...state,
      finalizedAt: this.nowIso(),
    };
    this.writeState(nextState);
    return {
      state: nextState,
      payloadPath: state.payloadFile,
      bytes,
      sha256: actualSha,
    };
  }

  readState(receiverId: string): ReceiverState {
    assertSafeReceiverId(receiverId);
    const statePath = path.join(this.receiverDir(receiverId), "state.json");
    return JSON.parse(fs.readFileSync(statePath, "utf8")) as ReceiverState;
  }

  private writeState(state: ReceiverState): void {
    const dir = this.receiverDir(state.receiverId);
    fs.mkdirSync(dir, { recursive: true });
    atomicWriteFile(path.join(dir, "state.json"), `${JSON.stringify(state, null, 2)}\n`);
  }

  private receiverDir(receiverId: string): string {
    assertSafeReceiverId(receiverId);
    return path.join(this.options.rootDir, receiverId);
  }

  private nowIso(): string {
    return this.options.nowIso?.() ?? new Date().toISOString();
  }

  private newReceiverId(): string {
    return this.options.newId?.() ?? `rx-${crypto.randomBytes(6).toString("hex")}`;
  }
}

function toReceiverOwner(state: ReceiverState): ReceiverOwner {
  return {
    kind: "receiver",
    revision: 0,
    receiverId: state.receiverId,
    commandLine: state.commandLine,
    mode: state.mode,
    nextSeq: state.nextSeq,
    bytesReceived: state.bytesReceived,
    maxFrameBytes: state.maxFrameBytes,
    expectedSha256: state.expectedSha256,
  };
}

function assertSafeReceiverId(receiverId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(receiverId) || receiverId.includes("..")) {
    throw new Error(`invalid receiver id: ${receiverId}`);
  }
}

function sha256(bytes: Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function atomicWriteFile(filePath: string, content: string): void {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tempPath, content, "utf8");
  fs.renameSync(tempPath, filePath);
}
