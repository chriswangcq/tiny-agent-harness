// ─── TUI Controller ─────────────────────────────────────────────────
//
// Orchestrates the TUI by wiring together:
//   TranscriptReader  → reads transcript.jsonl + state.json
//   ViewModelBuilder  → converts events into TuiViewModel
//   BlessedRenderer   → renders the view model to the terminal
//   ImCliTransport    → reads IM inbox/outbox, sends user messages
//
// Polls the transcript file and IM at a configurable interval and
// re-renders on each tick.

import { TranscriptReader } from "./transcript-reader.js";
import { ViewModelBuilder } from "./view-model-builder.js";
import { BlessedRenderer } from "./renderer.js";
import { ImCliTransport } from "../im/transport.js";
import { SessionLogTailReader } from "./session-log-tail.js";
import * as path from "node:path";

export class TuiController {
  private readonly reader: TranscriptReader;
  private readonly builder: ViewModelBuilder;
  private readonly renderer: BlessedRenderer;
  private readonly im: ImCliTransport;
  private readonly sessionLogs: SessionLogTailReader;
  private readonly channel: string;
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private imInboxCursor: string | undefined;
  private imOutboxCursor: string | undefined;

  constructor(options: {
    runDir: string;
    imBaseDir?: string;
    channel?: string;
    pollIntervalMs?: number;
  }) {
    this.reader = new TranscriptReader(options.runDir);
    this.builder = new ViewModelBuilder();
    this.renderer = new BlessedRenderer();
    this.sessionLogs = new SessionLogTailReader({
      sessionsDir: path.join(options.runDir, "sessions"),
    });
    this.im = new ImCliTransport({
      baseDir: options.imBaseDir ?? ".tiny-agent/im",
    });
    this.channel = options.channel ?? "default";
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
  }

  start(): void {
    void this.poll();

    this.timer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);

    this.renderer.onKey((key) => {
      if (key.name === "q") {
        this.stop();
        process.exit(0);
      }
    });

    this.renderer.onMessage(async (text: string) => {
      await this.sendUserMessage(text);
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

  private async poll(): Promise<void> {
    if (this.polling) {
      return;
    }
    this.polling = true;
    try {
      // Read new transcript events
      const { events } = this.reader.readNewEvents();
      for (const event of events) {
        this.builder.applyEvent(event);
      }

      // Read latest state
      const state = this.reader.readState();
      if (state) {
        this.builder.applyState(state);
      }

      // Poll IM inbox for user messages
      this.pollImInbox();

      // Poll IM outbox for agent messages
      this.pollImOutbox();

      // Read live session logs for display-only PTY pane updates. This does not
      // mutate runtime state or model-visible context.
      try {
        this.builder.applySessionLogTails(await this.sessionLogs.read());
      } catch {
        // Best-effort display projection; transcript/state rendering continues.
      }

      // Render
      const viewModel = this.builder.getViewModel();
      this.renderer.render(viewModel);
    } finally {
      this.polling = false;
    }
  }

  private pollImInbox(): void {
    try {
      const result = this.im.receiveSync({
        channel: this.channel,
        cursor: this.imInboxCursor,
      });
      for (const msg of result.messages) {
        this.builder.addImUserMessage(msg);
      }
      if (result.nextCursor) {
        this.imInboxCursor = result.nextCursor;
      }
    } catch {
      // Best-effort — IM may not exist yet
    }
  }

  private pollImOutbox(): void {
    try {
      const result = this.im.readOutboxSync({
        channel: this.channel,
        cursor: this.imOutboxCursor,
      });
      for (const msg of result.messages) {
        this.builder.addImAgentMessage(msg);
      }
      if (result.nextCursor) {
        this.imOutboxCursor = result.nextCursor;
      }
    } catch {
      // Best-effort
    }
  }

  private async sendUserMessage(text: string): Promise<void> {
    const id = `tui-msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    await this.im.post({
      id,
      channel: this.channel,
      role: "user",
      text,
      createdAt: new Date().toISOString(),
    });
  }
}
