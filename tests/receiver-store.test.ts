import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReceiverStore } from "../src/receiver/store.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

function makeStore(): ReceiverStore {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "receiver-store-"));
  tmpDirs.push(rootDir);
  return new ReceiverStore({
    rootDir,
    nowIso: () => "2026-05-27T00:00:00.000Z",
    newId: () => "rx-1",
  });
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

describe("ReceiverStore", () => {
  it("starts a receiver and emits a ready marker", () => {
    const store = makeStore();
    const result = store.start({
      promptNonce: "nonce",
      commandLine: "tiny-agent receiver start",
      maxFrameBytes: 4096,
      target: { kind: "file", path: "out.txt" },
    });

    expect(result.state).toMatchObject({
      receiverId: "rx-1",
      nextSeq: 0,
      bytesReceived: 0,
      target: { kind: "file", path: "out.txt" },
    });
    expect(result.readyMarker).toContain("__TAH_RECEIVER_READY__");
    expect(result.readyMarker).toContain("id=rx-1");
    expect(fs.existsSync(result.state.payloadFile)).toBe(true);
  });

  it("appends valid frames and finalizes matching payloads", () => {
    const store = makeStore();
    store.start({
      receiverId: "rx-1",
      promptNonce: "nonce",
      commandLine: "receiver start",
      maxFrameBytes: 4096,
      expectedSha256: sha256("hello world"),
      target: { kind: "file", path: "out.txt" },
    });

    const afterFirst = store.appendFrame({
      receiverId: "rx-1",
      seq: 0,
      dataBase64: Buffer.from("hello ").toString("base64"),
    });
    expect(afterFirst).toMatchObject({ nextSeq: 1, bytesReceived: 6 });

    const afterSecond = store.appendFrame({
      receiverId: "rx-1",
      seq: 1,
      dataBase64: Buffer.from("world").toString("base64"),
    });
    expect(afterSecond).toMatchObject({ nextSeq: 2, bytesReceived: 11 });

    const finalized = store.finalize({
      receiverId: "rx-1",
      frames: 2,
      bytes: 11,
      sha256: sha256("hello world"),
    });

    expect(finalized.bytes.toString("utf8")).toBe("hello world");
    expect(finalized.sha256).toBe(sha256("hello world"));
    expect(finalized.state.finalizedAt).toBe("2026-05-27T00:00:00.000Z");
  });

  it("rejects sequence mismatches before appending bytes", () => {
    const store = makeStore();
    const started = store.start({
      receiverId: "rx-1",
      promptNonce: "nonce",
      commandLine: "receiver start",
      maxFrameBytes: 4096,
      target: { kind: "file", path: "out.txt" },
    });

    expect(() =>
      store.appendFrame({
        receiverId: "rx-1",
        seq: 1,
        dataBase64: Buffer.from("bad").toString("base64"),
      }),
    ).toThrow("RECEIVER_SEQ_MISMATCH");
    expect(fs.readFileSync(started.state.payloadFile)).toHaveLength(0);
  });

  it("rejects invalid base64 before appending bytes", () => {
    const store = makeStore();
    const started = store.start({
      receiverId: "rx-1",
      promptNonce: "nonce",
      commandLine: "receiver start",
      maxFrameBytes: 4096,
      target: { kind: "file", path: "out.txt" },
    });

    expect(() =>
      store.appendFrame({
        receiverId: "rx-1",
        seq: 0,
        dataBase64: "not base64",
      }),
    ).toThrow("RECEIVER_INVALID_BASE64");
    expect(fs.readFileSync(started.state.payloadFile)).toHaveLength(0);
  });

  it("rejects finalize hash mismatches without marking finalized", () => {
    const store = makeStore();
    store.start({
      receiverId: "rx-1",
      promptNonce: "nonce",
      commandLine: "receiver start",
      maxFrameBytes: 4096,
      target: { kind: "file", path: "out.txt" },
    });
    store.appendFrame({
      receiverId: "rx-1",
      seq: 0,
      dataBase64: Buffer.from("hello").toString("base64"),
    });

    expect(() =>
      store.finalize({
        receiverId: "rx-1",
        frames: 1,
        bytes: 5,
        sha256: sha256("other"),
      }),
    ).toThrow("RECEIVER_HASH_MISMATCH");
    expect(store.readState("rx-1").finalizedAt).toBeUndefined();
  });
});
