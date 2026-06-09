import { describe, expect, it } from "vitest";
import {
  DEFAULT_TEAM_DIR,
  createInMemoryFsPort,
  createTeamDirectorySnapshot,
  planRunScopedTeamPaths,
  planTeamDirectoryLayout,
  readTeamDirectory,
  validateTeamDirectorySnapshot,
  writeTeamDirectory,
  type TeamDirectorySnapshot,
} from "../src/subagent/directory-store.js";
import { createTeamRosterState } from "../src/subagent/team-roster.js";

describe("team directory path planner", () => {
  it("computes project-scoped layout from state root", () => {
    const layout = planTeamDirectoryLayout("/home/project");
    expect(layout.teamDir).toBe("/home/project/team");
    expect(layout.rosterFile).toBe("/home/project/team/roster.json");
    expect(layout.eventsFile).toBe("/home/project/team/events.jsonl");
    expect(layout.runsDir).toBe("/home/project/team/runs");
  });

  it("produces distinct paths for different roots", () => {
    const a = planTeamDirectoryLayout("/a");
    const b = planTeamDirectoryLayout("/b");
    expect(a.teamDir).not.toBe(b.teamDir);
    expect(a.rosterFile).not.toBe(b.rosterFile);
  });

  it("uses DEFAULT_TEAM_DIR constant in paths", () => {
    expect(DEFAULT_TEAM_DIR).toBe("team");
    const layout = planTeamDirectoryLayout("/root");
    expect(layout.teamDir).toContain(DEFAULT_TEAM_DIR);
  });

  it("computes run-scoped paths under runs/<runId>/team/", () => {
    const paths = planRunScopedTeamPaths("/root", "run-123");
    expect(paths.runTeamDir).toBe("/root/runs/run-123/team");
    expect(paths.runRosterFile).toBe("/root/runs/run-123/team/roster.json");
    expect(paths.runEventsFile).toBe("/root/runs/run-123/team/events.jsonl");
  });

  it("handles trailing slashes in state root gracefully", () => {
    const a = planTeamDirectoryLayout("/root/");
    expect(a.teamDir).toBe("/root/team");
  });
});

describe("team directory snapshot", () => {
  const T0 = "2026-06-05T12:00:00.000Z";

  it("creates a snapshot from TeamRosterState with explicit now", () => {
    const state = createTeamRosterState("team-p6");
    const snapshot = createTeamDirectorySnapshot(state, T0);

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.teamId).toBe("team-p6");
    expect(snapshot.roster).toBe(state);
    expect(snapshot.createdAt).toBe(T0);
    expect(snapshot.updatedAt).toBe(T0);
  });

  it("round-trips through JSON serialization", () => {
    const state = createTeamRosterState("team-p6");
    const original = createTeamDirectorySnapshot(state, T0);
    const parsed = JSON.parse(JSON.stringify(original)) as TeamDirectorySnapshot;

    expect(parsed.schemaVersion).toBe(original.schemaVersion);
    expect(parsed.teamId).toBe(original.teamId);
    expect(parsed.createdAt).toBe(original.createdAt);
    expect(parsed.updatedAt).toBe(original.updatedAt);
    expect(parsed.roster.teamId).toBe(state.teamId);
    expect(parsed.roster.members).toEqual(state.members);
  });

  it("validates a well-formed snapshot", () => {
    const state = createTeamRosterState("team-p6");
    const snapshot = createTeamDirectorySnapshot(state, T0);
    const result = validateTeamDirectorySnapshot(snapshot);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects snapshot with wrong schemaVersion", () => {
    const snapshot = {
      schemaVersion: 99,
      teamId: "team-p6",
      createdAt: T0,
      updatedAt: T0,
      roster: createTeamRosterState("team-p6"),
    } as TeamDirectorySnapshot;

    const result = validateTeamDirectorySnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Unsupported schemaVersion: 99");
  });

  it("rejects snapshot with missing roster", () => {
    const snapshot = {
      schemaVersion: 1,
      teamId: "team-p6",
      createdAt: T0,
      updatedAt: T0,
      roster: null,
    } as unknown as TeamDirectorySnapshot;

    const result = validateTeamDirectorySnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("roster"))).toBe(true);
  });

  it("rejects snapshot with mismatched teamId", () => {
    const state = createTeamRosterState("team-A");
    const snapshot = {
      schemaVersion: 1,
      teamId: "team-B",
      createdAt: T0,
      updatedAt: T0,
      roster: state,
    };

    const result = validateTeamDirectorySnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("teamId"))).toBe(true);
  });
});

