import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { StashFileStore } from "../src/stash/file-store.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-stash-store-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe("StashFileStore", () => {
  it("stashes bytes and materializes them through the store", () => {
    const tmp = makeTmpDir();
    const store = new StashFileStore({
      rootDir: path.join(tmp, ".tiny-agent", "stash", "files"),
      cwd: tmp,
    });

    const observation = store.stash({
      kind: "stash_file",
      toolName: "stash_file",
      toolCallId: "fim-call-run-001-0",
      name: "snake.html",
      content: "<!DOCTYPE html>\n<title>Snake</title>\n",
      encoding: "utf8",
    });

    expect(observation.kind).toBe("stash_file");
    expect(observation.stashId).toMatch(/^f-[a-f0-9]{10}$/u);
    expect(observation.materializeCommand).toContain("file materialize");
    expect(observation.materializeCommand).toContain("snake.html");
    expect(observation.catCommand).toContain("file cat");
    expect(observation.catCommand).toContain(observation.stashId);

    const result = store.materialize(observation.stashId, "out/snake.html");
    expect(result.destinationPath).toBe(path.join(tmp, "out", "snake.html"));
    expect(fs.readFileSync(result.destinationPath, "utf8")).toBe(
      "<!DOCTYPE html>\n<title>Snake</title>\n",
    );
    expect(store.readMeta(observation.stashId).sha256).toBe(result.sha256);

    const read = store.readContent(observation.stashId);
    expect(read.sourcePath).toContain(observation.stashId);
    expect(read.sha256).toBe(result.sha256);
    expect(read.content.toString("utf8")).toBe(
      "<!DOCTYPE html>\n<title>Snake</title>\n",
    );
  });

  it("includes the configured state dir in materialize commands", () => {
    const tmp = makeTmpDir();
    const stateDir = path.join(tmp, "custom state");
    const store = new StashFileStore({
      rootDir: path.join(stateDir, "stash", "files"),
      cwd: tmp,
      stateDir,
    });

    const observation = store.stash({
      kind: "stash_file",
      toolName: "stash_file",
      toolCallId: "call-state-dir",
      content: "hello\n",
      encoding: "utf8",
    });

    expect(observation.materializeCommand).toContain("--state-dir");
    expect(observation.materializeCommand).toContain(`'${stateDir}'`);
    expect(observation.catCommand).toContain("--state-dir");
    expect(observation.catCommand).toContain(`'${stateDir}'`);
  });

  it("omits the default state dir from materialize commands", () => {
    const tmp = makeTmpDir();
    const store = new StashFileStore({
      rootDir: path.join(tmp, ".tiny-agent", "stash", "files"),
      cwd: tmp,
      stateDir: undefined,
    });

    const observation = store.stash({
      kind: "stash_file",
      toolName: "stash_file",
      toolCallId: "call-default-state-dir",
      name: "note.txt",
      content: "hello\n",
      encoding: "utf8",
    });

    expect(observation.materializeCommand).not.toContain("--state-dir");
    expect(observation.materializeCommand).toContain("note.txt");
  });

  it("decodes base64 content as bytes", () => {
    const tmp = makeTmpDir();
    const store = new StashFileStore({
      rootDir: path.join(tmp, "stash"),
      cwd: tmp,
    });

    const observation = store.stash({
      kind: "stash_file",
      toolName: "stash_file",
      toolCallId: "call-b64",
      content: "AAEC",
      encoding: "base64",
    });
    const outPath = path.join(tmp, "bytes.bin");

    store.materialize(observation.stashId, outPath);

    expect([...fs.readFileSync(outPath)]).toEqual([0, 1, 2]);
  });

  it("does not surface base64 validation to the model", () => {
    const tmp = makeTmpDir();
    const store = new StashFileStore({
      rootDir: path.join(tmp, "stash"),
      cwd: tmp,
    });

    const observation = store.stash({
      kind: "stash_file",
      toolName: "stash_file",
      toolCallId: "call-invalid-b64",
      content: "not valid!",
      encoding: "base64",
    });

    expect(observation.kind).toBe("stash_file");
    expect(store.readMeta(observation.stashId).encoding).toBe("base64");
  });
});
