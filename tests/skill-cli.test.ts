import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SkillCli } from "../src/skill/cli.js";
import { SkillDiscovery } from "../src/skill/discovery.js";
import { SkillRunStore } from "../src/skill/store.js";
import type { EnvironmentEvent, EnvironmentPort, IoWaitRequest } from "../src/types/environment.js";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-cli-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-05-25T12:00:00.000Z"));
});

function makeHarness(tmpDir: string) {
  const skillsDir = path.join(tmpDir, "skills");
  const skillRunsDir = path.join(tmpDir, "skill-runs");
  fs.mkdirSync(skillsDir, { recursive: true });

  const events: EnvironmentEvent[] = [];
  const environment: EnvironmentPort = {
    appendEvent(event) {
      events.push(event);
    },
    consumeSince() {
      return [];
    },
    waitFor(_options: { runId: string; wait: IoWaitRequest }) {
      return Promise.reject(new Error("waitFor is not used by SkillCli tests"));
    },
  };

  const store = new SkillRunStore({ skillRunsDir, skillsDir });
  const discovery = new SkillDiscovery({ skillsDir });
  const cli = new SkillCli(store, discovery, environment, skillsDir);

  return { cli, store, skillsDir, events };
}

function createSkill(
  skillsDir: string,
  name: string,
  options?: {
    manifest?: Record<string, unknown>;
    skillMd?: string;
    runScript?: string;
  },
): void {
  const skillDir = path.join(skillsDir, name);
  fs.mkdirSync(path.join(skillDir, "bin"), { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    options?.skillMd ?? `# ${name}\n\nTest skill.`,
    "utf-8",
  );
  fs.writeFileSync(
    path.join(skillDir, "skill.json"),
    JSON.stringify(
      options?.manifest ?? {
        name,
        description: `${name} description`,
        entry: "bin/run",
      },
      null,
      2,
    ),
    "utf-8",
  );

  if (options?.runScript !== undefined) {
    const runPath = path.join(skillDir, "bin", "run");
    fs.writeFileSync(runPath, options.runScript, "utf-8");
    fs.chmodSync(runPath, 0o755);
  }
}

describe("SkillCli", () => {
  it("handleList and handleShow expose discovered skill metadata", () => {
    const tmpDir = makeTmpDir();
    const { cli, skillsDir } = makeHarness(tmpDir);
    createSkill(skillsDir, "review", {
      manifest: {
        name: "review",
        description: "Review code",
        tags: ["coding", "review"],
        entry: "bin/run",
      },
      runScript: "#!/bin/sh\ncat\n",
    });

    expect(cli.handleList()).toEqual({
      skills: [
        {
          name: "review",
          description: "Review code",
          tags: ["coding", "review"],
        },
      ],
    });
    expect(cli.handleShow("review")).toMatchObject({
      name: "review",
      manifest: expect.objectContaining({ entry: "bin/run" }),
      contentLineCount: expect.any(Number),
    });
  });

  it("handleShow returns a structured error for missing skills", () => {
    const tmpDir = makeTmpDir();
    const { cli } = makeHarness(tmpDir);

    expect(cli.handleShow("missing")).toEqual({
      ok: false,
      error: "Skill not found: missing",
    });
  });

  it("handleRun creates a durable run, executes entry with JSON stdin, and emits a start event", () => {
    const tmpDir = makeTmpDir();
    const { cli, store, skillsDir, events } = makeHarness(tmpDir);
    createSkill(skillsDir, "echo-args", {
      runScript: "#!/bin/sh\nprintf 'args='\ncat\n",
    });

    const result = cli.handleRun("echo-args", { path: "src" });

    expect(result).toMatchObject({
      ok: true,
      skill: "echo-args",
      status: "running",
    });
    if (result.ok) {
      expect(result.skillRunId).toBe("skillrun-1779710400000-001");
      expect(fs.readFileSync(result.executionLogPath, "utf-8")).toBe(
        'args={"path":"src"}',
      );
      expect(store.get(result.skillRunId)?.executionReturnCode).toBe(0);
    }

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      id: "skill-evt-1779710400000",
      kind: "skill_run_started",
      source: "skill",
      skillRunId: "skillrun-1779710400000-001",
      skill: "echo-args",
    });
  });

  it("handleRun returns a structured error when a skill has no entry", () => {
    const tmpDir = makeTmpDir();
    const { cli, skillsDir } = makeHarness(tmpDir);
    createSkill(skillsDir, "docs-only", {
      manifest: {
        name: "docs-only",
        description: "No executable entry",
      },
    });

    expect(cli.handleRun("docs-only")).toEqual({
      ok: false,
      error: 'Skill "docs-only" has no entry',
    });
  });

  it("handleStatus lists active runs from the store", () => {
    const tmpDir = makeTmpDir();
    const { cli, store } = makeHarness(tmpDir);
    const run = store.create({ skill: "active" });

    expect(cli.handleStatus()).toEqual({
      activeRuns: [
        {
          skillRunId: run.skillRunId,
          skill: "active",
          status: "running",
          executionReturnCode: undefined,
          executionLogPath: run.executionLogPath,
          reviewTaskPath: undefined,
        },
      ],
    });
  });

  it("handleClose closes a running skill without review and emits skill_run_closed", () => {
    const tmpDir = makeTmpDir();
    const { cli, store, events } = makeHarness(tmpDir);
    const run = store.create({ skill: "cleanup" });

    const result = cli.handleClose(run.skillRunId, "none", "done");

    expect(result).toEqual({
      ok: true,
      skillRunId: run.skillRunId,
      status: "closed",
      reviewTaskPath: undefined,
    });
    expect(store.get(run.skillRunId)?.status).toBe("closed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "skill_run_closed",
      skillRunId: run.skillRunId,
      skill: "cleanup",
    });
  });

  it("handleClose can move a running skill to review_pending", () => {
    const tmpDir = makeTmpDir();
    const { cli, store, events } = makeHarness(tmpDir);
    const run = store.create({ skill: "review-me" });

    const result = cli.handleClose(run.skillRunId, "required", "please review");

    expect(result).toMatchObject({
      ok: true,
      skillRunId: run.skillRunId,
      status: "review_pending",
    });
    if (result.ok) {
      expect(fs.readFileSync(result.reviewTaskPath!, "utf-8")).toBe("please review");
    }
    expect(store.get(run.skillRunId)?.status).toBe("review_pending");
    expect(events[0]).toMatchObject({
      kind: "skill_review_pending",
      skillRunId: run.skillRunId,
      reviewTaskPath: expect.stringContaining("review-task.txt"),
    });
  });

  it("handleClose rejects missing and non-running skill runs", () => {
    const tmpDir = makeTmpDir();
    const { cli, store } = makeHarness(tmpDir);
    const run = store.create({ skill: "already-closed" });
    store.close(run.skillRunId, { review: "none", summary: "done" });

    expect(cli.handleClose("missing", "none", "done")).toEqual({
      ok: false,
      error: "Skill run not found: missing",
    });
    expect(cli.handleClose(run.skillRunId, "none", "done")).toEqual({
      ok: false,
      error: `Skill run ${run.skillRunId} is not running (status: closed)`,
    });
  });

  it("handleReviewComplete closes pending review, appends lessons, and emits completion", () => {
    const tmpDir = makeTmpDir();
    const { cli, store, events } = makeHarness(tmpDir);
    const run = store.create({ skill: "lesson-skill" });
    store.close(run.skillRunId, { review: "required", summary: "review task" });

    const result = cli.handleReviewComplete(run.skillRunId, {
      summary: "reviewed",
      lessons: ["keep logs short", "write tests first"],
    });

    expect(result).toMatchObject({
      ok: true,
      skillRunId: run.skillRunId,
      status: "closed",
    });
    if (result.ok) {
      const lessons = fs.readFileSync(result.lessonsPath!, "utf-8");
      expect(lessons).toContain("reviewed");
      expect(lessons).toContain("- keep logs short");
      expect(lessons).toContain("- write tests first");
    }
    expect(store.get(run.skillRunId)?.status).toBe("closed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "skill_review_completed",
      skillRunId: run.skillRunId,
      lessonsPath: expect.stringContaining("lessons.md"),
    });
  });

  it("handleInstall copies a skill directory into skills root", () => {
    const tmpDir = makeTmpDir();
    const { cli, skillsDir } = makeHarness(tmpDir);

    // Create a source skill directory with SKILL.md
    const sourceDir = path.join(tmpDir, "source-skill");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "SKILL.md"), "# my-skill\n\nA test skill.", "utf-8");
    fs.writeFileSync(path.join(sourceDir, "skill.json"), JSON.stringify({
      name: "my-skill",
      description: "A test skill",
    }), "utf-8");

    const result = cli.handleInstall(sourceDir);
    expect(result).toEqual({
      ok: true,
      name: "source-skill",
      path: path.join(skillsDir, "source-skill"),
    });

    // Verify the skill was copied
    expect(fs.existsSync(path.join(skillsDir, "source-skill", "SKILL.md"))).toBe(true);
    expect(fs.existsSync(path.join(skillsDir, "source-skill", "skill.json"))).toBe(true);
  });

  it("handleInstall with a custom name", () => {
    const tmpDir = makeTmpDir();
    const { cli, skillsDir } = makeHarness(tmpDir);

    const sourceDir = path.join(tmpDir, "source-skill");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "SKILL.md"), "# my-skill\n\nA test skill.", "utf-8");

    const result = cli.handleInstall(sourceDir, "custom-name");
    expect(result).toEqual({
      ok: true,
      name: "custom-name",
      path: path.join(skillsDir, "custom-name"),
    });
  });

  it("handleInstall rejects missing source directory", () => {
    const tmpDir = makeTmpDir();
    const { cli } = makeHarness(tmpDir);

    expect(cli.handleInstall("/nonexistent/path")).toEqual({
      ok: false,
      error: "Source directory not found: /nonexistent/path",
    });
  });

  it("handleInstall rejects non-directory source", () => {
    const tmpDir = makeTmpDir();
    const { cli } = makeHarness(tmpDir);

    const filePath = path.join(tmpDir, "not-a-dir");
    fs.writeFileSync(filePath, "hello", "utf-8");

    expect(cli.handleInstall(filePath)).toEqual({
      ok: false,
      error: expect.stringContaining("not a directory"),
    });
  });

  it("handleInstall rejects source without SKILL.md", () => {
    const tmpDir = makeTmpDir();
    const { cli } = makeHarness(tmpDir);

    const sourceDir = path.join(tmpDir, "bad-skill");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "README.md"), "no SKILL.md", "utf-8");

    expect(cli.handleInstall(sourceDir)).toEqual({
      ok: false,
      error: expect.stringContaining("SKILL.md not found"),
    });
  });

  it("handleInstall rejects duplicate skill name", () => {
    const tmpDir = makeTmpDir();
    const { cli, skillsDir } = makeHarness(tmpDir);

    // Pre-create a skill directory
    const existingDir = path.join(skillsDir, "existing-skill");
    fs.mkdirSync(existingDir, { recursive: true });
    fs.writeFileSync(path.join(existingDir, "SKILL.md"), "# existing", "utf-8");

    // Try to install to the same name
    const sourceDir = path.join(tmpDir, "source-skill");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "SKILL.md"), "# new skill", "utf-8");

    expect(cli.handleInstall(sourceDir, "existing-skill")).toEqual({
      ok: false,
      error: "Skill already exists: existing-skill",
    });
  });

  describe("isValidSkillName", () => {
    it("rejects empty string", () => {
      expect(SkillCli.isValidSkillName("")).toBe(false);
      expect(SkillCli.isValidSkillName("   ")).toBe(false);
    });

    it("rejects path traversal", () => {
      expect(SkillCli.isValidSkillName("../evil")).toBe(false);
      expect(SkillCli.isValidSkillName("..")).toBe(false);
      expect(SkillCli.isValidSkillName(".")).toBe(false);
      expect(SkillCli.isValidSkillName("nested/name")).toBe(false);
      expect(SkillCli.isValidSkillName("nested\\name")).toBe(false);
    });

    it("rejects absolute paths", () => {
      expect(SkillCli.isValidSkillName("/etc/passwd")).toBe(false);
      expect(SkillCli.isValidSkillName("C:\\Windows")).toBe(false);
    });

    it("rejects whitespace-only and leading/trailing whitespace", () => {
      expect(SkillCli.isValidSkillName(" ")).toBe(false);
      expect(SkillCli.isValidSkillName(" abc")).toBe(false);
      expect(SkillCli.isValidSkillName("abc ")).toBe(false);
    });

    it("accepts valid single-segment names", () => {
      expect(SkillCli.isValidSkillName("my-skill")).toBe(true);
      expect(SkillCli.isValidSkillName("coding-review")).toBe(true);
      expect(SkillCli.isValidSkillName("a")).toBe(true);
      expect(SkillCli.isValidSkillName("skill_123")).toBe(true);
    });
  });

  it("handleInstall rejects path-traversal names", () => {
    const tmpDir = makeTmpDir();
    const { cli } = makeHarness(tmpDir);

    const sourceDir = path.join(tmpDir, "source-skill");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, "SKILL.md"), "# my-skill\n\nA test skill.", "utf-8");

    expect(cli.handleInstall(sourceDir, "../outside")).toEqual({
      ok: false,
      error: "Invalid skill name: ../outside",
    });
    expect(cli.handleInstall(sourceDir, "nested/name")).toEqual({
      ok: false,
      error: "Invalid skill name: nested/name",
    });
  });


  it("handleReviewComplete rejects missing and non-pending skill runs", () => {
    const tmpDir = makeTmpDir();
    const { cli, store } = makeHarness(tmpDir);
    const run = store.create({ skill: "still-running" });

    expect(cli.handleReviewComplete("missing", { summary: "", lessons: [] })).toEqual({
      ok: false,
      error: "Skill run not found: missing",
    });
    expect(cli.handleReviewComplete(run.skillRunId, { summary: "", lessons: [] })).toEqual({
      ok: false,
      error: `Skill run ${run.skillRunId} is not pending review (status: running)`,
    });
  });
});
