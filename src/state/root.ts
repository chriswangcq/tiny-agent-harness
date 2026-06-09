import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as os from "node:os";
import type { ProjectConfig, StateRootInfo } from "./types.js";

type StateMode = ProjectConfig["stateMode"];

type StateRootFsPort = Pick<
  typeof fs,
  "existsSync" | "mkdirSync" | "readFileSync" | "writeFileSync"
>;

export type StateRootResolverDeps = {
  env?: Record<string, string | undefined>;
  cwd?: () => string;
  homeDir?: () => string;
  nowIso?: () => string;
  fs?: StateRootFsPort;
};

export type StateRootPlan = {
  stateDir: string;
  projectRoot: string;
  projectId: string;
  stateMode: StateMode;
};

export function buildProjectId(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  const basename = path.basename(resolved);
  const slug =
    basename
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project";
  const hash = crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 12);
  return `${slug}-${hash}`;
}

export class StateRootResolver {
  private readonly env: Record<string, string | undefined>;
  private readonly cwd: () => string;
  private readonly homeDir: () => string;
  private readonly nowIso: () => string;
  private readonly fs: StateRootFsPort;

  constructor(deps: StateRootResolverDeps = {}) {
    this.env = deps.env ?? process.env;
    this.cwd = deps.cwd ?? (() => process.cwd());
    this.homeDir = deps.homeDir ?? (() => os.homedir());
    this.nowIso = deps.nowIso ?? (() => new Date().toISOString());
    this.fs = deps.fs ?? fs;
  }

  resolve(options?: { stateDir?: string }): StateRootInfo {
    const plan = this.plan(options);
    return this.ensureStateRoot(plan.stateDir, {
      projectRoot: plan.projectRoot,
      stateMode: plan.stateMode,
    });
  }

  plan(options?: { stateDir?: string }): StateRootPlan {
    const cwd = this.cwd();
    const projectRoot = this.findProjectRoot(cwd);
    const projectId = buildProjectId(projectRoot);

    if (options?.stateDir) {
      return {
        stateDir: this.resolvePath(options.stateDir),
        projectRoot,
        projectId,
        stateMode: "explicit",
      };
    }

    const envDir = this.env.TAH_STATE_DIR;
    if (envDir) {
      return {
        stateDir: this.resolvePath(envDir),
        projectRoot,
        projectId,
        stateMode: "explicit",
      };
    }

    const stateDir = path.join(
      this.homeDir(),
      ".tiny-agent",
      "projects",
      projectId,
    );
    return {
      stateDir,
      projectRoot,
      projectId,
      stateMode: "home-project",
    };
  }

  private findProjectRoot(startDir: string): string {
    let current = path.resolve(startDir);
    while (true) {
      if (
        this.fs.existsSync(path.join(current, ".git")) ||
        this.fs.existsSync(path.join(current, "package.json"))
      ) {
        return current;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        return path.resolve(startDir);
      }
      current = parent;
    }
  }

  private ensureStateRoot(
    stateDir: string,
    options: {
      projectRoot: string;
      stateMode: StateMode;
    },
  ): StateRootInfo {
    const resolvedStateDir = this.resolvePath(stateDir);
    this.fs.mkdirSync(resolvedStateDir, { recursive: true });

    const projectJsonPath = path.join(resolvedStateDir, "project.json");
    if (this.fs.existsSync(projectJsonPath)) {
      const config = this.readProjectConfig(projectJsonPath);
      return {
        stateDir: resolvedStateDir,
        projectRoot: config.projectRoot,
        projectConfig: config,
      };
    }

    const now = this.nowIso();
    const config: ProjectConfig = {
      schemaVersion: 1,
      projectId: buildProjectId(options.projectRoot),
      projectRoot: path.resolve(options.projectRoot),
      stateMode: options.stateMode,
      createdAt: now,
      updatedAt: now,
    };

    this.fs.writeFileSync(projectJsonPath, JSON.stringify(config, null, 2), "utf-8");

    for (const sub of ["locks", "runs", "skills", "launcher", "tmp"]) {
      this.fs.mkdirSync(path.join(resolvedStateDir, sub), { recursive: true });
    }

    return {
      stateDir: resolvedStateDir,
      projectRoot: config.projectRoot,
      projectConfig: config,
    };
  }

  private resolvePath(input: string): string {
    return path.resolve(this.cwd(), input);
  }

  private readProjectConfig(projectJsonPath: string): ProjectConfig {
    const parsed = JSON.parse(this.fs.readFileSync(projectJsonPath, "utf-8")) as Partial<ProjectConfig>;
    if (parsed.schemaVersion !== 1) {
      throw new Error(`Unsupported state project schema at ${projectJsonPath}`);
    }
    if (typeof parsed.projectId !== "string" || parsed.projectId.length === 0) {
      throw new Error(`Invalid state projectId at ${projectJsonPath}`);
    }
    if (typeof parsed.projectRoot !== "string" || parsed.projectRoot.length === 0) {
      throw new Error(`Invalid state projectRoot at ${projectJsonPath}`);
    }
    if (parsed.stateMode !== "home-project" && parsed.stateMode !== "explicit") {
      throw new Error(`Unsupported stateMode at ${projectJsonPath}`);
    }
    if (typeof parsed.createdAt !== "string" || typeof parsed.updatedAt !== "string") {
      throw new Error(`Invalid state timestamps at ${projectJsonPath}`);
    }
    return parsed as ProjectConfig;
  }
}
