import * as path from "node:path";
import {
  DEFAULT_RUN_USER_ENDPOINT,
  createRunImSelfEndpoint,
  type PublicImMessage,
  type PublicImService,
} from "../im/index.js";
import type { AgentMessage, UserMessage } from "../types/environment.js";
import type { TuiViewModel } from "../tui/types.js";
import type { RunIndexRow } from "../tui/debugger.js";
import { scanRunIndex } from "../tui/run-index-reader.js";
import { SessionLogTailReader } from "../tui/session-log-tail.js";
import { TranscriptReader } from "../tui/transcript-reader.js";
import { ViewModelBuilder } from "../tui/view-model-builder.js";

export type ProjectSnapshotInput = {
  stateRoot: string;
  selectedRunId?: string;
  imService: PublicImService;
  userEndpoint?: string;
};

export type ProjectSnapshotResult = {
  selectedRunId?: string;
  view: TuiViewModel;
};

export async function readProjectSnapshot(
  input: ProjectSnapshotInput,
): Promise<ProjectSnapshotResult> {
  const projector = new ProjectSnapshotProjector(input);
  try {
    return await projector.snapshot({ selectedRunId: input.selectedRunId });
  } finally {
    projector.dispose();
  }
}

export class ProjectSnapshotProjector {
  private readonly stateRoot: string;
  private readonly runsDir: string;
  private readonly imService: PublicImService;
  private readonly userEndpoint: string;
  private readonly runs = new Map<string, RunViewProjector>();

  constructor(input: {
    stateRoot: string;
    imService: PublicImService;
    userEndpoint?: string;
  }) {
    this.stateRoot = input.stateRoot;
    this.runsDir = path.join(input.stateRoot, "runs");
    this.imService = input.imService;
    this.userEndpoint = input.userEndpoint ?? DEFAULT_RUN_USER_ENDPOINT;
  }

  async snapshot(input: {
    selectedRunId?: string;
  } = {}): Promise<ProjectSnapshotResult> {
    const rows = scanRunIndex(this.runsDir);
    const selectedRunId = resolveSelectedRunId(rows, input.selectedRunId);
    this.pruneMissingRuns(new Set(rows.map((row) => row.runId)));

    if (!selectedRunId) {
      const builder = new ViewModelBuilder();
      builder.applyRunBrowserRows(rows, { selectedRunId });
      return {
        selectedRunId,
        view: builder.getViewModel(),
      };
    }

    const view = await this.projectRun(selectedRunId).snapshot({
      rows,
      selectedRunId,
    });
    return { selectedRunId, view };
  }

  dispose(): void {
    for (const run of this.runs.values()) {
      run.dispose();
    }
    this.runs.clear();
  }

  private projectRun(runId: string): RunViewProjector {
    let run = this.runs.get(runId);
    if (!run) {
      run = new RunViewProjector({
        runDir: path.join(this.runsDir, runId),
        stateRoot: this.stateRoot,
        runId,
        userEndpoint: this.userEndpoint,
        imService: this.imService,
      });
      this.runs.set(runId, run);
    }
    return run;
  }

  private pruneMissingRuns(liveRunIds: Set<string>): void {
    for (const [runId, run] of this.runs.entries()) {
      if (!liveRunIds.has(runId)) {
        run.dispose();
        this.runs.delete(runId);
      }
    }
  }
}

class RunViewProjector {
  private readonly builder = new ViewModelBuilder();
  private readonly reader: TranscriptReader;
  private readonly sessionLogs: SessionLogTailReader;
  private readonly stateRoot: string;
  private readonly runId: string;
  private readonly userEndpoint: string;
  private readonly imService: PublicImService;
  private userMessageCursor: string | undefined;
  private agentMessageCursor: string | undefined;

  constructor(input: {
    runDir: string;
    stateRoot: string;
    runId: string;
    userEndpoint: string;
    imService: PublicImService;
  }) {
    this.reader = new TranscriptReader(input.runDir);
    this.sessionLogs = new SessionLogTailReader({
      sessionsDir: path.join(input.runDir, "sessions"),
    });
    this.stateRoot = input.stateRoot;
    this.runId = input.runId;
    this.userEndpoint = input.userEndpoint;
    this.imService = input.imService;
  }

  async snapshot(input: {
    rows: readonly RunIndexRow[];
    selectedRunId: string;
  }): Promise<TuiViewModel> {
    const { events } = this.reader.readNewEvents();
    for (const event of events) {
      this.builder.applyEvent(event);
    }

    const state = this.reader.readState();
    if (state) {
      this.builder.applyState(state);
    }

    this.builder.applySessionLogTails(await this.sessionLogs.read());
    await this.applyPublicImProjection();
    this.builder.applyRunBrowserRows(input.rows, {
      selectedRunId: input.selectedRunId,
    });
    return this.builder.getViewModel();
  }

  dispose(): void {
    this.sessionLogs.dispose();
  }

  private async applyPublicImProjection(): Promise<void> {
    const selfEndpoint = createRunImSelfEndpoint(this.runId);
    const [userMessages, agentMessages] = await Promise.all([
      this.imService.readChannelMessages({
        stateRoot: this.stateRoot,
        from: this.userEndpoint,
        to: selfEndpoint,
        cursor: this.userMessageCursor,
      }),
      this.imService.readChannelMessages({
        stateRoot: this.stateRoot,
        from: selfEndpoint,
        to: this.userEndpoint,
        cursor: this.agentMessageCursor,
      }),
    ]);

    this.userMessageCursor = userMessages.nextCursor;
    this.agentMessageCursor = agentMessages.nextCursor;

    for (const message of userMessages.messages) {
      this.builder.addImUserMessage(publicToUserMessage(message));
    }
    for (const message of agentMessages.messages) {
      this.builder.addImAgentMessage(publicToAgentMessage(message));
    }
  }
}

function resolveSelectedRunId(
  rows: readonly { runId: string }[],
  requested: string | undefined,
): string | undefined {
  if (rows.length === 0) {
    return undefined;
  }
  if (!requested || requested === "latest") {
    return rows[0]?.runId;
  }
  return rows.some((row) => row.runId === requested) ? requested : rows[0]?.runId;
}

function publicToUserMessage(message: PublicImMessage): UserMessage {
  return {
    id: message.id,
    channel: message.to,
    role: "user",
    text: message.text,
    createdAt: message.createdAt,
    metadata: publicMessageMetadata(message),
  };
}

function publicToAgentMessage(message: PublicImMessage): AgentMessage {
  return {
    id: message.id,
    channel: message.from,
    role: "agent",
    kind: message.kind === "error" ? "error" : "status",
    text: message.text,
    createdAt: message.createdAt,
    metadata: publicMessageMetadata(message),
  };
}

function publicMessageMetadata(message: PublicImMessage): Record<string, string> {
  const metadata: Record<string, string> = {
    from: message.from,
    to: message.to,
  };
  if (message.metadata?.source && typeof message.metadata.source === "string") {
    metadata.source = message.metadata.source;
  }
  return metadata;
}
