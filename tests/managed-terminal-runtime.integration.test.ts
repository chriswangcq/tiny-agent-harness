import { mkdtemp, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ManagedTerminalRuntime } from "../src/bash/managed-terminal-runtime.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) =>
      rm(dir, { recursive: true, force: true }),
    ),
  );
});

describe("ManagedTerminalRuntime real PTY pacing", () => {
  it("keeps bash --noediting in noncanonical mode so long physical lines execute", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tiny-agent-pty-"));
    tempDirs.push(cwd);
    const payload = "a".repeat(3000);
    const runtime = new ManagedTerminalRuntime({
      defaultSessionId: "default",
      cwd,
      promptNonce: `nonce-${Date.now()}`,
      sessionsDir: join(cwd, "session-logs"),
      screenRows: 24,
      screenCols: 80,
      postWriteReadDelayMs: 150,
      startupReadDelayMs: 500,
    });
    const port = runtime.createRunPort();

    try {
      const initial = await port.execute({ request: { kind: "session_observe" } });
      const command =
        `PAYLOAD='${payload}'; printf '__LONG_LINE_LEN__%s\\n' "\${#PAYLOAD}"\n`;
      let observation = await port.execute({
        request: {
          kind: "terminal_write",
          expectedInputSeq: initial.terminal.inputSeq,
          text: command,
          waitForReturnMs: 2000,
        },
      });

      for (let attempt = 0; attempt < 10; attempt += 1) {
        const raw = await readFile(observation.screen.logRef.path, "utf8");
        if (raw.includes("__LONG_LINE_LEN__3000") && observation.returnedToPrompt) {
          break;
        }
        await delay(100);
        observation = await port.execute({ request: { kind: "session_observe" } });
      }

      const raw = await readFile(observation.screen.logRef.path, "utf8");
      expect(raw).toContain("__LONG_LINE_LEN__3000");
      expect(raw).not.toContain("\u0007");
      expect(observation.terminal.lastShellPrompt?.lastReturnCode).toBe(0);
    } finally {
      await port.execute({ request: { kind: "session_terminate" } });
    }
  }, 15_000);

  it("preserves Ctrl-C handling after noncanonical managed-shell init", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tiny-agent-pty-"));
    tempDirs.push(cwd);
    const runtime = new ManagedTerminalRuntime({
      defaultSessionId: "default",
      cwd,
      promptNonce: `nonce-${Date.now()}`,
      screenRows: 16,
      screenCols: 80,
      postWriteReadDelayMs: 100,
      startupReadDelayMs: 500,
    });
    const port = runtime.createRunPort();

    try {
      const initial = await port.execute({ request: { kind: "session_observe" } });
      const running = await port.execute({
        request: {
          kind: "terminal_write",
          expectedInputSeq: initial.terminal.inputSeq,
          text: "sleep 10\n",
          waitForReturnMs: 0,
        },
      });

      await delay(100);
      let interrupted = await port.execute({
        request: {
          kind: "session_interrupt",
          expectedInputSeq: running.terminal.inputSeq,
          waitForReturnMs: 2000,
        },
      });

      for (let attempt = 0; attempt < 10 && !interrupted.returnedToPrompt; attempt += 1) {
        await delay(100);
        interrupted = await port.execute({ request: { kind: "session_observe" } });
      }

      expect(interrupted.returnedToPrompt).toBe(true);
      expect(interrupted.terminal.lastShellPrompt?.lastReturnCode).not.toBe(0);
    } finally {
      await port.execute({ request: { kind: "session_terminate" } });
    }
  }, 15_000);

  it("strips managed continuation prompt chrome from semantic screen text", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tiny-agent-pty-"));
    tempDirs.push(cwd);
    const runtime = new ManagedTerminalRuntime({
      defaultSessionId: "default",
      cwd,
      promptNonce: `nonce-${Date.now()}`,
      screenRows: 16,
      screenCols: 120,
      postWriteReadDelayMs: 150,
      startupReadDelayMs: 500,
    });
    const port = runtime.createRunPort();

    try {
      const initial = await port.execute({ request: { kind: "session_observe" } });
      const text =
        "这 9 个失败在我们改动 `state/root.ts` **之前**就已存在。\n";
      const command =
        "cat <<'EOF_PAYLOAD'\n" +
        text +
        "EOF_PAYLOAD\n" +
        "printf '__PROMPT_CHROME_DONE__\\n'\n";
      let observation = await port.execute({
        request: {
          kind: "terminal_write",
          expectedInputSeq: initial.terminal.inputSeq,
          text: command,
          waitForReturnMs: 1000,
        },
      });

      for (let attempt = 0; attempt < 10 && !observation.returnedToPrompt; attempt += 1) {
        await delay(100);
        observation = await port.execute({ request: { kind: "session_observe" } });
      }

      expect(observation.screen.text).toContain(text.trim());
      expect(observation.screen.text.replace(/\n/g, "")).toContain("__PROMPT_CHROME_DONE__");
      expect(observation.screen.text).not.toContain("**之> 前**");
      expect(observation.screen.text).not.toContain("> 这 9 个失败");
      expect(observation.screen.text).not.toContain("__TAH_CONT__");
    } finally {
      await port.execute({ request: { kind: "session_terminate" } });
    }
  }, 15_000);

  it("writes a long UTF-8 heredoc through interactive bash without corrupting bytes", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "tiny-agent-pty-"));
    tempDirs.push(cwd);
    const target = join(cwd, "heredoc.txt");
    const payload = makePayload(64 * 1024);
    const runtime = new ManagedTerminalRuntime({
      defaultSessionId: "default",
      cwd,
      promptNonce: `nonce-${Date.now()}`,
      screenRows: 24,
      screenCols: 80,
      postWriteReadDelayMs: 150,
      startupReadDelayMs: 500,
    });
    const port = runtime.createRunPort();

    try {
      const initial = await port.execute({ request: { kind: "session_observe" } });
      const command =
        `cat > ${JSON.stringify(target)} <<'EOF_PAYLOAD'\n` +
        payload +
        "EOF_PAYLOAD\n" +
        "printf '__HEREDOC_DONE__\\n'\n";
      let observation = await port.execute({
        request: {
          kind: "terminal_write",
          expectedInputSeq: initial.terminal.inputSeq,
          text: command,
          waitForReturnMs: 0,
        },
      });

      for (let attempt = 0; attempt < 20; attempt += 1) {
        if (existsSync(target)) {
          const actual = await readFile(target);
          if (sha(actual) === sha(Buffer.from(payload, "utf8"))) {
            break;
          }
        }
        await delay(100);
        observation = await port.execute({ request: { kind: "session_observe" } });
      }

      const actual = await readFile(target, "utf8");
      expect(sha(Buffer.from(actual, "utf8"))).toBe(
        sha(Buffer.from(payload, "utf8")),
      );
      expect(actual).not.toContain("\uFFFD");
      expect(observation.result).toBe("ok");
    } finally {
      await port.execute({ request: { kind: "session_terminate" } });
    }
  }, 15_000);
});

function makePayload(targetBytes: number): string {
  const line = "中文中文中文 ✅✅✅ 🚀🚀🚀 | markdown | heredoc | pacing test\n";
  let result = "";
  let index = 0;
  while (Buffer.byteLength(result, "utf8") < targetBytes) {
    result += `${index.toString().padStart(4, "0")} ${line}`;
    index += 1;
  }
  return result;
}

function sha(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
