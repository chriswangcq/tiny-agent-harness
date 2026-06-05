import { describe, expect, it } from "vitest";
import {
  planRunScopedWorkerPaths,
  planWorkerLaunch,
  buildSpawnCommand,
  launchLocalWorker,
  DEFAULT_WORKERS_DIR,
  type WorkerLaunchPlan,
  type WorkerLaunchParams,
  type RunScopedWorkerPaths,
  type WorkerSpawnCommand,
  type SpawnPort,
  type GitPort,
  type Clock,
  type IdGenerator,
  type ContactStorePort,
  type WorkerLaunchEffects,
  type WorkerLaunchResult,
} from "../src/subagent/local-worker-launcher.js";
import {
  createContactRegistryState,
  applyContactRegistryEvent,
  type ContactRegistryState,
  type ContactRegistryResult,
  type ContactRegistryEvent,
} from "../src/subagent/contact-registry.js";

// ---------------------------------------------------------------------------
// Fake port implementations
// ---------------------------------------------------------------------------

function fakeClock(iso: string): Clock {
  let current = iso;
  return {
    nowISO: () => {
      const result = current;
      // advance by 1s each call
      current = new Date(new Date(current).getTime() + 1000).toISOString();
      return result;
    },
  };
}

function fakeIdGenerator(prefix: string): IdGenerator {
  let seq = 0;
  return { newId: () => `${prefix}-${++seq}` };
}

function fakeSpawnPort(exitCode: number = 0, pid: number = 12345): SpawnPort {
  return {
    spawn: async (_command, _args, _cwd) => ({
      pid,
      stdout: "fake output",
      stderr: "",
      exitCode,
    }),
  };
}

function fakeGitPort(success: boolean = true): GitPort {
  return {
    checkout: async (_cwd, _branch) =>
      success
        ? { success: true, branch: _branch }
        : { success: false, branch: _branch, error: "mock checkout failure" },
  };
}

