import * as fs from "node:fs";
import * as path from "node:path";

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
import type { ToolRequest } from "../types/tools.js";
import type { BashObservation } from "../types/bash.js";
import type { ModelPromptMessage } from "../types/model.js";
import type { EnvironmentPort } from "../types/environment.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function die(message: string): never {
  console.error(`[tiny-agent] ERROR: ${message}`);
  process.exit(1);
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
      });
    } else {
      entries.push({
        role: "tool_result",
        toolCallId: "",
        observation: item.observation,
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

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // --- Route subcommands ---
  const firstArg = process.argv[2];

  if (firstArg === "tui") {
    const { runTui } = await import("./tui.js");
    runTui(process.argv.slice(3));
    return;
  }

  // --- Read task from argv ---
  const task = firstArg;
  if (!task) {
    die("Usage: tiny-agent <task>\n  Provide the task as the first argument.");
  }

  // --- Read env vars ---
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    die(
      "DEEPSEEK_API_KEY environment variable is required.\n" +
        "  export DEEPSEEK_API_KEY=your-key-here",
    );
  }

  const baseUrl = process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com/beta";
  const modelName = process.env.MODEL_NAME ?? "deepseek-v4-pro";

  // --- Create directory structure ---
  const baseDir = path.resolve(".tiny-agent");
  const runsDir = path.join(baseDir, "runs");
  const sessionsDir = path.join(baseDir, "sessions");
  fs.mkdirSync(runsDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });

  // --- Create run ID and transcript path ---
  const runId = `run-${Date.now()}`;
  const runDir = path.join(runsDir, runId);
  const transcriptPath = path.join(runDir, "transcript.jsonl");

  // --- Wire up modules ---
  const bashManager = new BashSessionManager({ logDir: sessionsDir });

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

  // --- Build RunPorts ---
  const ports: RunPorts = {
    model,
    validator,
    reviewer,
    bash: adaptBashPort(bashManager),
    prompt: {
      buildMessages(task: string, history: HistoryItem[]): ModelPromptMessage[] {
        const entries = convertHistoryItems(history);
        if (entries.length === 0) {
          return promptBuilder.buildInitialPrompt(task).messages;
        }
        return promptBuilder.buildNextPrompt(task, entries).messages;
      },
    },
    bashTool: BASH_TOOL_DEFINITION,
    environment: {
      appendEvent() {},
      consumeSince() { return []; },
      waitFor() { return new Promise(() => {}); },
    },
    listActiveSkillRuns: () => [],
  };

  // --- Create initial state ---
  const maxSteps = 50;
  const initialState = AgentRunState.create({
    runId,
    task,
    cwd: process.cwd(),
    maxSteps,
    transcriptPath,
  });

  // --- Create transcript store and orchestrator ---
  const transcript = new TranscriptStore(runDir);
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

    if (finalState.data.final) {
      console.log();
      console.log("=== Agent Response ===");
      console.log(finalState.data.final);
    }

    if (finalState.data.error) {
      console.error();
      console.error(`[tiny-agent] Error: ${finalState.data.error.message}`);
    }

    console.log();
    console.log(`[tiny-agent] Transcript: ${transcriptPath}`);
  } finally {
    bashManager.terminateAll();
  }
}

main().catch((err: unknown) => {
  console.error("[tiny-agent] Fatal error:", err);
  process.exit(1);
});
