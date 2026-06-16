import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  PublicImService,
  createInMemoryImStore,
  type PublicImServicePorts,
} from "../src/im/index.js";
import { ProjectSnapshotProjector } from "../src/runtime/project-snapshot.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("ProjectSnapshotProjector", () => {
  it("tails transcript events instead of rebuilding the run view on every snapshot", async () => {
    const stateRoot = makeStateRoot();
    const runDir = path.join(stateRoot, "runs", "run-1");
    fs.mkdirSync(runDir, { recursive: true });
    writeState(runDir, { stepIndex: 0, updatedAt: "2026-06-15T00:00:00.000Z" });
    appendEvent(runDir, {
      type: "run_started",
      runId: "run-1",
      task: "test task",
      cwd: "/repo",
      timestamp: "2026-06-15T00:00:00.000Z",
    });

    const projector = new ProjectSnapshotProjector({
      stateRoot,
      imService: makeImService(),
    });

    try {
      const first = await projector.snapshot({ selectedRunId: "run-1" });
      expect(first.view.loop.map((frame) => frame.title)).toEqual(["run started"]);

      appendEvent(runDir, {
        type: "model_requested",
        stepIndex: 1,
        timestamp: "2026-06-15T00:00:01.000Z",
      });
      writeState(runDir, { stepIndex: 1, updatedAt: "2026-06-15T00:00:01.000Z" });

      const second = await projector.snapshot({ selectedRunId: "run-1" });
      expect(second.view.loop.map((frame) => frame.title)).toEqual([
        "run started",
        "model requested",
      ]);

      const third = await projector.snapshot({ selectedRunId: "run-1" });
      expect(third.view.loop.map((frame) => frame.title)).toEqual([
        "run started",
        "model requested",
      ]);
    } finally {
      projector.dispose();
    }
  });
});

function makeStateRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "project-snapshot-"));
  tmpDirs.push(dir);
  return dir;
}

function makeImService(): PublicImService {
  const ports: PublicImServicePorts = {
    store: createInMemoryImStore(),
    clock: { nowIso: () => "2026-06-15T00:00:00.000Z" },
    ids: { newMessageId: (seed) => `msg-${seed}` },
  };
  return new PublicImService(ports);
}

function writeState(
  runDir: string,
  input: { stepIndex: number; updatedAt: string },
): void {
  fs.writeFileSync(
    path.join(runDir, "state.json"),
    JSON.stringify({
      runId: "run-1",
      status: "running",
      task: "test task",
      cwd: "/repo",
      createdAt: "2026-06-15T00:00:00.000Z",
      updatedAt: input.updatedAt,
      stepIndex: input.stepIndex,
      transcriptPath: path.join(runDir, "transcript.jsonl"),
    }),
  );
}

function appendEvent(runDir: string, event: Record<string, unknown>): void {
  fs.appendFileSync(
    path.join(runDir, "transcript.jsonl"),
    `${JSON.stringify(event)}\n`,
  );
}
