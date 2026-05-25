import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { SkillRunStore } from "../src/skill/store.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skill-store-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function makeStore(tmpDir: string): SkillRunStore {
  const skillRunsDir = path.join(tmpDir, "skill-runs");
  const skillsDir = path.join(tmpDir, "skills");
  return new SkillRunStore({ skillRunsDir, skillsDir });
}

// ===========================================================================
// Tests
// ===========================================================================

describe("SkillRunStore", () => {
  it("create() creates a skill run with status 'running', state.json exists, execution.txt exists", () => {
    const tmpDir = makeTmpDir();
    const store = makeStore(tmpDir);

    const state = store.create({ skill: "test-skill", args: { foo: "bar" } });

    expect(state.status).toBe("running");
    expect(state.skill).toBe("test-skill");
    expect(state.skillRunId).toMatch(/^skillrun-/);
    expect(state.startedAt).toBeTruthy();
    expect(state.args).toEqual({ foo: "bar" });

    // state.json should exist on disk
    expect(fs.existsSync(state.statePath)).toBe(true);
    const persisted = JSON.parse(fs.readFileSync(state.statePath, "utf-8"));
    expect(persisted.status).toBe("running");
    expect(persisted.skillRunId).toBe(state.skillRunId);

    // execution.txt should exist on disk
    expect(fs.existsSync(state.executionLogPath)).toBe(true);
    const logContent = fs.readFileSync(state.executionLogPath, "utf-8");
    expect(logContent).toBe("");
  });

  it("get() returns the created skill run", () => {
    const tmpDir = makeTmpDir();
    const store = makeStore(tmpDir);

    const created = store.create({ skill: "my-skill" });
    const fetched = store.get(created.skillRunId);

    expect(fetched).toBeDefined();
    expect(fetched!.skillRunId).toBe(created.skillRunId);
    expect(fetched!.skill).toBe("my-skill");
    expect(fetched!.status).toBe("running");
  });

  it("get() returns undefined for non-existent skillRunId", () => {
    const tmpDir = makeTmpDir();
    const store = makeStore(tmpDir);

    const result = store.get("skillrun-does-not-exist");
    expect(result).toBeUndefined();
  });

  it("listActive() returns running and review_pending, not closed", () => {
    const tmpDir = makeTmpDir();
    const store = makeStore(tmpDir);

    const run1 = store.create({ skill: "skill-a" });
    const run2 = store.create({ skill: "skill-b" });
    const run3 = store.create({ skill: "skill-c" });

    // Close run2 (no review) — should not appear in listActive
    store.close(run2.skillRunId, { review: "none", summary: "done" });

    // Move run3 to review_pending — should still appear
    store.close(run3.skillRunId, { review: "required", summary: "needs review" });

    const active = store.listActive();
    const activeIds = active.map((s) => s.skillRunId);

    expect(activeIds).toContain(run1.skillRunId); // running
    expect(activeIds).toContain(run3.skillRunId); // review_pending
    expect(activeIds).not.toContain(run2.skillRunId); // closed
  });

  it("close() with review:'none' transitions to 'closed' with closedAt set", () => {
    const tmpDir = makeTmpDir();
    const store = makeStore(tmpDir);

    const created = store.create({ skill: "close-test" });
    const closed = store.close(created.skillRunId, { review: "none", summary: "all done" });

    expect(closed.status).toBe("closed");
    expect(closed.closedAt).toBeTruthy();

    // Verify persisted state
    const persisted = store.get(created.skillRunId);
    expect(persisted!.status).toBe("closed");
    expect(persisted!.closedAt).toBeTruthy();
  });

  it("close() with review:'required' transitions to 'review_pending', creates review-task.txt", () => {
    const tmpDir = makeTmpDir();
    const store = makeStore(tmpDir);

    const created = store.create({ skill: "review-test" });
    const reviewPending = store.close(created.skillRunId, {
      review: "required",
      summary: "please review this",
    });

    expect(reviewPending.status).toBe("review_pending");
    expect(reviewPending.reviewTaskPath).toBeTruthy();

    // review-task.txt should exist with the summary content
    expect(fs.existsSync(reviewPending.reviewTaskPath!)).toBe(true);
    const reviewContent = fs.readFileSync(reviewPending.reviewTaskPath!, "utf-8");
    expect(reviewContent).toBe("please review this");
  });

  it("reviewComplete() transitions from 'review_pending' to 'closed', appends lessons", () => {
    const tmpDir = makeTmpDir();
    const store = makeStore(tmpDir);

    const created = store.create({ skill: "lesson-test" });
    store.close(created.skillRunId, { review: "required", summary: "needs review" });

    const closed = store.reviewComplete(created.skillRunId, {
      summary: "Reviewed and approved",
      lessons: ["Always validate input", "Use stricter types"],
    });

    expect(closed.status).toBe("closed");
    expect(closed.closedAt).toBeTruthy();
    expect(closed.lessonsPath).toBeTruthy();

    // Lessons file should exist and contain the lessons
    expect(fs.existsSync(closed.lessonsPath!)).toBe(true);
    const lessonsContent = fs.readFileSync(closed.lessonsPath!, "utf-8");
    expect(lessonsContent).toContain("Reviewed and approved");
    expect(lessonsContent).toContain("- Always validate input");
    expect(lessonsContent).toContain("- Use stricter types");
    expect(lessonsContent).toContain(created.skillRunId);
  });

  it("updateReturnCode() updates the return code in state", () => {
    const tmpDir = makeTmpDir();
    const store = makeStore(tmpDir);

    const created = store.create({ skill: "rc-test" });
    expect(created.executionReturnCode).toBeUndefined();

    store.updateReturnCode(created.skillRunId, 42);

    const updated = store.get(created.skillRunId);
    expect(updated!.executionReturnCode).toBe(42);
  });
});
