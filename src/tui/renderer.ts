// ─── BlessedRenderer ────────────────────────────────────────────────
//
// Implements TuiRenderer using neo-blessed (maintained fork of blessed).
// Renders the TUI layout: header, full-height messages, agent loop,
// loop detail, read-only PTY output, and a persistent input bar.
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
  SessionView,
} from "./types.js";
import { TuiInteractionState } from "./interaction-state.js";
import wcwidth from "wcwidth";

const INPUT_BAR_HEIGHT = 5;
const INPUT_INNER_ROWS = INPUT_BAR_HEIGHT - 2;

export class BlessedRenderer implements TuiRenderer {
  private screen: blessed.Widgets.Screen;
  private frameBox: blessed.Widgets.BoxElement;
  private headerBox: blessed.Widgets.BoxElement;
  private conversationList: blessed.Widgets.BoxElement;
  private loopList: blessed.Widgets.ListElement;
  private loopDetailBox: blessed.Widgets.BoxElement;
  private ptyBox: blessed.Widgets.BoxElement;
  private helpBox: blessed.Widgets.BoxElement;
  private inputBar: blessed.Widgets.BoxElement;
  private ui = new TuiInteractionState();
  private lastView: TuiViewModel | undefined;
  private conversationLineIndexes = new Map<string, number>();
  private loopFrameLineIndexes = new Map<string, number>();
  private expandedFrames = new Set<string>();
  private lastLoopDetailFrameId: string | undefined;
  private keyHandler?: (key: TuiKey) => void;
  private messageHandler?: (text: string) => void;
  private inputBuffer = "";
  private inputCursor = { row: 0, col: 0 };
  private lastRawShiftEnterSequence: string | undefined;
  private pendingRawShiftEnterEchoes: string[] = [];
  private frameScroll: TuiFrameScroll = {};

  constructor() {
    this.screen = blessed.screen({
      smartCSR: false,
      fullUnicode: true,
      title: "tiny-agent TUI",
    });

    this.enableModifiedKeyReporting();

    this.headerBox = blessed.box({
      top: 0,
      left: 0,
      width: "100%",
      height: 1,
      tags: true,
      style: { fg: "white", bg: "black" },
    });

    this.frameBox = blessed.box({
      top: 0,
      left: 0,
      width: "100%",
      height: `100%-${INPUT_BAR_HEIGHT}`,
      tags: true,
      wrap: false,
      style: { fg: "white", bg: "black" },
    });

    this.conversationList = blessed.box({
      top: 1,
      left: 0,
      width: "45%",
      height: `100%-${INPUT_BAR_HEIGHT + 1}`,
      border: { type: "line" },
      label: " Messages ",
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: "│", style: { fg: "cyan" } },
      tags: true,
      wrap: false,
      style: {
        border: { fg: "gray" },
      },
      keys: false,
      mouse: false,
    });

