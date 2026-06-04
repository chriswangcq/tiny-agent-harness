import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Readable } from "node:stream";
import { ImCliTransport } from "../src/im/transport.js";
import { runIm } from "../src/cli/im.js";

describe("ImCliTransport", () => {
  let tmpDir: string;

  function createBaseDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-test-"));
    return tmpDir;
  }

  afterEach(() => {
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("post writes to inbox and receive reads it", async () => {
    const baseDir = createBaseDir();
    const transport = new ImCliTransport({ baseDir });

    await transport.post({
      id: "msg-001",
      channel: "default",
      role: "user",
      text: "hello",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await transport.receive({ channel: "default" });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.id).toBe("msg-001");
    expect(result.messages[0]!.text).toBe("hello");
    expect(result.nextCursor).toBe("msg-001");
  });

  it("receive with cursor returns only newer messages", async () => {
    const baseDir = createBaseDir();
    const transport = new ImCliTransport({ baseDir });

    await transport.post({
      id: "msg-001",
      channel: "default",
      role: "user",
      text: "first",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await transport.post({
      id: "msg-002",
      channel: "default",
      role: "user",
      text: "second",
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    const result = await transport.receive({
      channel: "default",
      cursor: "msg-001",
    });
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]!.id).toBe("msg-002");
  });

  it("send writes to outbox", async () => {
    const baseDir = createBaseDir();
    const transport = new ImCliTransport({ baseDir });

    await transport.send({
      channel: "default",
      role: "agent",
      kind: "status",
      text: "done",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const outboxPath = path.join(baseDir, "default.outbox.jsonl");
    expect(fs.existsSync(outboxPath)).toBe(true);
    const content = fs.readFileSync(outboxPath, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.kind).toBe("status");
    expect(parsed.text).toBe("done");
  });

  it("ack writes cursor file", async () => {
    const baseDir = createBaseDir();
    const transport = new ImCliTransport({ baseDir });

    await transport.ack({ channel: "default", messageId: "msg-001" });

    const cursorPath = path.join(baseDir, "cursors", "default.cursor");
    expect(fs.existsSync(cursorPath)).toBe(true);
    expect(fs.readFileSync(cursorPath, "utf-8")).toBe("msg-001");
  });

  it("pollNewMessages returns filtered messages", async () => {
    const baseDir = createBaseDir();
    const transport = new ImCliTransport({ baseDir });

    await transport.post({
      id: "msg-001",
      channel: "test",
      role: "user",
      text: "a",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await transport.post({
      id: "msg-002",
      channel: "test",
      role: "user",
      text: "b",
      createdAt: "2026-01-01T00:00:01.000Z",
    });

    const msgs = await transport.pollNewMessages({
      channel: "test",
      cursor: "msg-001",
    });
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.text).toBe("b");
  });

  it("receive on empty channel returns empty array", async () => {
    const baseDir = createBaseDir();
    const transport = new ImCliTransport({ baseDir });

    const result = await transport.receive({ channel: "empty" });
    expect(result.messages).toHaveLength(0);
    expect(result.nextCursor).toBeUndefined();
  });

  it("multiple channels are isolated", async () => {
    const baseDir = createBaseDir();
    const transport = new ImCliTransport({ baseDir });

    await transport.post({
      id: "msg-a",
      channel: "alpha",
      role: "user",
      text: "alpha-msg",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    await transport.post({
      id: "msg-b",
      channel: "beta",
      role: "user",
      text: "beta-msg",
      createdAt: "2026-01-01T00:00:00.000Z",
    });

    const alpha = await transport.receive({ channel: "alpha" });
    const beta = await transport.receive({ channel: "beta" });
    expect(alpha.messages).toHaveLength(1);
    expect(alpha.messages[0]!.text).toBe("alpha-msg");
    expect(beta.messages).toHaveLength(1);
    expect(beta.messages[0]!.text).toBe("beta-msg");
  });
});

describe("runIm CLI", () => {
  let tmpDir: string;
  let originalWrite: typeof process.stdout.write;
  let captured: string[];
  let originalTahStateDir: string | undefined;
  let originalTahImDir: string | undefined;

  function createStateDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-cli-test-"));
    fs.mkdirSync(path.join(tmpDir, "im"), { recursive: true });
    return tmpDir;
  }

  function createLatestRun(stateDir: string, runId = "run-test"): string {
    const runDir = path.join(stateDir, "runs", runId);
    fs.mkdirSync(path.join(runDir, "im"), { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "runs", "latest.json"),
      JSON.stringify({ runId, runDir: path.join("runs", runId) }),
      "utf-8",
    );
    return runDir;
  }

  function readInbox(baseDir: string, channel: string): Array<{ text: string }> {
    const filePath = path.join(baseDir, `${channel}.inbox.jsonl`);
    return fs
      .readFileSync(filePath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { text: string });
  }

  function useTahStateDir(stateDir: string): void {
    originalTahStateDir = process.env.TAH_STATE_DIR;
    originalTahImDir = process.env.TAH_IM_DIR;
    process.env.TAH_STATE_DIR = stateDir;
    delete process.env.TAH_IM_DIR;
  }

  function captureStdout(): void {
    captured = [];
    originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
  }

  function restoreStdout(): void {
    process.stdout.write = originalWrite;
  }

  afterEach(() => {
    if (originalWrite) restoreStdout();
    if (originalTahStateDir === undefined) {
      delete process.env.TAH_STATE_DIR;
    } else {
      process.env.TAH_STATE_DIR = originalTahStateDir;
    }
    if (originalTahImDir === undefined) {
      delete process.env.TAH_IM_DIR;
    } else {
      process.env.TAH_IM_DIR = originalTahImDir;
    }
    originalTahStateDir = undefined;
    originalTahImDir = undefined;
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("post + recv roundtrip with --json", async () => {
    const stateDir = createStateDir();

    captureStdout();
    await runIm(["post", "--channel", "default", "--text", "hello world", "--state-dir", stateDir, "--json"]);
    restoreStdout();

    const postResult = JSON.parse(captured.join(""));
    expect(postResult.ok).toBe(true);
    expect(postResult.channel).toBe("default");

    captureStdout();
    await runIm(["recv", "--channel", "default", "--state-dir", stateDir, "--json"]);
    restoreStdout();

    const recvResult = JSON.parse(captured.join(""));
    expect(recvResult.ok).toBe(true);
    expect(recvResult.count).toBe(1);
    expect(recvResult.messages[0].text).toBe("hello world");
  });

  it("post without explicit state dir targets the latest run inbox", async () => {
    const stateDir = createStateDir();
    const runDir = createLatestRun(stateDir, "run-latest");
    useTahStateDir(stateDir);

    captureStdout();
    await runIm(["post", "--channel", "default", "--text", "hello latest", "--json"]);
    restoreStdout();

    const postResult = JSON.parse(captured.join(""));
    expect(postResult.ok).toBe(true);
    expect(postResult.target).toBe("run");
    expect(postResult.runId).toBe("run-latest");
    expect(readInbox(path.join(runDir, "im"), "default")[0].text).toBe(
      "hello latest",
    );
    expect(fs.existsSync(path.join(stateDir, "im", "default.inbox.jsonl"))).toBe(
      false,
    );
  });

  it("--run latest post targets the latest run inbox", async () => {
    const stateDir = createStateDir();
    const runDir = createLatestRun(stateDir, "run-explicit-latest");
    useTahStateDir(stateDir);

    captureStdout();
    await runIm([
      "post",
      "--channel",
      "default",
      "--text",
      "hello run latest",
      "--run",
      "latest",
      "--json",
    ]);
    restoreStdout();

    const postResult = JSON.parse(captured.join(""));
    expect(postResult.target).toBe("run");
    expect(postResult.runId).toBe("run-explicit-latest");
    expect(readInbox(path.join(runDir, "im"), "default")[0].text).toBe(
      "hello run latest",
    );
  });

  it("post without latest run falls back to global state inbox", async () => {
    const stateDir = createStateDir();
    useTahStateDir(stateDir);

    captureStdout();
    await runIm(["post", "--channel", "default", "--text", "hello global", "--json"]);
    restoreStdout();

    const postResult = JSON.parse(captured.join(""));
    expect(postResult.target).toBe("global_state");
    expect(postResult.runId).toBeUndefined();
    expect(readInbox(path.join(stateDir, "im"), "default")[0].text).toBe(
      "hello global",
    );
  });

  it("explicit --state-dir keeps the global state inbox even when latest exists", async () => {
    const stateDir = createStateDir();
    const runDir = createLatestRun(stateDir, "run-ignored");

    captureStdout();
    await runIm([
      "post",
      "--channel",
      "default",
      "--text",
      "hello explicit",
      "--state-dir",
      stateDir,
      "--json",
    ]);
    restoreStdout();

    const postResult = JSON.parse(captured.join(""));
    expect(postResult.target).toBe("explicit_state");
    expect(postResult.runId).toBeUndefined();
    expect(readInbox(path.join(stateDir, "im"), "default")[0].text).toBe(
      "hello explicit",
    );
    expect(fs.existsSync(path.join(runDir, "im", "default.inbox.jsonl"))).toBe(
      false,
    );
  });

  it("send writes agent message with --json", async () => {
    const stateDir = createStateDir();
    const origChannel = process.env.TAH_RUN_CHANNEL;
    delete process.env.TAH_RUN_CHANNEL;

    try {
      captureStdout();
      await runIm(["send", "--channel", "default", "--kind", "status", "--text", "all done", "--state-dir", stateDir, "--json"]);
      restoreStdout();

      const sendResult = JSON.parse(captured.join(""));
      expect(sendResult.ok).toBe(true);
      expect(sendResult.id).toMatch(/^agent-/);
      expect(sendResult.kind).toBe("status");

      const outboxPath = path.join(stateDir, "im", "default.outbox.jsonl");
      expect(fs.existsSync(outboxPath)).toBe(true);
    } finally {
      if (origChannel === undefined) {
        delete process.env.TAH_RUN_CHANNEL;
      } else {
        process.env.TAH_RUN_CHANNEL = origChannel;
      }
    }
  });

  it("send auto-corrects channel via TAH_RUN_CHANNEL (cli->default)", async () => {
    const origEnv = process.env.TAH_RUN_CHANNEL;
    process.env.TAH_RUN_CHANNEL = "default";
    try {
      const stateDir = createStateDir();

      captureStdout();
      await runIm(["send", "--channel", "cli", "--kind", "status", "--text-stdin", "--state-dir", stateDir, "--json"], {
        stdin: Readable.from(["hello from agent"]),
      });
      restoreStdout();

      const sendResult = JSON.parse(captured.join(""));
      expect(sendResult.ok).toBe(true);
      // Channel must be auto-corrected to default
      expect(sendResult.channel).toBe("default");

      // Verify default.outbox.jsonl exists with correct content
      const defaultOutbox = path.join(stateDir, "im", "default.outbox.jsonl");
      expect(fs.existsSync(defaultOutbox)).toBe(true);
      const lines = fs.readFileSync(defaultOutbox, "utf-8").trim().split("\n");
      expect(lines.length).toBeGreaterThanOrEqual(1);
      const msg = JSON.parse(lines[lines.length - 1]!);
      expect(msg.channel).toBe("default");
      expect(msg.text).toBe("hello from agent");

      // cli.outbox.jsonl MUST NOT exist
      const cliOutbox = path.join(stateDir, "im", "cli.outbox.jsonl");
      expect(fs.existsSync(cliOutbox)).toBe(false);
    } finally {
      if (origEnv === undefined) {
        delete process.env.TAH_RUN_CHANNEL;
      } else {
        process.env.TAH_RUN_CHANNEL = origEnv;
      }
    }
  });

  it("send reads multiline agent message with --text-stdin", async () => {
    const stateDir = createStateDir();
    const origChannel = process.env.TAH_RUN_CHANNEL;
    delete process.env.TAH_RUN_CHANNEL;
    const text = "## report\n\n- `cli/` stays literal\n- done\n";

    try {
      captureStdout();
      await runIm(
        ["send", "--channel", "default", "--kind", "status", "--text-stdin", "--state-dir", stateDir, "--json"],
        { stdin: Readable.from([text]) },
      );
      restoreStdout();

      const sendResult = JSON.parse(captured.join(""));
      expect(sendResult.ok).toBe(true);

      const outboxPath = path.join(stateDir, "im", "default.outbox.jsonl");
      const messages = fs.readFileSync(outboxPath, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
      expect(messages).toHaveLength(1);
      expect(messages[0].text).toBe(text);
    } finally {
      if (origChannel === undefined) {
        delete process.env.TAH_RUN_CHANNEL;
      } else {
        process.env.TAH_RUN_CHANNEL = origChannel;
      }
    }
  });

  it("post rejects reserved agent sender labels", async () => {
    const stateDir = createStateDir();
    const originalExit = process.exit;
    const originalStderrWrite = process.stderr.write;
    const capturedStderr: string[] = [];
    process.stderr.write = ((chunk: string | Uint8Array) => {
      capturedStderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: string | number | null) => {
      throw new Error(`process.exit ${code ?? 0}`);
    }) as typeof process.exit;

    try {
      await expect(
        runIm([
          "post",
          "--channel",
          "default",
          "--text",
          "hello",
          "--from",
          "assistant",
          "--state-dir",
          stateDir,
          "--json",
        ]),
      ).rejects.toThrow("process.exit 1");
    } finally {
      process.exit = originalExit;
      process.stderr.write = originalStderrWrite;
    }

    const error = JSON.parse(capturedStderr.join(""));
    expect(error.errorCode).toBe("IM_POST_RESERVED_SENDER");
  });

  it("ack writes cursor with --json", async () => {
    const stateDir = createStateDir();

    captureStdout();
    await runIm(["ack", "--channel", "default", "--message-id", "msg-001", "--state-dir", stateDir, "--json"]);
    restoreStdout();

    const ackResult = JSON.parse(captured.join(""));
    expect(ackResult.ok).toBe(true);
    expect(ackResult.messageId).toBe("msg-001");
  });

  it("recv uses the acknowledged cursor when --cursor is omitted", async () => {
    const stateDir = createStateDir();

    captureStdout();
    await runIm(["post", "--channel", "ch", "--text", "first", "--state-dir", stateDir, "--json"]);
    restoreStdout();
    const postResult1 = JSON.parse(captured.join(""));

    captureStdout();
    await runIm(["post", "--channel", "ch", "--text", "second", "--state-dir", stateDir, "--json"]);
    restoreStdout();

    captureStdout();
    await runIm(["ack", "--channel", "ch", "--message-id", postResult1.id, "--state-dir", stateDir, "--json"]);
    restoreStdout();

    captureStdout();
    await runIm(["recv", "--channel", "ch", "--state-dir", stateDir, "--json"]);
    restoreStdout();

    const recvResult = JSON.parse(captured.join(""));
    expect(recvResult.count).toBe(1);
    expect(recvResult.messages[0].text).toBe("second");
  });

  it("recv with cursor filters old messages", async () => {
    const stateDir = createStateDir();

    captureStdout();
    await runIm(["post", "--channel", "ch", "--text", "first", "--state-dir", stateDir, "--json"]);
    restoreStdout();
    const postResult1 = JSON.parse(captured.join(""));

    captureStdout();
    await runIm(["post", "--channel", "ch", "--text", "second", "--state-dir", stateDir, "--json"]);
    restoreStdout();

    captureStdout();
    await runIm(["recv", "--channel", "ch", "--cursor", postResult1.id, "--state-dir", stateDir, "--json"]);
    restoreStdout();

    const recvResult = JSON.parse(captured.join(""));
    expect(recvResult.count).toBe(1);
    expect(recvResult.messages[0].text).toBe("second");
  });
});
