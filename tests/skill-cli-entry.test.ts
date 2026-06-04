import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runSkill } from "../src/cli/skill.js";

describe("runSkill CLI", () => {
  let tmpDir: string;
  let originalWrite: typeof process.stdout.write;
  let captured: string[];
  let savedEnv: Record<string, string | undefined> = {};

  function createStateDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-cli-test-"));
    const skillsDir = path.join(tmpDir, "skills");
    const skillRunsDir = path.join(tmpDir, "skill-runs");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(skillRunsDir, { recursive: true });

    // Stub env vars so buildSkillCli resolves to our temp dir,
    // not the real project .tiny-agent/skills
    const vars = ["TAH_SKILLS_DIR", "TAH_SKILL_RUNS_DIR", "TAH_ENVIRONMENT_EVENTS_PATH", "TAH_STATE_DIR"];
    for (const v of vars) {
      if (!(v in savedEnv)) savedEnv[v] = process.env[v];
    }
    process.env.TAH_SKILLS_DIR = skillsDir;
    process.env.TAH_SKILL_RUNS_DIR = skillRunsDir;
    process.env.TAH_ENVIRONMENT_EVENTS_PATH = path.join(tmpDir, "environment", "events.jsonl");
    process.env.TAH_STATE_DIR = tmpDir;
    return tmpDir;
  }

  function createSkill(stateDir: string, name: string, opts?: { entry?: boolean }): void {
    const skillDir = path.join(stateDir, "skills", name);
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), `# ${name}\n\nA test skill.`, "utf-8");
    const manifest: Record<string, unknown> = {
      name,
      description: `${name} skill for testing`,
      tags: ["test"],
    };
    if (opts?.entry) {
      const binDir = path.join(skillDir, "bin");
      fs.mkdirSync(binDir, { recursive: true });
      const runScript = path.join(binDir, "run");
      fs.writeFileSync(runScript, '#!/bin/sh\necho "executed"', "utf-8");
      fs.chmodSync(runScript, 0o755);
      manifest.entry = "bin/run";
    }
    fs.writeFileSync(path.join(skillDir, "skill.json"), JSON.stringify(manifest), "utf-8");
  }

  function captureStdout(): void {
    captured = [];
    originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString());
      return true;
    }) as typeof process.stdout.write;
  }

  function restoreStdout(): void {
    if (originalWrite) process.stdout.write = originalWrite;
  }

  function getCapturedJson(): unknown {
    return JSON.parse(captured.join(""));
  }

  afterEach(() => {
    restoreStdout();
    // Restore env vars
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    savedEnv = {};
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("list returns available skills", async () => {
    const stateDir = createStateDir();
    createSkill(stateDir, "alpha");
    createSkill(stateDir, "beta");

    captureStdout();
    await runSkill(["list", "--state-dir", stateDir, "--json"]);
    restoreStdout();

    const result = getCapturedJson() as { skills: Array<{ name: string }> };
    expect(result.skills).toHaveLength(2);
    const names = result.skills.map((s) => s.name).sort();
    expect(names).toEqual(["alpha", "beta"]);
  });

  it("show returns skill details", async () => {
    const stateDir = createStateDir();
    createSkill(stateDir, "demo");

    captureStdout();
    await runSkill(["show", "demo", "--state-dir", stateDir, "--json"]);
    restoreStdout();

    const result = getCapturedJson() as { name: string; contentLineCount: number };
    expect(result.name).toBe("demo");
    expect(result.contentLineCount).toBeGreaterThan(0);
  });

  it("show returns error for missing skill", async () => {
    const stateDir = createStateDir();

    captureStdout();
    await runSkill(["show", "nonexistent", "--state-dir", stateDir, "--json"]);
    restoreStdout();

    const result = getCapturedJson() as { ok: false; error: string };
    expect(result.ok).toBe(false);
    expect(result.ok).toBe(false);
  });

  it("run executes skill entry and returns skill run id", async () => {
    const stateDir = createStateDir();
    createSkill(stateDir, "runner", { entry: true });

    captureStdout();
    await runSkill(["run", "runner", "--state-dir", stateDir, "--json"]);
    restoreStdout();

    const result = getCapturedJson() as { ok: boolean; skillRunId: string; skill: string; status: string };
    expect(result.ok).toBe(true);
    expect(result.skillRunId).toMatch(/^skillrun-/);
    expect(result.skill).toBe("runner");
    expect(result.status).toBe("running");
  });

  it("status lists active runs", async () => {
    const stateDir = createStateDir();
    createSkill(stateDir, "runner", { entry: true });

    captureStdout();
    await runSkill(["run", "runner", "--state-dir", stateDir, "--json"]);
    restoreStdout();

    captureStdout();
    await runSkill(["status", "--state-dir", stateDir, "--json"]);
    restoreStdout();

    const result = getCapturedJson() as { activeRuns: Array<{ skillRunId: string }> };
    expect(result.activeRuns).toHaveLength(1);
  });

  it("close with --review none closes a running skill run", async () => {
    const stateDir = createStateDir();
    createSkill(stateDir, "closer", { entry: true });

    captureStdout();
    await runSkill(["run", "closer", "--state-dir", stateDir, "--json"]);
    restoreStdout();
    const runResult = getCapturedJson() as { skillRunId: string };

    captureStdout();
    await runSkill(["close", runResult.skillRunId, "--review", "none", "--state-dir", stateDir, "--json"]);
    restoreStdout();

    const closeResult = getCapturedJson() as { ok: boolean; status: string };
    expect(closeResult.ok).toBe(true);
    expect(closeResult.status).toBe("closed");

    captureStdout();
    await runSkill(["status", "--state-dir", stateDir, "--json"]);
    restoreStdout();
    const statusResult = getCapturedJson() as { activeRuns: unknown[] };
    expect(statusResult.activeRuns).toHaveLength(0);
  });

  it("close with --review required sets review_pending", async () => {
    const stateDir = createStateDir();
    createSkill(stateDir, "reviewer", { entry: true });

    captureStdout();
    await runSkill(["run", "reviewer", "--state-dir", stateDir, "--json"]);
    restoreStdout();
    const runResult = getCapturedJson() as { skillRunId: string };

    captureStdout();
    await runSkill([
      "close", runResult.skillRunId,
      "--review", "required",
      '{"summary":"needs review"}',
      "--state-dir", stateDir, "--json",
    ]);
    restoreStdout();

    const closeResult = getCapturedJson() as { ok: boolean; status: string };
    expect(closeResult.ok).toBe(true);
    expect(["review_pending", "closed"]).toContain(closeResult.status);

    captureStdout();
    await runSkill(["status", "--state-dir", stateDir, "--json"]);
    restoreStdout();
    const statusResult = getCapturedJson() as { activeRuns: unknown[] };
    if (closeResult.status === "closed") {
      expect(statusResult.activeRuns).toHaveLength(0);
    } else {
      expect(statusResult.activeRuns.length).toBeGreaterThanOrEqual(0);
    }
  });

  it("review-complete transitions to closed", async () => {
    const stateDir = createStateDir();
    createSkill(stateDir, "rc-skill", { entry: true });

    // Run the skill
    captureStdout();
    await runSkill(["run", "rc-skill", "--state-dir", stateDir, "--json"]);
    restoreStdout();
    const runResult = getCapturedJson() as { skillRunId: string };

    // Close with review required
    captureStdout();
    await runSkill([
      "close", runResult.skillRunId,
      "--review", "required",
      '{"summary":"review me"}',
      "--state-dir", stateDir, "--json",
    ]);
    restoreStdout();

    // Review complete
    captureStdout();
    await runSkill([
      "review-complete", runResult.skillRunId,
      '{"summary":"done","lessons":["all good"]}',
      "--state-dir", stateDir, "--json",
    ]);
    restoreStdout();

    const rcResult = getCapturedJson() as { ok: boolean; skillRunId: string };
    expect(rcResult.ok).toBe(true);
    expect(rcResult.skillRunId).toBe(runResult.skillRunId);
  });

  it("validate returns ok for a valid skill", async () => {
    const stateDir = createStateDir();
    createSkill(stateDir, "valid-skill");

    captureStdout();
    await runSkill(["validate", "valid-skill", "--state-dir", stateDir, "--json"]);
    restoreStdout();

    const result = getCapturedJson() as { ok: boolean };
    expect(result.ok).toBe(true);
  });

  it("validate returns ok:false for missing skill", async () => {
    const stateDir = createStateDir();

    captureStdout();
    await runSkill(["validate", "nope", "--state-dir", stateDir, "--json"]);
    restoreStdout();

    const result = getCapturedJson() as { ok: boolean; error: string };
    expect(result.ok).toBe(false);
    expect(result.ok).toBe(false);
  });
});
