import * as fs from "node:fs";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

import { RunOrchestrator } from "../run/orchestrator.js";
import type { RunPorts, HistoryItem, BashPort } from "../run/orchestrator.js";
import { AgentRunState } from "../run/state.js";
import { TranscriptStore } from "../transcript/store.js";
import { DeepSeekFimAdapter } from "../model/adapter.js";
import { PromptBuilder } from "../model/prompt-builder.js";
import type { HistoryEntry } from "../model/prompt-builder.js";
import { BashSessionManager } from "../bash/session-manager.js";
import { ToolCallValidator } from "../tools/validator.js";
import { AlwaysApproveReviewer } from "../tools/reviewer.js";
import { BASH_TOOL_DEFINITION } from "../tools/catalog.js";
import { Environment } from "../environment/environment.js";
import { ImCliTransport } from "../im/transport.js";
import { SkillRunStore } from "../skill/store.js";
import type { ToolRequest } from "../types/tools.js";
import type { BashObservation } from "../types/bash.js";
import type { V4ChatMessage } from "../types/model.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(message: string): never {
  console.error(`[tiny-agent] ERROR: ${message}`);
  process.exit(1);
}

function resolveDeepSeekApiKey(): string | undefined {
  const fromEnv = process.env.DEEPSEEK_API_KEY?.trim();
  if (fromEnv) {
    return fromEnv;
  }

  const akPath = path.resolve("ak.txt");
  if (!fs.existsSync(akPath)) {
    return undefined;
  }

  const fromFile = fs.readFileSync(akPath, "utf-8").trim();
  return fromFile.length > 0 ? fromFile : undefined;
}

function missingApiKeyMessage(): string {
  return (
    "DeepSeek API key is required.\n" +
    "  Put your key in ./ak.txt, then run tiny-agent again.\n" +
    "  Or set DEEPSEEK_API_KEY in the environment."
  );
}

function parseCliOptions(args: string[]): {
  channel?: string;
  task?: string;
  stateDir?: string;
} {
  let channel: string | undefined;
  let task: string | undefined;
  let stateDir: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--channel" && i + 1 < args.length) {
      channel = args[++i];
    } else if (args[i] === "--task" && i + 1 < args.length) {
      task = args[++i];
    } else if (args[i] === "--state-dir" && i + 1 < args.length) {
      stateDir = args[++i];
    }
  }

  return { channel, task, stateDir };
}

function convertHistoryItems(items: HistoryItem[]): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const item of items) {
    if (item.type === "tool_call") {
      entries.push({
        role: "assistant_tool_call",
        toolCallId: item.toolCall.id,
        name: item.toolCall.name,
        arguments: item.toolCall.arguments,
        thinking: item.thinking?.content,
      });
    } else if (item.type === "observation") {
      entries.push({
        role: "tool_result",
        toolCallId: "",
        observation: item.observation,
      });
    } else if (item.type === "environment_reminder") {
      entries.push({
        role: "environment_reminder",
        content: item.content,
      });
    }
  }
  return entries;
}

