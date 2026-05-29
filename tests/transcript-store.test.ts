import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TranscriptStore } from "../src/transcript/store.js";
import type { AgentRunStateData, RunEvent } from "../src/types/run.js";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "transcript-store-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("TranscriptStore", () => {
  it("ensureDir creates the run directory and exposes canonical file paths", () => {
    const runDir = path.join(makeTmpDir(), "run-001");
    const store = new TranscriptStore(runDir);

    expect(fs.existsSync(runDir)).toBe(false);

    store.ensureDir();

    expect(fs.existsSync(runDir)).toBe(true);
    expect(store.transcriptFilePath).toBe(path.join(runDir, "transcript.jsonl"));
    expect(store.stateFilePath).toBe(path.join(runDir, "state.json"));
  });

  it("append writes JSONL transcript records in order", () => {
    const runDir = path.join(makeTmpDir(), "run-001");
    const store = new TranscriptStore(runDir);
    store.ensureDir();

    const first: RunEvent = {
      type: "run_started",
      runId: "run-001",
      task: "test task",
      cwd: "/repo",
      timestamp: "2026-05-25T12:00:00.000Z",
    };
    const second: RunEvent = {
      type: "model_requested",
      stepIndex: 0,
      timestamp: "2026-05-25T12:00:01.000Z",
    };

    store.append(first);
    store.append(second);

    const lines = fs.readFileSync(store.transcriptFilePath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]!)).toEqual(first);
    expect(JSON.parse(lines[1]!)).toEqual(second);
  });

  it("writes debug artifacts under the run directory", () => {
    const runDir = path.join(makeTmpDir(), "run-001");
    const store = new TranscriptStore(runDir);

    const artifact = store.writeDebugArtifact(
      "debug/prompts/step-0000-thinking.prompt.txt",
      "encoded prompt",
    );

    expect(artifact).toMatchObject({
      path: path.join(runDir, "debug/prompts/step-0000-thinking.prompt.txt"),
      relativePath: path.join("debug", "prompts", "step-0000-thinking.prompt.txt"),
      bytes: Buffer.byteLength("encoded prompt", "utf-8"),
    });
    expect(artifact.sha256).toHaveLength(64);
    expect(fs.readFileSync(artifact.path, "utf-8")).toBe("encoded prompt");
  });

  it("saveState and loadState round-trip run state", () => {
    const runDir = path.join(makeTmpDir(), "run-001");
    const store = new TranscriptStore(runDir);
    store.ensureDir();

    const state: AgentRunStateData = {
      runId: "run-001",
      status: "running",
      task: "test task",
      cwd: "/repo",
      createdAt: "2026-05-25T12:00:00.000Z",
      updatedAt: "2026-05-25T12:00:01.000Z",
      stepIndex: 1,
      transcriptPath: store.transcriptFilePath,
    };

    store.saveState(state);

    expect(store.loadState<AgentRunStateData>()).toEqual(state);
    expect(fs.readFileSync(store.stateFilePath, "utf-8")).toContain('\n  "runId": "run-001"');
  });

  it("loadState returns null when state has not been written", () => {
    const runDir = path.join(makeTmpDir(), "run-001");
    const store = new TranscriptStore(runDir);
    store.ensureDir();

    expect(store.loadState()).toBeNull();
  });
});