describe("in-memory FS port", () => {
  it("stores and retrieves data", async () => {
    const fs = createInMemoryFsPort();
    await fs.mkdir("/data");
    await fs.writeFile("/data/test.json", '{"key":"value"}');
    expect(await fs.readFile("/data/test.json")).toBe('{"key":"value"}');
  });

  it("throws on read of missing file", async () => {
    const fs = createInMemoryFsPort();
    await expect(fs.readFile("/nonexistent")).rejects.toThrow("ENOENT");
  });

  it("mkdir is idempotent", async () => {
    const fs = createInMemoryFsPort();
    await fs.mkdir("/data");
    await fs.mkdir("/data");
    await fs.writeFile("/data/f.txt", "ok");
    expect(await fs.readFile("/data/f.txt")).toBe("ok");
  });
});

describe("team directory repository", () => {
  const T0 = "2026-06-05T12:00:00.000Z";

  it("writes and reads a snapshot round-trip", async () => {
    const fs = createInMemoryFsPort();
    const state = createTeamRosterState("team-p6");
    const snapshot = createTeamDirectorySnapshot(state, T0);

    const layout = planTeamDirectoryLayout("/root");
    await writeTeamDirectory(fs, layout, snapshot);

    const restored = await readTeamDirectory(fs, layout);
    expect(restored.schemaVersion).toBe(snapshot.schemaVersion);
    expect(restored.teamId).toBe(snapshot.teamId);
    expect(restored.roster.teamId).toBe(state.teamId);
    expect(restored.roster.members).toEqual(state.members);
  });

  it("rejects read when roster file is missing", async () => {
    const fs = createInMemoryFsPort();
    const layout = planTeamDirectoryLayout("/root");
    await expect(readTeamDirectory(fs, layout)).rejects.toThrow(
      "Team roster not found",
    );
  });

  it("rejects read when JSON is malformed", async () => {
    const fs = createInMemoryFsPort();
    const layout = planTeamDirectoryLayout("/root");
    await fs.mkdir(layout.teamDir);
    await fs.writeFile(layout.rosterFile, "not json at all");
    await expect(readTeamDirectory(fs, layout)).rejects.toThrow();
  });

  it("rejects read when snapshot validation fails", async () => {
    const fs = createInMemoryFsPort();
    const layout = planTeamDirectoryLayout("/root");
    const badSnapshot = {
      schemaVersion: 99,
      teamId: "x",
      createdAt: T0,
      updatedAt: T0,
      roster: createTeamRosterState("x"),
    };
    await fs.mkdir(layout.teamDir);
    await fs.writeFile(layout.rosterFile, JSON.stringify(badSnapshot));
    await expect(readTeamDirectory(fs, layout)).rejects.toThrow(
      "Invalid team directory snapshot",
    );
  });

  it("write creates parent directory automatically", async () => {
    const fs = createInMemoryFsPort();
    const state = createTeamRosterState("team-p6");
    const snapshot = createTeamDirectorySnapshot(state, T0);
    const layout = planTeamDirectoryLayout("/root");

    await writeTeamDirectory(fs, layout, snapshot);

    const restored = await readTeamDirectory(fs, layout);
    expect(restored.teamId).toBe("team-p6");
  });

  it("maintains createdAt on subsequent writes", async () => {
    const fs = createInMemoryFsPort();
    const state = createTeamRosterState("team-p6");
    const layout = planTeamDirectoryLayout("/root");

    const first = createTeamDirectorySnapshot(state, T0);
    await writeTeamDirectory(fs, layout, first);
    const read1 = await readTeamDirectory(fs, layout);

    const later = createTeamDirectorySnapshot(
      read1.roster,
      "2026-06-05T13:00:00.000Z",
      read1.createdAt,
    );
    await writeTeamDirectory(fs, layout, later);
    const read2 = await readTeamDirectory(fs, layout);
    expect(read2.createdAt).toBe(read1.createdAt);
    expect(read2.updatedAt).toBe("2026-06-05T13:00:00.000Z");
  });
});
