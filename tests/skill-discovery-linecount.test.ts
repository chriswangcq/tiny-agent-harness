import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SkillDiscovery, countLogicalLines } from "../src/skill/discovery.js";

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skill-discovery-test-"));
}

function makeDiscovery(tmpDir: string) {
  const skillsDir = path.join(tmpDir, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  return { discovery: new SkillDiscovery({ skillsDir }), skillsDir };
}

function createSkill(skillsDir: string, name: string, opts: { skillMd: string; skillJson?: object }) {
  const skillDir = path.join(skillsDir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), opts.skillMd, "utf-8");
  if (opts.skillJson) {
    fs.writeFileSync(path.join(skillDir, "skill.json"), JSON.stringify(opts.skillJson), "utf-8");
  }
}

describe("SkillDiscovery contentLineCount precision", () => {
  it("contentLineCount for normal file with trailing newline", () => {
    const tmpDir = makeTmpDir();
    const { discovery, skillsDir } = makeDiscovery(tmpDir);

    // Standard POSIX file: lines separated by \n, with trailing newline
    const mdContent = "line1\nline2\nline3\n";
    createSkill(skillsDir, "test-skill", { skillMd: mdContent });

    const detail = discovery.show("test-skill");
    expect(detail).toBeDefined();
    expect(detail!.contentLineCount).toBe(3);
    expect(detail!.readmePath).toContain("SKILL.md");
  });

  it("contentLineCount for file without trailing newline", () => {
    const tmpDir = makeTmpDir();
    const { discovery, skillsDir } = makeDiscovery(tmpDir);

    // File without trailing newline
    const mdContent = "line1\nline2\nline3";
    createSkill(skillsDir, "test-skill", { skillMd: mdContent });

    const detail = discovery.show("test-skill");
    expect(detail).toBeDefined();
    expect(detail!.contentLineCount).toBe(3);
    expect(detail!.readmePath).toContain("SKILL.md");
  });

  it("contentLineCount for empty file", () => {
    const tmpDir = makeTmpDir();
    const { discovery, skillsDir } = makeDiscovery(tmpDir);

    // Empty file
    createSkill(skillsDir, "test-skill", { skillMd: "" });

    const detail = discovery.show("test-skill");
    expect(detail).toBeDefined();
    expect(detail!.contentLineCount).toBe(0);
  });

  it("contentLineCount for file with blank lines in middle", () => {
    const tmpDir = makeTmpDir();
    const { discovery, skillsDir } = makeDiscovery(tmpDir);

    // File with blank lines in the middle (preserved)
    const mdContent = "line1\n\nline3\nline4\n";
    createSkill(skillsDir, "test-skill", { skillMd: mdContent });

    const detail = discovery.show("test-skill");
    expect(detail).toBeDefined();
    // line1, (empty), line3, line4 = 4 logical lines
    expect(detail!.contentLineCount).toBe(4);
  });

  it("contentLineCount for file with only newlines", () => {
    const tmpDir = makeTmpDir();
    const { discovery, skillsDir } = makeDiscovery(tmpDir);

    // File with only newline characters
    const mdContent = "\n\n\n";
    createSkill(skillsDir, "test-skill", { skillMd: mdContent });

    const detail = discovery.show("test-skill");
    expect(detail).toBeDefined();
    // Each empty line before the final newline counts
    expect(detail!.contentLineCount).toBe(3);
  });

  it("contentLineCount for single line no trailing newline", () => {
    const tmpDir = makeTmpDir();
    const { discovery, skillsDir } = makeDiscovery(tmpDir);

    const mdContent = "just one line";
    createSkill(skillsDir, "test-skill", { skillMd: mdContent });

    const detail = discovery.show("test-skill");
    expect(detail).toBeDefined();
    expect(detail!.contentLineCount).toBe(1);
  });

  it("contentLineCount for single line with trailing newline", () => {
    const tmpDir = makeTmpDir();
    const { discovery, skillsDir } = makeDiscovery(tmpDir);

    const mdContent = "just one line\n";
    createSkill(skillsDir, "test-skill", { skillMd: mdContent });

    const detail = discovery.show("test-skill");
    expect(detail).toBeDefined();
    expect(detail!.contentLineCount).toBe(1);
  });
});

describe("countLogicalLines pure function", () => {
  it("empty string returns 0", () => {
    expect(countLogicalLines("")).toBe(0);
  });
  it("single line no trailing newline", () => {
    expect(countLogicalLines("hello")).toBe(1);
  });
  it("single line with trailing newline", () => {
    expect(countLogicalLines("hello\n")).toBe(1);
  });
  it("multiple lines with trailing newline", () => {
    expect(countLogicalLines("a\nb\nc\n")).toBe(3);
  });
  it("multiple lines without trailing newline", () => {
    expect(countLogicalLines("a\nb\nc")).toBe(3);
  });
  it("preserves middle blank lines", () => {
    expect(countLogicalLines("a\n\nc\n")).toBe(3);
  });
  it("multiple trailing newlines count as lines", () => {
    expect(countLogicalLines("a\n\n\n")).toBe(3);
  });
  it("only newlines", () => {
    expect(countLogicalLines("\n\n\n")).toBe(3);
  });
  it("matches discovery.show contentLineCount", () => {
    const tmpDir = makeTmpDir();
    const { discovery, skillsDir } = makeDiscovery(tmpDir);
    const mdContent = "line1\nline2\nline3\n";
    createSkill(skillsDir, "test-skill", { skillMd: mdContent });
    const detail = discovery.show("test-skill");
    expect(detail).toBeDefined();
    expect(detail!.contentLineCount).toBe(countLogicalLines(mdContent));
  });
});