    this.loopList = blessed.list({
      top: 1,
      left: "45%",
      width: "28%",
      height: "50%-1",
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
      top: 1,
      left: "73%",
      width: "27%",
      height: "50%-1",
      border: { type: "line" },
      label: " Loop Detail ",
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: "│", style: { fg: "cyan" } },
      tags: true,
      style: {
        border: { fg: "gray" },
      },
    });

    this.ptyBox = blessed.box({
      top: "50%",
      left: "45%",
      width: "55%",
      height: `50%-${INPUT_BAR_HEIGHT}`,
      border: { type: "line" },
      label: " PTY (read only) ",
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: "│", style: { fg: "cyan" } },
      tags: false,
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
        "  Shift+Enter insert newline",
        "  Escape      switch to browse mode",
        "",
        "{bold}Browse mode{/bold}:",
        "  Tab         switch loop/conversation",
        "  j/k         move selection",
        "  PgUp/PgDn   page active pane",
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
      height: INPUT_BAR_HEIGHT,
      border: { type: "line" },
      label: " [INPUT] message> (Enter=send, Shift+Enter=newline, Esc=browse) ",
      tags: false,
      style: {
        fg: "white",
        border: { fg: "cyan" },
      },
    });

    this.screen.append(this.frameBox);
    this.screen.append(this.helpBox);
    this.screen.append(this.inputBar);

    this.setupKeys();
    this.refreshInputBar();
  }

  render(view: TuiViewModel): void {
    this.lastView = view;
    this.ui.syncWithView(view.conversation, view.loop);
    this.frameBox.setContent(
      renderStyledTuiFrame(view, this.ui, this.expandedFrames, {
        width: this.screen.cols,
        height: Math.max(1, this.screen.rows - INPUT_BAR_HEIGHT),
      }, this.frameScroll).join("\n"),
    );

    this.renderScreen();
  }

  onKey(handler: (key: TuiKey) => void): void {
    this.keyHandler = handler;
  }

  onMessage(handler: (text: string) => void): void {
    this.messageHandler = handler;
  }

  close(): void {
    this.disableModifiedKeyReporting();
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
    this.updateInputBarContent();
    this.renderScreen();
  }

  private submitInput(): void {
    const text = this.inputBuffer.trimEnd();
    this.inputBuffer = "";
    this.refreshInputBar();
    if (text.trim()) {
      this.messageHandler?.(text);
    }
  }

  private insertInputNewline(): void {
    this.inputBuffer += "\n";
    this.refreshInputBar();
  }

  private updateInputBarContent(): void {
    const input = renderInputBufferForBox(
      this.inputBuffer,
      this.inputContentWidth(),
      INPUT_INNER_ROWS,
      this.ui.mode === "input",
    );
    this.inputCursor = {
      row: this.inputContentTop() + input.cursorLine,
      col: 1 + input.cursorCol,
    };
    this.inputBar.setContent(input.content);
  }

  private inputContentWidth(): number {
    return Math.max(1, this.screen.cols - 2);
  }

  private inputContentTop(): number {
    return Math.max(1, this.screen.rows - INPUT_BAR_HEIGHT + 1);
  }

  private renderScreen(): void {
    this.updateInputBarContent();
    this.prepareFullFrameRepaint();
    this.screen.render();
    this.updateTerminalCursor();
  }

  private prepareFullFrameRepaint(): void {
    // Repaint stability: clear the physical terminal and blessed's old-buffer
    // together. A raw program.clear() leaves olines stale, so unchanged cells
    // can be skipped after the screen has already been blanked.
    const scr = this.screen as unknown as {
      realloc?: () => void;
      alloc?: (dirty?: boolean) => void;
    };
    if (scr.realloc) {
      scr.realloc();
    } else {
      scr.alloc?.(true);
    }
  }

  private updateTerminalCursor(): void {
    if (this.ui.mode !== "input") {
      this.screen.program.hideCursor();
      return;
    }
    this.screen.program.cup(this.inputCursor.row, this.inputCursor.col);
    this.screen.program.showCursor();
  }

  // ─── Key Handling ─────────────────────────────────────────────────

  private enableModifiedKeyReporting(): void {
    // Ask xterm-compatible terminals to report modified "other" keys.
    // Without this, many terminals send Shift+Enter as plain Enter.
    this.screen.program.setResources("4", "2");
  }

  private disableModifiedKeyReporting(): void {
    (
      this.screen.program as unknown as {
        disableModifiers: (param: string) => boolean;
      }
    ).disableModifiers("4");
  }

  private setupKeys(): void {
    this.screen.program.on("data", (data: Buffer | string) => {
      const sequence = rawInputSequence(data);
      if (isRawCtrlCSequence(sequence)) {
        this.exitProcess();
        return;
      }

      if (this.ui.mode !== "input") return;
      if (!isRawShiftEnterSequence(sequence)) return;

      this.lastRawShiftEnterSequence = sequence;
      this.pendingRawShiftEnterEchoes = rawShiftEnterEchoCandidates(sequence);
      this.insertInputNewline();
    });

    this.screen.on(
      "keypress",
      (ch: string, key: blessed.Widgets.Events.IKeyEventArg) => {
        // Ctrl+C always quits
        if (key.ctrl && key.name === "c") {
          this.exitProcess();
        }

        // Help overlay: Esc closes it from any mode
        if (key.name === "escape" && !this.helpBox.hidden) {
          this.helpBox.hide();
          this.renderScreen();
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
    if (this.isShiftEnter(key)) {
      if (this.consumeRawShiftEnterEcho(ch, key)) {
        return;
      }
      this.insertInputNewline();
      return;
    }
    if (key.name === "return" || key.name === "enter") {
      this.submitInput();
      return;
    }
    if (key.name === "backspace") {
      // Remove one visible character, including emoji grapheme clusters.
      const chars = graphemeClusters(this.inputBuffer);
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
      if (this.consumeRawShiftEnterEcho(ch, key)) {
        return;
      }
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
        // Loop detail and PTY are persistent read-only panes in this layout.
        return;
      case "left":
        return;
      case "j":
      case "down":
        this.ui.moveSelection(frames, 1, conversation);
        this.clearActiveFrameScroll();
        this.rerenderLastView();
        return;
      case "k":
      case "up":
        this.ui.moveSelection(frames, -1, conversation);
        this.clearActiveFrameScroll();
        this.rerenderLastView();
        return;
      case "pagedown":
      case "next":
        this.scrollActiveFrame(this.activeFramePageSize());
        this.rerenderLastView();
        return;
      case "pageup":
      case "prior":
        this.scrollActiveFrame(-this.activeFramePageSize());
        this.rerenderLastView();
        return;
      case "g":
        if (!key.shift) {
          this.ui.jumpTop(frames, conversation);
          this.frameScroll[this.ui.pane] = 0;
        } else {
          this.ui.jumpBottom(frames, conversation);
          this.clearActiveFrameScroll();
        }
        this.rerenderLastView();
        return;
      case "f":
        this.ui.toggleFollow(this.ui.pane, conversation, frames);
        if (this.ui.followBottom[this.ui.pane]) {
          this.clearActiveFrameScroll();
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
      this.renderScreen();
    }
  }

  private clearActiveFrameScroll(): void {
    this.frameScroll[this.ui.pane] = undefined;
  }

  private scrollActiveFrame(delta: number): void {
    const pane = this.ui.pane;
    const wasFollowing = this.ui.followBottom[pane];
    const maxScroll = this.activeFrameMaxScroll();
    const current = this.frameScroll[pane] ?? (wasFollowing ? maxScroll : 0);
    this.ui.followBottom[pane] = false;
    this.frameScroll[pane] = clampNumber(current + delta, 0, maxScroll);
  }

  private activeFramePageSize(): number {
    return Math.max(1, this.activeFrameViewportHeight() - 1);
  }

  private activeFrameMaxScroll(): number {
    return Math.max(0, this.activeFrameLineCount() - this.activeFrameViewportHeight());
  }

  private activeFrameViewportHeight(): number {
    const frameHeight = Math.max(1, this.screen.rows - INPUT_BAR_HEIGHT);
    const bodyHeight = Math.max(0, frameHeight - 1);
    if (this.ui.pane === "conversation") {
      return Math.max(0, bodyHeight - 2);
    }
    const topHeight = Math.max(1, Math.floor(bodyHeight / 2));
    return Math.max(0, topHeight - 2);
  }

  private activeFrameLineCount(): number {
    if (!this.lastView) return 0;
    const width = Math.max(1, this.screen.cols);
    if (this.ui.pane === "conversation") {
      const leftWidth = chooseLeftWidth(width);
      return buildConversationFrameLines(
        this.lastView.conversation,
        this.ui,
        Math.max(1, leftWidth - 2),
      ).length;
    }

    return buildLoopFrameLines(
      this.lastView.loop,
      this.ui,
      this.expandedFrames,
    ).length;
  }

  // ─── Rendering Helpers ────────────────────────────────────────────

  private renderHeader(run: RunHeaderView): string {
    const statusColor = this.statusColor(run.status);
    return (
      `run=${run.runId} ` +
      `{${statusColor}-fg}status=${run.status}{/${statusColor}-fg} ` +
      `step=${run.stepIndex} ` +
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

  private renderConversationHeader(item: ConversationItem): string {
    const time = this.formatClockTime(item.timestamp);
    switch (item.kind) {
      case "user":
        return `{cyan-fg}[${this.escapeMarkup(item.channel)}] user{/cyan-fg} {gray-fg}${time}{/gray-fg}`;
      case "agent":
        return `{green-fg}agent [${item.messageKind}]{/green-fg} {gray-fg}${time}{/gray-fg}`;
      case "system":
        return `{gray-fg}system ${time}{/gray-fg}`;
    }
  }

  private renderConversationItems(items: ConversationItem[]): string[] {
    this.conversationLineIndexes.clear();
    const lines: string[] = [];
    const contentWidth = this.conversationContentWidth();
    for (const item of items) {
      this.conversationLineIndexes.set(item.id, lines.length);
      const selected = item.id === this.ui.selectedConversationItemId;
      const marker = selected ? "{blue-bg}{white-fg}>{/white-fg}{/blue-bg}" : " ";
      lines.push(
        padBlessedLineForDisplay(
          `${marker} ${this.renderConversationHeader(item)}`,
          contentWidth,
        ),
      );
      for (const bodyLine of this.conversationBodyLines(item.text)) {
        lines.push(padBlessedLineForDisplay(`  ${bodyLine}`, contentWidth));
      }
      lines.push(" ".repeat(contentWidth));
    }
    while (lines.length < this.conversationContentRows()) {
      lines.push(" ".repeat(contentWidth));
    }
    return lines;
  }

  private conversationBodyLines(text: string): string[] {
    return renderConversationBodyLinesForDisplay(
      text,
      Math.max(1, this.conversationContentWidth() - 2),
    ).map((line) => this.escapeMarkup(line));
  }

  private formatClockTime(timestamp: string): string {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) return this.escapeMarkup(timestamp);
    return date.toISOString().slice(11, 19);
  }

  private conversationContentWidth(): number {
    return Math.max(20, Math.floor(this.screen.cols * 0.45) - 2);
  }

  private conversationContentRows(): number {
    return Math.max(1, this.screen.rows - INPUT_BAR_HEIGHT - 3);
  }

  private loopDetailContentWidth(): number {
    return Math.max(20, Math.floor(this.screen.cols * 0.27) - 4);
  }

  private ptyContentWidth(): number {
    return Math.max(20, Math.floor(this.screen.cols * 0.55) - 4);
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
        line += ` {gray-fg}${this.escapeMarkup(displayPreview(frame.summary, 80))}{/gray-fg}`;
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
      this.renderScreen();
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
      lines.push(
        "",
        "{bold}Summary{/bold}",
        ...wrapDisplayText(frame.summary, this.loopDetailContentWidth()).map((line) =>
          this.escapeMarkup(line),
        ),
      );
    }
    if (frame.detail) {
      lines.push(
        "",
        "{bold}Detail{/bold}",
        ...wrapDisplayText(
          frame.detail.slice(0, 4000),
          this.loopDetailContentWidth(),
        ).map((line) => this.escapeMarkup(line)),
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
    const list = this.conversationList as blessed.Widgets.BoxElement & {
      scrollTo?: (offset: number) => void;
    };
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
    return escapeBlessedMarkup(text);
  }

  private updateStyles(): void {
    const convBorder = this.conversationList.style.border as Record<string, string>;
    const loopBorder = this.loopList.style.border as Record<string, string>;
    const detailBorder = this.loopDetailBox.style.border as Record<string, string>;
    const ptyBorder = this.ptyBox.style.border as Record<string, string>;
    const inputBorder = this.inputBar.style.border as Record<string, string>;

    if (this.ui.mode === "input") {
      convBorder.fg = "gray";
      loopBorder.fg = "gray";
      detailBorder.fg = "gray";
      ptyBorder.fg = "gray";
      inputBorder.fg = "cyan";
      this.inputBar.setLabel(
        " [INPUT] message> (Enter=send, Shift+Enter=newline, Esc=browse) ",
      );
    } else {
      convBorder.fg = this.ui.pane === "conversation" ? "white" : "gray";
      loopBorder.fg = this.ui.pane === "loop" ? "white" : "gray";
      detailBorder.fg = "gray";
      ptyBorder.fg = "gray";
      inputBorder.fg = "gray";
      this.inputBar.setLabel(" message> (i=input, Tab=switch, ?=help) ");
    }
  }

  private isShiftEnter(key: blessed.Widgets.Events.IKeyEventArg): boolean {
    return isShiftEnterKey(key);
  }

  private consumeRawShiftEnterEcho(
    ch: string,
    key: blessed.Widgets.Events.IKeyEventArg,
  ): boolean {
    const sequence = key.sequence ?? "";
    if (sequence && sequence === this.lastRawShiftEnterSequence) {
      this.clearRawShiftEnterEcho();
      return true;
    }

    const candidate = sequence || ch;
    const result = consumeRawShiftEnterEchoCandidate(
      this.pendingRawShiftEnterEchoes,
      candidate,
    );
    if (!result.consumed) {
      if (candidate) this.clearRawShiftEnterEcho();
      return false;
    }

    this.pendingRawShiftEnterEchoes = result.remaining;
    if (result.remaining.length === 0) {
      this.lastRawShiftEnterSequence = undefined;
    }
    return true;
  }

  private clearRawShiftEnterEcho(): void {
    this.lastRawShiftEnterSequence = undefined;
    this.pendingRawShiftEnterEchoes = [];
  }

  private exitProcess(): never {
    this.close();
    process.exit(0);
  }
}

export type TuiFrameSize = {
  width: number;
  height: number;
};

export type TuiFrameScroll = {
  conversation?: number;
  loop?: number;
};

export function renderTuiFrame(
  view: TuiViewModel,
  state: TuiInteractionState,
  expandedFrames: ReadonlySet<string>,
  size: TuiFrameSize,
  scroll: TuiFrameScroll = {},
): string[] {
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);
  const header = fitDisplayLine(renderHeaderLine(view.run), width);
  if (height === 1) return [header];

  const bodyHeight = height - 1;
  const leftWidth = chooseLeftWidth(width);
  const rightWidth = width - leftWidth;
  const conversationPaneWidth = Math.min(width, leftWidth + 1);
  const conversationContentWidth = Math.max(1, conversationPaneWidth - 2);
  const conversationLines = buildConversationFrameLines(
    view.conversation,
    state,
    conversationContentWidth,
  );
  const conversationPane = renderPane(
    state.pane === "conversation" ? "* Messages *" : "Messages",
    conversationPaneWidth,
    bodyHeight,
    visibleWindow(
      conversationLines,
      Math.max(0, bodyHeight - 2),
      conversationSelectedLine(view.conversation, state, conversationContentWidth),
      state.followBottom.conversation,
      scroll.conversation,
    ),
  );

  const bodyRows: string[] = [];
  if (rightWidth <= 0) {
    bodyRows.push(...conversationPane);
  } else {
    const topHeight = Math.max(1, Math.floor(bodyHeight / 2));
    const bottomHeight = Math.max(0, bodyHeight - topHeight);
    const loopWidth = Math.max(1, Math.floor(rightWidth * 0.51));
    const detailWidth = Math.max(1, rightWidth - loopWidth);
    const selectedLoopFrame = state.selectedLoopFrame(view.loop);
    const loopLines = buildLoopFrameLines(view.loop, state, expandedFrames);
    const loopPane = renderPane(
      state.pane === "loop" ? "* Agent Loop *" : "Agent Loop",
      loopWidth + 1,
      topHeight,
      visibleWindow(
        loopLines,
        Math.max(0, topHeight - 2),
        loopSelectedLine(view.loop, state, expandedFrames),
        state.followBottom.loop,
        scroll.loop,
      ),
    );
    const detailPane = renderPane(
      "Loop Detail",
      detailWidth,
      topHeight,
      buildLoopDetailLines(selectedLoopFrame, Math.max(1, detailWidth - 2)),
    );
    const ptySession = selectPtySession(view.sessions);
    const ptyLines = ptySession
      ? renderPtySessionForDisplay(ptySession, 4000, Math.max(1, rightWidth - 2)).split(
          "\n",
        )
      : ["No PTY session yet"];
    const ptyPane =
      bottomHeight > 0
        ? renderPane("PTY (read only)", rightWidth, bottomHeight, ptyLines)
        : [];

    for (let row = 0; row < bodyHeight; row++) {
      const rightRow =
        row < topHeight
          ? mergeAdjacentPanes(
              loopPane[row] ?? " ".repeat(loopWidth + 1),
              detailPane[row] ?? " ".repeat(detailWidth),
            )
          : ptyPane[row - topHeight] ?? " ".repeat(rightWidth);
      bodyRows.push(
        mergeAdjacentPanes(
          conversationPane[row] ?? " ".repeat(conversationPaneWidth),
          rightRow,
        ),
      );
    }
  }

  return exactFrame([header, ...bodyRows], width, height);
}

export function renderStyledTuiFrame(
  view: TuiViewModel,
  state: TuiInteractionState,
  expandedFrames: ReadonlySet<string>,
  size: TuiFrameSize,
  scroll: TuiFrameScroll = {},
): string[] {
  return renderTuiFrame(view, state, expandedFrames, size, scroll).map(
    styleTuiFrameLine,
  );
}

function styleTuiFrameLine(line: string): string {
  let styled = escapeBlessedMarkup(line);
  styled = styled.replace(
    /(\* Messages \*|\* Agent Loop \*)/gu,
    (_match, label: string) => tagged("cyan-fg", label),
  );
  styled = styled.replace(
    /\b(Messages|Agent Loop|Loop Detail|PTY \(read only\))\b/gu,
    (_match, label: string) => tagged("bold", label),
  );
  styled = styled.replace(
    /(\[[^\]\n]+\] user)/gu,
    (_match, label: string) => tagged("cyan-fg", label),
  );
  styled = styled.replace(
    /(agent \[[^\]\n]+\])/gu,
    (_match, label: string) => tagged("green-fg", label),
  );
  styled = styled.replace(/\bsystem\b/gu, (label) => tagged("gray-fg", label));
  styled = styled.replace(
    /(\b\d{2}:\d{2}:\d{2}\b)/gu,
    (_match, time: string) => tagged("gray-fg", time),
  );
  styled = styled.replace(/^([^\n]*\bstep\s+\d{3}\b)/u, (_match, step: string) =>
    tagged("gray-fg", step),
  );
  styled = styled.replace(
    /\b(waiting_for_io|waiting|running|ok|valid|success|warn|error|failed|blocked)\b/gu,
    (status: string) => tagged(statusColorTag(status), status),
  );
  styled = styled.replace(/(│|^)(>)(?=\s)/gu, (_match, prefix: string, marker: string) =>
    `${prefix}${tagged("blue-fg", marker)}`,
  );
  styled = styled.replace(/(^|│)(┌─ code[^│]*)/gu, (_match, prefix: string, code: string) =>
    `${prefix}${tagged("cyan-fg", code)}`,
  );
  styled = styled.replace(/(^|│)(└─)(?=\s*│?|$)/gu, (_match, prefix: string, code: string) =>
    `${prefix}${tagged("cyan-fg", code)}`,
  );
  return styled;
}

function statusColorTag(status: string): string {
  switch (status) {
    case "ok":
    case "valid":
    case "success":
      return "green-fg";
    case "error":
    case "failed":
    case "blocked":
      return "red-fg";
    case "running":
    case "waiting":
    case "waiting_for_io":
    case "warn":
      return "yellow-fg";
    default:
      return "white-fg";
  }
}

function tagged(tag: string, text: string): string {
  return `{${tag}}${text}{/${tag}}`;
}

function chooseLeftWidth(width: number): number {
  if (width < 40) return width;
  const preferred = Math.floor(width * 0.45);
  return clampNumber(preferred, 24, width - 16);
}

function renderHeaderLine(run: RunHeaderView): string {
  return (
    `run=${run.runId} ` +
    `status=${run.status} ` +
    `step=${run.stepIndex} ` +
    `cwd=${run.cwd}` +
    (run.model ? ` model=${run.model}` : "")
  );
}

function buildConversationFrameLines(
  items: ConversationItem[],
  state: TuiInteractionState,
  width: number,
): string[] {
  const lines: string[] = [];
  for (const item of items) {
    const selected = item.id === state.selectedConversationItemId;
    const marker = selected ? ">" : " ";
    lines.push(`${marker} ${conversationHeaderLine(item)}`);
    for (const bodyLine of renderConversationBodyLinesForDisplay(
      item.text,
      Math.max(1, width - 2),
    )) {
      lines.push(`  ${bodyLine}`);
    }
    lines.push("");
  }
  return lines;
}

function conversationHeaderLine(item: ConversationItem): string {
  const time = formatClockTimePlain(item.timestamp);
  switch (item.kind) {
    case "user":
      return `[${sanitizeDisplayText(item.channel)}] user ${time}`;
    case "agent":
      return `agent [${item.messageKind}] ${time}`;
    case "system":
      return `system ${time}`;
  }
}

function conversationSelectedLine(
  items: ConversationItem[],
  state: TuiInteractionState,
  width: number,
): number | undefined {
  let line = 0;
  for (const item of items) {
    if (item.id === state.selectedConversationItemId) return line;
    line += 2 + renderConversationBodyLinesForDisplay(item.text, width).length;
  }
  return undefined;
}

function buildLoopFrameLines(
  frames: LoopFrame[],
  state: TuiInteractionState,
  expandedFrames: ReadonlySet<string>,
): string[] {
  const lines: string[] = [];
  let currentStep = -1;
  for (const frame of frames) {
    if (frame.stepIndex !== currentStep) {
      currentStep = frame.stepIndex;
      lines.push(`step ${String(currentStep).padStart(3, "0")}`);
    }
    const marker = frame.id === state.selectedLoopFrameId ? ">" : " ";
    let line =
      `${marker} ${frame.phase.padEnd(12)} ` +
      `${frame.status.padEnd(8)} ${sanitizeDisplayText(frame.title)}`;
    if (frame.summary) {
      line += ` ${displayPreview(frame.summary, 80)}`;
    }
    lines.push(line);
    if (expandedFrames.has(frame.id) && frame.detail) {
      for (const detailLine of sanitizeDisplayText(frame.detail).slice(0, 2000).split("\n")) {
        lines.push(`    ${detailLine}`);
      }
    }
    if (expandedFrames.has(frame.id) && frame.logPath) {
      lines.push(`    log: ${frame.logPath}`);
    }
  }
  return lines;
}

function loopSelectedLine(
  frames: LoopFrame[],
  state: TuiInteractionState,
  expandedFrames: ReadonlySet<string>,
): number | undefined {
  let line = 0;
  let currentStep = -1;
  for (const frame of frames) {
    if (frame.stepIndex !== currentStep) {
      currentStep = frame.stepIndex;
      line += 1;
    }
    if (frame.id === state.selectedLoopFrameId) return line;
    line += 1;
    if (expandedFrames.has(frame.id) && frame.detail) {
      line += sanitizeDisplayText(frame.detail).slice(0, 2000).split("\n").length;
    }
    if (expandedFrames.has(frame.id) && frame.logPath) {
      line += 1;
    }
  }
  return undefined;
}

function buildLoopDetailLines(frame: LoopFrame | undefined, width: number): string[] {
  if (!frame) return [];
  const lines = [
    sanitizeDisplayText(frame.title),
    "",
    `step: ${frame.stepIndex}`,
    `phase: ${frame.phase}`,
    `status: ${frame.status}`,
    `time: ${frame.timestamp}`,
  ];
  if (frame.summary) {
    lines.push("", "Summary", ...wrapDisplayText(frame.summary, width));
  }
  if (frame.detail) {
    lines.push("", "Detail", ...wrapDisplayText(frame.detail.slice(0, 4000), width));
  }
  if (frame.logPath) {
    lines.push("", "Log", frame.logPath);
  }
  return lines;
}

function visibleWindow(
  lines: string[],
  height: number,
  selectedLine: number | undefined,
  followBottom: boolean,
  scrollTop?: number,
): string[] {
  if (height <= 0) return [];
  const maxStart = Math.max(0, lines.length - height);
  const start = followBottom
    ? maxStart
    : scrollTop !== undefined
      ? clampNumber(scrollTop, 0, maxStart)
      : selectedLine === undefined
        ? 0
        : clampNumber(selectedLine - 2, 0, maxStart);
  return lines.slice(start, start + height);
}

function renderPane(
  title: string,
  width: number,
  height: number,
  contentLines: string[],
): string[] {
  const safeWidth = Math.max(0, width);
  const safeHeight = Math.max(0, height);
  if (safeHeight === 0) return [];
  if (safeWidth <= 1) return Array.from({ length: safeHeight }, () => " ".repeat(safeWidth));
  if (safeHeight === 1) return [fitDisplayLine(`[${title}]`, safeWidth)];

  const innerWidth = Math.max(0, safeWidth - 2);
  const rows = [paneTop(title, safeWidth)];
  const innerHeight = Math.max(0, safeHeight - 2);
  for (let i = 0; i < innerHeight; i++) {
    rows.push(`│${fitDisplayLine(contentLines[i] ?? "", innerWidth)}│`);
  }
  rows.push(`└${"─".repeat(innerWidth)}┘`);
  return rows;
}

function paneTop(title: string, width: number): string {
  const innerWidth = Math.max(0, width - 2);
  const label = ` ${sanitizeDisplayText(title)} `;
  const fittedLabel = truncateDisplayText(label, innerWidth);
  const fill = Math.max(0, innerWidth - displayWidth(fittedLabel));
  return `┌${fittedLabel}${"─".repeat(fill)}┐`;
}

function mergeAdjacentPanes(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  const leftChars = Array.from(left);
  const rightChars = Array.from(right);
  leftChars[leftChars.length - 1] = mergeBorderChars(
    leftChars[leftChars.length - 1] ?? " ",
    rightChars[0] ?? " ",
  );
  return `${leftChars.join("")}${rightChars.slice(1).join("")}`;
}

type BorderDirection = "up" | "down" | "left" | "right";

const BORDER_DIRECTIONS: Record<string, BorderDirection[]> = {
  "│": ["up", "down"],
  "─": ["left", "right"],
  "┌": ["right", "down"],
  "┐": ["left", "down"],
  "└": ["right", "up"],
  "┘": ["left", "up"],
  "├": ["up", "down", "right"],
  "┤": ["up", "down", "left"],
  "┬": ["left", "right", "down"],
  "┴": ["left", "right", "up"],
  "┼": ["up", "down", "left", "right"],
};

const BORDER_BY_DIRECTIONS = new Map(
  Object.entries(BORDER_DIRECTIONS).map(([char, directions]) => [
    directionKey(directions),
    char,
  ]),
);

function mergeBorderChars(left: string, right: string): string {
  const directions = new Set<BorderDirection>([
    ...(BORDER_DIRECTIONS[left] ?? []),
    ...(BORDER_DIRECTIONS[right] ?? []),
  ]);
  return BORDER_BY_DIRECTIONS.get(directionKey([...directions])) ?? left;
}

function directionKey(directions: BorderDirection[]): string {
  return [...directions].sort().join(",");
}

function exactFrame(lines: string[], width: number, height: number): string[] {
  const frame = lines.slice(0, height).map((line) => fitDisplayLine(line, width));
  while (frame.length < height) {
    frame.push(" ".repeat(width));
  }
  return frame;
}

function fitDisplayLine(text: string, width: number): string {
  const safeWidth = Math.max(0, width);
  const clipped = truncateDisplayText(text, safeWidth);
  const fill = Math.max(0, safeWidth - displayWidth(clipped));
  return `${clipped}${" ".repeat(fill)}`;
}

function formatClockTimePlain(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return sanitizeDisplayText(timestamp);
  return date.toISOString().slice(11, 19);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function selectPtySession(
  sessions: SessionView[],
): SessionView | undefined {
  if (sessions.length === 0) return undefined;
  const defaultSession = sessions.find((session) => session.session === "default");
  if (defaultSession) return defaultSession;

  return sessions.reduce((best, session) => {
    if (session.updatedAt > best.updatedAt) return session;
    if (session.updatedAt < best.updatedAt) return best;
    return session.session.localeCompare(best.session) < 0 ? session : best;
  });
}

export function renderPtySessionForDisplay(
  session: SessionView,
  maxTailChars = 4000,
  maxLineWidth = 120,
): string {
  const tail = session.tail ?? "";
  const visibleTail =
    tail.length > maxTailChars ? tail.slice(-maxTailChars) : tail;
  const header =
    `${session.session}: ${session.state} ` +
    `(cmd=${session.currentCommand ?? "?"}, ` +
    `rc=${session.returnCode ?? "?"}, ` +
    `offset=${session.tailOffset ?? "?"})`;
  return `${header}\n\n${wrapDisplayText(visibleTail, maxLineWidth).join("\n")}`;
}

function escapeBlessedMarkup(text: string): string {
  const escape = (blessed as unknown as { escape(value: string): string }).escape;
  return escape(sanitizeDisplayText(text));
}

export function sanitizeDisplayText(text: string): string {
  const withoutAnsi = text
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[P_^][\s\S]*?\x1b\\/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-_]/g, "");
  const normalized = withoutAnsi
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\t/g, "  ");
  return normalized
    .split("\n")
    .map(applyBackspaces)
    .join("\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, "");
}

export function wrapDisplayText(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  for (const rawLine of sanitizeDisplayText(text).split("\n")) {
    if (rawLine.length === 0) {
      lines.push("");
      continue;
    }

    let current = "";
    let currentWidth = 0;
    for (const cluster of graphemeClusters(rawLine)) {
      const nextWidth = clusterWidth(cluster);
      if (current && currentWidth + nextWidth > safeWidth) {
        lines.push(current);
        current = "";
        currentWidth = 0;
      }
      current += cluster;
      currentWidth = Math.min(safeWidth, currentWidth + nextWidth);
    }
    lines.push(current);
  }
  return lines.length > 0 ? lines : [""];
}

export function renderConversationBodyLinesForDisplay(
  text: string,
  width: number,
  maxBodyChars = 4000,
  maxBodyLines = 80,
): string[] {
  const truncated =
    text.length > maxBodyChars
      ? `${text.slice(0, maxBodyChars)}\n[truncated ${text.length - maxBodyChars} chars]`
      : text;
  const lines = renderMarkdownForDisplay(truncated, width);
  if (lines.length > maxBodyLines) {
    return [...lines.slice(0, maxBodyLines), "[truncated additional lines]"];
  }
  return lines;
}

function renderMarkdownForDisplay(text: string, width: number): string[] {
  const lines: string[] = [];
  let codeFence: { marker: "`" | "~"; length: number } | undefined;
  const rawLines = sanitizeDisplayText(text).split("\n");

  for (let index = 0; index < rawLines.length; index++) {
    const line = rawLines[index]!.trimEnd();
    const fence = line.match(/^\s{0,3}(`{3,}|~{3,})\s*([^`]*)$/u);
    if (fence) {
      const marker = fence[1]!.startsWith("`") ? "`" : "~";
      const length = fence[1]!.length;
      if (!codeFence) {
        codeFence = { marker, length };
        const lang = fence[2]?.trim();
        lines.push(truncateDisplayText(lang ? `┌─ code ${lang}` : "┌─ code", width));
        continue;
      }
      if (marker === codeFence.marker && length >= codeFence.length) {
        codeFence = undefined;
        lines.push(truncateDisplayText("└─", width));
        continue;
      }
    }

    if (codeFence) {
      lines.push(truncateDisplayText(`│ ${line}`, width));
      continue;
    }

    const table = parseMarkdownTable(rawLines, index);
    if (table) {
      lines.push(...renderMarkdownTableForDisplay(table, width));
      index = table.nextIndex - 1;
      continue;
    }

    lines.push(...renderMarkdownLineForDisplay(line, width));
  }

  return lines.length > 0 ? lines : [""];
}

