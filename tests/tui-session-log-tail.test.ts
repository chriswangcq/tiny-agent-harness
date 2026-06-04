import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatPromptMarker } from "../src/application/managed-shell.js";
import { SessionLogTailReader } from "../src/tui/session-log-tail.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("SessionLogTailReader", () => {
  it("reads filtered live screen projections from run-scoped session logs", async () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "default-37a8eec1ce.log");
    const content = [
      "export TAH_PROMPT_RC=0",
      "export PROMPT_COMMAND='TAH_PROMPT_RC=$?; TAH_PROMPT_SEQ=$((TAH_PROMPT_SEQ + 1))'",
      formatPromptMarker({
        nonce: "nonce",
        returnCode: 0,
        cwd: "/repo",
        promptSeq: 1,
      }),
      "[user@host:/repo]$ npm test",
      "PASS tests/example.test.ts",
      formatPromptMarker({
        nonce: "nonce",
        returnCode: 0,
        cwd: "/repo",
        promptSeq: 2,
      }),
      "[user@host:/repo]$ ",
    ].join("\n");
    writeFileSync(logPath, content);

    const [update] = await new SessionLogTailReader({
      sessionsDir: dir,
      maxTailBytes: 4096,
      maxTailChars: 4096,
    }).read();

    expect(update).toMatchObject({
      session: "default",
      logPath,
      tailOffset: Buffer.byteLength(content),
      screenRows: 24,
      screenCols: 80,
    });
    expect(update?.tail).toContain("npm test");
    expect(update?.tail).toContain("PASS tests/example.test.ts");
    expect(update?.tail).not.toContain("__TAH_PROMPT__");
    expect(update?.tail).not.toContain("PROMPT_COMMAND");
    expect(update?.tail).not.toContain("TAH_PROMPT_RC");
  });

  it("renders terminal screen semantics instead of append-only log text", async () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "default-37a8eec1ce.log");
    const content = "hello world\rreplacement\r\nline-2";
    writeFileSync(logPath, content);

    const [update] = await new SessionLogTailReader({
      sessionsDir: dir,
      screenRows: 4,
      screenCols: 40,
    }).read();

    expect(update?.tail).toContain("replacement");
    expect(update?.tail).toContain("line-2");
    expect(update?.tail).not.toContain("hello world");
    expect(update?.tail.split("\n")).toHaveLength(4);
  });

  it("drops partial leading lines when reading a bounded byte tail", async () => {
    const dir = makeTempDir();
    const logPath = path.join(dir, "worker-abcdef1234.log");
    const content = [
      ...Array.from({ length: 30 }, (_, index) => `old-${index} 中文`),
      "fresh 中文 tail",
    ].join("\n");
    writeFileSync(logPath, content);

    const [update] = await new SessionLogTailReader({
      sessionsDir: dir,
      maxTailBytes: 32,
      maxTailChars: 4096,
    }).read();

    expect(update).toMatchObject({
      session: "worker",
      tailOffset: Buffer.byteLength(content),
    });
    expect(update?.tail).toContain("fresh 中文 tail");
    expect(update?.tail).not.toContain("\uFFFD");
  });

  it("returns no updates when the sessions directory is missing", async () => {
    const dir = path.join(makeTempDir(), "missing");

    await expect(new SessionLogTailReader({ sessionsDir: dir }).read()).resolves.toEqual([]);
  });
});

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "tiny-agent-tui-log-"));
  tempDirs.push(dir);
  return dir;
}
