import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { scanRunIndex } from "../src/tui/run-index-reader.js";
import type { AgentRunStateData } from "../src/types/run.js";

function makeState(
  overrides: Partial<AgentRunStateData> & { runId: string },
): AgentRunStateData {
  return {
    runId: overrides.runId,
    status: "running",
    task: "test task",
    cwd: "/repo",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:01:00.000Z",
    stepIndex: 5,
    transcriptPath: `/tmp/${overrides.runId}/transcript.jsonl`,
    ...overrides,
  };
}

function withTempDir(fn: (dir: string) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-run-index-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeRunState(
  runsDir: string,
  runId: string,
  state: AgentRunStateData,
): string {
  const runDir = path.join(runsDir, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const statePath = path.join(runDir, "state.json");
  fs.writeFileSync(statePath, JSON.stringify(state), "utf-8");
  return runDir;
}

describe("scanRunIndex", () => {
  it("returns empty array for empty directory", () => {
    withTempDir((dir) => {
      expect(scanRunIndex(dir)).toEqual([]);
    });
  });

  it("returns empty array for non-existent directory", () => {
    expect(scanRunIndex("/tmp/nonexistent-runs-dir-xyz")).toEqual([]);
  });

  it("reads a single run state and builds a row", () => {
    withTempDir((dir) => {
      writeRunState(dir, "run-a", makeState({ runId: "run-a" }));

      const rows = scanRunIndex(dir);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        runId: "run-a",
        status: "running",
        stepIndex: 5,
        cwd: "/repo",
        startedAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:01:00.000Z",
        durationMs: 60000,
        frameCount: 0,
        problemFrameCount: 0,
        conversationCount: 0,
        sessionCount: 0,
        taskPreview: "test task",
      });
    });
  });

  it("reads multiple runs sorted newest first", () => {
    withTempDir((dir) => {
      writeRunState(dir, "run-old", makeState({
        runId: "run-old",
        createdAt: "2026-06-01T00:00:00.000Z",
        updatedAt: "2026-06-01T00:01:00.000Z",
      }));
      writeRunState(dir, "run-new", makeState({
        runId: "run-new",
        createdAt: "2026-06-01T00:02:00.000Z",
        updatedAt: "2026-06-01T00:03:00.000Z",
      }));

      const rows = scanRunIndex(dir);
      expect(rows.map((r) => r.runId)).toEqual(["run-new", "run-old"]);
    });
  });

  it("extracts failure summary from failed states", () => {
    withTempDir((dir) => {
      writeRunState(dir, "run-failed", makeState({
        runId: "run-failed",
        status: "failed",
        error: { message: "API key not found", code: "AUTH_ERROR" },
      }));

      const rows = scanRunIndex(dir);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.failureSummary).toBe("API key not found");
    });
  });

  it("skips non-run directories without state.json", () => {
    withTempDir((dir) => {
      writeRunState(dir, "run-a", makeState({ runId: "run-a" }));
      // Create a dir that looks like a run but has no state.json
      fs.mkdirSync(path.join(dir, "run-empty"), { recursive: true });
      // Create a non-run dir
      fs.mkdirSync(path.join(dir, "latest"), { recursive: true });
      // Create a file that looks like a run (should be ignored)
      fs.writeFileSync(path.join(dir, "latest.json"), "{}", "utf-8");
      // Create a symlink (should be ignored)
      try {
        fs.symlinkSync(path.join(dir, "run-a"), path.join(dir, "run-link"));
      } catch {
        // symlink may not be supported in all environments
      }

      const rows = scanRunIndex(dir);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.runId).toBe("run-a");
    });
  });

  it("skips unreadable state.json gracefully", () => {
    withTempDir((dir) => {
      writeRunState(dir, "run-a", makeState({ runId: "run-a" }));
      const badDir = path.join(dir, "run-bad");
      fs.mkdirSync(badDir, { recursive: true });
      fs.writeFileSync(path.join(badDir, "state.json"), "not json", "utf-8");

      const rows = scanRunIndex(dir);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.runId).toBe("run-a");
    });
  });

  it("handles runs with missing optional fields", () => {
    withTempDir((dir) => {
      writeRunState(dir, "run-minimal", {
        runId: "run-minimal",
        status: "cancelled",
        task: "",
        cwd: "",
        createdAt: "",
        updatedAt: "",
        stepIndex: 0,
        transcriptPath: "",
      } as AgentRunStateData);

      const rows = scanRunIndex(dir);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        runId: "run-minimal",
        status: "cancelled",
        stepIndex: 0,
      });
      expect(rows[0]!.durationMs).toBeUndefined();
      expect(rows[0]!.failureSummary).toBeUndefined();
      expect(rows[0]!.taskPreview).toBeUndefined();
    });
  });

  describe("task preview", () => {
    it("derives taskPreview from state.task", () => {
      withTempDir((dir) => {
        writeRunState(dir, "run-1", makeState({
          runId: "run-1",
          task: "Add task preview to durable run index rows",
        }));

        const rows = scanRunIndex(dir);
        expect(rows[0]!.taskPreview).toBe("Add task preview to durable run index rows");
      });
    });

    it("returns undefined for empty task", () => {
      withTempDir((dir) => {
        writeRunState(dir, "run-1", makeState({
          runId: "run-1",
          task: "",
        }));

        const rows = scanRunIndex(dir);
        expect(rows[0]!.taskPreview).toBeUndefined();
      });
    });

    it("returns undefined for whitespace-only task", () => {
      withTempDir((dir) => {
        writeRunState(dir, "run-1", makeState({
          runId: "run-1",
          task: "   ",
        }));

        const rows = scanRunIndex(dir);
        expect(rows[0]!.taskPreview).toBeUndefined();
      });
    });

    it("returns undefined when parsed state omits task", () => {
      withTempDir((dir) => {
        writeRunState(dir, "run-1", {
          runId: "run-1",
          status: "running",
          cwd: "/repo",
          createdAt: "2026-06-01T00:00:00.000Z",
          updatedAt: "2026-06-01T00:01:00.000Z",
          stepIndex: 5,
          transcriptPath: "/tmp/run-1/transcript.jsonl",
        } as AgentRunStateData);

        const rows = scanRunIndex(dir);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.taskPreview).toBeUndefined();
      });
    });

    it("truncates long task with ASCII ellipsis", () => {
      withTempDir((dir) => {
        const longTask = "A".repeat(200);
        writeRunState(dir, "run-1", makeState({
          runId: "run-1",
          task: longTask,
        }));

        const rows = scanRunIndex(dir);
        expect(rows[0]!.taskPreview).toBeDefined();
        expect(rows[0]!.taskPreview!.length).toBeLessThanOrEqual(83); // 80 chars + "..."
        expect(rows[0]!.taskPreview!).toMatch(/\.\.\.$/);
        expect(rows[0]!.taskPreview!).toContain("A");
      });
    });

    it("does not truncate task exactly at the limit", () => {
      withTempDir((dir) => {
        const task80 = "A".repeat(80);
        writeRunState(dir, "run-1", makeState({
          runId: "run-1",
          task: task80,
        }));

        const rows = scanRunIndex(dir);
        expect(rows[0]!.taskPreview).toBe(task80);
        expect(rows[0]!.taskPreview!).not.toMatch(/\.\.\.$/);
      });
    });

    it("truncates task one over the limit", () => {
      withTempDir((dir) => {
        const task81 = "A".repeat(81);
        writeRunState(dir, "run-1", makeState({
          runId: "run-1",
          task: task81,
        }));

        const rows = scanRunIndex(dir);
        expect(rows[0]!.taskPreview).toBe("A".repeat(80) + "...");
      });
    });
  });
});
