// ─── TUI Controller ─────────────────────────────────────────────────
//
// Orchestrates the TUI by wiring together:
//   TranscriptReader  → reads transcript.jsonl + state.json
//   ViewModelBuilder  → converts events into TuiViewModel
//   BlessedRenderer   → renders the view model to the terminal
//   PublicImService   → projects public IM channel logs and posts user messages
//
// Polls the transcript file and public IM at a configurable interval and
// re-renders on each tick.

import * as crypto from "node:crypto";
import * as path from "node:path";
import {
  DEFAULT_RUN_USER_ENDPOINT,
  PublicImService,
  createNodeImStore,
  createRunImSelfEndpoint,
  type PublicImMessage,
} from "../im/index.js";
import type { AgentMessage, UserMessage } from "../types/environment.js";
import { BlessedRenderer } from "./renderer.js";
import { scanRunIndex } from "./run-index-reader.js";
import { SessionLogTailReader } from "./session-log-tail.js";
import { TranscriptReader } from "./transcript-reader.js";
import type { SessionTailUpdate, TuiKey, TuiViewModel } from "./types.js";
import { ViewModelBuilder } from "./view-model-builder.js";

export type TuiRendererPort = {
  render(view: TuiViewModel): void;
  onKey(handler: (key: TuiKey) => void): void;
  onMessage(handler: (text: string) => void): void;
  close(): void;
};

export type TuiSessionLogPort = {
  read(): Promise<SessionTailUpdate[]>;
  dispose(): void;
};

export type TuiControllerOptions = {
  runDir: string;
  stateRoot: string;
  runId: string;
  selfEndpoint?: string;
  userEndpoint?: string;
  pollIntervalMs?: number;
  runsDir?: string;
  imService?: PublicImService;
  builder?: ViewModelBuilder;
  renderer?: TuiRendererPort;
  sessionLogs?: TuiSessionLogPort;
};

export class TuiController {
  private readonly reader: TranscriptReader;
  private readonly builder: ViewModelBuilder;
  private readonly renderer: TuiRendererPort;
  private readonly im: PublicImService;
  private readonly sessionLogs: TuiSessionLogPort;
  private readonly stateRoot: string;
  private readonly selfEndpoint: string;
  private readonly userEndpoint: string;
  private readonly pollIntervalMs: number;
  private readonly runsDir?: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private imUserCursor: string | undefined;
  private imAgentCursor: string | undefined;

  constructor(options: TuiControllerOptions) {
    this.reader = new TranscriptReader(options.runDir);
    this.builder = options.builder ?? new ViewModelBuilder();
    this.renderer = options.renderer ?? new BlessedRenderer();
    this.sessionLogs =
      options.sessionLogs ??
      new SessionLogTailReader({
        sessionsDir: path.join(options.runDir, "sessions"),
      });
    this.im = options.imService ?? createTuiPublicImService();
    this.stateRoot = options.stateRoot;
    this.selfEndpoint = options.selfEndpoint ?? createRunImSelfEndpoint(options.runId);
    this.userEndpoint = options.userEndpoint ?? DEFAULT_RUN_USER_ENDPOINT;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.runsDir = options.runsDir;
  }

  start(): void {
    void this.pollOnce();

    this.timer = setInterval(() => {
      void this.pollOnce();
    }, this.pollIntervalMs);

    this.renderer.onKey((key) => {
      if (key.name === "q") {
        this.stop();
        process.exit(0);
      }
    });

    this.renderer.onMessage(async (text: string) => {
      await this.submitUserMessage(text);
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.sessionLogs.dispose();
    this.renderer.close();
  }

  async pollOnce(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      const { events } = this.reader.readNewEvents();
      for (const event of events) {
        this.builder.applyEvent(event);
      }

      const state = this.reader.readState();
      if (state) {
        this.builder.applyState(state);
      }

      await this.pollPublicImUserMessages();
      await this.pollPublicImAgentMessages();

      try {
        this.builder.applySessionLogTails(await this.sessionLogs.read());
      } catch {
        // Best-effort display projection; transcript/state rendering continues.
      }

      if (this.runsDir) {
        try {
          const runRows = scanRunIndex(this.runsDir);
          this.builder.applyRunBrowserRows(runRows);
        } catch {
          // Best-effort; transcript/state rendering continues.
        }
      }

      const viewModel = this.builder.getViewModel();
      this.renderer.render(viewModel);
    } finally {
      this.polling = false;
    }
  }

  private async pollPublicImUserMessages(): Promise<void> {
    try {
      const result = await this.im.readChannelMessages({
        stateRoot: this.stateRoot,
        from: this.userEndpoint,
        to: this.selfEndpoint,
        cursor: this.imUserCursor,
      });
      for (const message of result.messages) {
        if (message.role === "user") {
          this.builder.addImUserMessage(publicToUserMessage(message));
        }
      }
      if (result.nextCursor) {
        this.imUserCursor = result.nextCursor;
      }
    } catch {
      // Best-effort — public IM may not exist yet.
    }
  }

  private async pollPublicImAgentMessages(): Promise<void> {
    try {
      const result = await this.im.readChannelMessages({
        stateRoot: this.stateRoot,
        from: this.selfEndpoint,
        to: this.userEndpoint,
        cursor: this.imAgentCursor,
      });
      for (const message of result.messages) {
        if (message.role === "agent") {
          this.builder.addImAgentMessage(publicToAgentMessage(message));
        }
      }
      if (result.nextCursor) {
        this.imAgentCursor = result.nextCursor;
      }
    } catch {
      // Best-effort — public IM may not exist yet.
    }
  }

  async submitUserMessage(text: string): Promise<void> {
    await this.im.postMessage({
      stateRoot: this.stateRoot,
      from: this.userEndpoint,
      to: this.selfEndpoint,
      text,
      metadata: { source: "tui" },
    });
  }
}

function createTuiPublicImService(): PublicImService {
  return new PublicImService({
    store: createNodeImStore(),
    clock: { nowIso: () => new Date().toISOString() },
    ids: {
      newMessageId: (seed) => {
        const scope = seed.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
        return `tui-im-${scope}-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
      },
    },
  });
}

function publicToUserMessage(message: PublicImMessage): UserMessage {
  return {
    id: message.id,
    channel: message.channelId,
    role: "user",
    text: message.text,
    createdAt: message.createdAt,
    metadata: publicMessageMetadata(message),
  };
}

function publicToAgentMessage(message: PublicImMessage): AgentMessage {
  return {
    id: message.id,
    channel: message.channelId,
    role: "agent",
    kind: message.kind === "error" ? "error" : "status",
    text: message.text,
    createdAt: message.createdAt,
    metadata: publicMessageMetadata(message),
  };
}

function publicMessageMetadata(message: PublicImMessage): Record<string, string> {
  return {
    from: message.from,
    to: message.to,
    pairId: message.pairId,
  };
}