function fakeContactStorePort(
  initialState?: ContactRegistryState,
): ContactStorePort {
  let state: ContactRegistryState =
    initialState ?? createContactRegistryState("fake-registry");
  return {
    load: async () => state,
    apply: async (event: ContactRegistryEvent) => {
      const result = applyContactRegistryEvent(state, event);
      if (result.status !== "rejected") {
        state = result.state;
      }
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Path planner tests
// ---------------------------------------------------------------------------

describe("worker path planner", () => {
  it("computes run-scoped worker paths from project root, runId, workerId", () => {
    const paths = planRunScopedWorkerPaths("/root", "run-abc", "worker-1");
    expect(paths.runWorkerDir).toBe(
      "/root/.tiny-agent/runs/run-abc/workers/worker-1"
    );
    expect(paths.runWorkerStateFile).toBe(
      "/root/.tiny-agent/runs/run-abc/workers/worker-1/state.json"
    );
    expect(paths.runWorkerLogFile).toBe(
      "/root/.tiny-agent/runs/run-abc/workers/worker-1/output.log"
    );
  });

  it("uses DEFAULT_WORKERS_DIR constant in paths", () => {
    expect(DEFAULT_WORKERS_DIR).toBe(".tiny-agent/runs");
    const paths = planRunScopedWorkerPaths("/root", "run-abc", "w1");
    expect(paths.runWorkerDir).toContain(".tiny-agent/runs");
  });

  it("produces distinct paths for different workers within same run", () => {
    const a = planRunScopedWorkerPaths("/root", "run-abc", "worker-1");
    const b = planRunScopedWorkerPaths("/root", "run-abc", "worker-2");
    expect(a.runWorkerDir).not.toBe(b.runWorkerDir);
    expect(a.runWorkerStateFile).not.toBe(b.runWorkerStateFile);
  });

  it("strips trailing slashes from project root", () => {
    const paths = planRunScopedWorkerPaths("/root/", "run-abc", "w1");
    expect(paths.runWorkerDir).toBe(
      "/root/.tiny-agent/runs/run-abc/workers/w1"
    );
  });

  it("handles nested paths in project root", () => {
    const paths = planRunScopedWorkerPaths(
      "/home/user/projects/my-app",
      "run-001",
      "coder-1"
    );
    expect(paths.runWorkerDir).toBe(
      "/home/user/projects/my-app/.tiny-agent/runs/run-001/workers/coder-1"
    );
  });
});

// ---------------------------------------------------------------------------
// Launch plan tests
// ---------------------------------------------------------------------------

describe("planWorkerLaunch", () => {
  const baseParams: WorkerLaunchParams = {
    projectRoot: "/home/project",
    runId: "run-001",
    workerId: "coder-1",
    workspace: "/home/workspace",
    branch: "feature/x",
    channel: "worker-coder-1",
    role: "coder",
    allowedActions: ["read", "write", "test"],
    taskPrompt: "Fix the failing tests in auth module",
    now: "2026-06-05T15:00:00.000Z",
  };

  it("returns a complete WorkerLaunchPlan with all fields", () => {
    const plan = planWorkerLaunch(baseParams);
    expect(plan.workerId).toBe("coder-1");
    expect(plan.runId).toBe("run-001");
    expect(plan.workspace).toBe("/home/workspace");
    expect(plan.branch).toBe("feature/x");
    expect(plan.channel).toBe("worker-coder-1");
    expect(plan.role).toBe("coder");
    expect(plan.allowedActions).toEqual(["read", "write", "test"]);
    expect(plan.taskPrompt).toBe("Fix the failing tests in auth module");
    expect(plan.createdAt).toBe("2026-06-05T15:00:00.000Z");
  });

  it("computes run-scoped worker paths in the plan", () => {
    const plan = planWorkerLaunch(baseParams);
    expect(plan.paths.runWorkerDir).toBe(
      "/home/project/.tiny-agent/runs/run-001/workers/coder-1"
    );
    expect(plan.paths.runWorkerStateFile).toContain("state.json");
    expect(plan.paths.runWorkerLogFile).toContain("output.log");
  });

  it("uses projectRoot for path computation, not workspace", () => {
    const plan = planWorkerLaunch({
      ...baseParams,
      workspace: "/different/workspace",
    });
    expect(plan.paths.runWorkerDir).toContain("/home/project");
    expect(plan.paths.runWorkerDir).not.toContain("/different/workspace");
  });

  it("includes spawn command in plan", () => {
    const plan = planWorkerLaunch(baseParams);
    expect(plan.spawnCommand).toBeDefined();
    expect(plan.spawnCommand.command).toBe("node");
    expect(plan.spawnCommand.args).toContain("dist/cli/main.js");
  });
});

// ---------------------------------------------------------------------------
// Command builder tests
// ---------------------------------------------------------------------------

describe("buildSpawnCommand", () => {
  const basePlan: WorkerLaunchPlan = {
    workerId: "coder-1",
    runId: "run-001",
    workspace: "/home/workspace",
    branch: "feature/x",
    channel: "worker-coder-1",
    role: "coder",
    allowedActions: ["read"],
    taskPrompt: "Do something useful",
    createdAt: "2026-06-05T15:00:00.000Z",
    paths: {
      runWorkerDir: "/root/.tiny-agent/runs/run-001/workers/coder-1",
      runWorkerStateFile:
        "/root/.tiny-agent/runs/run-001/workers/coder-1/state.json",
      runWorkerLogFile:
        "/root/.tiny-agent/runs/run-001/workers/coder-1/output.log",
    },
    spawnCommand: { command: "", args: [] },
  };

  it("builds a spawn command with node and main.js", () => {
    const cmd = buildSpawnCommand(basePlan);
    expect(cmd.command).toBe("node");
    expect(cmd.args).toEqual([
      "dist/cli/main.js",
      "run",
      "--channel",
      "worker-coder-1",
      "--task",
      "Do something useful",
    ]);
  });

  it("includes run flag for run subcommand", () => {
    const cmd = buildSpawnCommand(basePlan);
    expect(cmd.args[0]).toBe("dist/cli/main.js");
    expect(cmd.args[1]).toBe("run");
  });

  it("includes channel argument", () => {
    const cmd = buildSpawnCommand(basePlan);
    const channelIdx = cmd.args.indexOf("--channel");
    expect(channelIdx).toBeGreaterThan(-1);
    expect(cmd.args[channelIdx + 1]).toBe("worker-coder-1");
  });

  it("includes task argument", () => {
    const cmd = buildSpawnCommand({
      ...basePlan,
      taskPrompt: "Review PR #42",
    });
    const taskIdx = cmd.args.indexOf("--task");
    expect(taskIdx).toBeGreaterThan(-1);
    expect(cmd.args[taskIdx + 1]).toBe("Review PR #42");
  });

  it("omits --task when taskPrompt is empty string", () => {
    const cmd = buildSpawnCommand({ ...basePlan, taskPrompt: "" });
    expect(cmd.args).not.toContain("--task");
  });

  it("does not contain cwd in command (cwd is an effect port concern)", () => {
    const cmd = buildSpawnCommand(basePlan);
    expect(cmd).not.toHaveProperty("cwd");
    expect(cmd.args).not.toContain("--cwd");
  });

  it("returns a plain object compatible with spawn-like ports", () => {
    const cmd = buildSpawnCommand(basePlan);
    expect(typeof cmd.command).toBe("string");
    expect(Array.isArray(cmd.args)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Port type shape tests
// ---------------------------------------------------------------------------

describe("port type shapes", () => {
  it("SpawnPort is an interface with spawn method signature", () => {
    const mockSpawn: SpawnPort = {
      spawn: async (_command: string, _args: string[], _cwd: string) => ({
        pid: 12345,
        stdout: "fake stdout",
        stderr: "",
        exitCode: 0,
      }),
    };
    expect(typeof mockSpawn.spawn).toBe("function");
  });

  it("GitPort is an interface with checkout method signature", () => {
    const mockGit: GitPort = {
      checkout: async (_cwd: string, _branch: string) => ({
        success: true,
        branch: "feature/x",
      }),
    };
    expect(typeof mockGit.checkout).toBe("function");
  });

  it("WorkerLaunchEffects collects all ports", () => {
    const effects: WorkerLaunchEffects = {
      spawn: fakeSpawnPort(),
      git: fakeGitPort(),
      clock: fakeClock("2026-01-01T00:00:00.000Z"),
      ids: fakeIdGenerator("test"),
      contacts: fakeContactStorePort(),
    };
    expect(effects.spawn).toBeDefined();
    expect(effects.git).toBeDefined();
    expect(effects.clock).toBeDefined();
    expect(effects.ids).toBeDefined();
    expect(effects.contacts).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Launch executor tests
// ---------------------------------------------------------------------------

const buildLaunchPlan = (): WorkerLaunchPlan => ({
  workerId: "coder-1",
  runId: "run-001",
  workspace: "/home/workspace",
  branch: "feature/x",
  channel: "worker-coder-1",
  role: "coder",
  allowedActions: ["read", "write", "test"],
  taskPrompt: "Fix the failing tests in auth module",
  createdAt: "2026-06-05T15:00:00.000Z",
  paths: {
    runWorkerDir: "/root/.tiny-agent/runs/run-001/workers/coder-1",
    runWorkerStateFile:
      "/root/.tiny-agent/runs/run-001/workers/coder-1/state.json",
    runWorkerLogFile:
      "/root/.tiny-agent/runs/run-001/workers/coder-1/output.log",
  },
  spawnCommand: {
    command: "node",
    args: ["dist/cli/main.js", "run", "--channel", "worker-coder-1", "--task", "Fix the failing tests in auth module"],
  },
});

const buildEffects = (overrides?: Partial<{
  spawnExitCode: number;
  gitSuccess: boolean;
  clockISO: string;
}>): WorkerLaunchEffects => ({
  spawn: fakeSpawnPort(overrides?.spawnExitCode ?? 0),
  git: fakeGitPort(overrides?.gitSuccess ?? true),
  clock: fakeClock(overrides?.clockISO ?? "2026-06-05T15:00:00.000Z"),
  ids: fakeIdGenerator("test"),
  contacts: fakeContactStorePort(),
});

describe("launchLocalWorker", () => {
  it("succeeds with all ports responding correctly", async () => {
    const plan = buildLaunchPlan();
    const effects = buildEffects();
    const result = await launchLocalWorker(plan, effects);
    expect(result.kind).toBe("launch_success");
    if (result.kind === "launch_success") {
      expect(result.workerId).toBe("coder-1");
      expect(result.runId).toBe("run-001");
      expect(result.channel).toBe("worker-coder-1");
      expect(result.branch).toBe("feature/x");
      expect(result.spawnedPid).toBe(12345);
      expect(result.contact.workerId).toBe("coder-1");
      expect(result.contact.status).toBe("active");
    }
  });

  it("fails at checkout stage when git checkout returns failure", async () => {
    const plan = buildLaunchPlan();
    const effects = buildEffects({ gitSuccess: false });
    const result = await launchLocalWorker(plan, effects);
    expect(result.kind).toBe("launch_failure");
    if (result.kind === "launch_failure") {
      expect(result.stage).toBe("checkout");
      expect(result.error).toContain("Git checkout failed");
      expect(result.evidence.branch).toBe("feature/x");
      expect(result.evidence.registeredEventId).toBeDefined();
      expect(result.evidence.failedAt).toBeDefined();
    }
  });

  it("fails at spawn stage when spawn exits non-zero", async () => {
    const plan = buildLaunchPlan();
    const effects = buildEffects({ spawnExitCode: 1 });
    const result = await launchLocalWorker(plan, effects);
    expect(result.kind).toBe("launch_failure");
    if (result.kind === "launch_failure") {
      expect(result.stage).toBe("spawn");
      expect(result.error).toContain("exited with code 1");
      expect(result.evidence.spawnResult).toBeDefined();
      if (result.evidence.spawnResult) {
        expect(result.evidence.spawnResult.exitCode).toBe(1);
      }
    }
  });

  it("fails at spawn stage when spawn throws", async () => {
    const plan = buildLaunchPlan();
    const effects = {
      ...buildEffects(),
      spawn: {
        spawn: async () => { throw new Error("process spawn refused"); },
      },
    };
    const result = await launchLocalWorker(plan, effects);
    expect(result.kind).toBe("launch_failure");
    if (result.kind === "launch_failure") {
      expect(result.stage).toBe("spawn");
      expect(result.error).toContain("process spawn refused");
    }
  });

  it("fails at contact_register stage when contact store throws", async () => {
    const plan = buildLaunchPlan();
    const effects = {
      ...buildEffects(),
      contacts: {
        load: async () => createContactRegistryState("fake"),
        apply: async () => { throw new Error("store write rejected"); },
      },
    };
    const result = await launchLocalWorker(plan, effects);
    expect(result.kind).toBe("launch_failure");
    if (result.kind === "launch_failure") {
      expect(result.stage).toBe("contact_register");
      expect(result.error).toContain("store write rejected");
      expect(result.evidence.registeredEventId).toBeDefined();
    }
  });


  it("fails at contact_register stage when worker_registered is rejected", async () => {
    const plan = buildLaunchPlan();
    const effects = {
      ...buildEffects(),
      contacts: {
        load: async () => createContactRegistryState("fake"),
        apply: async () => ({
          status: "rejected" as const,
          state: createContactRegistryState("fake"),
          rejection: {
            code: "worker_exists" as const,
            message: "worker already registered",
          },
        }),
      },
    };
    const result = await launchLocalWorker(plan, effects);
    expect(result.kind).toBe("launch_failure");
    if (result.kind === "launch_failure") {
      expect(result.stage).toBe("contact_register");
      expect(result.error).toContain("already registered");
      expect(result.evidence.registeredEventId).toBeDefined();
    }
  });

  it("fails at contact_update stage when worker_updated is rejected", async () => {
    const plan = buildLaunchPlan();
    let callCount = 0;
    const effects = {
      ...buildEffects(),
      contacts: {
        load: async () => createContactRegistryState("fake"),
        apply: async () => {
          callCount++;
          if (callCount === 2) {
            return {
              status: "rejected" as const,
              state: createContactRegistryState("fake"),
              rejection: {
                code: "unknown_worker" as const,
                message: "worker not found for update",
              },
            };
          }
          const state = createContactRegistryState("fake");
          return { status: "applied" as const, state };
        },
      },
    };
    const result = await launchLocalWorker(plan, effects);
    expect(result.kind).toBe("launch_failure");
    if (result.kind === "launch_failure") {
      expect(result.stage).toBe("contact_update");
      expect(result.error).toContain("not found for update");
      expect(result.evidence.spawnResult).toBeDefined();
    }
  });

  it("returns contact_update failure when worker launched but update fails", async () => {
    const plan = buildLaunchPlan();
    let callCount = 0;
    const effects = {
      ...buildEffects(),
      contacts: {
        load: async () => createContactRegistryState("fake"),
        apply: async (event: ContactRegistryEvent) => {
          callCount++;
          if (callCount >= 2) {
            throw new Error("update rejected");
          }
          // First call (register) succeeds
          return {
            status: "applied" as const,
            state: createContactRegistryState("fake"),
          };
        },
      },
    };
    const result = await launchLocalWorker(plan, effects);
    expect(result.kind).toBe("launch_failure");
    if (result.kind === "launch_failure") {
      expect(result.stage).toBe("contact_update");
      expect(result.error).toContain("update rejected");
      expect(result.evidence.runId).toBe("run-001");
      expect(result.evidence.spawnResult).toBeDefined();
    }
  });


  it("fails at contact_status stage when status change is rejected", async () => {
    const plan = buildLaunchPlan();
    let callCount = 0;
    const effects = {
      ...buildEffects(),
      contacts: {
        load: async () => createContactRegistryState("fake"),
        apply: async (event: ContactRegistryEvent) => {
          callCount++;
          if (callCount === 3) {
            // Third call is status change — reject it
            return {
              status: "rejected" as const,
              state: createContactRegistryState("fake"),
              rejection: {
                code: "invalid_transition" as const,
                message: "cannot set active on idle",
              },
            };
          }
          // First two calls succeed
          const state = createContactRegistryState("fake");
          return { status: "applied" as const, state };
        },
      },
    };
    const result = await launchLocalWorker(plan, effects);
    expect(result.kind).toBe("launch_failure");
    if (result.kind === "launch_failure") {
      expect(result.stage).toBe("contact_status");
      expect(result.error).toContain("cannot set active on idle");
      expect(result.evidence.runId).toBe("run-001");
      expect(result.evidence.spawnResult).toBeDefined();
    }
  });

  it("returns contact from registry in success result", async () => {
    const plan = buildLaunchPlan();
    const effects = buildEffects();
    const result = await launchLocalWorker(plan, effects);
    expect(result.kind).toBe("launch_success");
    if (result.kind === "launch_success") {
      expect(result.contact.workerId).toBe("coder-1");
      expect(result.contact.workspace).toBe("/home/workspace");
      expect(result.contact.branch).toBe("feature/x");
      expect(result.contact.runId).toBe("run-001");
    }
  });
});
