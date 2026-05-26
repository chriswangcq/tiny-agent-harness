// ─── BlessedRenderer ────────────────────────────────────────────────
//
// Implements TuiRenderer using neo-blessed (maintained fork of blessed).
// Renders the three-pane TUI layout: header, conversation pane, loop player,
// and a persistent input bar at the bottom.
//
// Input is handled via manual keypress buffer (not readInput which freezes).
// fullUnicode + wcwidth for CJK character support.

import blessed from "neo-blessed";
import type {
  TuiRenderer,
  TuiViewModel,
  TuiKey,
  LoopFrame,
  ConversationItem,
  RunHeaderView,
} from "./types.js";
import { TuiInteractionState } from "./interaction-state.js";

export class BlessedRenderer implements TuiRenderer {
  private screen: blessed.Widgets.Screen;
  private headerBox: blessed.Widgets.BoxElement;
  private conversationList: blessed.Widgets.ListElement;
  private conversationDetailBox: blessed.Widgets.BoxElement;
  private loopList: blessed.Widgets.ListElement;
  private loopDetailBox: blessed.Widgets.BoxElement;
  private helpBox: blessed.Widgets.BoxElement;
  private inputBar: blessed.Widgets.BoxElement;
  private ui = new TuiInteractionState();
  private lastView: TuiViewModel | undefined;
  private conversationLineIndexes = new Map<string, number>();
  private loopFrameLineIndexes = new Map<string, number>();
  private expandedFrames = new Set<string>();
  private keyHandler?: (key: TuiKey) => void;
  private messageHandler?: (text: string) => void;
  private inputBuffer = "";

