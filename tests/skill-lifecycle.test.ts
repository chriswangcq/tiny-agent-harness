import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SkillCli } from "../src/skill/cli.js";
import { SkillDiscovery } from "../src/skill/discovery.js";
import { SkillRunStore } from "../src/skill/store.js";
import type {
  EnvironmentEvent,
  EnvironmentPort,
  IoWaitRequest,
} from "../src/types/environment.js";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-lifecycle-test-"));
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
      return Promise.reject(
        new Error("waitFor is not used by SkillCli tests"),
      );
    },
  };

  const store = new SkillRunStore({ skillRunsDir, skillsDir });
  const discovery = new SkillDiscovery({ skillsDir });
  const cli = new SkillCli(store, discovery, environment, skillsDir);

  return { cli, store, discovery, skillsDir, skillRunsDir, events };
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
    ),
    "utf-8",
  );

  if (options?.runScript !== undefined) {
    const runPath = path.join(skillDir, "bin", "run");
    fs.writeFileSync(runPath, options.runScript, "utf-8");
    fs.chmodSync(runPath, 0o755);
  }
}

describe("Skill lifecycle integration", () => {
  it("full lifecycle: install -> validate -> run -> close(review) -> review-complete -> lessons", () => {
    const tmpDir = makeTmpDir();
    const harness = makeHarness(tmpDir);

    // Create a test skill source directory
    const sourceDir = path.join(tmpDir, "source");
    fs.mkdirSync(sourceDir, { recursive: true });
    createSkill(sourceDir, "lifecycle-test", {
      runScript: "#!/bin/sh\necho ok\n",
    });

    const sourceSkillPath = path.join(sourceDir, "lifecycle-test");

    // 1. Install
    const installResult = harness.cli.handleInstall(sourceSkillPath);
    expect(installResult).toMatchObject({ ok: true, name: "lifecycle-test" });
    expect(fs.existsSync(installResult.path!)).toBe(true);

    // Verify it appears in list
    const list = harness.cli.handleList();
    expect(list.skills.some((s) => s.name === "lifecycle-test")).toBe(true);

    // 2. Validate
    const validateResult = harness.cli.handleValidate("lifecycle-test");
    expect(validateResult).toMatchObject({ ok: true });
    expect(validateResult.errors).toEqual([]);

    // 3. Run
    const runResult = harness.cli.handleRun("lifecycle-test", {});
    expect(runResult).toMatchObject({
      ok: true,
      skill: "lifecycle-test",
      status: "running",
    });
    expect(runResult.skillRunId).toBeTruthy();
    const skillRunId = runResult.skillRunId!;

    // Verify run-scoped state exists
    expect(fs.existsSync(runResult.statePath!)).toBe(true);
    expect(fs.existsSync(runResult.executionLogPath!)).toBe(true);

    // Verify active runs include this run
    const activeBefore = harness.cli.handleStatus();
    expect(
      activeBefore.activeRuns.some((r) => r.skillRunId === skillRunId),
    ).toBe(true);

    // 4. Close with review required
    const closeResult = harness.cli.handleClose(
      skillRunId,
      "required",
      '{"summary":"Test review summary"}',
    );
    expect(closeResult).toMatchObject({
      ok: true,
      status: "review_pending",
    });
    expect(closeResult.reviewTaskPath).toBeTruthy();
    expect(fs.existsSync(closeResult.reviewTaskPath!)).toBe(true);

    // Verify still in active runs (review_pending)
    const activeAfterClose = harness.cli.handleStatus();
    expect(
      activeAfterClose.activeRuns.some((r) => r.skillRunId === skillRunId),
    ).toBe(true);

    // 5. Review-complete with lessons
    const reviewResult = harness.cli.handleReviewComplete(skillRunId, {
      summary: "Review completed successfully",
      lessons: ["Lesson 1: Always check tests", "Lesson 2: Verify state transitions"],
    });
    expect(reviewResult).toMatchObject({
      ok: true,
      status: "closed",
    });
    expect(reviewResult.lessonsPath).toBeTruthy();

    // 6. Verify lessons appended
    expect(fs.existsSync(reviewResult.lessonsPath!)).toBe(true);
    const lessonsContent = fs.readFileSync(reviewResult.lessonsPath!, "utf-8");
    expect(lessonsContent).toContain(skillRunId);
    expect(lessonsContent).toContain("Review completed successfully");
    expect(lessonsContent).toContain("Lesson 1: Always check tests");
    expect(lessonsContent).toContain("Lesson 2: Verify state transitions");

    // 7. Verify no longer in active runs
    const activeAfterComplete = harness.cli.handleStatus();
    expect(
      activeAfterComplete.activeRuns.some((r) => r.skillRunId === skillRunId),
    ).toBe(false);

    // 8. Verify events were emitted
    expect(harness.events.length).toBe(3);
    expect(harness.events[0]!.kind).toBe("skill_run_started");
    expect(harness.events[1]!.kind).toBe("skill_review_pending");
    expect(harness.events[2]!.kind).toBe("skill_review_completed");
  });

  it("close non-running skill run returns error", () => {
    const tmpDir = makeTmpDir();
    const harness = makeHarness(tmpDir);

    createSkill(harness.skillsDir, "err-test", {
      runScript: "#!/bin/sh\necho ok\n",
    });

    // Run and close with review none (which sets to closed)
    const runResult = harness.cli.handleRun("err-test", {});
    harness.cli.handleClose(runResult.skillRunId!, "none", "done");

    // Try closing again - should fail
    const closeAgain = harness.cli.handleClose(
      runResult.skillRunId!,
      "none",
      "again",
    );
    expect(closeAgain).toMatchObject({ ok: false });
  });

  it("review-complete non-review_pending skill run returns error", () => {
    const tmpDir = makeTmpDir();
    const harness = makeHarness(tmpDir);

    createSkill(harness.skillsDir, "err2-test", {
      runScript: "#!/bin/sh\necho ok\n",
    });

    // Run but don't close with review
    const runResult = harness.cli.handleRun("err2-test", {});

    // Try review-complete on a running skill run
    const reviewResult = harness.cli.handleReviewComplete(
      runResult.skillRunId!,
      { summary: "premature", lessons: ["bad"] },
    );
    expect(reviewResult).toMatchObject({ ok: false });
  });

  it("run-scoped state isolation: different store dirs are independent", () => {
    const tmpDir1 = makeTmpDir();
    const tmpDir2 = makeTmpDir();

    const harness1 = makeHarness(tmpDir1);
    const harness2 = makeHarness(tmpDir2);

    createSkill(harness1.skillsDir, "scope-test", {
      runScript: "#!/bin/sh\necho ok\n",
    });
    createSkill(harness2.skillsDir, "scope-test", {
      runScript: "#!/bin/sh\necho ok\n",
    });

    // Run in harness1 only
    const run1 = harness1.cli.handleRun("scope-test", {});
    expect(run1.ok).toBe(true);

    // harness2 should not see harness1's runs
    const active1 = harness1.cli.handleStatus();
    const active2 = harness2.cli.handleStatus();

    expect(active1.activeRuns.length).toBe(1);
    expect(active2.activeRuns.length).toBe(0);

    // Close in harness1
    harness1.cli.handleClose(run1.skillRunId!, "none", "done");

    // harness2 still clean
    expect(harness2.cli.handleStatus().activeRuns.length).toBe(0);
  });

  it("lessons append to skill attachments for review-complete", () => {
    const tmpDir = makeTmpDir();
    const harness = makeHarness(tmpDir);

    createSkill(harness.skillsDir, "lessons-test", {
      runScript: "#!/bin/sh\necho ok\n",
    });

    // First run
    const run1 = harness.cli.handleRun("lessons-test", {});
    harness.cli.handleClose(run1.skillRunId!, "required", "first run");
    harness.cli.handleReviewComplete(run1.skillRunId!, {
      summary: "First review",
      lessons: ["Lesson A"],
    });

    // Second run
    vi.advanceTimersByTime(1000);
    const run2 = harness.cli.handleRun("lessons-test", {});
    harness.cli.handleClose(run2.skillRunId!, "required", "second run");
    harness.cli.handleReviewComplete(run2.skillRunId!, {
      summary: "Second review",
      lessons: ["Lesson B"],
    });

    // Verify both lessons in the file
    const lessonsPath = path.join(
      harness.skillsDir,
      "lessons-test",
      "attachments",
      "lessons.md",
    );
    expect(fs.existsSync(lessonsPath)).toBe(true);
    const content = fs.readFileSync(lessonsPath, "utf-8");
    expect(content).toContain(run1.skillRunId!);
    expect(content).toContain(run2.skillRunId!);
    expect(content).toContain("Lesson A");
    expect(content).toContain("Lesson B");
  });
});