type MarkdownTableAlign = "left" | "center" | "right";

type MarkdownTable = {
  rows: string[][];
  aligns: MarkdownTableAlign[];
  nextIndex: number;
};

function parseMarkdownTable(
  rawLines: string[],
  startIndex: number,
): MarkdownTable | undefined {
  const headerLine = rawLines[startIndex]?.trimEnd();
  const separatorLine = rawLines[startIndex + 1]?.trimEnd();
  if (!headerLine || !separatorLine) return undefined;

  const header = splitMarkdownTableRow(headerLine).map(renderInlineMarkdownForDisplay);
  const separators = splitMarkdownTableRow(separatorLine);
  if (header.length < 2 || separators.length !== header.length) return undefined;
  if (!separators.every(isMarkdownTableSeparatorCell)) return undefined;

  const aligns = separators.map(parseMarkdownTableAlign);
  const rows = [header];
  let nextIndex = startIndex + 2;
  while (nextIndex < rawLines.length) {
    const rowLine = rawLines[nextIndex]!.trimEnd();
    if (!isMarkdownTableLine(rowLine)) break;
    const row = splitMarkdownTableRow(rowLine).map(renderInlineMarkdownForDisplay);
    if (row.length === 0) break;
    rows.push(normalizeMarkdownTableRow(row, header.length));
    nextIndex++;
  }

  return { rows, aligns, nextIndex };
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return [];
  let body = trimmed;
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|")) body = body.slice(0, -1);
  return body.split("|").map((cell) => cell.trim());
}

