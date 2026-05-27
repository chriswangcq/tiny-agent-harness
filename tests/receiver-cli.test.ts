import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runReceiver } from "../src/cli/receiver.js";

let tmpDir: string | undefined;
let originalWrite: typeof process.stdout.write | undefined;
let captured: string[] = [];

afterEach(() => {
  if (originalWrite) {
    process.stdout.write = originalWrite;
    originalWrite = undefined;
  }
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
  captured = [];
});

function createTmpDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "receiver-cli-"));
  return tmpDir;
}

function captureStdout(): void {
  captured = [];
  originalWrite ??= process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
    return true;
  }) as typeof process.stdout.write;
}

function stdoutJson(): Record<string, unknown> {
  return JSON.parse(captured.join("")) as Record<string, unknown>;
}

function sha256(bytes: string | Buffer): string {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function splitForBase64FrameLimit(bytes: Buffer, maxBase64Bytes: number): Buffer[] {
  const decodedChunkBytes = Math.floor(maxBase64Bytes / 4) * 3;
  const frames: Buffer[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += decodedChunkBytes) {
    frames.push(bytes.subarray(offset, offset + decodedChunkBytes));
  }
  return frames;
}

function readOutbox(stateDir: string, channel: string): Record<string, unknown>[] {
  const outboxPath = path.join(stateDir, "im", `${channel}.outbox.jsonl`);
  if (!fs.existsSync(outboxPath)) {
    return [];
  }
  return fs.readFileSync(outboxPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("runReceiver CLI", () => {
  it("commits a multi-frame file payload after validation", async () => {
    const stateDir = createTmpDir();
    const outPath = path.join(stateDir, "nested", "snake.html");
    const payload = [
      "<!DOCTYPE html>",
      "<meta charset=\"utf-8\">",
      "<script>",
      "const text = 'emoji ok: 你好 🌊';",
      "console.log(text);",
      "</script>",
      "```js",
      "console.log('markdown code fence survives');",
      "```",
    ].join("\n").repeat(90);
    const bytes = Buffer.from(payload, "utf8");
    const hash = sha256(bytes);

    captureStdout();
    await runReceiver([
      "start",
      "--target",
      "file",
      "--path",
      outPath,
      "--id",
      "rx-file",
      "--nonce",
      "nonce-1",
      "--command-line",
      "node dist/cli/main.js receiver start",
      "--max-frame-bytes",
      "8192",
      "--sha256",
      hash,
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(stdoutJson()).toMatchObject({
      ok: true,
      receiverId: "rx-file",
      readyMarker: expect.stringContaining("__TAH_RECEIVER_READY__"),
    });

    const frames = splitForBase64FrameLimit(bytes, 8192);
    for (const [seq, frame] of frames.entries()) {
      captureStdout();
      await runReceiver([
        "frame",
        "--id",
        "rx-file",
        "--seq",
        String(seq),
        "--data-base64",
        frame.toString("base64"),
        "--state-dir",
        stateDir,
        "--json",
      ]);
      expect(stdoutJson()).toMatchObject({
        ok: true,
        receiverId: "rx-file",
        seq,
        ackMarker: expect.stringContaining("__TAH_RECEIVER_ACK__"),
      });
    }

    captureStdout();
    await runReceiver([
      "end",
      "--id",
      "rx-file",
      "--frames",
      String(frames.length),
      "--bytes",
      String(bytes.byteLength),
      "--sha256",
      hash,
      "--state-dir",
      stateDir,
      "--json",
    ]);

    expect(stdoutJson()).toMatchObject({
      ok: true,
      receiverId: "rx-file",
      destinationPath: outPath,
      bytes: bytes.byteLength,
      sha256: hash,
      doneMarker: expect.stringContaining("__TAH_RECEIVER_DONE__"),
    });
    expect(fs.readFileSync(outPath, "utf8")).toBe(payload);
  });

  it("does not commit the file target when final hash validation fails", async () => {
    const stateDir = createTmpDir();
    const outPath = path.join(stateDir, "bad.txt");
    const payload = Buffer.from("hello world", "utf8");

    captureStdout();
    await runReceiver([
      "start",
      "--target",
      "file",
      "--path",
      outPath,
      "--id",
      "rx-bad",
      "--nonce",
      "nonce-1",
      "--max-frame-bytes",
      "4096",
      "--state-dir",
      stateDir,
      "--json",
    ]);

    captureStdout();
    await runReceiver([
      "frame",
      "--id",
      "rx-bad",
      "--seq",
      "0",
      "--data-base64",
      payload.toString("base64"),
      "--state-dir",
      stateDir,
      "--json",
    ]);

    await expect(
      runReceiver([
        "end",
        "--id",
        "rx-bad",
        "--frames",
        "1",
        "--bytes",
        String(payload.byteLength),
        "--sha256",
        sha256("different"),
        "--state-dir",
        stateDir,
        "--json",
      ]),
    ).rejects.toThrow("RECEIVER_HASH_MISMATCH");
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it("commits a validated multi-frame payload to the IM outbox", async () => {
    const stateDir = createTmpDir();
    const payload = [
      "回复正文",
      "```ts",
      "export const answer = 'large IM payload';",
      "```",
      "emoji: 你好 🌊",
    ].join("\n").repeat(120);
    const bytes = Buffer.from(payload, "utf8");
    const hash = sha256(bytes);

    captureStdout();
    await runReceiver([
      "start",
      "--target",
      "im",
      "--channel",
      "default",
      "--kind",
      "status",
      "--run-id",
      "run-1",
      "--id",
      "rx-im",
      "--nonce",
      "nonce-1",
      "--max-frame-bytes",
      "8192",
      "--sha256",
      hash,
      "--state-dir",
      stateDir,
      "--json",
    ]);
    expect(stdoutJson()).toMatchObject({
      ok: true,
      receiverId: "rx-im",
      target: {
        kind: "im",
        channel: "default",
        messageKind: "status",
        runId: "run-1",
      },
    });

    const frames = splitForBase64FrameLimit(bytes, 8192);
    for (const [seq, frame] of frames.entries()) {
      captureStdout();
      await runReceiver([
        "frame",
        "--id",
        "rx-im",
        "--seq",
        String(seq),
        "--data-base64",
        frame.toString("base64"),
        "--state-dir",
        stateDir,
        "--json",
      ]);
    }

    captureStdout();
    await runReceiver([
      "end",
      "--id",
      "rx-im",
      "--frames",
      String(frames.length),
      "--bytes",
      String(bytes.byteLength),
      "--sha256",
      hash,
      "--state-dir",
      stateDir,
      "--json",
    ]);

    expect(stdoutJson()).toMatchObject({
      ok: true,
      receiverId: "rx-im",
      channel: "default",
      kind: "status",
      runId: "run-1",
      bytes: bytes.byteLength,
      sha256: hash,
    });
    const messages = readOutbox(stateDir, "default");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      channel: "default",
      role: "agent",
      kind: "status",
      text: payload,
      runId: "run-1",
      metadata: {
        receiverId: "rx-im",
        sha256: hash,
        bytes: String(bytes.byteLength),
      },
    });
  });

  it("does not commit an IM outbox message when final hash validation fails", async () => {
    const stateDir = createTmpDir();
    const payload = Buffer.from("hello IM", "utf8");

    captureStdout();
    await runReceiver([
      "start",
      "--target",
      "im",
      "--channel",
      "default",
      "--kind",
      "status",
      "--id",
      "rx-im-bad",
      "--nonce",
      "nonce-1",
      "--max-frame-bytes",
      "4096",
      "--state-dir",
      stateDir,
      "--json",
    ]);

    captureStdout();
    await runReceiver([
      "frame",
      "--id",
      "rx-im-bad",
      "--seq",
      "0",
      "--data-base64",
      payload.toString("base64"),
      "--state-dir",
      stateDir,
      "--json",
    ]);

    await expect(
      runReceiver([
        "end",
        "--id",
        "rx-im-bad",
        "--frames",
        "1",
        "--bytes",
        String(payload.byteLength),
        "--sha256",
        sha256("different"),
        "--state-dir",
        stateDir,
        "--json",
      ]),
    ).rejects.toThrow("RECEIVER_HASH_MISMATCH");
    expect(readOutbox(stateDir, "default")).toHaveLength(0);
  });

  it("rejects sequence mismatches without committing a target", async () => {
    const stateDir = createTmpDir();
    const outPath = path.join(stateDir, "seq.txt");

    captureStdout();
    await runReceiver([
      "start",
      "--target",
      "file",
      "--path",
      outPath,
      "--id",
      "rx-seq",
      "--nonce",
      "nonce-1",
      "--max-frame-bytes",
      "4096",
      "--state-dir",
      stateDir,
      "--json",
    ]);

    await expect(
      runReceiver([
        "frame",
        "--id",
        "rx-seq",
        "--seq",
        "1",
        "--data-base64",
        Buffer.from("out of order").toString("base64"),
        "--state-dir",
        stateDir,
        "--json",
      ]),
    ).rejects.toThrow("RECEIVER_SEQ_MISMATCH");
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it("rejects oversized frames without committing a target", async () => {
    const stateDir = createTmpDir();
    const outPath = path.join(stateDir, "oversized.txt");

    captureStdout();
    await runReceiver([
      "start",
      "--target",
      "file",
      "--path",
      outPath,
      "--id",
      "rx-oversized",
      "--nonce",
      "nonce-1",
      "--max-frame-bytes",
      "4",
      "--state-dir",
      stateDir,
      "--json",
    ]);

    await expect(
      runReceiver([
        "frame",
        "--id",
        "rx-oversized",
        "--seq",
        "0",
        "--data-base64",
        Buffer.from("hello").toString("base64"),
        "--state-dir",
        stateDir,
        "--json",
      ]),
    ).rejects.toThrow("RECEIVER_FRAME_TOO_LARGE");
    expect(fs.existsSync(outPath)).toBe(false);
  });
});
