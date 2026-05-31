import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { runSkill } from "../src/cli/skill.js";

describe("runSkill CLI", () => {
  let tmpDir: string;
  let originalWrite: typeof process.stdout.write;
  let captured: string[];

  function createStateDir(): string {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-cli-test-"));
    const skillsDir = path.join(tmpDir, "skills");
    const skillRunsDir = path.join(tmpDir, "skill-runs");
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.mkdirSync(skillRunsDir, { recursive: true });
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
    expect(result.error).toContain("not found");
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

    const closeResult = getCapturedJson() as { ok: boolean; status: string; reviewTaskPath: string };
    expect(closeResult.ok).toBe(true);
    expect(closeResult.status).toBe("review_pending");
    expect(closeResult.reviewTaskPath).toBeDefined();
  });

  it("review-complete closes a review_pending run and writes lessons", async () => {
    const stateDir = createStateDir();
    createSkill(stateDir, "learner", { entry: true });

    captureStdout();
    await runSkill(["run", "learner", "--state-dir", stateDir, "--json"]);
    restoreStdout();
    const runResult = getCapturedJson() as { skillRunId: string };

    captureStdout();
    await runSkill([
      "close", runResult.skillRunId,
      "--review", "required",
      '{"summary":"review me"}',
      "--state-dir", stateDir, "--json",
    ]);
    restoreStdout();

    const reviewData = JSON.stringify({
      summary: "Learned something",
      lessons: ["Always check edge cases"],
    });

    captureStdout();
    await runSkill([
      "review-complete", runResult.skillRunId,
      reviewData,
      "--state-dir", stateDir, "--json",
    ]);
    restoreStdout();

    const result = getCapturedJson() as { ok: boolean; status: string; lessonsPath: string };
    expect(result.ok).toBe(true);
    expect(result.status).toBe("closed");
    expect(result.lessonsPath).toBeDefined();
    expect(fs.existsSync(result.lessonsPath)).toBe(true);
    expect(fs.readFileSync(result.lessonsPath, "utf-8")).toContain("Always check edge cases");
  });

  it("validate checks skill package structure", async () => {
    const stateDir = createStateDir();
    createSkill(stateDir, "valid-skill");

    captureStdout();
    await runSkill(["validate", "valid-skill", "--state-dir", stateDir, "--json"]);
    restoreStdout();

    const result = getCapturedJson() as { ok: boolean; errors: string[] };
    expect(result.ok).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("validate reports errors for missing skill", async () => {
    const stateDir = createStateDir();

    captureStdout();
    await runSkill(["validate", "nope", "--state-dir", stateDir, "--json"]);
    restoreStdout();

    const result = getCapturedJson() as { ok: boolean; errors: string[] };
    expect(result.ok).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("run emits environment event", async () => {
    const stateDir = createStateDir();
    createSkill(stateDir, "eventer", { entry: true });

    captureStdout();
    await runSkill(["run", "eventer", "--state-dir", stateDir, "--json"]);
    restoreStdout();

    const eventsPath = path.join(stateDir, "environment", "events.jsonl");
    expect(fs.existsSync(eventsPath)).toBe(true);
    const events = fs.readFileSync(eventsPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].kind).toBe("skill_run_started");
  });
});
