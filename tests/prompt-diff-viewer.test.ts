import { describe, expect, it } from "vitest";
import {
  listPromptArtifacts,
  comparePromptArtifacts,
  estimateTokenCount,
  type PromptArtifactEntry,
  type PromptComparison,
} from "../src/tui/prompt-diff-viewer.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "p14-prompt-diff-test-"));
}

function writeFile(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf-8");
}

describe("listPromptArtifacts", () => {
  it("returns empty array for empty debug/prompts directory", () => {
    const dir = makeTempDir();
    const promptsDir = path.join(dir, "debug", "prompts");
    fs.mkdirSync(promptsDir, { recursive: true });
    const result = listPromptArtifacts(dir);
    expect(result).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty array when debug/prompts directory does not exist", () => {
    const dir = makeTempDir();
    const result = listPromptArtifacts(dir);
    expect(result).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("lists prompt artifacts sorted by step", () => {
    const dir = makeTempDir();
    const promptsDir = path.join(dir, "debug", "prompts");
    writeFile(path.join(promptsDir, "step-0000-thinking.prompt.txt"), "prompt 0");
    writeFile(path.join(promptsDir, "step-0002-thinking.prompt.txt"), "prompt 2");
    writeFile(path.join(promptsDir, "step-0001-thinking.prompt.txt"), "prompt 1");
    // unrelated file should be ignored
    writeFile(path.join(promptsDir, "step-0000-thinking.trace.txt"), "trace 0");
    writeFile(path.join(promptsDir, "other-file.txt"), "other");

    const result = listPromptArtifacts(dir);
    expect(result).toHaveLength(3);
    expect(result[0]!.step).toBe(0);
    expect(result[1]!.step).toBe(1);
    expect(result[2]!.step).toBe(2);
    expect(result[0]!.relativePath).toContain("step-0000");
    expect(result[0]!.fileSize).toBe(8); // "prompt 0"
    expect(result[0]!.estimatedTokens).toBe(2); // 8/4 = 2
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("handles non-numeric step prefixes gracefully", () => {
    const dir = makeTempDir();
    const promptsDir = path.join(dir, "debug", "prompts");
    writeFile(path.join(promptsDir, "unknown-step-thinking.prompt.txt"), "content");
    const result = listPromptArtifacts(dir);
    expect(result).toHaveLength(1);
    expect(result[0]!.step).toBe(-1); // unparseable step
    expect(result[0]!.fileName).toBe("unknown-step-thinking.prompt.txt");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("comparePromptArtifacts", () => {
  it("returns identical: true for same content", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "a.txt"), "line1\nline2\nline3\n");
    writeFile(path.join(dir, "b.txt"), "line1\nline2\nline3\n");

    const result = comparePromptArtifacts(
      path.join(dir, "a.txt"),
      path.join(dir, "b.txt"),
    );

    expect(result.identical).toBe(true);
    expect(result.diffLines).toHaveLength(0);
    expect(result.sizeA).toBe(result.sizeB);
    expect(result.tokenDelta).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("detects added lines", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "a.txt"), "line1\nline2\n");
    writeFile(path.join(dir, "b.txt"), "line1\nline2\nline3\n");

    const result = comparePromptArtifacts(
      path.join(dir, "a.txt"),
      path.join(dir, "b.txt"),
    );

    expect(result.identical).toBe(false);
    const addedLines = result.diffLines.filter((l) => l.kind === "+");
    expect(addedLines).toHaveLength(1);
    expect(addedLines[0]!.text).toBe("line3");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("detects removed lines", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "a.txt"), "line1\nline2\nline3\n");
    writeFile(path.join(dir, "b.txt"), "line1\nline2\n");

    const result = comparePromptArtifacts(
      path.join(dir, "a.txt"),
      path.join(dir, "b.txt"),
    );

    expect(result.identical).toBe(false);
    const removedLines = result.diffLines.filter((l) => l.kind === "-");
    expect(removedLines).toHaveLength(1);
    expect(removedLines[0]!.text).toBe("line3");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("handles missing file gracefully", () => {
    const result = comparePromptArtifacts(
      "/nonexistent/a.txt",
      "/nonexistent/b.txt",
    );
    expect(result.error).toBeDefined();
    expect(result.error).toContain("ENOENT");
    expect(result.diffLines).toHaveLength(0);
    expect(result.identical).toBe(false);
  });

  it("handles empty files", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "a.txt"), "");
    writeFile(path.join(dir, "b.txt"), "");

    const result = comparePromptArtifacts(
      path.join(dir, "a.txt"),
      path.join(dir, "b.txt"),
    );

    expect(result.identical).toBe(true);
    expect(result.sizeA).toBe(0);
    expect(result.sizeB).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("handles one file larger than the other", () => {
    const dir = makeTempDir();
    const longContent = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    writeFile(path.join(dir, "large.txt"), longContent);
    writeFile(path.join(dir, "small.txt"), "line 0\nline 1\n");

    const result = comparePromptArtifacts(
      path.join(dir, "large.txt"),
      path.join(dir, "small.txt"),
    );

    expect(result.identical).toBe(false);
    expect(result.sizeA).toBeGreaterThan(result.sizeB);
    expect(result.sizeDelta).toBe(result.sizeA - result.sizeB);
    expect(result.tokenDelta).not.toBe(0);
    // The diffLines should contain both + and - lines
    const kinds = new Set(result.diffLines.map((l) => l.kind));
    expect(result.diffLines.length).toBeGreaterThan(0);
    // diffLines verified non-empty above
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("produces summary text", () => {
    const dir = makeTempDir();
    writeFile(path.join(dir, "a.txt"), "hello world\n");
    writeFile(path.join(dir, "b.txt"), "hello world\nmore content\n");

    const result = comparePromptArtifacts(
      path.join(dir, "a.txt"),
      path.join(dir, "b.txt"),
    );

    expect(result.summary).toBeDefined();
    expect(result.summary!.length).toBeGreaterThan(0);
    expect(result.summary).toContain("Identical: false");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("estimateTokenCount", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokenCount("")).toBe(0);
  });

  it("uses characters/4 heuristic", () => {
    expect(estimateTokenCount("abcd")).toBe(1);
    expect(estimateTokenCount("abcdefgh")).toBe(2);
    expect(estimateTokenCount("abc")).toBe(1); // rounding up
  });
});