function isMarkdownTableSeparatorCell(cell: string): boolean {
  return /^:?-{3,}:?$/u.test(cell.trim());
}

function parseMarkdownTableAlign(cell: string): MarkdownTableAlign {
  const trimmed = cell.trim();
  const left = trimmed.startsWith(":");
  const right = trimmed.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  return "left";
}

function normalizeMarkdownTableRow(row: string[], columnCount: number): string[] {
  return Array.from({ length: columnCount }, (_unused, index) => row[index] ?? "");
}

function renderMarkdownTableForDisplay(
  table: MarkdownTable,
  width: number,
): string[] {
  const safeWidth = Math.max(1, width);
  const columnCount = table.rows[0]?.length ?? 0;
  if (columnCount === 0) return [];

  const delimiter = "  ";
  const delimiterWidth = displayWidth(delimiter) * Math.max(0, columnCount - 1);
  if (safeWidth <= delimiterWidth + columnCount) {
    return table.rows.flatMap((row) =>
      wrapDisplayText(row.filter(Boolean).join(" "), safeWidth),
    );
  }

  const availableWidth = safeWidth - delimiterWidth;
  const naturalWidths = Array.from({ length: columnCount }, (_unused, column) =>
    Math.max(
      3,
      ...table.rows.map((row) => displayWidth(row[column] ?? "")),
    ),
  );
  const columnWidths = fitMarkdownTableColumnWidths(
    naturalWidths,
    availableWidth,
  );

  const separator = columnWidths.map((columnWidth) => "─".repeat(columnWidth)).join(
    delimiter,
  );
  return [
    ...renderMarkdownTableRowLines(
      table.rows[0] ?? [],
      columnWidths,
      table.aligns,
      delimiter,
    ).map((row) => truncateDisplayText(row, safeWidth)),
    truncateDisplayText(separator, safeWidth),
    ...table.rows.slice(1).flatMap((row) =>
      renderMarkdownTableRowLines(
        row,
        columnWidths,
        table.aligns,
        delimiter,
      ).map((renderedRow) => truncateDisplayText(renderedRow, safeWidth)),
    ),
  ];
}

