import * as fs from "node:fs";
import * as path from "node:path";
import type { SkillManifest } from "../types/skill.js";

export type SkillListEntry = {
  name: string;
  description: string;
  tags?: string[];
};

export type SkillShowResult = {
  name: string;
  manifest?: SkillManifest;
  readmePath: string;
  contentLineCount: number;
};

export type SkillValidation = {
  ok: boolean;
  errors: string[];
  warnings: string[];
};

/**
 * Count logical content lines.
 * - Empty string → 0
 * - Single trailing newline is not counted as an extra line
 * - Middle blank lines and extra trailing blank lines are preserved
 */
export function countLogicalLines(raw: string): number {
  const segments = raw.split("\n");
  // Remove trailing empty segment from POSIX trailing newline
  if (segments.length > 0 && segments[segments.length - 1] === "") {
    return segments.length - 1;
  }
  // Empty file ("") → segments = [""] → segments[0] === "" → return 0
  if (segments.length === 1 && segments[0] === "") {
    return 0;
  }
  return segments.length;
}

export class SkillDiscovery {
  private readonly skillsDir: string;

  constructor(options: { skillsDir: string }) {
    this.skillsDir = options.skillsDir;
  }

  list(): SkillListEntry[] {
    if (!fs.existsSync(this.skillsDir)) return [];

    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true });
    const skills: SkillListEntry[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const skillDir = path.join(this.skillsDir, entry.name);
      const skillMdPath = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(skillMdPath)) continue;

      const manifestPath = path.join(skillDir, "skill.json");
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as SkillManifest;
          skills.push({
            name: manifest.name,
            description: manifest.description,
            tags: manifest.tags,
          });
          continue;
        } catch {
          // fall through to SKILL.md parsing
        }
      }

      const mdContent = fs.readFileSync(skillMdPath, "utf-8");
      const firstLine = mdContent.split("\n")[0] ?? "";
      const description = firstLine.replace(/^#\s*/, "").trim() || entry.name;
      skills.push({ name: entry.name, description });
    }

    return skills;
  }

  show(name: string): SkillShowResult | undefined {
    const skillDir = path.join(this.skillsDir, name);
    const skillMdPath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) return undefined;

    let manifest: SkillManifest | undefined;
    const manifestPath = path.join(skillDir, "skill.json");
    if (fs.existsSync(manifestPath)) {
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as SkillManifest;
      } catch {
        // ignore invalid manifest
      }
    }

    const raw = fs.readFileSync(skillMdPath, "utf-8");
    const contentLineCount = countLogicalLines(raw);

    return { name, manifest, readmePath: skillMdPath, contentLineCount };
  }

  validate(name: string): SkillValidation {
    const errors: string[] = [];
    const warnings: string[] = [];

    const skillDir = path.join(this.skillsDir, name);
    if (!fs.existsSync(skillDir)) {
      return { ok: false, errors: [`Skill directory not found: ${name}`], warnings };
    }

    const skillMdPath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillMdPath)) {
      errors.push("Missing SKILL.md");
    }

    const manifestPath = path.join(skillDir, "skill.json");
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as SkillManifest;
        if (!manifest.name) errors.push("skill.json: name is required");
        if (!manifest.description) errors.push("skill.json: description is required");
        if (manifest.name && manifest.name !== name) {
          warnings.push(`skill.json name "${manifest.name}" does not match directory "${name}"`);
        }
        if (manifest.entry) {
          const entryPath = path.join(skillDir, manifest.entry);
          if (!fs.existsSync(entryPath)) {
            errors.push(`Entry file not found: ${manifest.entry}`);
          }
        }
      } catch (e) {
        errors.push(`Invalid skill.json: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    return { ok: errors.length === 0, errors, warnings };
  }
}
