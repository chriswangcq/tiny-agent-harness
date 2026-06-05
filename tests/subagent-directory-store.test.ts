import { describe, expect, it } from "vitest";
import {
  planTeamDirectoryLayout,
  planRunScopedTeamPaths,
  DEFAULT_TEAM_DIR,
  type TeamDirectoryLayout,
  type RunScopedTeamPaths,
} from "../src/subagent/directory-store.js";
import {
  createTeamDirectorySnapshot,
  validateTeamDirectorySnapshot,
  type TeamDirectorySnapshot,
} from "../src/subagent/directory-store.js";
import {
  createInMemoryFsPort,
  readTeamDirectory,
  writeTeamDirectory,
  type FsPort,
} from "../src/subagent/directory-store.js";
import { createContactRegistryState } from "../src/subagent/contact-registry.js";

// ---------------------------------------------------------------------------
// Path planner tests
// ---------------------------------------------------------------------------
describe("team directory path planner", () => {
  it("computes project-scoped layout from project root", () => {
    const layout = planTeamDirectoryLayout("/home/project");
    expect(layout.teamDir).toBe("/home/project/.tiny-agent/team");
    expect(layout.registryFile).toBe(
      "/home/project/.tiny-agent/team/contact-registry.json"
    );
    expect(layout.eventsFile).toBe(
      "/home/project/.tiny-agent/team/events.jsonl"
    );
    expect(layout.runsDir).toBe("/home/project/.tiny-agent/team/runs");
  });

  it("produces distinct paths for different roots", () => {
    const a = planTeamDirectoryLayout("/a");
    const b = planTeamDirectoryLayout("/b");
    expect(a.teamDir).not.toBe(b.teamDir);
    expect(a.registryFile).not.toBe(b.registryFile);
  });

  it("uses DEFAULT_TEAM_DIR constant in paths", () => {
    expect(DEFAULT_TEAM_DIR).toBe(".tiny-agent/team");
    const layout = planTeamDirectoryLayout("/root");
    expect(layout.teamDir).toContain(DEFAULT_TEAM_DIR);
  });

  it("computes run-scoped paths under .tiny-agent/runs/<runId>/team/", () => {
    const paths = planRunScopedTeamPaths("/root", "run-123");
    // Run-scoped team state lives under .tiny-agent/runs/<runId>/team/
    expect(paths.runTeamDir).toBe(
      "/root/.tiny-agent/runs/run-123/team"
    );
    expect(paths.runRegistryFile).toBe(
      "/root/.tiny-agent/runs/run-123/team/contact-registry.json"
    );
    expect(paths.runEventsFile).toBe(
      "/root/.tiny-agent/runs/run-123/team/events.jsonl"
    );
  });

  it("handles trailing slashes in project root gracefully", () => {
    const a = planTeamDirectoryLayout("/root/");
    const b = planTeamDirectoryLayout("/root");
    expect(a.teamDir).toBe("/root/.tiny-agent/team");
  });
});

