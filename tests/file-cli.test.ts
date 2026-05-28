import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runFile } from "../src/cli/file.js";
import { StashFileStore } from "../src/stash/file-store.js";

describe("runFile CLI", () => {
  let tmpDir: string;
  let originalWrite: typeof process.stdout.write;
  let captured: Buffer[];

  function createStateDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "file-cli-test-"));
    fs.mkdirSync(path.join(tmpDir, "stash", "files"), { recursive: true });
    return tmpDir;
  }

  function captureStdout(): void {
    captured = [];
    originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
      return true;
    }) as typeof process.stdout.write;
  }

  function restoreStdout(): void {
    process.stdout.write = originalWrite;
  }

  afterEach(() => {
    if (originalWrite) restoreStdout();
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("materializes a stashed file by id", async () => {
    const stateDir = createStateDir();
    const store = new StashFileStore({
      rootDir: path.join(stateDir, "stash", "files"),
      cwd: tmpDir,
    });
    const observation = store.stash({
      kind: "stash_file",
      toolName: "stash_file",
      toolCallId: "call-file-cli",
      name: "report.md",
      content: "# Report\n\nDone.\n",
      encoding: "utf8",
    });

    captureStdout();
    const outputPath = path.join(tmpDir, "out", "report.md");
    await runFile([
      "materialize",
      observation.stashId,
      outputPath,
      "--state-dir",
      stateDir,
      "--json",
    ]);
    restoreStdout();

    const result = JSON.parse(Buffer.concat(captured).toString("utf8"));
    expect(result.stashId).toBe(observation.stashId);
    expect(fs.readFileSync(outputPath, "utf8")).toBe("# Report\n\nDone.\n");
  });

  it("cats stashed file bytes to stdout", async () => {
    const stateDir = createStateDir();
    const store = new StashFileStore({
      rootDir: path.join(stateDir, "stash", "files"),
      cwd: tmpDir,
    });
    const observation = store.stash({
      kind: "stash_file",
      toolName: "stash_file",
      toolCallId: "call-file-cat",
      name: "reply.md",
      content: "hello 中文\n",
      encoding: "utf8",
    });

    captureStdout();
    await runFile([
      "cat",
      observation.stashId,
      "--state-dir",
      stateDir,
    ]);
    restoreStdout();

    expect(Buffer.concat(captured).toString("utf8")).toBe("hello 中文\n");
  });

  it("cats binary stashed bytes without JSON framing", async () => {
    const stateDir = createStateDir();
    const store = new StashFileStore({
      rootDir: path.join(stateDir, "stash", "files"),
      cwd: tmpDir,
    });
    const observation = store.stash({
      kind: "stash_file",
      toolName: "stash_file",
      toolCallId: "call-file-cat-bin",
      name: "bytes.bin",
      content: "AAEC/w==",
      encoding: "base64",
    });

    captureStdout();
    await runFile([
      "cat",
      observation.stashId,
      "--state-dir",
      stateDir,
    ]);
    restoreStdout();

    expect([...Buffer.concat(captured)]).toEqual([0, 1, 2, 255]);
  });
});
