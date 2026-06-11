#!/usr/bin/env node
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";

import { RunOrchestrator } from "../run/orchestrator.js";
import type { RunPorts } from "../run/orchestrator.js";
import { AgentRunState } from "../run/state.js";
import {
  RunSessionStore,
  reconstructModelContextItemsFromTranscript,
} from "../run/session-store.js";
import { TranscriptStore } from "../transcript/store.js";
import { PromptBuilder } from "../model/prompt-builder.js";
import {
  ModelContextSession,
  PromptBuilderContextRenderer,
  modelContextItemsToHistoryEntries,
  type ModelContextItem,
  type ModelContextSessionSnapshot,
} from "../model/context-session.js";
import { DeepSeekV4PromptTokenCounter } from "../model/prompt-token-counter.js";
import {
  JsonlRuntimeEventSink,
  JsonProcessRegistryStore,
  RunSupervisor,
  type ProcessSpawnerPort,
  type SpawnedProcessPort,
} from "../runtime/index.js";
import { launchTerminalHost, type LaunchedTerminalHost } from "../terminal-host/index.js";
import { launchModelGateway, type LaunchedModelGateway } from "../model/index.js";
import { ToolCallValidator } from "../tools/validator.js";
import { AlwaysApproveReviewer } from "../tools/reviewer.js";
import { STATIC_TOOL_CATALOG } from "../tools/catalog.js";
import { ENVIRONMENT_EVENT_LEVELS } from "../types/environment.js";
import type { UserMessage } from "../types/environment.js";
import { Environment } from "../environment/environment.js";
import { PublicImService, createNodeImStore, type PublicImRunReceiveMessage } from "../im/index.js";
import { SkillRunStore } from "../skill/store.js";
import { buildCliTerminalEnv } from "./terminal-env.js";
import {
  ackPublicRunUserMessage,
  createRunImSelfEndpoint,
  ensureDefaultRunImBinding,
  receivePublicRunUserMessages,
} from "./run-im.js";
import type { AgentRunStateData, RunEvent } from "../types/run.js";
import {
  DEFAULT_CONTEXT_WINDOW_MAX_TOKENS,
  DeterministicModelContextCompactor,
  type ModelContextWindowPort,
} from "../model/context-window.js";
import { HELP_TEXT } from "./help-text.js";
import { StateRootResolver } from "../state/root.js";
import {
  loadDeepSeekRuntimeConfig,
  missingDeepSeekApiKeyMessage,
} from "./runtime-config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(message: string): never {
  console.error(`[tiny-agent] ERROR: ${message}`);
  process.exit(1);
}

function parseCliOptions(args: string[]): {
  task?: string;
  stateDir?: string;
  resumeRunId?: string;
} {
  let task: string | undefined;
  let stateDir: string | undefined;
  let resumeRunId: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--task" && i + 1 < args.length) {
      task = args[++i];
    } else if (args[i] === "--state-dir" && i + 1 < args.length) {
      stateDir = args[++i];
    } else if (args[i] === "--resume" && i + 1 < args.length) {
      resumeRunId = args[++i];
    }
  }

  return { task, stateDir, resumeRunId };
}

type RunScopedPaths = {
  skillRunsDir: string;
  sessionsDir: string;
  environmentDir: string;
  environmentEventsPath: string;
};

