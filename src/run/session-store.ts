import * as fs from "node:fs";
import * as path from "node:path";
import type { HistoryItem } from "./orchestrator.js";
import type { RunEvent } from "../types/run.js";

const SESSION_SCHEMA_VERSION = 1;

export type RunSessionSnapshot = {
  schemaVersion: 1;
  runId: string;
  updatedAt: string;
  history: HistoryItem[];
};

export class RunSessionStore {
  private readonly sessionPath: string;

  constructor(private readonly runDir: string) {
    this.sessionPath = path.join(runDir, "session.json");
  }

  save(snapshot: Omit<RunSessionSnapshot, "schemaVersion">): void {
    fs.mkdirSync(this.runDir, { recursive: true });
    const tmpPath = `${this.sessionPath}.tmp.${process.pid}`;
    fs.writeFileSync(
      tmpPath,
      JSON.stringify({ schemaVersion: SESSION_SCHEMA_VERSION, ...snapshot }, null, 2),
      "utf-8",
    );
    fs.renameSync(tmpPath, this.sessionPath);
  }

  load(): RunSessionSnapshot | null {
    if (!fs.existsSync(this.sessionPath)) {
      return null;
    }
    const parsed = JSON.parse(fs.readFileSync(this.sessionPath, "utf-8")) as {
      schemaVersion?: unknown;
      runId?: unknown;
      updatedAt?: unknown;
      history?: unknown;
    };
    if (
      parsed.schemaVersion !== SESSION_SCHEMA_VERSION ||
      typeof parsed.runId !== "string" ||
      typeof parsed.updatedAt !== "string" ||
      !Array.isArray(parsed.history)
    ) {
      throw new Error(`Invalid run session snapshot: ${this.sessionPath}`);
    }
    return parsed as RunSessionSnapshot;
  }

  get filePath(): string {
    return this.sessionPath;
  }
}

export function reconstructHistoryFromTranscript(
  events: readonly RunEvent[],
): HistoryItem[] {
  const history: HistoryItem[] = [];
  let pendingOutput:
    | Extract<RunEvent, { type: "model_output_received" }>
    | undefined;

  for (const event of events) {
    switch (event.type) {
      case "model_output_received":
        pendingOutput = event;
        break;

      case "tool_execution_finished":
        if (pendingOutput?.turn.kind === "tool_call") {
          history.push({
            type: "tool_call",
            toolCall: pendingOutput.turn.toolCall,
            thinking: pendingOutput.output.thinking,
          });
        }
        history.push({
          type: "observation",
          observation: event.observation,
        });
        pendingOutput = undefined;
        break;

      case "observation_appended":
        history.push({
          type: "observation",
          observation: event.observation,
        });
        pendingOutput = undefined;
        break;

      case "io_wait_started":
        if (pendingOutput?.turn.kind === "io_wait") {
          history.push({
            type: "io_wait_call",
            toolCallId: `fim-call-${findRunId(events)}-${event.stepIndex}`,
            wait: event.wait,
            thinking: pendingOutput.output.thinking,
          });
        }
        break;

      case "io_wait_satisfied":
        history.push({
          type: "observation",
          toolCallId: `fim-call-${findRunId(events)}-${event.stepIndex}`,
          observation: {
            kind: "io_wait",
            message: "io_wait satisfied by external event.",
            recoverable: false,
            event: event.event,
          },
        });
        pendingOutput = undefined;
        break;

      case "history_compacted":
        history.splice(0, history.length, {
          type: "environment_reminder",
          content: event.compaction.summary,
        });
        break;

      default:
        break;
    }
  }

  return history;
}

function findRunId(events: readonly RunEvent[]): string {
  const started = events.find((event) => event.type === "run_started");
  if (started?.type === "run_started") {
    return started.runId;
  }
  const resumed = events.find((event) => event.type === "run_resumed");
  if (resumed?.type === "run_resumed") {
    return resumed.runId;
  }
  return "unknown";
}
