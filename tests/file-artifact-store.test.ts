import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { FileArtifactStore } from "../src/artifacts/file-store.js";

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "file-artifact-store-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe("FileArtifactStore", () => {
  it("stashes bytes and materializes them through write", () => {
    const tmp = makeTmpDir();
    const store = new FileArtifactStore({
      rootDir: path.join(tmp, ".tiny-agent", "artifacts", "files"),
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

    expect(observation.kind).toBe("file_artifact");
    expect(observation.artifactId).toContain("snake");
    expect(observation.writeCommand).toContain("artifact write");
    expect(fs.readFileSync(observation.contentPath, "utf8")).toContain("Snake");

    const result = store.write(observation.artifactId, "out/snake.html");
    expect(result.destinationPath).toBe(path.join(tmp, "out", "snake.html"));
    expect(fs.readFileSync(result.destinationPath, "utf8")).toBe(
      "<!DOCTYPE html>\n<title>Snake</title>\n",
    );
    expect(result.sha256).toBe(observation.sha256);
  });

  it("decodes base64 content as bytes", () => {
    const tmp = makeTmpDir();
    const store = new FileArtifactStore({
      rootDir: path.join(tmp, "artifacts"),
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

    store.write(observation.artifactId, outPath);

    expect([...fs.readFileSync(outPath)]).toEqual([0, 1, 2]);
  });
});
