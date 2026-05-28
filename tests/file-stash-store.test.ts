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
    expect(observation.stashId).toContain("snake");
    expect(observation.materializeCommand).toContain("file materialize");
    expect(fs.readFileSync(observation.contentPath, "utf8")).toContain("Snake");

    const result = store.materialize(observation.stashId, "out/snake.html");
    expect(result.destinationPath).toBe(path.join(tmp, "out", "snake.html"));
    expect(fs.readFileSync(result.destinationPath, "utf8")).toBe(
      "<!DOCTYPE html>\n<title>Snake</title>\n",
    );
    expect(result.sha256).toBe(observation.sha256);
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

  it("rejects invalid base64 content before writing metadata", () => {
    const tmp = makeTmpDir();
    const store = new StashFileStore({
      rootDir: path.join(tmp, "stash"),
      cwd: tmp,
    });

    expect(() =>
      store.stash({
        kind: "stash_file",
        toolName: "stash_file",
        toolCallId: "call-invalid-b64",
        content: "not valid!",
        encoding: "base64",
      }),
    ).toThrow(/invalid base64/u);
    expect(fs.existsSync(path.join(tmp, "stash"))).toBe(false);
  });
});
