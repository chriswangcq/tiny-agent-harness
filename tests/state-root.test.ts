import { describe, it, expect, afterEach, beforeEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { StateRootResolver } from "../src/state/root.js";

describe("StateRootResolver", () => {
  let resolver: StateRootResolver;
  let tmpDir: string;
  let originalCwd: string;
  let originalEnv: string | undefined;

  beforeEach(() => {
    resolver = new StateRootResolver();
    tmpDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "tah-test-")));
    originalCwd = process.cwd();
    originalEnv = process.env.TAH_STATE_DIR;
    delete process.env.TAH_STATE_DIR;
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
    const stateDir = path.join(tmpDir, ".tiny-agent");
    const result = resolver.resolve({ stateDir });

    expect(result.stateDir).toBe(stateDir);
    expect(result.projectRoot).toBe(tmpDir);
    expect(fs.existsSync(path.join(stateDir, "project.json"))).toBe(true);
  });

  it("resolves with TAH_STATE_DIR env var", () => {
    const stateDir = path.join(tmpDir, ".tiny-agent");
    process.env.TAH_STATE_DIR = stateDir;

    const result = resolver.resolve();

    expect(result.stateDir).toBe(stateDir);
    expect(result.projectRoot).toBe(tmpDir);
    expect(fs.existsSync(path.join(stateDir, "project.json"))).toBe(true);
  });

  it("walks up to find existing project.json", () => {
    // Create a project.json at the root tmpDir
    const stateDir = path.join(tmpDir, ".tiny-agent");
    fs.mkdirSync(stateDir, { recursive: true });
    const config = {
      schemaVersion: 1,
      projectId: "proj-existing",
      projectRoot: tmpDir,
      stateMode: "project-local",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(path.join(stateDir, "project.json"), JSON.stringify(config), "utf-8");

    // Create nested subdirectories and chdir into them
    const subdir2 = path.join(tmpDir, "subdir", "subdir2");
    fs.mkdirSync(subdir2, { recursive: true });
    process.chdir(subdir2);

    const result = resolver.resolve();

    expect(result.stateDir).toBe(stateDir);
    expect(result.projectRoot).toBe(tmpDir);
    expect(result.projectConfig.projectId).toBe("proj-existing");
  });

  it("creates .tiny-agent in cwd when nothing found", () => {
    process.chdir(tmpDir);

    const result = resolver.resolve();

    const expectedStateDir = path.join(tmpDir, ".tiny-agent");
    expect(result.stateDir).toBe(expectedStateDir);
    expect(result.projectRoot).toBe(tmpDir);
    expect(fs.existsSync(path.join(expectedStateDir, "project.json"))).toBe(true);
  });

  it("creates standard subdirectories", () => {
    const stateDir = path.join(tmpDir, ".tiny-agent");
    resolver.resolve({ stateDir });

    const expectedSubs = ["locks", "runs", "sessions", "environment", "im", "skills", "skill-runs", "tmp"];
    for (const sub of expectedSubs) {
      expect(fs.existsSync(path.join(stateDir, sub))).toBe(true);
    }
  });

  it("project.json has correct schema", () => {
    const stateDir = path.join(tmpDir, ".tiny-agent");
    resolver.resolve({ stateDir });

    const raw = fs.readFileSync(path.join(stateDir, "project.json"), "utf-8");
    const config = JSON.parse(raw);

    expect(config.schemaVersion).toBe(1);
    expect(config.stateMode).toBe("project-local");
    expect(config.projectId).toMatch(/^proj-/);
    expect(config.createdAt).toBeDefined();
    expect(config.updatedAt).toBeDefined();
    expect(config.projectRoot).toBe(tmpDir);
  });
});
