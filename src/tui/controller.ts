// ─── TUI Controller ─────────────────────────────────────────────────
//
// Orchestrates the TUI by wiring together:
//   TranscriptReader  → reads transcript.jsonl + state.json
//   ViewModelBuilder  → converts events into TuiViewModel
//   BlessedRenderer   → renders the view model to the terminal
//
// Polls the transcript file at a configurable interval and
// re-renders on each tick.

import { TranscriptReader } from "./transcript-reader.js";
import { ViewModelBuilder } from "./view-model-builder.js";
import { BlessedRenderer } from "./renderer.js";

export class TuiController {
  private readonly reader: TranscriptReader;
  private readonly builder: ViewModelBuilder;
  private readonly renderer: BlessedRenderer;
  private readonly pollIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: { runDir: string; pollIntervalMs?: number }) {
    this.reader = new TranscriptReader(options.runDir);
    this.builder = new ViewModelBuilder();
    this.renderer = new BlessedRenderer();
    this.pollIntervalMs = options.pollIntervalMs ?? 500;
  }

  start(): void {
    // Initial load
    this.poll();

    // Set up polling
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);

    // Handle quit
    this.renderer.onKey((key) => {
      if (key.name === "q") {
        this.stop();
        process.exit(0);
      }
    });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.renderer.close();
  }

  private poll(): void {
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

    // Render
    const viewModel = this.builder.getViewModel();
    this.renderer.render(viewModel);
  }
}
