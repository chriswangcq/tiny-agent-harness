import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { ProjectConfig, StateRootInfo } from "./types.js";

export class StateRootResolver {
  resolve(options?: { stateDir?: string }): StateRootInfo {
    // 1. Explicit --state-dir option
    if (options?.stateDir) {
      return this.ensureStateRoot(options.stateDir);
    }

    // 2. TAH_STATE_DIR environment variable
    const envDir = process.env.TAH_STATE_DIR;
    if (envDir) {
      return this.ensureStateRoot(envDir);
    }

    // 3. Walk up from cwd to find existing .tiny-agent/project.json
    const found = this.walkUpForStateRoot(process.cwd());
    if (found) {
      return found;
    }

    // 4. Create in current working directory
    const stateDir = path.join(process.cwd(), ".tiny-agent");
    return this.ensureStateRoot(stateDir);
  }

  private walkUpForStateRoot(startDir: string): StateRootInfo | undefined {
    let current = path.resolve(startDir);
    while (true) {
      const stateDir = path.join(current, ".tiny-agent");
      const projectJsonPath = path.join(stateDir, "project.json");
      if (fs.existsSync(projectJsonPath)) {
        try {
          const config = JSON.parse(fs.readFileSync(projectJsonPath, "utf-8")) as ProjectConfig;
          return { stateDir, projectRoot: current, projectConfig: config };
        } catch {
          // Invalid project.json, skip
        }
      }
      const parent = path.dirname(current);
      if (parent === current) break; // reached filesystem root
      current = parent;
    }
    return undefined;
  }

  private ensureStateRoot(stateDir: string): StateRootInfo {
    const resolvedStateDir = path.resolve(stateDir);
    fs.mkdirSync(resolvedStateDir, { recursive: true });

    const projectJsonPath = path.join(resolvedStateDir, "project.json");
    if (fs.existsSync(projectJsonPath)) {
      const config = JSON.parse(fs.readFileSync(projectJsonPath, "utf-8")) as ProjectConfig;
      return { stateDir: resolvedStateDir, projectRoot: path.dirname(resolvedStateDir), projectConfig: config };
    }

    // Create new project.json
    const now = new Date().toISOString();
    const config: ProjectConfig = {
      schemaVersion: 1,
      projectId: `proj-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`,
      projectRoot: path.dirname(resolvedStateDir),
      stateMode: "project-local",
      createdAt: now,
      updatedAt: now,
    };

    fs.writeFileSync(projectJsonPath, JSON.stringify(config, null, 2), "utf-8");

    // Create standard subdirectories
    for (const sub of ["locks", "runs", "sessions", "environment", "im", "skills", "skill-runs", "tmp"]) {
      fs.mkdirSync(path.join(resolvedStateDir, sub), { recursive: true });
    }

    return { stateDir: resolvedStateDir, projectRoot: path.dirname(resolvedStateDir), projectConfig: config };
  }
}