function adaptBashPort(manager: BashSessionManager): BashPort {
  return {
    async execute(request: ToolRequest): Promise<BashObservation> {
      if (request.kind === "command") {
        return manager.executeCommandAutoCreate(
          request.session,
          request.command,
          request.timeoutMs,
        );
      }

      // Control request -- adapt to BashControlInput
      if (request.control === "list") {
        return manager.handleControl({ control: "list" });
      }

      if (request.control === "create") {
        return manager.handleControl({
          control: "create",
          session: request.session!,
          cwd: request.createOptions?.cwd,
          shell: request.createOptions?.shell,
          env: request.createOptions?.env,
          defaultTimeoutMs: request.createOptions?.defaultTimeoutMs,
          maxObservationBytes: request.createOptions?.maxObservationBytes,
        });
      }

      if (request.control === "sendInput") {
        return manager.handleControl({
          control: "sendInput",
          session: request.session!,
          input: request.input!,
        });
      }

      // status | poll | interrupt | terminate | restart
      return manager.handleControl({
        control: request.control as
          | "status"
          | "poll"
          | "interrupt"
          | "terminate"
          | "restart",
        session: request.session!,
      });
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

async function waitForNewLatestRun(options: {
  runsDir: string;
  previousRunId?: string;
  child: ChildProcess;
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

async function runUnifiedUi(args: string[]): Promise<void> {
  const { channel: parsedChannel, task, stateDir } = parseCliOptions(args);
  const channel = parsedChannel ?? process.env.TAH_IM_CHANNEL ?? "default";
  const apiKey = resolveDeepSeekApiKey();

  if (!apiKey) {
    die(missingApiKeyMessage());
  }

  const baseDir = path.resolve(stateDir ?? ".tiny-agent");
  const runsDir = path.join(baseDir, "runs");
  const launcherDir = path.join(baseDir, "launcher");
  fs.mkdirSync(launcherDir, { recursive: true });

  const previousRunId = readLatestRunId(runsDir);
  const logPath = path.join(launcherDir, `ui-${Date.now()}.log`);
  const logStream = fs.createWriteStream(logPath, { flags: "a" });

  const runArgs = [
    ...process.execArgv,
    process.argv[1]!,
    "run",
    "--channel",
    channel,
    "--state-dir",
    baseDir,
  ];
  if (task) {
    runArgs.push("--task", task);
  }

  const child = spawn(process.execPath, runArgs, {
    cwd: process.cwd(),
    env: { ...process.env, DEEPSEEK_API_KEY: apiKey },
    stdio: ["ignore", "pipe", "pipe"],
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

  const runId = await waitForNewLatestRun({
    runsDir,
    previousRunId,
    child,
    timeoutMs: 5_000,
  });

  console.log(`[tiny-agent] Started background run: ${runId}`);
  console.log(`[tiny-agent] Agent log: ${logPath}`);
  console.log("[tiny-agent] Opening TUI. Press m to send the first task.");

  const { runTui } = await import("./tui.js");
  runTui(["--run", runId, "--channel", channel, "--state-dir", baseDir]);
}

async function waitForFirstMessage(
  transport: ImCliTransport,
  environment: Environment,
  channel: string,
): Promise<string> {
  // Skip messages already in inbox from previous runs
  const existing = await transport.receive({ channel });
  let cursor = existing.nextCursor;

  while (true) {
    const result = await transport.receive({ channel, cursor });
    if (result.messages.length > 0) {
      const msg = result.messages[0]!;
      environment.appendEvent({
        id: `env-im-${msg.id}`,
        kind: "user_message_received",
        source: "im",
        timestamp: msg.createdAt,
        message: msg,
      });
      return msg.text;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const HELP_TEXT = `tiny-agent — AI agent harness with bash tool calling

Usage:
  tiny-agent <task>                                   Run with inline task
  tiny-agent run --channel <ch> [--task <task>]       Run, optionally wait for IM
  tiny-agent ui  --channel <ch> [--task <task>]       Run + TUI in one command
  tiny-agent tui --run <runId|latest>                 Attach TUI to existing run
  tiny-agent im  <subcommand> [options]               IM message operations
  tiny-agent skill <subcommand> [options]             Skill management
  tiny-agent --help                                   Show this help

IM subcommands:
  post   --channel <ch> --text <text>          Post user message to inbox
  recv   --channel <ch> [--cursor <id>]        Receive user messages from inbox
  send   --channel <ch> --text <t> --kind <k>  Send agent message to outbox
  ack    --channel <ch> --message-id <id>      Acknowledge (advance cursor)
  listen --channel <ch> [--cursor <id>]        Poll for new messages

Skill subcommands:
  list                          List available skills
  show   <name>                 Show skill details
  run    <name>                 Execute a skill
  status [<runId>]              Check skill run status
  close  <runId>                Close a skill run
  review-complete <runId>       Complete skill review
  validate <name>               Validate skill structure

Environment variables:
  DEEPSEEK_API_KEY   (required) API key for DeepSeek
  DEEPSEEK_BASE_URL  Base URL (default: https://api.deepseek.com/beta)
  MODEL_NAME         Model name (default: deepseek-v4-pro)
  TAH_IM_CHANNEL     Default IM channel (default: "default")

All flags accept --json for machine-readable output and --state-dir to override .tiny-agent location.
`;

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

  // --- Parse run arguments ---
  // Supported forms:
  //   tiny-agent "fix the tests"                     (legacy positional)
  //   tiny-agent run --channel default                (wait for IM message)
  //   tiny-agent run --channel default --task "fix"   (task + channel)
  const args = process.argv.slice(2);
  let channel: string | undefined;
  let taskArg: string | undefined;
  let stateDirArg: string | undefined;

  if (args[0] === "run") {
    const parsed = parseCliOptions(args.slice(1));
    channel = parsed.channel;
    taskArg = parsed.task;
    stateDirArg = parsed.stateDir;
    if (!channel) {
      die("Usage: tiny-agent run --channel <channel> [--task <task>] [--state-dir <dir>]");
    }
  } else if (args[0]) {
    const reserved = ["io_wait", "io-wait", "final"];
    if (reserved.includes(args[0])) {
      die(`"${args[0]}" is a tool call, not a CLI command. Do not run it via bash.`);
    }
    const parsed = parseCliOptions(args.slice(1));
    channel = parsed.channel;
    stateDirArg = parsed.stateDir;
    taskArg = args[0];
  } else {
    die(
        "Usage:\n" +
        "  tiny-agent <task> [--state-dir <dir>]\n" +
        "  tiny-agent run --channel <channel> [--task <task>] [--state-dir <dir>]\n" +
        "  tiny-agent ui --channel <channel> [--task <task>] [--state-dir <dir>]",
    );
  }

  // --- Read env vars ---
  const apiKey = resolveDeepSeekApiKey();
  if (!apiKey) {
    die(missingApiKeyMessage());
  }

  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/beta";
  const modelName = process.env.MODEL_NAME ?? "deepseek-v4-pro";
  if (!channel) {
    channel = process.env.TAH_IM_CHANNEL ?? "default";
  }

  // --- Create directory structure ---
  const baseDir = path.resolve(stateDirArg ?? ".tiny-agent");
  const runsDir = path.join(baseDir, "runs");
  const sessionsDir = path.join(baseDir, "sessions");
  const skillsDir = path.join(baseDir, "skills");
  const skillRunsDir = path.join(baseDir, "skill-runs");
  const imDir = path.join(baseDir, "im");
  for (const dir of [runsDir, sessionsDir, skillsDir, skillRunsDir, imDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // --- Create run ID and transcript path ---
  const runId = `run-${Date.now()}`;
  const runDir = path.join(runsDir, runId);
  const transcriptPath = path.join(runDir, "transcript.jsonl");
  const maxSteps = 50;
  const transcript = new TranscriptStore(runDir);
  const initialDisplayTask =
    taskArg ?? `Waiting for first user message on channel "${channel}"`;

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
      maxSteps,
      transcriptPath,
    }).data,
    status: taskArg ? "created" : "waiting_for_io",
    updatedAt: new Date().toISOString(),
  });
  publishLatestRun(runsDir, runId, runDir);

  // --- Wire up modules ---
  const bashManager = new BashSessionManager({ logDir: sessionsDir, defaultCwd: process.cwd() });

  const model = new DeepSeekFimAdapter({
    apiKey,
    baseUrl,
    model: modelName,
    thinkingMaxTokens: 4096,
    decisionMaxTokens: 2048,
  });

  const promptBuilder = new PromptBuilder();
  const validator = new ToolCallValidator();
  const reviewer = new AlwaysApproveReviewer();

  const environment = new Environment();
  const imTransport = new ImCliTransport({ baseDir: imDir });
  const skillRunStore = new SkillRunStore({ skillRunsDir, skillsDir });

  // --- Wait for first IM message if no --task ---
  let task: string;
  if (taskArg) {
    task = taskArg;
    const createdAt = new Date().toISOString();
    environment.appendEvent({
      id: `env-task-${runId}`,
      kind: "user_message_received",
      source: "im",
      timestamp: createdAt,
      message: {
        id: `task-${runId}`,
        channel,
        role: "user",
        text: taskArg,
        createdAt,
      },
    });
  } else {
    console.log(`[tiny-agent] Waiting for user message on channel: ${channel}`);
    task = await waitForFirstMessage(imTransport, environment, channel);
    console.log(`[tiny-agent] Received task: ${task}`);
  }

  // --- IM → Environment bridge: poll inbox for new user messages ---
  let imCursor: string | undefined;
  // If we already consumed the first message, set cursor past it
  {
    const initial = await imTransport.receive({ channel });
    if (initial.nextCursor) {
      imCursor = initial.nextCursor;
    }
  }
  let imPollingActive = true;
  const imPollInterval = setInterval(async () => {
    if (!imPollingActive) return;
    try {
      const result = await imTransport.receive({ channel, cursor: imCursor });
      for (const msg of result.messages) {
        environment.appendEvent({
          id: `env-im-${msg.id}`,
          kind: "user_message_received",
          source: "im",
          timestamp: msg.createdAt,
          message: msg,
        });
      }
      if (result.nextCursor) {
        imCursor = result.nextCursor;
      }
    } catch {
      // Best-effort polling
    }
  }, 500);

  // --- Build RunPorts ---
  const ports: RunPorts = {
    model,
    validator,
    reviewer,
    bash: adaptBashPort(bashManager),
    prompt: {
      buildMessages(task: string, history: HistoryItem[]): V4ChatMessage[] {
        const entries = convertHistoryItems(history);
        const hasToolHistory = entries.some(
          (e) => e.role === "assistant_tool_call" || e.role === "tool_result",
        );
        if (!hasToolHistory && entries.length === 0) {
          return promptBuilder.buildInitialPrompt(task).messages;
        }
        return promptBuilder.buildNextPrompt(task, entries).messages;
      },
    },
    bashTool: BASH_TOOL_DEFINITION,
    environment,
    listActiveSkillRuns: () => skillRunStore.listActive(),
  };

  // --- Create initial state ---
  const initialState = AgentRunState.create({
    runId,
    task,
    cwd: process.cwd(),
    maxSteps,
    transcriptPath,
  });

  // --- Create transcript store and orchestrator ---
  const orchestrator = new RunOrchestrator(initialState, transcript, ports);

  // --- Run ---
  console.log(`[tiny-agent] Run ${runId} started`);
  console.log(`[tiny-agent] Task: ${task}`);
  console.log(`[tiny-agent] Model: ${modelName} @ ${baseUrl}`);
  console.log(`[tiny-agent] Max steps: ${maxSteps}`);
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
    bashManager.terminateAll();
  }
}

main().catch((err: unknown) => {
  console.error("[tiny-agent] Fatal error:", err);
  process.exit(1);
});
