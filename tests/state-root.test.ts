import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateRootResolver, buildProjectId } from "../src/state/root.js";

describe("StateRootResolver", () => {
  let resolver: StateRootResolver;
  let tmpDir: string;
  let homeDir: string;
  let originalCwd: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tah-test-")));
    homeDir = path.join(tmpDir, "home");
    fs.mkdirSync(homeDir, { recursive: true });
    originalCwd = process.cwd();
    originalEnv = process.env.TAH_STATE_DIR;
    delete process.env.TAH_STATE_DIR;
    resolver = new StateRootResolver({
      homeDir: () => homeDir,
      nowIso: () => "2026-06-09T00:00:00.000Z",
    });
  });

  afterEach(() => {
    process.chdir(originalCwd);
    if (originalEnv !== undefined) {
      process.env.TAH_STATE_DIR = originalEnv;
    } else {
      delete process.env.TAH_STATE_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("resolves with explicit stateDir option", () => {
    const stateDir = path.join(tmpDir, "explicit-state");
    process.chdir(tmpDir);
    const result = resolver.resolve({ stateDir });

    expect(result.stateDir).toBe(stateDir);
    expect(result.projectRoot).toBe(tmpDir);
    expect(result.projectConfig.stateMode).toBe("explicit");
    expect(fs.existsSync(path.join(stateDir, "project.json"))).toBe(true);
  });

  it("resolves with TAH_STATE_DIR env var", () => {
    const stateDir = path.join(tmpDir, "env-state");
    process.env.TAH_STATE_DIR = stateDir;
    process.chdir(tmpDir);

    const result = resolver.resolve();

    expect(result.stateDir).toBe(stateDir);
    expect(result.projectRoot).toBe(tmpDir);
    expect(result.projectConfig.stateMode).toBe("explicit");
    expect(fs.existsSync(path.join(stateDir, "project.json"))).toBe(true);
  });

  it("uses a home-scoped project state root by default", () => {
    process.chdir(tmpDir);

    const result = resolver.resolve();

    const expectedStateDir = path.join(
      homeDir,
      ".tiny-agent",
      "projects",
      buildProjectId(tmpDir),
    );
    expect(result.stateDir).toBe(expectedStateDir);
    expect(result.projectRoot).toBe(tmpDir);
    expect(result.projectConfig.stateMode).toBe("home-project");
    expect(fs.existsSync(path.join(expectedStateDir, "project.json"))).toBe(true);
  });

  it("can plan the default state root without creating files", () => {
    process.chdir(tmpDir);

    const plan = resolver.plan();

    expect(plan.stateDir).toBe(
      path.join(homeDir, ".tiny-agent", "projects", buildProjectId(tmpDir)),
    );
    expect(plan.projectRoot).toBe(tmpDir);
    expect(plan.stateMode).toBe("home-project");
    expect(fs.existsSync(plan.stateDir)).toBe(false);
  });

  it("finds a stable project root from nested package directories", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}", "utf-8");
    const subdir2 = path.join(tmpDir, "subdir", "subdir2");
    fs.mkdirSync(subdir2, { recursive: true });
    process.chdir(subdir2);

    const result = resolver.resolve();

    expect(result.projectRoot).toBe(tmpDir);
    expect(result.stateDir).toBe(
      path.join(homeDir, ".tiny-agent", "projects", buildProjectId(tmpDir)),
    );
    expect(result.projectConfig.projectId).toBe(buildProjectId(tmpDir));
  });

  it("does not auto-discover a repo-local .tiny-agent project", () => {
    fs.writeFileSync(path.join(tmpDir, "package.json"), "{}", "utf-8");
    const legacyStateDir = path.join(tmpDir, ".tiny-agent");
    fs.mkdirSync(legacyStateDir, { recursive: true });
    fs.writeFileSync(
      path.join(legacyStateDir, "project.json"),
      JSON.stringify({
        schemaVersion: 1,
        projectId: "legacy-project",
        projectRoot: tmpDir,
        stateMode: "home-project",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      "utf-8",
    );

    process.chdir(path.join(tmpDir));
    const result = resolver.resolve();

    expect(result.stateDir).not.toBe(legacyStateDir);
    expect(result.projectConfig.projectId).not.toBe("legacy-project");
  });

  it("creates standard subdirectories", () => {
    const stateDir = path.join(tmpDir, "explicit-state");
    process.chdir(tmpDir);
    resolver.resolve({ stateDir });

    const expectedSubs = ["locks", "runs", "skills", "launcher", "tmp"];
    for (const sub of expectedSubs) {
      expect(fs.existsSync(path.join(stateDir, sub))).toBe(true);
    }

    const runScopedSubs = ["sessions", "environment", "im", "skill-runs"];
    for (const sub of runScopedSubs) {
      expect(fs.existsSync(path.join(stateDir, sub))).toBe(false);
    }
  });

  it("project.json has correct schema", () => {
    const stateDir = path.join(tmpDir, "explicit-state");
    process.chdir(tmpDir);
    resolver.resolve({ stateDir });

    const raw = fs.readFileSync(path.join(stateDir, "project.json"), "utf-8");
    const config = JSON.parse(raw);

    expect(config.schemaVersion).toBe(1);
    expect(config.stateMode).toBe("explicit");
    expect(config.projectId).toBe(buildProjectId(tmpDir));
    expect(config.createdAt).toBe("2026-06-09T00:00:00.000Z");
    expect(config.updatedAt).toBe("2026-06-09T00:00:00.000Z");
    expect(config.projectRoot).toBe(tmpDir);
  });

  it("rejects obsolete project-local configs instead of silently reusing them", () => {
    const stateDir = path.join(tmpDir, "obsolete-state");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(
      path.join(stateDir, "project.json"),
      JSON.stringify({
        schemaVersion: 1,
        projectId: "old",
        projectRoot: tmpDir,
        stateMode: "project-local",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      "utf-8",
    );

    expect(() => resolver.resolve({ stateDir })).toThrow(/Unsupported stateMode/);
  });
});
