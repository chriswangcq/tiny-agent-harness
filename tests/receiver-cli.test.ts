import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runReceiver } from "../src/cli/receiver.js";

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function createTmpDir(): string {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "receiver-cli-"));
  return tmpDir;
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

async function* stdinLines(lines: string[]): AsyncIterable<string> {
  for (const line of lines) {
    yield line;
  }
}

function captureStdout(): {
  stdout: { write(chunk: string): void };
  output: () => string;
} {
  const chunks: string[] = [];
  return {
    stdout: {
      write(chunk: string): void {
        chunks.push(chunk);
      },
    },
    output: () => chunks.join(""),
  };
}

function receiverInputLines(payload: Buffer, maxBase64Bytes: number, hash: string): string[] {
  const frames = splitForBase64FrameLimit(payload, maxBase64Bytes);
  return [
    ...frames.map((frame) => `${frame.toString("base64")}\n`),
    `__TAH_RECEIVER_END__ frames=${frames.length} bytes=${payload.byteLength} sha256=${hash}\n`,
  ];
}

function readOutbox(stateDir: string, channel: string): Record<string, unknown>[] {
  const outboxPath = path.join(stateDir, "im", `${channel}.outbox.jsonl`);
  if (!fs.existsSync(outboxPath)) {
    return [];
  }
  return fs
    .readFileSync(outboxPath, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("runReceiver CLI", () => {
  it("commits a multi-frame file payload from PTY stdin", async () => {
    const stateDir = createTmpDir();
    const outPath = path.join(stateDir, "nested", "snake.html");
    const payload = [
      "<!DOCTYPE html>",
      "<meta charset=\"utf-8\">",
      "<script>",
      "const text = 'emoji ok: 你好';",
      "console.log(text);",
      "</script>",
      "```js",
      "console.log('markdown code fence survives');",
      "```",
    ]
      .join("\n")
      .repeat(90);
    const bytes = Buffer.from(payload, "utf8");
    const hash = sha256(bytes);
    const captured = captureStdout();

    await runReceiver(
      [
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
        "4000",
        "--sha256",
        hash,
        "--state-dir",
        stateDir,
      ],
      {
        stdin: stdinLines(receiverInputLines(bytes, 4000, hash)),
        stdout: captured.stdout,
      },
    );

    const output = captured.output();
    expect(output).toContain("__TAH_RECEIVER_READY__");
    expect(output).toContain("__TAH_RECEIVER_ACK__");
    expect(output).toContain("__TAH_RECEIVER_DONE__");
    expect(output).toContain(`sha256=${hash}`);
    expect(fs.readFileSync(outPath, "utf8")).toBe(payload);
  });

  it("commits a validated multi-frame payload to the IM outbox from PTY stdin", async () => {
    const stateDir = createTmpDir();
    const payload = [
      "回复正文",
      "```ts",
      "export const answer = 'large IM payload';",
      "```",
      "emoji: 你好",
    ]
      .join("\n")
      .repeat(120);
    const bytes = Buffer.from(payload, "utf8");
    const hash = sha256(bytes);
    const captured = captureStdout();

    await runReceiver(
      [
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
        "4000",
        "--sha256",
        hash,
        "--state-dir",
        stateDir,
      ],
      {
        stdin: stdinLines(receiverInputLines(bytes, 4000, hash)),
        stdout: captured.stdout,
      },
    );

    const output = captured.output();
    expect(output).toContain("__TAH_RECEIVER_READY__");
    expect(output).toContain("__TAH_RECEIVER_DONE__");
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

  it("does not commit the target when final hash validation fails", async () => {
    const stateDir = createTmpDir();
    const outPath = path.join(stateDir, "bad.txt");
    const payload = Buffer.from("hello world", "utf8");
    const badHash = sha256("different");

    await expect(
      runReceiver(
        [
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
          "4000",
          "--state-dir",
          stateDir,
        ],
        {
          stdin: stdinLines(receiverInputLines(payload, 4000, badHash)),
          stdout: captureStdout().stdout,
        },
      ),
    ).rejects.toThrow("RECEIVER_HASH_MISMATCH");
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it("rejects malformed stdin frames without committing a target", async () => {
    const stateDir = createTmpDir();
    const outPath = path.join(stateDir, "bad-frame.txt");

    await expect(
      runReceiver(
        [
          "start",
          "--target",
          "file",
          "--path",
          outPath,
          "--id",
          "rx-frame-bad",
          "--nonce",
          "nonce-1",
          "--max-frame-bytes",
          "4000",
          "--state-dir",
          stateDir,
        ],
        {
          stdin: stdinLines([
            "not base64\n",
            "__TAH_RECEIVER_END__ frames=1 bytes=10 sha256=bad\n",
          ]),
          stdout: captureStdout().stdout,
        },
      ),
    ).rejects.toThrow("RECEIVER_INVALID_BASE64");
    expect(fs.existsSync(outPath)).toBe(false);
  });

  it("rejects json output because receiver start is parsed from PTY markers", async () => {
    const stateDir = createTmpDir();

    await expect(
      runReceiver(
        [
          "start",
          "--target",
          "file",
          "--path",
          path.join(stateDir, "out.txt"),
          "--id",
          "rx-json",
          "--nonce",
          "nonce-1",
          "--max-frame-bytes",
          "4000",
          "--state-dir",
          stateDir,
          "--json",
        ],
        {
          stdin: stdinLines([]),
          stdout: captureStdout().stdout,
        },
      ),
    ).rejects.toThrow("--json is not supported");
  });
});
