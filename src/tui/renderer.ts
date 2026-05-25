// ─── BlessedRenderer ────────────────────────────────────────────────
//
// Implements TuiRenderer using neo-blessed (maintained fork of blessed).
// Renders the three-pane TUI layout: header, conversation pane, loop player,
// and a persistent input bar at the bottom.

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
  private inputBar: blessed.Widgets.BoxElement;
  private focusedPane: "conversation" | "loop" | "input" = "input";
  private followMode = true;
  private expandedFrames = new Set<string>();
  private keyHandler?: (key: TuiKey) => void;
  private messageHandler?: (text: string) => void;
  private inputBuffer = "";

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

    // Loop player - lower portion (leave 3 rows for input bar)
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
        "Tab        switch pane (input/loop/conversation)",
        "j / Down   scroll down (loop/conversation pane)",
        "k / Up     scroll up",
        "g          jump to top",
        "G          jump to bottom",
        "f          toggle follow mode",
        "Enter      send message (input) / expand frame (loop)",
        "q          quit TUI (not in input pane)",
        "Ctrl+C     quit TUI (always)",
        "?          toggle help (not in input pane)",
        "Esc        close help",
      ].join("\n"),
    });

    // Input bar (always visible at bottom)
    this.inputBar = blessed.box({
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      border: { type: "line" },
      label: " message> ",
      tags: true,
      style: {
        fg: "white",
        border: { fg: "cyan" },
      },
    });

    this.screen.append(this.headerBox);
    this.screen.append(this.conversationList);
    this.screen.append(this.loopList);
    this.screen.append(this.helpBox);
    this.screen.append(this.inputBar);

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

  private refreshInputBar(): void {
    const cursor = this.focusedPane === "input" ? "_" : "";
    this.inputBar.setContent(this.escapeMarkup(this.inputBuffer) + cursor);
    this.screen.render();
  }

  private submitInput(): void {
    const text = this.inputBuffer.trim();
    this.inputBuffer = "";
    this.refreshInputBar();
    if (text) {
      this.messageHandler?.(text);
    }
  }

  private setupKeys(): void {
    this.screen.on(
      "keypress",
      (ch: string, key: blessed.Widgets.Events.IKeyEventArg) => {
        // Ctrl+C always quits
        if (key.ctrl && key.name === "c") {
          this.keyHandler?.({ name: "q" });
          return;
        }

        // Help overlay: Esc closes it from any pane
        if (key.name === "escape" && !this.helpBox.hidden) {
          this.helpBox.hide();
          this.screen.render();
          return;
        }

        // Tab always cycles panes: input → loop → conversation → input
        if (key.name === "tab") {
          if (this.focusedPane === "input") {
            this.focusedPane = "loop";
          } else if (this.focusedPane === "loop") {
            this.focusedPane = "conversation";
          } else {
            this.focusedPane = "input";
          }
          this.updateFocusStyle();
          this.refreshInputBar();
          return;
        }

        // ── Input pane: capture typing ──
        if (this.focusedPane === "input") {
          if (key.name === "return" || key.name === "enter") {
            this.submitInput();
            return;
          }
          if (key.name === "backspace") {
            this.inputBuffer = this.inputBuffer.slice(0, -1);
            this.refreshInputBar();
            return;
          }
          if (key.name === "escape") {
            this.focusedPane = "loop";
            this.updateFocusStyle();
            this.refreshInputBar();
            return;
          }
          // Printable character
          if (ch && ch.length === 1 && !key.ctrl && !key.meta) {
            this.inputBuffer += ch;
            this.refreshInputBar();
            return;
          }
          return;
        }

        // ── Loop / Conversation pane navigation ──
        const tuiKey: TuiKey = {
          name: key.name ?? "",
          ctrl: key.ctrl,
          shift: key.shift,
          meta: key.meta,
          sequence: key.sequence,
        };

        const activeList =
          this.focusedPane === "conversation"
            ? this.conversationList
            : this.loopList;

        switch (key.name) {
          case "q":
            this.keyHandler?.({ name: "q" });
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
            this.keyHandler?.(tuiKey);
            return;
          case "escape":
            return;
        }

        if (key.sequence === "?") {
          this.helpBox.toggle();
          this.screen.render();
          return;
        }

        this.keyHandler?.(tuiKey);
      },
    );
  }

  private updateFocusStyle(): void {
    const convBorder = this.conversationList.style.border as Record<string, string>;
    const loopBorder = this.loopList.style.border as Record<string, string>;
    const inputBorder = this.inputBar.style.border as Record<string, string>;

    convBorder.fg = this.focusedPane === "conversation" ? "white" : "gray";
    loopBorder.fg = this.focusedPane === "loop" ? "white" : "gray";
    inputBorder.fg = this.focusedPane === "input" ? "cyan" : "gray";

    this.inputBar.setLabel(
      this.focusedPane === "input"
        ? " message> (Enter=send, Esc=back, Tab=switch) "
        : " message> (Tab to focus) ",
    );

    this.screen.render();
  }
}
