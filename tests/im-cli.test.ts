import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { runIm } from "../src/cli/im.js";
import {
  planImRunBindingLayout,
  type PublicImRunReceiveMessage,
} from "../src/im/index.js";

describe("runIm public IM CLI", () => {
  let tmpDir: string | undefined;
  let originalWrite: typeof process.stdout.write | undefined;
  let captured: string[] = [];
  let originalTahStateDir: string | undefined;
  let originalTahImStateDir: string | undefined;

  function createStateDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-cli-test-"));
    return tmpDir;
  }

  function useTahStateDir(stateDir: string): void {
    originalTahStateDir = process.env.TAH_STATE_DIR;
    process.env.TAH_STATE_DIR = stateDir;
  }

  function useTahImStateDir(stateDir: string): void {
    originalTahImStateDir = process.env.TAH_IM_STATE_DIR;
    process.env.TAH_IM_STATE_DIR = stateDir;
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
    if (originalWrite) {
      process.stdout.write = originalWrite;
      originalWrite = undefined;
    }
  }

  async function runJson(args: string[], stdin?: Readable): Promise<Record<string, any>> {
    captureStdout();
    await runIm([...args, "--json"], stdin ? { stdin } : {});
    restoreStdout();
    return JSON.parse(captured.join("")) as Record<string, any>;
  }

  afterEach(() => {
    restoreStdout();
    if (originalTahStateDir === undefined) {
      delete process.env.TAH_STATE_DIR;
    } else {
      process.env.TAH_STATE_DIR = originalTahStateDir;
    }
    if (originalTahImStateDir === undefined) {
      delete process.env.TAH_IM_STATE_DIR;
    } else {
      process.env.TAH_IM_STATE_DIR = originalTahImStateDir;
    }
    originalTahStateDir = undefined;
    originalTahImStateDir = undefined;
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
    tmpDir = undefined;
  });

  it("creates public pair metadata", async () => {
    const stateDir = createStateDir();

    const result = await runJson([
      "pair",
      "--a",
      "user:main",
      "--b",
      "member:team-p6/coder-1",
      "--kind",
      "a2user",
      "--state-dir",
      stateDir,
    ]);

    expect(result).toMatchObject({
      ok: true,
      tool: "im",
      pair: {
        kind: "a2user",
        endpoints: ["member:team-p6/coder-1", "user:main"],
      },
    });
    expect(fs.existsSync(path.join(stateDir, "im", "pairs", `${result.pair.pairId}.json`)))
      .toBe(true);
  });

  it("post + recv roundtrip with endpoint pair cursor semantics", async () => {
    const stateDir = createStateDir();

    const first = await runJson([
      "post",
      "--from",
      "user:main",
      "--to",
      "member:team-p6/coder-1",
      "--text",
      "first",
      "--state-dir",
      stateDir,
    ]);
    await runJson([
      "post",
      "--from",
      "user:main",
      "--to",
      "member:team-p6/coder-1",
      "--text",
      "second",
      "--state-dir",
      stateDir,
    ]);

    const initial = await runJson([
      "recv",
      "--as",
      "member:team-p6/coder-1",
      "--with",
      "user:main",
      "--state-dir",
      stateDir,
    ]);
    expect(initial.count).toBe(2);
    expect(initial.messages.map((message: { text: string }) => message.text)).toEqual([
      "first",
      "second",
    ]);

    await runJson([
      "ack",
      "--as",
      "member:team-p6/coder-1",
      "--with",
      "user:main",
      "--message-id",
      first.id,
      "--state-dir",
      stateDir,
    ]);

    const afterAck = await runJson([
      "recv",
      "--as",
      "member:team-p6/coder-1",
      "--with",
      "user:main",
      "--state-dir",
      stateDir,
    ]);
    expect(afterAck.count).toBe(1);
    expect(afterAck.messages[0].text).toBe("second");
  });

  it("sends agent status from stdin over the public pair", async () => {
    const stateDir = createStateDir();
    const text = "## report\n\n- done\n";

    const sent = await runJson(
      [
        "send",
        "--from",
        "member:team-p6/coder-1",
        "--to",
        "user:main",
        "--kind",
        "status",
        "--text-stdin",
        "--state-dir",
        stateDir,
      ],
      Readable.from([text]),
    );
    expect(sent).toMatchObject({
      ok: true,
      kind: "status",
      from: "member:team-p6/coder-1",
      to: "user:main",
    });

    const received = await runJson([
      "recv",
      "--as",
      "user:main",
      "--with",
      "member:team-p6/coder-1",
      "--state-dir",
      stateDir,
    ]);
    expect(received.count).toBe(1);
    expect(received.messages[0]).toMatchObject({
      id: sent.id,
      role: "agent",
      kind: "status",
      text,
    });
  });

  it("binds a run to a2user and a2a pairs and aggregates inbound messages", async () => {
    const stateDir = createStateDir();

    await runJson([
      "bind",
      "--run-id",
      "run-123",
      "--self",
      "member:team-p6/coder-1",
      "--peer",
      "user:main",
      "--kind",
      "a2user",
      "--state-dir",
      stateDir,
    ]);
    await runJson([
      "bind",
      "--run-id",
      "run-123",
      "--self",
      "member:team-p6/coder-1",
      "--peer",
      "member:team-p6/reviewer-1",
      "--kind",
      "a2a",
      "--state-dir",
      stateDir,
    ]);
    const userMessage = await runJson([
      "post",
      "--from",
      "user:main",
      "--to",
      "member:team-p6/coder-1",
      "--text",
      "from user",
      "--state-dir",
      stateDir,
    ]);
    const reviewerMessage = await runJson([
      "send",
      "--from",
      "member:team-p6/reviewer-1",
      "--to",
      "member:team-p6/coder-1",
      "--kind",
      "status",
      "--text",
      "from reviewer",
      "--state-dir",
      stateDir,
    ]);

    const received = await runJson([
      "run-recv",
      "--run-id",
      "run-123",
      "--state-dir",
      stateDir,
    ]);
    expect(received.count).toBe(2);
    expect(
      received.messages.map((message: PublicImRunReceiveMessage) => message.text),
    ).toEqual(["from user", "from reviewer"]);
    expect(
      received.messages.map((message: PublicImRunReceiveMessage) => message.binding.kind),
    ).toEqual(["a2user", "a2a"]);

    await runJson([
      "run-ack",
      "--run-id",
      "run-123",
      "--peer",
      "user:main",
      "--message-id",
      userMessage.id,
      "--state-dir",
      stateDir,
    ]);

    const afterAck = await runJson([
      "run-recv",
      "--run-id",
      "run-123",
      "--state-dir",
      stateDir,
    ]);
    expect(afterAck.messages.map((message: { id: string }) => message.id)).toEqual([
      reviewerMessage.id,
    ]);

    const bindingLayout = planImRunBindingLayout(stateDir, "run-123");
    expect(fs.existsSync(bindingLayout.bindingFile)).toBe(true);
  });

  it("uses TAH_STATE_DIR as the default public IM root", async () => {
    const stateDir = createStateDir();
    useTahStateDir(stateDir);

    await runJson([
      "post",
      "--from",
      "user:main",
      "--to",
      "member:team-p6/coder-1",
      "--text",
      "hello env root",
    ]);

    const received = await runJson([
      "recv",
      "--as",
      "member:team-p6/coder-1",
      "--with",
      "user:main",
    ]);
    expect(received.messages[0].text).toBe("hello env root");
  });

  it("prefers TAH_IM_STATE_DIR over TAH_STATE_DIR for public IM storage", async () => {
    const publicStateDir = createStateDir();
    const runLocalStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "im-cli-run-local-"));
    useTahStateDir(runLocalStateDir);
    useTahImStateDir(publicStateDir);

    try {
      await runJson([
        "post",
        "--from",
        "user:main",
        "--to",
        "member:team-p6/coder-1",
        "--text",
        "hello explicit im root",
      ]);

      const received = await runJson([
        "recv",
        "--as",
        "member:team-p6/coder-1",
        "--with",
        "user:main",
      ]);
      expect(received.messages[0].text).toBe("hello explicit im root");
      expect(fs.existsSync(path.join(publicStateDir, "im"))).toBe(true);
      expect(fs.existsSync(path.join(runLocalStateDir, "im"))).toBe(false);
    } finally {
      fs.rmSync(runLocalStateDir, { recursive: true, force: true });
    }
  });

  it("prints usable text output when --json is omitted", async () => {
    const stateDir = createStateDir();

    captureStdout();
    await runIm([
      "post",
      "--from",
      "user:main",
      "--to",
      "member:team-p6/coder-1",
      "--text",
      "hello text mode",
      "--state-dir",
      stateDir,
    ]);
    restoreStdout();

    const lines = captured.join("").trim().split("\n");
    expect(lines).toContain("message.text=hello text mode");
    expect(lines).toContain("from=user:main");
    expect(lines).toContain("to=member:team-p6/coder-1");
  });

  it("returns a failure envelope for missing endpoint arguments", async () => {
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
        runIm(["post", "--to", "member:team-p6/coder-1", "--text", "hello", "--state-dir", stateDir]),
      ).rejects.toThrow("process.exit 1");
    } finally {
      process.exit = originalExit;
      process.stderr.write = originalStderrWrite;
    }

    const error = JSON.parse(capturedStderr.join(""));
    expect(error).toMatchObject({
      ok: false,
      tool: "im",
      errorCode: "IM_ERROR",
      error: "tiny-agent im post requires --from",
    });
  });

  it("returns a failure envelope for malformed endpoints", async () => {
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
          "--from",
          "not-an-endpoint",
          "--to",
          "member:team-p6/coder-1",
          "--text",
          "hello",
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
    expect(error).toMatchObject({
      ok: false,
      tool: "im",
      errorCode: "IM_ERROR",
    });
    expect(error.error).toMatch(/Invalid IM endpoint/);
  });
});
