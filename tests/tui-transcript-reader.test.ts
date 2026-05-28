import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { TranscriptReader } from "../src/tui/transcript-reader.js";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-transcript-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

// Minimal RunEvent fixtures
const event1 = {
  type: "run_started" as const,
  runId: "run-1",
  task: "test",
  cwd: "/tmp",
  timestamp: "2026-01-01T00:00:00Z",
};

const event2 = {
  type: "model_requested" as const,
  stepIndex: 0,
  timestamp: "2026-01-01T00:00:01Z",
};

const event3 = {
  type: "model_requested" as const,
  stepIndex: 1,
  timestamp: "2026-01-01T00:00:02Z",
};

describe("TranscriptReader", () => {
  it("returns empty events when transcript.jsonl does not exist", () => {
    const dir = makeTmpDir();
    const reader = new TranscriptReader(dir);
    const result = reader.readNewEvents();
    expect(result.events).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("reads events from transcript.jsonl", () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "transcript.jsonl");
    fs.writeFileSync(
      filePath,
      JSON.stringify(event1) + "\n" + JSON.stringify(event2) + "\n",
    );

    const reader = new TranscriptReader(dir);
    const result = reader.readNewEvents();
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toEqual(event1);
    expect(result.events[1]).toEqual(event2);
    expect(result.errors).toEqual([]);
  });

  it("reads incrementally from byte offset", () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "transcript.jsonl");
    fs.writeFileSync(
      filePath,
      JSON.stringify(event1) + "\n" + JSON.stringify(event2) + "\n",
    );

    const reader = new TranscriptReader(dir);

    // First read: get 2 events
    const first = reader.readNewEvents();
    expect(first.events).toHaveLength(2);

    // Append a third event
    fs.appendFileSync(filePath, JSON.stringify(event3) + "\n");

    // Second read: get only the new event
    const second = reader.readNewEvents();
    expect(second.events).toHaveLength(1);
    expect(second.events[0]).toEqual(event3);
    expect(second.errors).toEqual([]);
  });

  it("handles malformed JSONL lines gracefully", () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "transcript.jsonl");
    fs.writeFileSync(
      filePath,
      JSON.stringify(event1) +
        "\n" +
        "this is not valid json\n" +
        JSON.stringify(event2) +
        "\n",
    );

    const reader = new TranscriptReader(dir);
    const result = reader.readNewEvents();
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toEqual(event1);
    expect(result.events[1]).toEqual(event2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/Failed to parse JSONL line/);
  });

  it("handles empty lines in JSONL", () => {
    const dir = makeTmpDir();
    const filePath = path.join(dir, "transcript.jsonl");
    fs.writeFileSync(
      filePath,
      JSON.stringify(event1) +
        "\n\n\n" +
        JSON.stringify(event2) +
        "\n\n",
    );

    const reader = new TranscriptReader(dir);
    const result = reader.readNewEvents();
    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toEqual(event1);
    expect(result.events[1]).toEqual(event2);
    expect(result.errors).toEqual([]);
  });

  it("readState returns AgentRunStateData", () => {
    const dir = makeTmpDir();
    const stateData = {
      runId: "run-1",
      status: "running",
      task: "test",
      cwd: "/tmp",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:01Z",
      stepIndex: 0,
      transcriptPath: path.join(dir, "transcript.jsonl"),
    };
    fs.writeFileSync(
      path.join(dir, "state.json"),
      JSON.stringify(stateData),
    );

    const reader = new TranscriptReader(dir);
    const state = reader.readState();
    expect(state).toEqual(stateData);
  });

  it("readState returns undefined for missing state.json", () => {
    const dir = makeTmpDir();
    const reader = new TranscriptReader(dir);
    expect(reader.readState()).toBeUndefined();
  });

  it("readState returns undefined for invalid JSON in state.json", () => {
    const dir = makeTmpDir();
    fs.writeFileSync(path.join(dir, "state.json"), "not valid json {{{");

    const reader = new TranscriptReader(dir);
    expect(reader.readState()).toBeUndefined();
  });
});