function fitMarkdownTableColumnWidths(
  naturalWidths: number[],
  availableWidth: number,
): number[] {
  const widths = naturalWidths.slice();
  const minWidths = naturalWidths.map((width) => Math.min(width, 3));
  while (sumNumbers(widths) > availableWidth) {
    const shrinkIndex = widths.reduce((bestIndex, width, index) => {
      if (width <= minWidths[index]!) return bestIndex;
      if (bestIndex === -1) return index;
      return width > widths[bestIndex]! ? index : bestIndex;
    }, -1);
    if (shrinkIndex === -1) break;
    widths[shrinkIndex]!--;
  }

  while (sumNumbers(widths) > availableWidth) {
    const shrinkIndex = widths.findIndex((columnWidth) => columnWidth > 1);
    if (shrinkIndex === -1) break;
    widths[shrinkIndex]!--;
  }
  return widths;
}

function renderMarkdownTableRowLines(
  row: string[],
  widths: number[],
  aligns: MarkdownTableAlign[],
  delimiter: string,
): string[] {
  const cells = widths.map((columnWidth, index) =>
    wrapDisplayText(row[index] ?? "", columnWidth),
  );
  const rowHeight = Math.max(1, ...cells.map((cellLines) => cellLines.length));
  return Array.from({ length: rowHeight }, (_unused, lineIndex) =>
    widths
      .map((columnWidth, columnIndex) =>
        fitDisplayCell(
          cells[columnIndex]?.[lineIndex] ?? "",
          columnWidth,
          aligns[columnIndex] ?? "left",
        ),
      )
      .join(delimiter),
  );
}

