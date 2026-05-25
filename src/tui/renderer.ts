// ─── BlessedRenderer ────────────────────────────────────────────────
//
// Implements TuiRenderer using neo-blessed (maintained fork of blessed).
// Renders the three-pane TUI layout: header, conversation pane, loop player,
// and a persistent input bar at the bottom.
//
// Input uses blessed readInput for proper IME/CJK support.
// Escape = exit input mode (browse panes), Tab = re-enter input mode.

import blessed from "neo-blessed";
import type {
  TuiRenderer,
  TuiViewModel,
  TuiKey,
  LoopFrame,
  ConversationItem,
  RunHeaderView,
} from "./types.js";

export class BlessedRenderer implements TuiRenderer {
  private screen: blessed.Widgets.Screen;
  private headerBox: blessed.Widgets.BoxElement;
  private conversationList: blessed.Widgets.ListElement;
  private loopList: blessed.Widgets.ListElement;
  private helpBox: blessed.Widgets.BoxElement;
  private inputBox: blessed.Widgets.TextboxElement;
  private browsePane: "loop" | "conversation" = "loop";
  private inputMode = true;
  private followMode = true;
  private expandedFrames = new Set<string>();
  private keyHandler?: (key: TuiKey) => void;
  private messageHandler?: (text: string) => void;

  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: "tiny-agent TUI",
      fullUnicode: true,
    });

    this.headerBox = blessed.box({
      top: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      style: { fg: "white", bg: "black" },
    });

    this.conversationList = blessed.list({
      top: 1,
      left: 0,
      width: "100%",
      height: "50%-1",
      border: { type: "line" },
      label: " Conversation ",
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: "│", style: { fg: "cyan" } },
      tags: true,
      style: {
        border: { fg: "gray" },
        selected: { bg: "blue" },
      },
      keys: false,
      mouse: false,
    });

    this.loopList = blessed.list({
      top: "50%",
      left: 0,
      width: "100%",
      height: "50%-3",
      border: { type: "line" },
      label: " Agent Loop ",
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: "│", style: { fg: "cyan" } },
      tags: true,
      style: {
        border: { fg: "gray" },
        selected: { bg: "blue" },
      },
      keys: false,
      mouse: false,
    });

    this.helpBox = blessed.box({
      top: "center",
      left: "center",
      width: 54,
      height: 16,
      border: { type: "line" },
      label: " Help ",
      hidden: true,
      tags: true,
      style: { border: { fg: "yellow" } },
      content: [
        "{bold}Keyboard Shortcuts{/bold}",
        "",
        "{bold}Input mode{/bold} (default):",
        "  Type normally (CJK/IME supported)",
        "  Enter       send message",
        "  Escape      switch to browse mode",
        "",
        "{bold}Browse mode{/bold}:",
        "  Tab         switch loop/conversation pane",
        "  j/k         scroll up/down",
        "  g/G         jump to top/bottom",
        "  f           toggle follow mode",
        "  Enter       expand/collapse frame",
        "  i / Tab     back to input mode",
        "  q           quit",
        "  ?           toggle help",
      ].join("\n"),
    });

    this.inputBox = blessed.textbox({
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      border: { type: "line" },
      label: " [INPUT] message> (Enter=send, Esc=browse) ",
      inputOnFocus: true,
      tags: false,
      style: {
        fg: "white",
        border: { fg: "cyan" },
      },
    }) as unknown as blessed.Widgets.TextboxElement;

    this.screen.append(this.headerBox);
    this.screen.append(this.conversationList);
    this.screen.append(this.loopList);
    this.screen.append(this.helpBox);
    this.screen.append(this.inputBox);

    // Process-level SIGINT so Ctrl+C always works even during readInput
    process.on("SIGINT", () => {
      this.close();
      process.exit(0);
    });

    this.setupBrowseKeys();
    this.enterInputMode();
  }

  render(view: TuiViewModel): void {
    this.headerBox.setContent(this.renderHeader(view.run));

    const convItems = view.conversation.map((item) =>
      this.renderConversationItem(item),
    );
    this.conversationList.setItems(convItems);

    const loopItems = this.renderLoopFrames(view.loop);
    this.loopList.setItems(loopItems);

    if (this.followMode) {
      if (this.browsePane === "conversation") {
        this.conversationList.setScrollPerc(100);
      }
      this.loopList.setScrollPerc(100);
    }

    this.screen.render();
  }

  onKey(handler: (key: TuiKey) => void): void {
    this.keyHandler = handler;
  }

  onMessage(handler: (text: string) => void): void {
    this.messageHandler = handler;
  }

  close(): void {
    this.screen.destroy();
  }

  toggleFrameExpand(frameId: string): void {
    if (this.expandedFrames.has(frameId)) {
      this.expandedFrames.delete(frameId);
    } else {
      this.expandedFrames.add(frameId);
    }
  }

  // ─── Input Mode ───────────────────────────────────────────────────

  private enterInputMode(): void {
    this.inputMode = true;
    this.updateBorderStyles();
    this.inputBox.focus();
    this.inputBox.readInput((_err: Error | null, value?: string) => {
      // Enter → value is the text; Escape → value is undefined
      if (value && value.trim()) {
        this.messageHandler?.(value.trim());
      }
      this.inputBox.clearValue();
      this.screen.render();

      if (value !== undefined) {
        // Enter was pressed — stay in input mode
        process.nextTick(() => this.enterInputMode());
      } else {
        // Escape was pressed — switch to browse mode
        this.enterBrowseMode();
      }
    });
    this.screen.render();
  }

  private enterBrowseMode(): void {
    this.inputMode = false;
    this.updateBorderStyles();
    this.screen.render();
  }

  // ─── Browse Mode Keys ─────────────────────────────────────────────

  private setupBrowseKeys(): void {
    this.screen.on(
      "keypress",
      (_ch: string, key: blessed.Widgets.Events.IKeyEventArg) => {
        // Only handle keys when NOT in input mode
        if (this.inputMode) return;

        // Help overlay: Esc closes it
        if (key.name === "escape" && !this.helpBox.hidden) {
          this.helpBox.hide();
          this.screen.render();
          return;
        }

        const activeList =
          this.browsePane === "conversation"
            ? this.conversationList
            : this.loopList;

        switch (key.name) {
          case "q":
            this.keyHandler?.({ name: "q" });
            return;
          case "i":
          case "tab":
            this.enterInputMode();
            return;
          case "j":
          case "down":
            this.followMode = false;
            activeList.scroll(1);
            this.screen.render();
            return;
          case "k":
          case "up":
            this.followMode = false;
            activeList.scroll(-1);
            this.screen.render();
            return;
          case "g":
            if (!key.shift) {
              activeList.setScrollPerc(0);
              this.followMode = false;
              this.screen.render();
              return;
            }
            activeList.setScrollPerc(100);
            this.followMode = true;
            this.screen.render();
            return;
          case "f":
            this.followMode = !this.followMode;
            if (this.followMode) {
              this.loopList.setScrollPerc(100);
            }
            this.screen.render();
            return;
          case "return":
          case "enter":
            this.keyHandler?.({
              name: key.name ?? "",
              ctrl: key.ctrl,
              shift: key.shift,
              meta: key.meta,
              sequence: key.sequence,
            });
            return;
        }

        if (key.sequence === "?") {
          this.helpBox.toggle();
          this.screen.render();
          return;
        }
      },
    );

    // Tab in browse mode switches between loop and conversation
    this.screen.key(["S-tab"], () => {
      if (this.inputMode) return;
      this.browsePane =
        this.browsePane === "loop" ? "conversation" : "loop";
      this.updateBorderStyles();
      this.screen.render();
    });
  }

  // ─── Rendering Helpers ────────────────────────────────────────────

  private renderHeader(run: RunHeaderView): string {
    const statusColor = this.statusColor(run.status);
    return (
      `run=${run.runId} ` +
      `{${statusColor}-fg}status=${run.status}{/${statusColor}-fg} ` +
      `step=${run.stepIndex}/${run.maxSteps} ` +
      `cwd=${run.cwd}` +
      (run.model ? ` model=${run.model}` : "")
    );
  }

  private statusColor(status: string): string {
    switch (status) {
      case "running":
      case "waiting_for_model":
      case "waiting_for_tool":
      case "waiting_for_review":
      case "waiting_for_io":
        return "yellow";
      case "completed":
        return "green";
      case "failed":
        return "red";
      case "cancelled":
        return "gray";
      default:
        return "white";
    }
  }

  private renderConversationItem(item: ConversationItem): string {
    switch (item.kind) {
      case "user":
        return `{cyan-fg}[${item.channel}] user:{/cyan-fg} ${this.escapeMarkup(item.text)}`;
      case "agent":
        return `{green-fg}agent [${item.messageKind}]:{/green-fg} ${this.escapeMarkup(item.text.slice(0, 200))}`;
      case "system":
        return `{gray-fg}system:{/gray-fg} ${this.escapeMarkup(item.text)}`;
    }
  }

  private renderLoopFrames(frames: LoopFrame[]): string[] {
    const lines: string[] = [];
    let currentStep = -1;

    for (const frame of frames) {
      if (frame.stepIndex !== currentStep) {
        currentStep = frame.stepIndex;
        lines.push(
          `{bold}step ${String(currentStep).padStart(3, "0")}{/bold}`,
        );
      }

      const statusTag = this.frameStatusColor(frame.status);
      const phase = frame.phase.padEnd(12);
      const status = frame.status.padEnd(8);
      let line = `  ${phase} {${statusTag}-fg}${status}{/${statusTag}-fg} ${frame.title}`;

      if (frame.summary) {
        line += ` {gray-fg}${this.escapeMarkup(frame.summary.slice(0, 80))}{/gray-fg}`;
      }

      lines.push(line);

      if (this.expandedFrames.has(frame.id) && frame.detail) {
        const detailLines = frame.detail.slice(0, 2000).split("\n");
        for (const dl of detailLines) {
          lines.push(`    {gray-fg}${this.escapeMarkup(dl)}{/gray-fg}`);
        }
      }

      if (this.expandedFrames.has(frame.id) && frame.logPath) {
        lines.push(`    {cyan-fg}log: ${frame.logPath}{/cyan-fg}`);
      }
    }

    return lines;
  }

  private frameStatusColor(status: string): string {
    switch (status) {
      case "ok":
        return "green";
      case "running":
        return "yellow";
      case "waiting":
        return "yellow";
      case "warn":
        return "yellow";
      case "error":
        return "red";
      case "pending":
        return "gray";
      default:
        return "white";
    }
  }

  private escapeMarkup(text: string): string {
    return text.replace(/\{/g, "\\{").replace(/\}/g, "\\}");
  }

  private updateBorderStyles(): void {
    const convBorder = this.conversationList.style.border as Record<string, string>;
    const loopBorder = this.loopList.style.border as Record<string, string>;
    const inputBorder = this.inputBox.style.border as Record<string, string>;

    if (this.inputMode) {
      convBorder.fg = "gray";
      loopBorder.fg = "gray";
      inputBorder.fg = "cyan";
      this.inputBox.setLabel(" [INPUT] message> (Enter=send, Esc=browse) ");
    } else {
      convBorder.fg = this.browsePane === "conversation" ? "white" : "gray";
      loopBorder.fg = this.browsePane === "loop" ? "white" : "gray";
      inputBorder.fg = "gray";
      this.inputBox.setLabel(" message> (i or Tab=input mode, ?=help) ");
    }
  }
}