function ensureRunScopedPaths(runDir: string): RunScopedPaths {
  const paths: RunScopedPaths = {
    skillRunsDir: path.join(runDir, "skill-runs"),
    sessionsDir: path.join(runDir, "sessions"),
    environmentDir: path.join(runDir, "environment"),
    environmentEventsPath: path.join(runDir, "environment", "events.jsonl"),
  };
  for (const dir of [
    paths.skillRunsDir,
    paths.sessionsDir,
    paths.environmentDir,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return paths;
}

function createCliTerminalHost(options: {
  runId: string;
  runDir: string;
  stateDir: string;
  paths: RunScopedPaths;
  skillsDir: string;
  transcriptPath: string;
  supervisor: RunSupervisor;
}): LaunchedTerminalHost {
  const promptNonce = `cli-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const terminalEnv = buildCliTerminalEnv(process.env, {
      runId: options.runId,
      runDir: options.runDir,
      stateDir: options.runDir,
      projectStateDir: options.stateDir,
      imStateDir: options.stateDir,
      imRunId: options.runId,
      imSelfEndpoint: createRunImSelfEndpoint(options.runId),
      imUserEndpoint: "user:main",
      skillRunsDir: options.paths.skillRunsDir,
      sessionsDir: options.paths.sessionsDir,
      skillsDir: options.skillsDir,
      transcriptPath: options.transcriptPath,
      environmentEventsPath: options.paths.environmentEventsPath,
  });
  const hostArgs = [
    ...process.execArgv,
    process.argv[1]!,
    "terminal-host",
    "--default-session",
    "default",
    "--cwd",
    process.cwd(),
    "--prompt-nonce",
    promptNonce,
    "--sessions-dir",
    options.paths.sessionsDir,
    "--rows",
    "24",
    "--cols",
    "80",
  ];

  return launchTerminalHost({
    supervisor: options.supervisor,
    processId: `terminal-host:${options.runId}:default`,
    owner: { scope: "run", runId: options.runId },
    executable: process.execPath,
    args: hostArgs,
    cwd: process.cwd(),
    env: terminalEnv,
    statePath: path.join(options.runDir, "terminal-host.json"),
    logPath: path.join(options.paths.sessionsDir, "terminal-host.stderr.log"),
    requestTimeoutMs: 30_000,
    newRequestId: (() => {
      let sequence = 0;
      return () => `terminal-host-${options.runId}-${++sequence}`;
    })(),
  });
}

function createCliRunImService(): PublicImService {
  return new PublicImService({
    store: createNodeImStore(),
    clock: { nowIso: () => new Date().toISOString() },
    ids: {
      newMessageId: (seed) => {
        const scope = seed.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
        return `run-im-${scope}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
      },
    },
  });
}

function createCliModelGateway(options: {
  runId: string;
  runDir: string;
  model: string;
  supervisor: RunSupervisor;
}): LaunchedModelGateway {
  const gatewayArgs = [
    ...process.execArgv,
    process.argv[1]!,
    "model-gateway",
    "--model",
    options.model,
  ];
  return launchModelGateway({
    supervisor: options.supervisor,
    processId: `model-gateway:${options.runId}:${options.model}`,
    owner: { scope: "run", runId: options.runId },
    executable: process.execPath,
    args: gatewayArgs,
    cwd: process.cwd(),
    env: process.env,
    statePath: path.join(options.runDir, "model-gateway.json"),
    logPath: path.join(options.runDir, "model-gateway.stderr.log"),
    requestTimeoutMs: 180_000,
    newRequestId: (() => {
      let sequence = 0;
      return () => `model-gateway-${options.runId}-${++sequence}`;
    })(),
  });
}

function createCliRunSessionPort(store: RunSessionStore) {
  return {
    saveModelContext(
      runId: string,
      snapshot: ModelContextSessionSnapshot,
    ): void {
      store.save({
        runId,
        updatedAt: new Date().toISOString(),
        modelContext: snapshot,
      });
    },
  };
}

function createCliContextWindowPort(
  promptBuilder: PromptBuilder,
): ModelContextWindowPort {
  const tokenCounter = new DeepSeekV4PromptTokenCounter();
  const compactor = new DeterministicModelContextCompactor({
    now: () => new Date().toISOString(),
  });
  return {
    maxTokens: DEFAULT_CONTEXT_WINDOW_MAX_TOKENS,
    countTokens(items: readonly ModelContextItem[]): number {
      const entries = modelContextItemsToHistoryEntries(items);
      const messages = promptBuilder.buildHistoryMessages(entries);
      return tokenCounter.countMessages(messages);
    },
    compact(input) {
      return compactor.compact(input);
    },
  };
}