// ---------------------------------------------------------------------------
// Snapshot schema tests
// ---------------------------------------------------------------------------
describe("team directory snapshot", () => {
  // fixed clock to avoid hidden global Date dependency in tests
  const T0 = "2026-06-05T12:00:00.000Z";

  it("creates a snapshot from ContactRegistryState with explicit now", () => {
    const state = createContactRegistryState("team-p6");
    const snapshot = createTeamDirectorySnapshot(state, T0);

    expect(snapshot.schemaVersion).toBe(1);
    expect(snapshot.registryId).toBe("team-p6");
    expect(snapshot.registry).toBe(state);
    expect(snapshot.createdAt).toBe(T0);
    expect(snapshot.updatedAt).toBe(T0);
  });

  it("round-trips through JSON serialization", () => {
    const state = createContactRegistryState("team-p6");
    const original = createTeamDirectorySnapshot(state, T0);
    const json = JSON.stringify(original);
    const parsed = JSON.parse(json) as TeamDirectorySnapshot;

    expect(parsed.schemaVersion).toBe(original.schemaVersion);
    expect(parsed.registryId).toBe(original.registryId);
    expect(parsed.createdAt).toBe(original.createdAt);
    expect(parsed.updatedAt).toBe(original.updatedAt);
    expect(parsed.registry.registryId).toBe(state.registryId);
    expect(parsed.registry.workers).toEqual(state.workers);
  });

  it("validates a well-formed snapshot", () => {
    const state = createContactRegistryState("team-p6");
    const snapshot = createTeamDirectorySnapshot(state, T0);
    const result = validateTeamDirectorySnapshot(snapshot);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects snapshot with wrong schemaVersion", () => {
    const snapshot = {
      schemaVersion: 99,
      registryId: "team-p6",
      createdAt: T0,
      updatedAt: T0,
      registry: createContactRegistryState("team-p6"),
    } as TeamDirectorySnapshot;

    const result = validateTeamDirectorySnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("Unsupported schemaVersion: 99");
  });

  it("rejects snapshot with missing registry", () => {
    const snapshot = {
      schemaVersion: 1,
      registryId: "team-p6",
      createdAt: T0,
      updatedAt: T0,
      registry: null,
    } as unknown as TeamDirectorySnapshot;

    const result = validateTeamDirectorySnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("registry"))).toBe(true);
  });

  it("rejects snapshot with mismatched registryId", () => {
    const state = createContactRegistryState("team-A");
    const snapshot = {
      schemaVersion: 1,
      registryId: "team-B",
      createdAt: T0,
      updatedAt: T0,
      registry: state,
    };

    const result = validateTeamDirectorySnapshot(snapshot);
    expect(result.valid).toBe(false);
    expect(
      result.errors.some((e) => e.includes("registryId"))
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// In-memory FS port tests
// ---------------------------------------------------------------------------
describe("in-memory FS port", () => {
  it("stores and retrieves data", async () => {
    const fs = createInMemoryFsPort();
    await fs.mkdir("/data");
    await fs.writeFile("/data/test.json", '{"key":"value"}');
    const content = await fs.readFile("/data/test.json");
    expect(content).toBe('{"key":"value"}');
  });

  it("throws on read of missing file", async () => {
    const fs = createInMemoryFsPort();
    await expect(fs.readFile("/nonexistent")).rejects.toThrow(
      "ENOENT"
    );
  });

  it("mkdir is idempotent", async () => {
    const fs = createInMemoryFsPort();
    await fs.mkdir("/data");
    await fs.mkdir("/data"); // should not throw
    await fs.writeFile("/data/f.txt", "ok");
    expect(await fs.readFile("/data/f.txt")).toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// Repository read/write tests
// ---------------------------------------------------------------------------
describe("team directory repository", () => {
  const T0 = "2026-06-05T12:00:00.000Z";

  it("writes and reads a snapshot round-trip", async () => {
    const fs = createInMemoryFsPort();
    const state = createContactRegistryState("team-p6");
    const snapshot = createTeamDirectorySnapshot(state, T0);

    const layout = planTeamDirectoryLayout("/root");
    await writeTeamDirectory(fs, layout, snapshot);

    const restored = await readTeamDirectory(fs, layout);
    expect(restored.schemaVersion).toBe(snapshot.schemaVersion);
    expect(restored.registryId).toBe(snapshot.registryId);
    expect(restored.registry.registryId).toBe(state.registryId);
    expect(restored.registry.workers).toEqual(state.workers);
  });

  it("rejects read when registry file is missing", async () => {
    const fs = createInMemoryFsPort();
    const layout = planTeamDirectoryLayout("/root");
    await expect(readTeamDirectory(fs, layout)).rejects.toThrow(
      "Team directory not found"
    );
  });

  it("rejects read when JSON is malformed", async () => {
    const fs = createInMemoryFsPort();
    const layout = planTeamDirectoryLayout("/root");
    await fs.mkdir(layout.teamDir);
    await fs.writeFile(layout.registryFile, "not json at all");
    await expect(readTeamDirectory(fs, layout)).rejects.toThrow();
  });

  it("rejects read when snapshot validation fails", async () => {
    const fs = createInMemoryFsPort();
    const layout = planTeamDirectoryLayout("/root");
    const badSnapshot = {
      schemaVersion: 99,
      registryId: "x",
      createdAt: T0,
      updatedAt: T0,
      registry: createContactRegistryState("x"),
    };
    await fs.mkdir(layout.teamDir);
    await fs.writeFile(layout.registryFile, JSON.stringify(badSnapshot));
    await expect(readTeamDirectory(fs, layout)).rejects.toThrow(
      "Invalid team directory snapshot"
    );
  });

  it("write creates parent directory automatically", async () => {
    const fs = createInMemoryFsPort();
    const state = createContactRegistryState("team-p6");
    const snapshot = createTeamDirectorySnapshot(state, T0);
    const layout = planTeamDirectoryLayout("/root");

    // No mkdir beforehand
    await writeTeamDirectory(fs, layout, snapshot);

    const restored = await readTeamDirectory(fs, layout);
    expect(restored.registryId).toBe("team-p6");
  });

  it("maintains createdAt on subsequent writes", async () => {
    const fs = createInMemoryFsPort();
    const state = createContactRegistryState("team-p6");
    const layout = planTeamDirectoryLayout("/root");

    const first = createTeamDirectorySnapshot(state, T0);
    await writeTeamDirectory(fs, layout, first);
    const read1 = await readTeamDirectory(fs, layout);

    // Write again, updatedAt advances but createdAt stays
    const later = createTeamDirectorySnapshot(
      read1.registry,
      read1.createdAt, // pass through original createdAt
    );
    await writeTeamDirectory(fs, layout, later);
    const read2 = await readTeamDirectory(fs, layout);
    expect(read2.createdAt).toBe(read1.createdAt);
  });
});
