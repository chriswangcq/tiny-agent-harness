// ─── BlessedRenderer ────────────────────────────────────────────────
//
// Implements TuiRenderer using neo-blessed (maintained fork of blessed).
// Renders the three-pane TUI layout: header, conversation pane, loop player.

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
  private focusedPane: "conversation" | "loop" = "loop";
  private followMode = true;
  private expandedFrames = new Set<string>();
  private keyHandler?: (key: TuiKey) => void;
  private messageHandler?: (text: string) => void;
  private inputBox: blessed.Widgets.TextboxElement;

  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      title: "tiny-agent TUI",
    });

    // Header bar - 1 line at top
    this.headerBox = blessed.box({
      top: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      style: { fg: "white", bg: "black" },
    });

    // Conversation pane - upper portion
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

    // Loop player - lower portion
    this.loopList = blessed.list({
      top: "50%",
      left: 0,
      width: "100%",
      height: "50%",
      border: { type: "line" },
      label: " Agent Loop ",
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: "│", style: { fg: "cyan" } },
      tags: true,
      style: {
        border: { fg: "white" },
        selected: { bg: "blue" },
      },
      keys: false,
      mouse: false,
    });

    // Help overlay (hidden by default)
    this.helpBox = blessed.box({
      top: "center",
      left: "center",
      width: 50,
      height: 16,
      border: { type: "line" },
      label: " Help ",
      hidden: true,
      tags: true,
      style: { border: { fg: "yellow" } },
      content: [
        "{bold}Keyboard Shortcuts{/bold}",
        "",
        "Tab        switch pane focus",
        "j / Down   scroll down",
        "k / Up     scroll up",
        "g          jump to top",
        "G          jump to bottom",
        "f          toggle follow mode",
        "Enter      expand/collapse frame",
        "m          compose user message",
        "q          quit TUI",
        "?          toggle help",
        "Esc        close help / cancel",
      ].join("\n"),
    });

    // Message input box (hidden by default, shown on 'm' key)
    this.inputBox = blessed.textbox({
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      border: { type: "line" },
      label: " message> ",
      hidden: true,
      inputOnFocus: true,
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

    this.setupKeys();
    this.updateFocusStyle();
  }

  render(view: TuiViewModel): void {
    // Header
    this.headerBox.setContent(this.renderHeader(view.run));

    // Conversation
    const convItems = view.conversation.map((item) =>
      this.renderConversationItem(item),
    );
    this.conversationList.setItems(convItems);

    // Loop frames grouped by step
    const loopItems = this.renderLoopFrames(view.loop);
    this.loopList.setItems(loopItems);

    // Auto-scroll if follow mode
    if (this.followMode) {
      if (this.focusedPane === "conversation") {
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

  /** Toggle expand/collapse state for a loop frame by id. */
  toggleFrameExpand(frameId: string): void {
    if (this.expandedFrames.has(frameId)) {
      this.expandedFrames.delete(frameId);
    } else {
      this.expandedFrames.add(frameId);
    }
  }

  // ─── Private Helpers ──────────────────────────────────────────────

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

      // Show detail if expanded
      if (this.expandedFrames.has(frame.id) && frame.detail) {
        const detailLines = frame.detail.slice(0, 2000).split("\n");
        for (const dl of detailLines) {
          lines.push(`    {gray-fg}${this.escapeMarkup(dl)}{/gray-fg}`);
        }
      }

      // Show log path if present and expanded
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

  private setupKeys(): void {
    this.screen.on(
      "keypress",
      (_ch: string, key: blessed.Widgets.Events.IKeyEventArg) => {
        const tuiKey: TuiKey = {
          name: key.name ?? "",
          ctrl: key.ctrl,
          shift: key.shift,
          meta: key.meta,
          sequence: key.sequence,
        };

        // Handle built-in navigation
        const activeList =
          this.focusedPane === "conversation"
            ? this.conversationList
            : this.loopList;

        switch (key.name) {
          case "q":
            this.keyHandler?.({ name: "q" });
            return;
          case "tab":
            this.focusedPane =
              this.focusedPane === "conversation" ? "loop" : "conversation";
            this.updateFocusStyle();
            this.screen.render();
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
            // G (shift+g) = jump to bottom
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
          case "enter":
            // Toggle expand for loop frames - delegated to key handler
            this.keyHandler?.(tuiKey);
            return;
          case "m":
            this.showComposeInput();
            return;
          case "escape":
            if (!this.helpBox.hidden) {
              this.helpBox.hide();
              this.screen.render();
              return;
            }
            return;
        }

        // "?" key — blessed may report the name as "?" for Shift+/
        if (key.sequence === "?") {
          this.helpBox.toggle();
          this.screen.render();
          return;
        }

        // Forward unhandled keys to external handler
        this.keyHandler?.(tuiKey);
      },
    );
  }

  private showComposeInput(): void {
    this.inputBox.show();
    this.inputBox.focus();
    this.inputBox.readInput((_err: Error | null, value?: string) => {
      this.inputBox.hide();
      this.inputBox.clearValue();
      this.screen.render();
      if (value && value.trim()) {
        this.messageHandler?.(value.trim());
      }
    });
    this.screen.render();
  }

  private updateFocusStyle(): void {
    if (this.focusedPane === "conversation") {
      (this.conversationList.style.border as Record<string, string>).fg =
        "white";
      (this.loopList.style.border as Record<string, string>).fg = "gray";
    } else {
      (this.conversationList.style.border as Record<string, string>).fg =
        "gray";
      (this.loopList.style.border as Record<string, string>).fg = "white";
    }
  }
}