function publishLatestRun(runsDir: string, runId: string, runDir: string): void {
  fs.mkdirSync(runsDir, { recursive: true });

  fs.writeFileSync(
    path.join(runsDir, "latest.json"),
    JSON.stringify(
      {
        runId,
        runDir: path.relative(process.cwd(), runDir),
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
  );

  const latestLink = path.join(runsDir, "latest");
  try {
    const stat = fs.lstatSync(latestLink);
    if (stat.isSymbolicLink() || stat.isFile()) {
      fs.unlinkSync(latestLink);
    }
  } catch {
    // No existing latest pointer.
  }

  try {
    fs.symlinkSync(runId, latestLink, "dir");
  } catch {
    // latest.json is the portable fallback.
  }
}

function resolveCliStateRoot(stateDir?: string): string {
  return new StateRootResolver().resolve({ stateDir }).stateDir;
}

function readLatestRunId(runsDir: string): string | undefined {
  const latestJsonPath = path.join(runsDir, "latest.json");
  if (!fs.existsSync(latestJsonPath)) {
    return undefined;
  }

  try {
    const data = JSON.parse(fs.readFileSync(latestJsonPath, "utf-8")) as {
      runId?: string;
    };
    return data.runId;
  } catch {
    return undefined;
  }
}

function resolveRunDir(runsDir: string, runIdOrLatest: string): string {
  const runId =
    runIdOrLatest === "latest" ? readLatestRunId(runsDir) : runIdOrLatest;
  if (!runId) {
    die("No latest run is available to resume.");
  }
  const runDir = path.join(runsDir, runId);
  if (!fs.existsSync(path.join(runDir, "state.json"))) {
    die(`Cannot resume ${runId}: missing ${path.join(runDir, "state.json")}`);
  }
  return runDir;
}

function readTranscriptEvents(transcriptPath: string): RunEvent[] {
  if (!fs.existsSync(transcriptPath)) {
    return [];
  }
  return fs
    .readFileSync(transcriptPath, "utf-8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as RunEvent);
}

function loadHistoryForRun(runDir: string): ModelContextItem[] {
  const sessionStore = new RunSessionStore(runDir);
  const snapshot = sessionStore.load();
  if (snapshot !== null) {
    return [...snapshot.modelContext.items];
  }
  return reconstructModelContextItemsFromTranscript(
    readTranscriptEvents(path.join(runDir, "transcript.jsonl")),
  );
}

function appendResumeReminder(items: ModelContextItem[]): ModelContextItem[] {
  return [
    ...items,
    {
      type: "environment_reminder",
      content:
        "Run resumed from persisted state. Agent-loop history was loaded from the run session. Terminal processes are fresh after resume; inspect with session_observe/session_list and use the latest terminal.inputSeq before sending terminal input. Do not assume prior ssh, vim, cat, or other foreground processes survived the resume.",
    },
  ];
}

async function waitForNewLatestRun(options: {
  runsDir: string;
  previousRunId?: string;
  child: SpawnedProcessPort;
  timeoutMs: number;
}): Promise<string> {
  let childExit:
    | {
        code: number | null;
        signal: NodeJS.Signals | null;
      }
    | undefined;

  options.child.once("exit", (code, signal) => {
    childExit = { code, signal };
  });

  const startedAt = Date.now();
  while (Date.now() - startedAt < options.timeoutMs) {
    const runId = readLatestRunId(options.runsDir);
    if (runId && runId !== options.previousRunId) {
      return runId;
    }

    if (childExit) {
      throw new Error(
        `agent run exited before creating a run (code=${childExit.code}, signal=${childExit.signal})`,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error("timed out waiting for agent run to create latest run");
}

function readProjectIdFromStateRoot(baseDir: string): string {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(baseDir, "project.json"), "utf-8"),
    ) as { projectId?: string };
    if (parsed.projectId) {
      return parsed.projectId;
    }
  } catch {
    // Fall through to a stable local fallback.
  }
  return path.basename(baseDir) || "project";
}

function createRuntimeEventIdFactory(prefix: string): () => string {
  let sequence = 0;
  return () => `${prefix}-${Date.now()}-${++sequence}`;
}

function createRuntimeEventSink(baseDir: string): JsonlRuntimeEventSink {
  return new JsonlRuntimeEventSink({
    filePath: path.join(baseDir, "runtime", "events.jsonl"),
  });
}

const nodeProcessSpawner: ProcessSpawnerPort = {
  spawn(executable, args, options) {
    return spawn(executable, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: [...options.stdio] as ["ignore" | "pipe", "pipe", "pipe"],
    });
  },
};

async function runUnifiedUi(args: string[]): Promise<void> {
  const { task, stateDir, resumeRunId } = parseCliOptions(args);
  const deepseek = loadDeepSeekRuntimeConfig();

  if (!deepseek.apiKey) {
    die(missingDeepSeekApiKeyMessage(deepseek.configPath));
  }
  if (task && resumeRunId) {
    die("tiny-agent ui accepts either --task or --resume, not both.");
  }

  const baseDir = resolveCliStateRoot(stateDir);
  const runsDir = path.join(baseDir, "runs");
  const launcherDir = path.join(baseDir, "launcher");
  fs.mkdirSync(launcherDir, { recursive: true });

  const previousRunId = readLatestRunId(runsDir);
  const logPath = path.join(launcherDir, `ui-${Date.now()}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  const resumeTargetRunId =
    resumeRunId === undefined
      ? undefined
      : resumeRunId === "latest"
        ? readLatestRunId(runsDir)
        : resumeRunId;
  if (resumeRunId !== undefined && !resumeTargetRunId) {
    die("No latest run is available to resume.");
  }
  if (resumeTargetRunId !== undefined) {
    resolveRunDir(runsDir, resumeTargetRunId);
  }

  const runArgs =
    resumeTargetRunId !== undefined
      ? [
          ...process.execArgv,
          process.argv[1]!,
          "resume",
          resumeTargetRunId,
          "--state-dir",
          baseDir,
        ]
      : [
          ...process.execArgv,
          process.argv[1]!,
          "run",
          "--state-dir",
          baseDir,
        ];
  if (task) {
    runArgs.push("--task", task);
  }

  const supervisor = new RunSupervisor({
    store: new JsonProcessRegistryStore({
      filePath: path.join(baseDir, "processes.json"),
      nowIso: () => new Date().toISOString(),
    }),
    spawner: nodeProcessSpawner,
    nowIso: () => new Date().toISOString(),
    nowEpochMs: () => Date.now(),
    events: createRuntimeEventSink(baseDir),
    newEventId: createRuntimeEventIdFactory("runtime-ui"),
    eventProducer: "tiny-agent-ui",
  });
  const runProcessId = `run-launch-${Date.now()}`;
  const { child } = supervisor.startRunProcess({
    processId: runProcessId,
    owner: { scope: "project", projectId: readProjectIdFromStateRoot(baseDir) },
    executable: process.execPath,
    args: runArgs,
    cwd: process.cwd(),
    env: process.env,
    logPath,
    statePath: baseDir,
    metadata: {
      resume: resumeTargetRunId ?? null,
    },
  });

  child.stdout?.pipe(logStream, { end: false });
  child.stderr?.pipe(logStream, { end: false });
  child.once("exit", () => {
    logStream.end();
  });

  const stopChild = () => {
    if (!child.killed && child.exitCode === null) {
      child.kill("SIGTERM");
    }
  };
  process.once("exit", stopChild);
  process.once("SIGINT", () => {
    stopChild();
    process.exit(130);
  });
  process.once("SIGTERM", () => {
    stopChild();
    process.exit(143);
  });

  const runId =
    resumeTargetRunId ??
    (await waitForNewLatestRun({
      runsDir,
      previousRunId,
      child,
      timeoutMs: 5_000,
    }));
  supervisor.attachRunId({
    processId: runProcessId,
    runId,
    runDir: path.join(runsDir, runId),
  });

  console.log(`[tiny-agent] ${resumeTargetRunId ? "Resumed" : "Started"} background run: ${runId}`);
  console.log(`[tiny-agent] Agent log: ${logPath}`);
  console.log(
    resumeTargetRunId
      ? "[tiny-agent] Opening TUI."
      : "[tiny-agent] Opening TUI. Press m to send the first task.",
  );

  const { runTui } = await import("./tui.js");
  runTui(["--run", runId, "--state-dir", baseDir]);
}

async function waitForFirstMessage(
  options: {
    service: PublicImService;
    stateRoot: string;
    runId: string;
  },
  environment: Environment,
): Promise<{ task: string }> {
  while (true) {
    const messages = await receivePublicRunUserMessages(options);
    if (messages.length > 0) {
      for (const message of messages) {
        appendPublicImUserMessage(environment, message);
        await ackPublicRunUserMessage({ ...options, messageId: message.id });
      }
      return { task: messages[0]!.text };
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

function appendPublicImUserMessage(
  environment: Environment,
  message: PublicImRunReceiveMessage,
): void {
  environment.appendEvent({
    level: ENVIRONMENT_EVENT_LEVELS.USER_MESSAGE,
    id: `env-im-${message.id}`,
    kind: "user_message_received",
    source: "im",
    timestamp: message.createdAt,
    message: publicImMessageToEnvironmentUserMessage(message),
  });
}

function publicImMessageToEnvironmentUserMessage(
  message: PublicImRunReceiveMessage,
): UserMessage {
  return {
    id: message.id,
    channel: message.channelId,
    role: "user",
    text: message.text,
    createdAt: message.createdAt,
    metadata: {
      from: message.from,
      to: message.to,
      pairId: message.pairId,
      bindingPeer: message.binding.peer,
      bindingKind: String(message.binding.kind),
    },
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------


async function main(): Promise<void> {
  // --- Help ---
  const firstArg = process.argv[2];
  if (firstArg === "--help" || firstArg === "-h") {
    process.stdout.write(HELP_TEXT);
    return;
  }

  // --- Route subcommands ---
  if (firstArg === "tui") {
    const { runTui } = await import("./tui.js");
    runTui(process.argv.slice(3));
    return;
  }

  if (firstArg === "ui") {
    await runUnifiedUi(process.argv.slice(3));
    return;
  }

  if (firstArg === "im") {
    const { runIm } = await import("./im.js");
    await runIm(process.argv.slice(3));
    return;
  }

  if (firstArg === "skill") {
    const { runSkill } = await import("./skill.js");
    await runSkill(process.argv.slice(3));
    return;
  }

  if (firstArg === "team") {
    const { runTeam } = await import("./team-run.js");
    await runTeam(process.argv.slice(3));
    return;
  }

  if (firstArg === "terminal-host") {
    const { runTerminalHostCli } = await import("../terminal-host/cli.js");
    process.exitCode = await runTerminalHostCli(process.argv.slice(3));
    return;
  }

  if (firstArg === "codeq") {
    const { runCodeIntelCli } = await import("../code-intel/cli.js");
    process.exitCode = await runCodeIntelCli(process.argv.slice(3));
    return;
  }

  if (firstArg === "mcp") {
    const { runMcpCli } = await import("../mcp/cli.js");
    process.exitCode = await runMcpCli(process.argv.slice(3));
    return;
  }

  if (firstArg === "model-gateway") {
    const { runModelGatewayCli } = await import("./model-gateway.js");
    process.exitCode = await runModelGatewayCli(process.argv.slice(3));
    return;
  }

  // Handle --state-dir before mcp subcommand (e.g. tiny-agent --state-dir /path mcp list)
  {
    const stateIdx = process.argv.indexOf("--state-dir");
    const mcpIdx = process.argv.indexOf("mcp");
    if (stateIdx !== -1 && mcpIdx !== -1 && stateIdx < mcpIdx) {
      const stateDirVal = process.argv[stateIdx + 1];
      // Skip --state-dir and its value, pass rest to runMcpCli
      const mcpArgs = process.argv.slice(mcpIdx + 1);
      // Prepend --state-dir so runMcpCli's own parser can use it
      const fullArgs = stateDirVal ? ["--state-dir", stateDirVal, ...mcpArgs] : mcpArgs;
      const { runMcpCli: runMcpCli2 } = await import("../mcp/cli.js");
      process.exitCode = await runMcpCli2(fullArgs);
      return;
    }
  }

  // --- Parse run arguments ---
  // Supported forms:
  //   tiny-agent "fix the tests"                     (legacy positional)
  //   tiny-agent run                                  (wait for public IM message)
  //   tiny-agent run --task "fix"                     (start with task)
  const args = process.argv.slice(2);
  let taskArg: string | undefined;
  let stateDirArg: string | undefined;
  let resumeRunId: string | undefined;

  if (args[0] === "resume") {
    resumeRunId = args[1];
    const parsed = parseCliOptions(args.slice(2));
    stateDirArg = parsed.stateDir;
    if (!resumeRunId) {
      die("Usage: tiny-agent resume <runId|latest> [--state-dir <dir>]");
    }
  } else if (args[0] === "run") {
    const parsed = parseCliOptions(args.slice(1));
    taskArg = parsed.task;
    stateDirArg = parsed.stateDir;
    resumeRunId = parsed.resumeRunId;
  } else if (args[0]) {
    const reserved = ["io_wait", "io-wait"];
    if (reserved.includes(args[0])) {
      die(`"${args[0]}" is a tool call, not a CLI command.`);
    }
    const parsed = parseCliOptions(args.slice(1));
    stateDirArg = parsed.stateDir;
    taskArg = args[0];
  } else {
    die(
        "Usage:\n" +
        "  tiny-agent <task> [--state-dir <dir>]\n" +
        "  tiny-agent run [--task <task>] [--state-dir <dir>]\n" +
        "  tiny-agent resume <runId|latest> [--state-dir <dir>]\n" +
        "  tiny-agent ui [--task <task>|--resume <runId|latest>] [--state-dir <dir>]",
    );
  }

  // --- Read env vars ---
  const deepseek = loadDeepSeekRuntimeConfig();
  if (!deepseek.apiKey) {
    die(missingDeepSeekApiKeyMessage(deepseek.configPath));
  }

  // --- Create directory structure ---
  const baseDir = resolveCliStateRoot(stateDirArg);
  const runsDir = path.join(baseDir, "runs");
  const skillsDir = path.join(baseDir, "skills");
  for (const dir of [runsDir, skillsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const runProcessSupervisor = new RunSupervisor({
    store: new JsonProcessRegistryStore({
      filePath: path.join(baseDir, "processes.json"),
      nowIso: () => new Date().toISOString(),
    }),
    spawner: nodeProcessSpawner,
    nowIso: () => new Date().toISOString(),
    nowEpochMs: () => Date.now(),
    events: createRuntimeEventSink(baseDir),
    newEventId: createRuntimeEventIdFactory(`runtime-${resumeRunId ? "resume" : "run"}`),
    eventProducer: "tiny-agent-run",
  });

  // --- Wire up modules ---
  const promptBuilder = new PromptBuilder();
  const validator = new ToolCallValidator();
  const reviewer = new AlwaysApproveReviewer();

  const environment = new Environment();

  const imService = createCliRunImService();
  let skillRunStore: SkillRunStore;

  // --- Create or load run/session state ---
  let runId: string;
  let runDir: string;
  let transcriptPath: string;
  let transcript: TranscriptStore;
  let initialState: AgentRunState;
  let initialHistory: ModelContextItem[] = [];
  let task: string;
  let runPaths: RunScopedPaths;

  if (resumeRunId) {
    runDir = resolveRunDir(runsDir, resumeRunId);
    runPaths = ensureRunScopedPaths(runDir);
    skillRunStore = new SkillRunStore({
      skillRunsDir: runPaths.skillRunsDir,
      skillsDir,
    });
    environment.setEventsPath(runPaths.environmentEventsPath);

    transcript = new TranscriptStore(runDir);
    const loadedState = transcript.loadState<AgentRunStateData>();
    if (loadedState === null) {
      die(`Cannot resume ${resumeRunId}: missing persisted run state.`);
    }
    runId = loadedState.runId;
    transcriptPath = loadedState.transcriptPath;
    task = loadedState.task;
    initialState = new AgentRunState(loadedState);
    initialHistory = appendResumeReminder(loadHistoryForRun(runDir));

    await ensureDefaultRunImBinding({
      service: imService,
      stateRoot: baseDir,
      runId,
    });
    publishLatestRun(runsDir, runId, runDir);
  } else {
    runId = `run-${Date.now()}`;
    runDir = path.join(runsDir, runId);
    runPaths = ensureRunScopedPaths(runDir);
    skillRunStore = new SkillRunStore({
      skillRunsDir: runPaths.skillRunsDir,
      skillsDir,
    });
    environment.setEventsPath(runPaths.environmentEventsPath);
    await ensureDefaultRunImBinding({
      service: imService,
      stateRoot: baseDir,
      runId,
    });

    transcriptPath = path.join(runDir, "transcript.jsonl");
    transcript = new TranscriptStore(runDir);
    const initialDisplayTask =
      taskArg ?? `Waiting for first user message on public IM endpoint ${createRunImSelfEndpoint(runId)}`;

    // Make the run visible to TUI immediately, even before the first IM message.
    // The real run_started event is still recorded by RunOrchestrator once a
    // task exists; this snapshot is only the attachable waiting-room state.
    transcript.ensureDir();
    fs.closeSync(fs.openSync(transcriptPath, "a"));
    transcript.saveState({
      ...AgentRunState.create({
        runId,
        task: initialDisplayTask,
        cwd: process.cwd(),
        transcriptPath,
      }).data,
      status: taskArg ? "created" : "waiting_for_io",
      updatedAt: new Date().toISOString(),
    });
    publishLatestRun(runsDir, runId, runDir);

    if (taskArg) {
      task = taskArg;
    } else {
      console.log(
        `[tiny-agent] Waiting for user message on public IM endpoint: ${createRunImSelfEndpoint(runId)}`,
      );
      const firstMessage = await waitForFirstMessage(
        {
          service: imService,
          stateRoot: baseDir,
          runId,
        },
        environment,
      );
      task = firstMessage.task;
      console.log(`[tiny-agent] Received task: ${task}`);
    }

    initialState = AgentRunState.create({
      runId,
      task,
      cwd: process.cwd(),
      transcriptPath,
    });
  }

  if (taskArg && !resumeRunId) {
    const createdAt = new Date().toISOString();
    environment.appendEvent({
      id: `env-task-${runId}`,
      level: ENVIRONMENT_EVENT_LEVELS.USER_MESSAGE,
      kind: "user_message_received",
      source: "im",
      timestamp: createdAt,
      message: {
        id: `task-${runId}`,
        channel: createRunImSelfEndpoint(runId),
        role: "user",
        text: taskArg,
        createdAt,
        metadata: {
          from: "user:main",
          to: createRunImSelfEndpoint(runId),
        },
      },
    });
  }

  // --- IM → Environment bridge: poll public run bindings for new user messages ---
  let imPollingActive = true;
  const imPollInterval = setInterval(async () => {
    if (!imPollingActive) return;
    try {
      const messages = await receivePublicRunUserMessages({
        service: imService,
        stateRoot: baseDir,
        runId,
      });
      for (const message of messages) {
        appendPublicImUserMessage(environment, message);
        await ackPublicRunUserMessage({
          service: imService,
          stateRoot: baseDir,
          runId,
          messageId: message.id,
        });
      }
    } catch {
      // Best-effort polling
    }
  }, 500);

  // --- Build RunPorts ---
  const modelContext = ModelContextSession.create({
    task,
    renderer: new PromptBuilderContextRenderer(promptBuilder),
    contextWindow: createCliContextWindowPort(promptBuilder),
    initialItems: initialHistory,
  });
  const terminalHost = createCliTerminalHost({
    runId,
    runDir,
    stateDir: baseDir,
    paths: runPaths,
    skillsDir,
    transcriptPath,
    supervisor: runProcessSupervisor,
  });
  const modelGateway = createCliModelGateway({
    runId,
    runDir,
    model: deepseek.model,
    supervisor: runProcessSupervisor,
  });
  const ports: RunPorts = {
    model: modelGateway.model,
    validator,
    reviewer,
    terminal: terminalHost.terminal,
    modelContext,
    session: createCliRunSessionPort(new RunSessionStore(runDir)),
    tools: [...STATIC_TOOL_CATALOG],
    environment,
    listActiveSkillRuns: () => skillRunStore.listActive(),
  };

  // --- Create transcript store and orchestrator ---
  const orchestrator = new RunOrchestrator(initialState, transcript, ports);

  // --- Run ---
  console.log(`[tiny-agent] Run ${runId} ${resumeRunId ? "resumed" : "started"}`);
  console.log(`[tiny-agent] Task: ${task}`);
  console.log(`[tiny-agent] Model: ${deepseek.model} @ ${deepseek.baseUrl}`);
  console.log();

  try {
    const finalState = await orchestrator.run();

    console.log();
    console.log(`[tiny-agent] Run ${runId} finished — status: ${finalState.status}`);

    if (finalState.data.error) {
      console.error();
      console.error(`[tiny-agent] Error: ${finalState.data.error.message}`);
    }

    console.log();
    console.log(`[tiny-agent] Transcript: ${transcriptPath}`);
  } finally {
    imPollingActive = false;
    clearInterval(imPollInterval);
    await Promise.all([
      terminalHost.dispose(),
      modelGateway.dispose(),
    ]);
  }
}

main().catch((err: unknown) => {
  console.error("[tiny-agent] Fatal error:", err);
  process.exit(1);
});