function fitDisplayCell(
  text: string,
  width: number,
  align: MarkdownTableAlign,
): string {
  const fitted = truncateDisplayText(text, width);
  const fill = Math.max(0, width - displayWidth(fitted));
  if (align === "right") return `${" ".repeat(fill)}${fitted}`;
  if (align === "center") {
    const left = Math.floor(fill / 2);
    return `${" ".repeat(left)}${fitted}${" ".repeat(fill - left)}`;
  }
  return `${fitted}${" ".repeat(fill)}`;
}

function sumNumbers(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0);
}

function renderMarkdownLineForDisplay(line: string, width: number): string[] {
  if (line.length === 0) return [""];
  if (isMarkdownTableLine(line)) return [truncateDisplayText(line, width)];
  if (/^\s{0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/u.test(line)) {
    return ["─".repeat(Math.max(1, width))];
  }

  const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u);
  if (heading) {
    return wrapDisplayText(renderInlineMarkdownForDisplay(heading[1]!), width);
  }

  const quote = line.match(/^\s{0,3}>\s?(.*)$/u);
  if (quote) {
    return wrapDisplayTextWithPrefix(
      "│ ",
      renderInlineMarkdownForDisplay(quote[1] ?? ""),
      width,
    );
  }

  const unordered = line.match(/^(\s*)[-+*]\s+(.*)$/u);
  if (unordered) {
    const indent = markdownIndent(unordered[1] ?? "");
    const body = unordered[2] ?? "";
    const task = body.match(/^\[([ xX])\]\s+(.*)$/u);
    const prefix = task
      ? `${indent}${task[1]!.toLowerCase() === "x" ? "☑" : "☐"} `
      : `${indent}• `;
    return wrapDisplayTextWithPrefix(
      prefix,
      renderInlineMarkdownForDisplay(task ? task[2] ?? "" : body),
      width,
    );
  }

  const ordered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/u);
  if (ordered) {
    const prefix = `${markdownIndent(ordered[1] ?? "")}${ordered[2]}. `;
    return wrapDisplayTextWithPrefix(
      prefix,
      renderInlineMarkdownForDisplay(ordered[3] ?? ""),
      width,
    );
  }

  return wrapDisplayText(renderInlineMarkdownForDisplay(line), width);
}