  constructor() {
    this.screen = blessed.screen({
      smartCSR: true,
      fullUnicode: true,
      title: "tiny-agent TUI",
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

    this.conversationDetailBox = blessed.box({
      top: 1,
      left: "60%",
      width: "40%",
      height: "50%-1",
      border: { type: "line" },
      label: " Conversation Detail ",
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: "│", style: { fg: "cyan" } },
      tags: true,
      hidden: true,
      style: {
        border: { fg: "gray" },
      },
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

    this.loopDetailBox = blessed.box({
      top: "50%",
      left: "60%",
      width: "40%",
      height: "50%-3",
      border: { type: "line" },
      label: " Loop Detail ",
      scrollable: true,
      alwaysScroll: true,
      tags: true,
      hidden: true,
      style: {
        border: { fg: "gray" },
      },
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
        "  Type to compose, Enter to send",
        "  Escape      switch to browse mode",
        "",
        "{bold}Browse mode{/bold}:",
        "  Tab         switch loop/conversation",
        "  j/k         scroll up/down",
        "  ←/→         move between list and detail",
        "  g/G         jump to top/bottom",
        "  f           toggle follow mode",
        "  Enter       expand/collapse selected loop frame",
        "  i           back to input mode",
        "  q           quit",
        "  ?           toggle help",
        "  Ctrl+C      quit (always)",
      ].join("\n"),
    });

    this.inputBar = blessed.box({
      bottom: 0,
      left: 0,
      width: "100%",
      height: 3,
      border: { type: "line" },
      label: " [INPUT] message> (Enter=send, Esc=browse) ",
      tags: false,
      style: {
        fg: "white",
        border: { fg: "cyan" },
      },
    });

    this.screen.append(this.headerBox);
    this.screen.append(this.conversationList);
    this.screen.append(this.conversationDetailBox);
    this.screen.append(this.loopList);
    this.screen.append(this.loopDetailBox);
    this.screen.append(this.helpBox);
    this.screen.append(this.inputBar);

    this.setupKeys();
    this.refreshInputBar();
  }

  render(view: TuiViewModel): void {
    this.lastView = view;
    this.ui.syncWithConversation(view.conversation);
    this.ui.syncWithFrames(view.loop);
    this.headerBox.setContent(this.renderHeader(view.run));

    const selectedConversationItem = this.ui.selectedConversationItem(
      view.conversation,
    );
    this.updateConversationDetailLayout(selectedConversationItem);

    const convItems = this.renderConversationItems(view.conversation);
    this.conversationList.setItems(convItems);
    this.conversationDetailBox.setContent(
      this.renderConversationDetail(selectedConversationItem),
    );
    this.selectConversationListRow(selectedConversationItem?.id);

    const selectedLoopFrame = this.ui.selectedLoopFrame(view.loop);
    this.updateLoopDetailLayout(selectedLoopFrame);

    const loopItems = this.renderLoopFrames(view.loop);
    this.loopList.setItems(loopItems);
    this.loopDetailBox.setContent(this.renderLoopDetail(selectedLoopFrame));
    this.selectLoopListRow(selectedLoopFrame?.id);

    if (this.ui.followBottom.conversation) {
      this.conversationList.setScrollPerc(100);
    }
    if (this.ui.followBottom.loop) {
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

  // ─── Input Bar ────────────────────────────────────────────────────

  private refreshInputBar(): void {
    const cursor = this.ui.mode === "input" ? "█" : "";
    this.inputBar.setContent(this.inputBuffer + cursor);
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

  // ─── Key Handling ─────────────────────────────────────────────────

  private setupKeys(): void {
    this.screen.on(
      "keypress",
      (ch: string, key: blessed.Widgets.Events.IKeyEventArg) => {
        // Ctrl+C always quits
        if (key.ctrl && key.name === "c") {
          this.close();
          process.exit(0);
        }

        // Help overlay: Esc closes it from any mode
        if (key.name === "escape" && !this.helpBox.hidden) {
          this.helpBox.hide();
          this.screen.render();
          return;
        }

        if (this.ui.mode === "input") {
          this.handleInputKey(ch, key);
        } else {
          this.handleBrowseKey(ch, key);
        }
      },
    );
  }

  private handleInputKey(
    ch: string,
    key: blessed.Widgets.Events.IKeyEventArg,
  ): void {
    if (key.name === "return" || key.name === "enter") {
      this.submitInput();
      return;
    }
    if (key.name === "backspace") {
      // Remove last character (handles multi-byte via Array.from)
      const chars = Array.from(this.inputBuffer);
      chars.pop();
      this.inputBuffer = chars.join("");
      this.refreshInputBar();
      return;
    }
    if (key.name === "escape") {
      this.ui.enterBrowse(this.lastView?.loop ?? [], "loop");
      this.updateStyles();
      this.refreshInputBar();
      this.rerenderLastView();
      return;
    }
    // Printable character (including CJK / IME composed)
    if (ch && !key.ctrl && !key.meta) {
      this.inputBuffer += ch;
      this.refreshInputBar();
    }
  }

  private handleBrowseKey(
    _ch: string,
    key: blessed.Widgets.Events.IKeyEventArg,
  ): void {
    const frames = this.lastView?.loop ?? [];
    const conversation = this.lastView?.conversation ?? [];
    const activeList =
      this.ui.pane === "conversation"
        ? this.conversationList
        : this.ui.pane === "conversationDetail"
          ? this.conversationDetailBox
        : this.ui.pane === "detail"
          ? this.loopDetailBox
          : this.loopList;

    switch (key.name) {
      case "q":
        this.keyHandler?.({ name: "q" });
        return;
      case "i":
        this.ui.enterInput();
        this.updateStyles();
        this.refreshInputBar();
        this.rerenderLastView();
        return;
      case "tab":
        this.ui.switchPane(frames);
        this.updateStyles();
        this.rerenderLastView();
        return;
      case "right":
        if (this.ui.pane === "loop" && this.ui.selectedLoopFrameId) {
          this.ui.enterDetail(frames);
          this.updateStyles();
          this.rerenderLastView();
        } else if (
          this.ui.pane === "conversation" &&
          this.ui.selectedConversationItemId
        ) {
          this.ui.enterConversationDetail(conversation);
          this.updateStyles();
          this.rerenderLastView();
        }
        return;
      case "left":
        if (this.ui.pane === "detail") {
          this.ui.leaveDetail(frames);
          this.updateStyles();
          this.rerenderLastView();
        } else if (this.ui.pane === "conversationDetail") {
          this.ui.leaveConversationDetail(conversation);
          this.updateStyles();
          this.rerenderLastView();
        }
        return;
      case "j":
      case "down":
        if (this.ui.pane === "detail") {
          this.loopDetailBox.scroll(1);
          this.screen.render();
          return;
        }
        if (this.ui.pane === "conversationDetail") {
          this.conversationDetailBox.scroll(1);
          this.screen.render();
          return;
        }
        this.ui.moveSelection(frames, 1, conversation);
        this.rerenderLastView();
        return;
      case "k":
      case "up":
        if (this.ui.pane === "detail") {
          this.loopDetailBox.scroll(-1);
          this.screen.render();
          return;
        }
        if (this.ui.pane === "conversationDetail") {
          this.conversationDetailBox.scroll(-1);
          this.screen.render();
          return;
        }
        this.ui.moveSelection(frames, -1, conversation);
        this.rerenderLastView();
        return;
      case "g":
        if (this.ui.pane === "detail" || this.ui.pane === "conversationDetail") {
          activeList.setScrollPerc(key.shift ? 100 : 0);
          this.screen.render();
          return;
        }
        if (!key.shift) {
          this.ui.jumpTop(frames, conversation);
          activeList.setScrollPerc(0);
        } else {
          this.ui.jumpBottom(frames);
          activeList.setScrollPerc(100);
        }
        this.rerenderLastView();
        return;
      case "f":
        if (this.ui.pane === "detail" || this.ui.pane === "conversationDetail") {
          return;
        }
        this.ui.toggleFollow(frames);
        if (this.ui.followBottom[this.ui.pane]) {
          activeList.setScrollPerc(100);
        }
        this.rerenderLastView();
        return;
      case "return":
      case "enter":
        if (this.ui.pane === "loop" && this.ui.selectedLoopFrameId) {
          this.toggleFrameExpand(this.ui.selectedLoopFrameId);
          this.rerenderLastView();
          return;
        }
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
    }
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

  private renderConversationItems(items: ConversationItem[]): string[] {
    this.conversationLineIndexes.clear();
    return items.map((item, index) => {
      this.conversationLineIndexes.set(item.id, index);
      const selected = item.id === this.ui.selectedConversationItemId;
      const marker = selected ? "{blue-bg}{white-fg}>{/white-fg}{/blue-bg}" : " ";
      return `${marker} ${this.renderConversationItem(item)}`;
    });
  }

  private renderLoopFrames(frames: LoopFrame[]): string[] {
    const lines: string[] = [];
    let currentStep = -1;
    this.loopFrameLineIndexes.clear();

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
      const selected = frame.id === this.ui.selectedLoopFrameId;
      const marker = selected ? "{blue-bg}{white-fg}>{/white-fg}{/blue-bg}" : " ";
      let line = `${marker} ${phase} {${statusTag}-fg}${status}{/${statusTag}-fg} ${frame.title}`;

      if (frame.summary) {
        line += ` {gray-fg}${this.escapeMarkup(frame.summary.slice(0, 80))}{/gray-fg}`;
      }

      this.loopFrameLineIndexes.set(frame.id, lines.length);
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

  private rerenderLastView(): void {
    if (this.lastView) {
      this.render(this.lastView);
    } else {
      this.screen.render();
    }
  }

  private updateLoopDetailLayout(selectedFrame: LoopFrame | undefined): void {
    if (selectedFrame) {
      this.loopList.width = "60%";
      this.loopDetailBox.show();
      return;
    }
    this.loopList.width = "100%";
    this.loopDetailBox.hide();
  }

  private updateConversationDetailLayout(
    selectedItem: ConversationItem | undefined,
  ): void {
    if (selectedItem) {
      this.conversationList.width = "60%";
      this.conversationDetailBox.show();
      return;
    }
    this.conversationList.width = "100%";
    this.conversationDetailBox.hide();
  }

  private renderConversationDetail(item: ConversationItem | undefined): string {
    if (!item) return "";
    const lines = [
      `{bold}${this.escapeMarkup(this.conversationDetailTitle(item))}{/bold}`,
      "",
      `id: ${this.escapeMarkup(item.id)}`,
      `kind: ${item.kind}`,
      `time: ${this.escapeMarkup(item.timestamp)}`,
    ];

    switch (item.kind) {
      case "user":
        lines.push(
          `channel: ${this.escapeMarkup(item.channel)}`,
          ...(item.sourceEventId
            ? [`sourceEventId: ${this.escapeMarkup(item.sourceEventId)}`]
            : []),
          "",
          "{bold}Text{/bold}",
          this.escapeMarkup(item.text),
        );
        break;
      case "agent":
        lines.push(
          `messageKind: ${item.messageKind}`,
          "",
          "{bold}Text{/bold}",
          this.escapeMarkup(item.text),
        );
        break;
      case "system":
        lines.push("", "{bold}Text{/bold}", this.escapeMarkup(item.text));
        break;
    }

    return lines.join("\n");
  }

  private conversationDetailTitle(item: ConversationItem): string {
    switch (item.kind) {
      case "user":
        return `[${item.channel}] user`;
      case "agent":
        return `agent [${item.messageKind}]`;
      case "system":
        return "system";
    }
  }

  private renderLoopDetail(frame: LoopFrame | undefined): string {
    if (!frame) return "";
    const lines = [
      `{bold}${this.escapeMarkup(frame.title)}{/bold}`,
      "",
      `step: ${frame.stepIndex}`,
      `phase: ${frame.phase}`,
      `status: ${frame.status}`,
      `time: ${frame.timestamp}`,
    ];
    if (frame.summary) {
      lines.push("", "{bold}Summary{/bold}", this.escapeMarkup(frame.summary));
    }
    if (frame.detail) {
      lines.push(
        "",
        "{bold}Detail{/bold}",
        this.escapeMarkup(frame.detail.slice(0, 4000)),
      );
    }
    if (frame.logPath) {
      lines.push("", "{bold}Log{/bold}", this.escapeMarkup(frame.logPath));
    }
    return lines.join("\n");
  }

  private selectConversationListRow(itemId: string | undefined): void {
    if (!itemId) return;
    const row = this.conversationLineIndexes.get(itemId);
    if (row === undefined) return;
    const list = this.conversationList as blessed.Widgets.ListElement & {
      select?: (index: number) => void;
      scrollTo?: (offset: number) => void;
    };
    list.select?.(row);
    if (!this.ui.followBottom.conversation) {
      list.scrollTo?.(Math.max(0, row - 2));
    }
  }

  private selectLoopListRow(frameId: string | undefined): void {
    if (!frameId) return;
    const row = this.loopFrameLineIndexes.get(frameId);
    if (row === undefined) return;
    const list = this.loopList as blessed.Widgets.ListElement & {
      select?: (index: number) => void;
      scrollTo?: (offset: number) => void;
    };
    list.select?.(row);
    if (!this.ui.followBottom.loop) {
      list.scrollTo?.(Math.max(0, row - 2));
    }
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

  private updateStyles(): void {
    const convBorder = this.conversationList.style.border as Record<string, string>;
    const convDetailBorder = this.conversationDetailBox.style.border as Record<
      string,
      string
    >;
    const loopBorder = this.loopList.style.border as Record<string, string>;
    const inputBorder = this.inputBar.style.border as Record<string, string>;

    const detailBorder = this.loopDetailBox.style.border as Record<string, string>;

    if (this.ui.mode === "input") {
      convBorder.fg = "gray";
      convDetailBorder.fg = "gray";
      loopBorder.fg = "gray";
      detailBorder.fg = "gray";
      inputBorder.fg = "cyan";
      this.inputBar.setLabel(" [INPUT] message> (Enter=send, Esc=browse) ");
    } else {
      convBorder.fg = this.ui.pane === "conversation" ? "white" : "gray";
      convDetailBorder.fg =
        this.ui.pane === "conversationDetail" ? "white" : "gray";
      loopBorder.fg = this.ui.pane === "loop" ? "white" : "gray";
      detailBorder.fg = this.ui.pane === "detail" ? "white" : "gray";
      inputBorder.fg = "gray";
      this.inputBar.setLabel(" message> (i=input, Tab=switch, ?=help) ");
    }
  }
}
