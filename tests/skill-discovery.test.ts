import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SkillDiscovery } from "../src/skill/discovery.js";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-discovery-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function makeDiscovery(tmpDir: string): { discovery: SkillDiscovery; skillsDir: string } {
  const skillsDir = path.join(tmpDir, "skills");
  fs.mkdirSync(skillsDir, { recursive: true });
  const discovery = new SkillDiscovery({ skillsDir });
  return { discovery, skillsDir };
}

function createSkill(
  skillsDir: string,
  name: string,
  options?: { skillMd?: string; manifest?: Record<string, unknown> },
): void {
  const skillDir = path.join(skillsDir, name);
  fs.mkdirSync(skillDir, { recursive: true });

  if (options?.skillMd !== undefined) {
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), options.skillMd, "utf-8");
  }

  if (options?.manifest) {
    fs.writeFileSync(path.join(skillDir, "skill.json"), JSON.stringify(options.manifest, null, 2), "utf-8");
  }
}

describe("SkillDiscovery", () => {
  it("list() returns empty for empty skills directory", () => {
    const tmpDir = makeTmpDir();
    const { discovery } = makeDiscovery(tmpDir);
    expect(discovery.list()).toEqual([]);
  });

  it("list() discovers skill with SKILL.md", () => {
    const tmpDir = makeTmpDir();
    const { discovery, skillsDir } = makeDiscovery(tmpDir);

    createSkill(skillsDir, "my-skill", {
      skillMd: "# My Skill\n\nA useful skill for testing.",
    });

    const skills = discovery.list();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("my-skill");
    expect(skills[0].description).toBeTruthy();
  });

  it("list() uses skill.json manifest when present", () => {
    const tmpDir = makeTmpDir();
    const { discovery, skillsDir } = makeDiscovery(tmpDir);

    createSkill(skillsDir, "fancy-skill", {
      skillMd: "# Fancy Skill\n\nDoes fancy things.",
      manifest: {
        name: "fancy-skill",
        description: "A fancy skill from manifest",
        tags: ["fancy", "test"],
      },
    });

    const skills = discovery.list();
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("fancy-skill");
    expect(skills[0].description).toBe("A fancy skill from manifest");
    expect(skills[0].tags).toEqual(["fancy", "test"]);
  });

  it("show() returns skill info with contentLineCount", () => {
    const tmpDir = makeTmpDir();
    const { discovery, skillsDir } = makeDiscovery(tmpDir);

    const mdContent = "# Test Skill\n\nThis is the skill content.\n\n## Usage\n\nUse it wisely.";
    createSkill(skillsDir, "test-skill", { skillMd: mdContent });

    const detail = discovery.show("test-skill");
    expect(detail).toBeDefined();
    expect(detail!.name).toBe("test-skill");
    expect(detail!.contentLineCount).toBeGreaterThan(0);
    expect(detail!.readmePath).toContain("SKILL.md");
  });

  it("show() returns undefined for non-existent skill", () => {
    const tmpDir = makeTmpDir();
    const { discovery } = makeDiscovery(tmpDir);
    expect(discovery.show("does-not-exist")).toBeUndefined();
  });

  it("validate() passes for valid skill with SKILL.md", () => {
    const tmpDir = makeTmpDir();
    const { discovery, skillsDir } = makeDiscovery(tmpDir);

    createSkill(skillsDir, "valid-skill", {
      skillMd: "# Valid Skill\n\nEverything is fine.",
    });

    const result = discovery.validate("valid-skill");
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("validate() fails for missing SKILL.md", () => {
    const tmpDir = makeTmpDir();
    const { discovery, skillsDir } = makeDiscovery(tmpDir);

    const skillDir = path.join(skillsDir, "broken-skill");
    fs.mkdirSync(skillDir, { recursive: true });

    const result = discovery.validate("broken-skill");
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.includes("SKILL.md"))).toBe(true);
  });
});