function wrapDisplayTextWithPrefix(
  prefix: string,
  body: string,
  width: number,
): string[] {
  const safeWidth = Math.max(1, width);
  const prefixWidth = displayWidth(prefix);
  if (prefixWidth >= safeWidth) {
    return [truncateDisplayText(`${prefix}${body}`, safeWidth)];
  }

  const wrapped = wrapDisplayText(body, Math.max(1, safeWidth - prefixWidth));
  const continuation = " ".repeat(prefixWidth);
  return wrapped.map((line, index) =>
    index === 0 ? `${prefix}${line}` : `${continuation}${line}`,
  );
}

function markdownIndent(spaces: string): string {
  return " ".repeat(Math.floor(displayWidth(spaces) / 2) * 2);
}

function renderInlineMarkdownForDisplay(text: string): string {
  let rendered = text;
  rendered = rendered.replace(
    /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu,
    (_match, alt: string, url: string) =>
      alt ? `[image: ${alt}] (${url})` : `[image] (${url})`,
  );
  rendered = rendered.replace(
    /\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/gu,
    (_match, label: string, url: string) =>
      label === url ? url : `${label} (${url})`,
  );
  rendered = rendered.replace(/`([^`]+)`/gu, "$1");
  rendered = rendered.replace(/\*\*([^*]+)\*\*/gu, "$1");
  rendered = rendered.replace(/__([^_]+)__/gu, "$1");
  rendered = rendered.replace(/~~([^~]+)~~/gu, "$1");
  rendered = rendered.replace(/(^|[^\p{L}\p{N}])\*([^*\n]+)\*/gu, "$1$2");
  rendered = rendered.replace(/(^|[^\p{L}\p{N}])_([^_\n]+)_/gu, "$1$2");
  return rendered;
}

export function truncateDisplayText(text: string, width: number): string {
  const safeWidth = Math.max(1, width);
  const sanitized = sanitizeDisplayText(text).trimEnd();
  if (displayWidth(sanitized) <= safeWidth) return sanitized;

  const suffix = safeWidth > 3 ? "..." : "";
  const contentWidth = safeWidth - displayWidth(suffix);
  let result = "";
  let currentWidth = 0;
  for (const cluster of graphemeClusters(sanitized)) {
    const nextWidth = clusterWidth(cluster);
    if (currentWidth + nextWidth > contentWidth) break;
    result += cluster;
    currentWidth += nextWidth;
  }
  return `${result}${suffix}`;
}

export function padBlessedLineForDisplay(line: string, width: number): string {
  const safeWidth = Math.max(0, width);
  const visibleWidth = displayWidth(stripBlessedTags(line));
  if (visibleWidth >= safeWidth) return line;
  return `${line}${" ".repeat(safeWidth - visibleWidth)}`;
}

function stripBlessedTags(text: string): string {
  return text.replace(/\{\/?[^{}\s]+\}/g, "");
}

function isMarkdownTableLine(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.includes("|")) return false;
  const pipeCount = Array.from(trimmed).filter((ch) => ch === "|").length;
  if (pipeCount < 2) return false;
  return (
    /^\|.*\|$/u.test(trimmed) ||
    /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/u.test(trimmed)
  );
}

function displayWidth(text: string): number {
  let width = 0;
  for (const cluster of graphemeClusters(text)) {
    width += clusterWidth(cluster);
  }
  return width;
}

function displayPreview(text: string, maxLength: number): string {
  const singleLine = sanitizeDisplayText(text).replace(/\s+/g, " ").trim();
  return singleLine.length <= maxLength
    ? singleLine
    : `${singleLine.slice(0, Math.max(0, maxLength - 3))}...`;
}

function applyBackspaces(text: string): string {
  const chars: string[] = [];
  for (const cluster of graphemeClusters(text)) {
    if (cluster === "\b") {
      chars.pop();
      continue;
    }
    chars.push(cluster);
  }
  return chars.join("");
}

export type RenderedInputBuffer = {
  content: string;
  cursorLine: number;
  cursorCol: number;
};

export function isShiftEnterKey(
  key: Pick<blessed.Widgets.Events.IKeyEventArg, "name" | "shift">,
): boolean {
  return (
    key.shift === true &&
    (key.name === "return" || key.name === "enter" || key.name === "linefeed")
  );
}

export function isRawShiftEnterSequence(sequence: string): boolean {
  return (
    sequence === "\x1b[13;2u" ||
    sequence === "\x1b[13;2U" ||
    sequence === "\x1b[13;2~" ||
    sequence === "\x1b[27;2;13~"
  );
}

export function isRawCtrlCSequence(sequence: string): boolean {
  return (
    sequence === "\x03" ||
    /^\x1b\[(?:27;5;(?:67|99)~|(?:3|67|99);5[Uu])$/.test(sequence)
  );
}

export function rawShiftEnterEchoCandidates(sequence: string): string[] {
  const withoutEscape = sequence.startsWith("\x1b")
    ? sequence.slice(1)
    : sequence;
  const withoutCsi = withoutEscape.startsWith("[")
    ? withoutEscape.slice(1)
    : withoutEscape;
  return Array.from(new Set([withoutEscape, withoutCsi])).filter(Boolean);
}

export function consumeRawShiftEnterEchoCandidate(
  pending: string[],
  candidate: string,
): { consumed: boolean; remaining: string[] } {
  if (!candidate) {
    return { consumed: false, remaining: pending };
  }

  let consumed = false;
  const remaining = pending.flatMap((echo) => {
    if (echo === candidate) {
      consumed = true;
      return [];
    }
    if (echo.startsWith(candidate)) {
      consumed = true;
      return [echo.slice(candidate.length)];
    }
    return [];
  });

  return {
    consumed,
    remaining: consumed ? remaining.filter(Boolean) : pending,
  };
}

function rawInputSequence(data: Buffer | string): string {
  return Buffer.isBuffer(data) ? data.toString("utf8") : data;
}

type DisplayLine = {
  text: string;
  width: number;
};

export function renderInputBufferForBox(
  input: string,
  innerWidth: number,
  rows: number,
  showCursor = false,
): RenderedInputBuffer {
  const safeRows = Math.max(1, rows);
  const safeWidth = Math.max(1, innerWidth);
  const contentWidth = Math.max(1, safeWidth - 1);
  const lines = wrapInputLines(input, contentWidth);
  const visibleStart = Math.max(0, lines.length - safeRows);
  const visible = lines.slice(visibleStart);
  const cursorLine = Math.max(0, lines.length - 1 - visibleStart);
  const cursorCol = Math.min(lines.at(-1)?.width ?? 0, safeWidth - 1);
  const contentLines = visible.map((line) => line.text);
  if (showCursor) {
    contentLines[cursorLine] = `${contentLines[cursorLine] ?? ""}█`;
  }

  return {
    content: contentLines.join("\n"),
    cursorLine,
    cursorCol,
  };
}

function wrapInputLines(input: string, width: number): DisplayLine[] {
  const lines: DisplayLine[] = [];
  let text = "";
  let currentWidth = 0;

  for (const cluster of graphemeClusters(input)) {
    if (cluster === "\n") {
      lines.push({ text, width: currentWidth });
      text = "";
      currentWidth = 0;
      continue;
    }

    const nextWidth = clusterWidth(cluster);
    if (currentWidth > 0 && currentWidth + nextWidth > width) {
      lines.push({ text, width: currentWidth });
      text = "";
      currentWidth = 0;
    }

    text += cluster;
    currentWidth = Math.min(width, currentWidth + nextWidth);
  }

  lines.push({ text, width: currentWidth });
  return lines;
}

type GraphemeSegment = { segment: string };

type GraphemeSegmenter = {
  segment(input: string): Iterable<GraphemeSegment>;
};

const graphemeSegmenter = (() => {
  const Segmenter = (
    Intl as unknown as {
      Segmenter?: new (
        locale: string | undefined,
        options: { granularity: "grapheme" },
      ) => GraphemeSegmenter;
    }
  ).Segmenter;
  return Segmenter
    ? new Segmenter(undefined, { granularity: "grapheme" })
    : undefined;
})();

function graphemeClusters(text: string): string[] {
  if (!graphemeSegmenter) return Array.from(text);
  return Array.from(graphemeSegmenter.segment(text), (segment) => segment.segment);
}

const emojiClusterPattern =
  /[\u{1f1e6}-\u{1f1ff}\u{20e3}\ufe0f\u200d]|\p{Extended_Pictographic}|\p{Emoji_Presentation}/u;

function clusterWidth(cluster: string): number {
  if (!cluster) return 0;
  if (emojiClusterPattern.test(cluster)) return 2;
  return Array.from(cluster).reduce(
    (width, ch) => width + Math.max(0, wcwidth(ch)),
    0,
  );
}
