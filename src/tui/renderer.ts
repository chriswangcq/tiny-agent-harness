// ─── BlessedRenderer ────────────────────────────────────────────────
//
// Implements TuiRenderer using neo-blessed (maintained fork of blessed).
// Renders the TUI layout: header, full-height messages, agent loop,
// loop detail, read-only PTY output, and a persistent input bar.
// The visible panes are separate blessed widgets; pure framebuffer helpers
// are kept for tests and text projections, and share the same pane model.
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
  TuiNoticeItem,
} from "./types.js";
import { TuiInteractionState } from "./interaction-state.js";
import {
  buildLoopFrameDetail,
  resolveLoopDetailFrame,
  summarizeLoopFrames,
} from "./debugger.js";
import type {
  RunBrowserControlIntentDisplay,
  RunBrowserView,
} from "./debugger.js";
import {
  createTuiInputEditorState,
  reduceTuiInputEditor,
  type TuiInputEditorAction,
  type TuiInputEditorState,
} from "./input-editor.js";
import wcwidth from "wcwidth";

import { buildScreenGrid, screenGridToDisplayLines } from './screen-projection.js';
const INPUT_BAR_HEIGHT = 5;
const INPUT_INNER_ROWS = INPUT_BAR_HEIGHT - 2;
const DEFAULT_STREAMING_ANIMATION_INTERVAL_MS = 220;

export type TuiAnimationTimerHandle = unknown;

export type TuiAnimationTimer = {
  setInterval(
    handler: () => void,
    intervalMs: number,
  ): TuiAnimationTimerHandle;
  clearInterval(handle: TuiAnimationTimerHandle): void;
};

export type BlessedRendererOptions = {
  animationTimer?: TuiAnimationTimer;
  animationIntervalMs?: number;
};

const SYSTEM_ANIMATION_TIMER: TuiAnimationTimer = {
  setInterval: (handler, intervalMs) => setInterval(handler, intervalMs),
  clearInterval: (handle) =>
    clearInterval(handle as ReturnType<typeof setInterval>),
};

export class BlessedRenderer implements TuiRenderer {
  private screen: blessed.Widgets.Screen;
  private headerBox: blessed.Widgets.BoxElement;
  private conversationBox: blessed.Widgets.BoxElement;
  private loopBox: blessed.Widgets.BoxElement;
  private detailBox: blessed.Widgets.BoxElement;
  private ptyBox: blessed.Widgets.BoxElement;
  private helpBox: blessed.Widgets.BoxElement;
  private inputBar: blessed.Widgets.BoxElement;
  private ui = new TuiInteractionState();
  private lastView: TuiViewModel | undefined;
  private expandedFrames = new Set<string>();
  private keyHandler?: (key: TuiKey) => void;
  private messageHandler?: (text: string) => void;
  private inputState: TuiInputEditorState = createTuiInputEditorState();
  private inputCursor = { row: 0, col: 0 };
  private lastRawShiftEnterSequence: string | undefined;
  private pendingRawShiftEnterEchoes: string[] = [];
  private frameScroll: TuiFrameScroll = {};
  private animationFrame = 0;
  private animationTimerHandle: TuiAnimationTimerHandle | undefined;
  private readonly animationTimer: TuiAnimationTimer;
  private readonly animationIntervalMs: number;

  constructor(options: BlessedRendererOptions = {}) {
    this.animationTimer = options.animationTimer ?? SYSTEM_ANIMATION_TIMER;
    this.animationIntervalMs = Math.max(
      16,
      Math.floor(
        options.animationIntervalMs ?? DEFAULT_STREAMING_ANIMATION_INTERVAL_MS,
      ),
    );
    this.screen = blessed.screen({
      smartCSR: true,
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
      wrap: false,
      style: { fg: "white", bg: "black" },
    });

    this.conversationBox = this.createPaneBox();
    this.loopBox = this.createPaneBox();
    this.detailBox = this.createPaneBox();
    this.ptyBox = this.createPaneBox();

    this.helpBox = blessed.box({
      top: "center",
      left: "center",
      width: 54,
      height: 22,
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
        "{bold}Project commands{/bold}:",
        "  :new <task>      start and attach a new run",
        "  :new             start a run waiting for IM",
        "  :open <runId>    attach an existing run",
        "  :open latest     attach latest run",
        "  :resume <runId>  start old run and attach",
        "  :stop [runId]    request run process stop",
        "  :refresh         reload run list",
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
      label: " [INPUT] message or :new/:open/:resume/:stop/:refresh ",
      tags: false,
      style: {
        fg: "white",
        border: { fg: "cyan" },
      },
    });

    this.screen.append(this.headerBox);
    this.screen.append(this.conversationBox);
    this.screen.append(this.loopBox);
    this.screen.append(this.detailBox);
    this.screen.append(this.ptyBox);
    this.screen.append(this.inputBar);
    this.screen.append(this.helpBox);

    this.setupKeys();
    this.refreshInputBar();
  }

  render(view: TuiViewModel): void {
    this.lastView = view;
    this.ui.syncWithView(view.conversation, view.loop);
    this.animationFrame++;
    const frameSize = {
      width: this.screen.cols,
      height: Math.max(1, this.screen.rows - INPUT_BAR_HEIGHT),
    };
    this.renderPaneModel(
      buildTuiPaneModel(view, this.ui, this.expandedFrames, {
        width: frameSize.width,
        height: frameSize.height,
      }, this.frameScroll, { animationFrame: this.animationFrame }),
    );

    this.updateStreamingAnimation(view, frameSize);
    this.renderScreen();
  }

  onKey(handler: (key: TuiKey) => void): void {
    this.keyHandler = handler;
  }

  onMessage(handler: (text: string) => void): void {
    this.messageHandler = handler;
  }

  close(): void {
    this.stopStreamingAnimation();
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

  private createPaneBox(): blessed.Widgets.BoxElement {
    return blessed.box({
      top: 1,
      left: 0,
      width: 1,
      height: 1,
      border: { type: "line" },
      tags: true,
      wrap: false,
      style: {
        fg: "white",
        bg: "black",
        border: { fg: "white" },
      },
    });
  }

  private renderPaneModel(model: TuiPaneFrameModel): void {
    this.headerBox.setContent(styleTuiFrameLine(fitDisplayLine(model.header, this.screen.cols)));

    this.updatePaneBox(this.conversationBox, {
      pane: model.conversation,
      top: 1,
      left: 0,
      active: this.ui.pane === "conversation",
    });

    const rightLeft = Math.max(0, model.layout.conversationPaneWidth);
    this.updatePaneBox(this.loopBox, {
      pane: model.loop,
      top: 1,
      left: rightLeft,
      active: this.ui.pane === "loop",
    });
    this.updatePaneBox(this.detailBox, {
      pane: model.detail,
      top: 1,
      left: rightLeft + Math.max(0, model.layout.loopPaneWidth),
      active: false,
    });
    this.updatePaneBox(this.ptyBox, {
      pane: model.pty,
      top: 1 + model.layout.topHeight,
      left: rightLeft,
      active: false,
    });
  }

  private updatePaneBox(
    box: blessed.Widgets.BoxElement,
    input: {
      pane?: TuiPaneModel;
      top: number;
      left: number;
      active: boolean;
    },
  ): void {
    if (!input.pane || input.pane.width <= 0 || input.pane.height <= 0) {
      box.hide();
      return;
    }

    box.show();
    box.top = input.top;
    box.left = input.left;
    box.width = input.pane.width;
    box.height = input.pane.height;
    box.setLabel(` ${input.pane.title} `);
    box.setContent(renderBlessedPaneContent(input.pane));
    const border = box.style.border as Record<string, string>;
    border.fg = input.active ? "cyan" : "white";
  }

  private refreshInputBar(): void {
    this.updateInputBarContent();
    this.renderScreen();
  }

  private submitInput(): void {
    const result = this.applyInputAction({ kind: "submit" });
    this.refreshInputBar();
    if (result.submittedText !== undefined) {
      this.messageHandler?.(result.submittedText);
    }
  }

  private insertInputNewline(): void {
    this.applyInputAction({ kind: "insert-newline" });
    this.refreshInputBar();
  }

  private updateInputBarContent(): void {
    const input = renderInputBufferForBox(
      this.inputState.buffer,
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
    this.screen.render();
    this.updateTerminalCursor();
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
    this.screen.on("resize", () => {
      this.rerenderLastView();
    });
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
      this.applyInputAction({ kind: "backspace" });
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
      this.applyInputAction({ kind: "insert-text", text: ch });
      this.refreshInputBar();
    }
  }

  private applyInputAction(action: TuiInputEditorAction): {
    submittedText?: string;
  } {
    const result = reduceTuiInputEditor(this.inputState, action, {
      graphemeClusters,
    });
    this.inputState = result.state;
    return result.submittedText === undefined
      ? {}
      : { submittedText: result.submittedText };
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
    const layout = this.currentLayoutPlan(bodyHeight);
    if (this.ui.pane === "conversation") {
      return Math.max(0, bodyHeight - 2);
    }
    return Math.max(0, layout.topHeight - 2);
  }

  private activeFrameLineCount(): number {
    if (!this.lastView) return 0;
    const frameHeight = Math.max(1, this.screen.rows - INPUT_BAR_HEIGHT);
    const bodyHeight = Math.max(0, frameHeight - 1);
    const layout = this.currentLayoutPlan(bodyHeight);
    if (this.ui.pane === "conversation") {
      return buildConversationFrameLines(
        this.lastView.conversation,
        this.ui,
        Math.max(1, layout.conversationPaneWidth - 2),
      ).length;
    }

    return buildLoopFrameLines(
      this.lastView.loop,
      this.ui,
      this.expandedFrames,
    ).length;
  }

  private currentLayoutPlan(bodyHeight: number): TuiLayoutPlan {
    return planTuiLayout({
      width: Math.max(1, this.screen.cols),
      bodyHeight,
      ptyViewport: ptyViewportFromSession(
        selectPtySession(this.lastView?.sessions ?? []),
      ),
    });
  }

  private rerenderLastView(): void {
    if (this.lastView) {
      this.render(this.lastView);
    } else {
      this.renderScreen();
    }
  }

  private updateStreamingAnimation(
    view: TuiViewModel,
    frameSize: TuiFrameSize,
  ): void {
    if (shouldAnimateStreamingThinking(view, this.ui, frameSize)) {
      this.startStreamingAnimation();
    } else {
      this.stopStreamingAnimation();
    }
  }

  private startStreamingAnimation(): void {
    if (this.animationTimerHandle !== undefined) return;
    this.animationTimerHandle = this.animationTimer.setInterval(() => {
      this.rerenderLastView();
    }, this.animationIntervalMs);
  }

  private stopStreamingAnimation(): void {
    if (this.animationTimerHandle === undefined) return;
    this.animationTimer.clearInterval(this.animationTimerHandle);
    this.animationTimerHandle = undefined;
  }

  private updateStyles(): void {
    const inputBorder = this.inputBar.style.border as Record<string, string>;

    if (this.ui.mode === "input") {
      inputBorder.fg = "cyan";
      this.inputBar.setLabel(
        " [INPUT] message or :new/:open/:resume/:stop/:refresh ",
      );
    } else {
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

export type TuiFrameRenderOptions = {
  animationFrame?: number;
};

export type TuiPtyViewport = {
  rows: number;
  cols: number;
};

export type TuiLayoutPlan = {
  bodyHeight: number;
  conversationPaneWidth: number;
  rightWidth: number;
  topHeight: number;
  bottomHeight: number;
  loopPaneWidth: number;
  detailPaneWidth: number;
  ptyFitsViewport: boolean;
};

export type TuiLayoutInput = {
  width: number;
  bodyHeight: number;
  ptyViewport?: TuiPtyViewport;
};

export type TuiPaneModel = {
  title: string;
  width: number;
  height: number;
  contentLines: string[];
};

export type TuiPaneFrameModel = {
  header: string;
  layout: TuiLayoutPlan;
  conversation: TuiPaneModel;
  loop?: TuiPaneModel;
  detail?: TuiPaneModel;
  pty?: TuiPaneModel;
};

export function renderTuiFrame(
  view: TuiViewModel,
  state: TuiInteractionState,
  expandedFrames: ReadonlySet<string>,
  size: TuiFrameSize,
  scroll: TuiFrameScroll = {},
  options: TuiFrameRenderOptions = {},
): string[] {
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);
  const model = buildTuiPaneModel(
    view,
    state,
    expandedFrames,
    { width, height },
    scroll,
    options,
  );
  const header = fitDisplayLine(model.header, width);
  if (height === 1) return [header];

  const conversationPane = renderPane(
    model.conversation.title,
    model.conversation.width,
    model.conversation.height,
    model.conversation.contentLines,
  );

  const bodyRows: string[] = [];
  if (!model.loop || !model.detail || !model.pty || model.layout.rightWidth <= 0) {
    bodyRows.push(...conversationPane);
  } else {
    const loopPane = renderPane(
      model.loop.title,
      model.loop.width,
      model.loop.height,
      model.loop.contentLines,
    );
    const detailPane = renderPane(
      model.detail.title,
      model.detail.width,
      model.detail.height,
      model.detail.contentLines,
    );
    const ptyPane = renderPane(
      model.pty.title,
      model.pty.width,
      model.pty.height,
      model.pty.contentLines,
    );

    for (let row = 0; row < model.layout.bodyHeight; row++) {
      const rightRow =
        row < model.layout.topHeight
          ? joinPaneRows(
              loopPane[row] ?? " ".repeat(model.layout.loopPaneWidth),
              detailPane[row] ?? " ".repeat(model.layout.detailPaneWidth),
            )
          : ptyPane[row - model.layout.topHeight] ?? " ".repeat(model.layout.rightWidth);
      bodyRows.push(
        joinPaneRows(
          conversationPane[row] ?? " ".repeat(model.layout.conversationPaneWidth),
          rightRow,
        ),
      );
    }
  }

  return exactFrame([header, ...bodyRows], width, height);
}

export function shouldAnimateStreamingThinking(
  view: TuiViewModel,
  _state: TuiInteractionState,
  size: TuiFrameSize,
): boolean {
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);
  const bodyHeight = Math.max(0, height - 1);
  const layout = planTuiLayout({
    width,
    bodyHeight,
    ptyViewport: ptyViewportFromSession(selectPtySession(view.sessions)),
  });
  if (
    layout.rightWidth <= 0 ||
    layout.loopPaneWidth <= 2 ||
    layout.topHeight <= 2
  ) {
    return false;
  }

  return view.loop.some((frame) => isStreamingThinkingFrame(frame));
}

export function buildTuiPaneModel(
  view: TuiViewModel,
  state: TuiInteractionState,
  expandedFrames: ReadonlySet<string>,
  size: TuiFrameSize,
  scroll: TuiFrameScroll = {},
  options: TuiFrameRenderOptions = {},
): TuiPaneFrameModel {
  const width = Math.max(1, size.width);
  const height = Math.max(1, size.height);
  const bodyHeight = Math.max(0, height - 1);
  const ptySession = selectPtySession(view.sessions);
  const layout = planTuiLayout({
    width,
    bodyHeight,
    ptyViewport: ptyViewportFromSession(ptySession),
  });
  const conversationContentWidth = Math.max(1, layout.conversationPaneWidth - 2);
  const conversationLines = buildConversationFrameLines(
    view.conversation,
    state,
    conversationContentWidth,
  );
  const runBrowserLines = buildRunBrowserFrameLines(
    view.runBrowser,
    view.notices ?? [],
    conversationContentWidth,
  );
  const conversationPaneLines =
    runBrowserLines.length > 0
      ? [...conversationLines, ...runBrowserLines]
      : conversationLines;
  const selectedConversationLine = conversationSelectedLine(
    view.conversation,
    state,
    conversationContentWidth,
  );
  const conversation: TuiPaneModel = {
    title: state.pane === "conversation" ? "* Messages *" : "Messages",
    width: layout.conversationPaneWidth,
    height: bodyHeight,
    contentLines: visibleWindow(
      conversationPaneLines,
      Math.max(0, bodyHeight - 2),
      selectedConversationLine,
      state.followBottom.conversation,
      scroll.conversation,
    ),
  };

  if (layout.rightWidth <= 0) {
    return {
      header: renderHeaderLine(view.run),
      layout,
      conversation,
    };
  }

  const detailFrame = resolveLoopDetailFrame(view.loop, {
    selectedFrameId: state.selectedLoopFrameId,
  });
  const loopLines = buildLoopFrameLines(
    view.loop,
    state,
    expandedFrames,
    options,
  );
  const loop: TuiPaneModel = {
    title: loopPaneTitle(view.loop, state.pane === "loop"),
    width: layout.loopPaneWidth,
    height: layout.topHeight,
    contentLines: visibleWindow(
      loopLines,
      Math.max(0, layout.topHeight - 2),
      loopSelectedLine(view.loop, state, expandedFrames),
      state.followBottom.loop,
      scroll.loop,
    ),
  };
  const detail: TuiPaneModel = {
    title: "Loop Detail",
    width: layout.detailPaneWidth,
    height: layout.topHeight,
    contentLines: buildLoopDetailLines(
      detailFrame,
      Math.max(1, layout.detailPaneWidth - 2),
      Math.max(0, layout.topHeight - 2),
      options,
    ),
  };
  const ptySessionTail = ptySession?.tail ?? "";
  const ptyRows = Math.max(1, ptySession?.screenRows ?? 24);
  const ptyCols = Math.max(1, ptySession?.screenCols ?? 80);
  const grid = buildScreenGrid(ptySessionTail, ptyRows, ptyCols);
  const displayWidth = Math.max(1, layout.rightWidth - 2);
  const ptyLines = ptySession
    ? screenGridToDisplayLines(grid, displayWidth)
    : ["No PTY session yet"];
  const pty: TuiPaneModel = {
    title: ptyPaneTitle(ptySession, layout),
    width: layout.rightWidth,
    height: layout.bottomHeight,
    contentLines: ptyLines.slice(Math.max(0, ptyLines.length - Math.max(0, layout.bottomHeight - 2))),
  };

  return {
    header: renderHeaderLine(view.run),
    layout,
    conversation,
    loop,
    detail,
    pty,
  };
}

export function renderBlessedPaneContent(pane: TuiPaneModel): string {
  const innerWidth = Math.max(0, pane.width - 2);
  const visibleRows = Math.max(0, pane.height - 2);
  return pane.contentLines
    .slice(0, visibleRows)
    .map((line) => styleTuiFrameLine(fitDisplayLine(line, innerWidth)))
    .join("\n");
}

function styleTuiFrameLine(line: string): string {
  let styled = escapeBlessedMarkup(line);
  styled = styled.replace(
    /(\* Messages \*|\* Agent Loop[^*]*\*)/gu,
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

export function planTuiLayout(input: TuiLayoutInput): TuiLayoutPlan {
  const width = Math.max(1, Math.floor(input.width));
  const bodyHeight = Math.max(0, Math.floor(input.bodyHeight));
  const ptyRows = positiveInteger(input.ptyViewport?.rows);
  const ptyCols = positiveInteger(input.ptyViewport?.cols);

  const preferredLeftWidth = chooseLeftWidth(width);
  const preferredRightWidth = Math.max(0, width - preferredLeftWidth);
  const requiredPtyWidth = ptyCols === undefined ? undefined : ptyCols + 2;

  const rightWidth =
    requiredPtyWidth === undefined
      ? preferredRightWidth
      : clampNumber(Math.max(preferredRightWidth, requiredPtyWidth), 0, width);
  const leftWidth = Math.max(0, width - rightWidth);
  const conversationPaneWidth = rightWidth > 0 ? leftWidth : width;

  const requiredPtyHeight = ptyRows === undefined ? undefined : ptyRows + 2;
  const bottomHeight =
    requiredPtyHeight === undefined
      ? Math.max(0, bodyHeight - Math.max(1, Math.floor(bodyHeight / 2)))
      : clampNumber(requiredPtyHeight, 0, bodyHeight);
  const topHeight = Math.max(0, bodyHeight - bottomHeight);

  const { loopPaneWidth, detailPaneWidth } = planTopRightSplit(rightWidth);
  return {
    bodyHeight,
    conversationPaneWidth,
    rightWidth,
    topHeight,
    bottomHeight,
    loopPaneWidth,
    detailPaneWidth,
    ptyFitsViewport:
      requiredPtyWidth !== undefined &&
      requiredPtyHeight !== undefined &&
      rightWidth >= requiredPtyWidth &&
      bottomHeight >= requiredPtyHeight,
  };
}

export function planTopRightSplit(rightWidth: number): {
  loopPaneWidth: number;
  detailPaneWidth: number;
} {
  if (rightWidth <= 0) return { loopPaneWidth: 0, detailPaneWidth: 0 };
  if (rightWidth < 24) {
    return { loopPaneWidth: rightWidth, detailPaneWidth: 0 };
  }

  const loopPaneWidth = clampNumber(
    Math.floor(rightWidth * 0.51),
    12,
    rightWidth - 12,
  );
  return {
    loopPaneWidth,
    detailPaneWidth: rightWidth - loopPaneWidth,
  };
}

function positiveInteger(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const integer = Math.floor(value);
  return integer > 0 ? integer : undefined;
}

function renderHeaderLine(run: RunHeaderView): string {
  const pendingTag = run.pendingReview ? " [REVIEW PENDING]" : "";
  return (
    `run=${run.runId} ` +
    `status=${run.status} ` +
    `step=${run.stepIndex} ` +
    `cwd=${run.cwd}` +
    (run.model ? ` model=${run.model}` : "") +
    pendingTag
  );
}

function buildRunBrowserFrameLines(
  runBrowser: RunBrowserView | undefined,
  notices: readonly TuiNoticeItem[],
  width: number,
): string[] {
  const safeWidth = Math.max(1, width);
  const lines: string[] = [];
  if (notices.length > 0) {
    lines.push("Notices");
    for (const notice of notices.slice(-5)) {
      lines.push(...wrapDisplayText(`  ${formatNoticeTime(notice.timestamp)} ${notice.text}`, safeWidth));
    }
    lines.push("");
  }
  if (!runBrowser) return lines;
  lines.push(truncateDisplayText(`Runs (${runBrowser.totalCount})`, safeWidth));
  if (runBrowser.isEmpty || runBrowser.rows.length === 0) {
    lines.push("  No runs found", "");
    return lines;
  }

  for (const row of runBrowser.rows) {
    const marker = row.isSelected ? ">" : " ";
    const preview = row.taskPreview || row.cwdPreview || "-";
    const failure = row.failureSummary ? " failure" : "";
    lines.push(
      truncateDisplayText(
        `${marker} ${row.runId} ${row.statusDisplay} ${row.stepDisplay} ${row.durationDisplay} ${preview}${failure}`,
        safeWidth,
      ),
    );
    if (row.isSelected && row.failureSummary) {
      lines.push(...wrapDisplayText(`  failure: ${row.failureSummary}`, safeWidth));
    }
  }

  const detail = runBrowser.selected?.detail;
  if (detail) {
    lines.push(
      ...wrapDisplayText(
        `  selected: ${detail.runId} ${detail.status} step ${detail.stepIndex}`,
        safeWidth,
      ),
      ...wrapDisplayText(`  cwd: ${detail.cwd}`, safeWidth),
    );
    if (detail.taskPreview) {
      lines.push(...wrapDisplayText(`  task: ${detail.taskPreview}`, safeWidth));
    }
    lines.push(
      ...wrapDisplayText(
        `  frames: ${detail.frameCount} problems: ${detail.problemFrameCount} messages: ${detail.conversationCount} sessions: ${detail.sessionCount}`,
        safeWidth,
      ),
    );
    if (detail.failureSummary) {
      lines.push(...wrapDisplayText(`  failure: ${detail.failureSummary}`, safeWidth));
    }
  }

  const controlIntentLines = buildRunBrowserControlIntentLines(
    runBrowser.controlIntentDisplays ?? [],
    safeWidth,
  );
  if (controlIntentLines.length > 0) {
    lines.push("");
    lines.push(...controlIntentLines);
  }

  lines.push("");
  return lines;
}

function buildRunBrowserControlIntentLines(
  displays: readonly RunBrowserControlIntentDisplay[],
  width: number,
): string[] {
  if (displays.length === 0) return [];

  const validDisplays = displays.filter((display) => display.valid);
  if (validDisplays.length > 0) {
    const first = validDisplays[0]!;
    const labels = validDisplays
      .map((display) => display.actionLabel)
      .join("/");
    return [
      ...wrapDisplayText(`  ctl: ${labels}`, width),
      ...wrapDisplayText(
        `  target: ${first.runId} owner=${first.intent.owner}`,
        width,
      ),
      ...wrapDisplayText(
        `  review: ${first.intent.review} effect=${first.intent.effect}`,
        width,
      ),
    ];
  }

  const firstError = displays.find(isRunBrowserControlIntentError);
  if (!firstError) return [];
  return [
    ...wrapDisplayText("  ctl: unavailable", width),
    ...wrapDisplayText(
      `  why: ${formatRunBrowserControlErrorReason(firstError)}`,
      width,
    ),
  ];
}

function isRunBrowserControlIntentError(
  display: RunBrowserControlIntentDisplay,
): display is Extract<RunBrowserControlIntentDisplay, { status: "error" }> {
  return !display.valid;
}

function formatRunBrowserControlErrorReason(
  display: Extract<RunBrowserControlIntentDisplay, { status: "error" }>,
): string {
  switch (display.errorKind) {
    case "missing_run_id":
      return "no target";
    case "unknown_run_id":
      return "unknown run";
    case "unsafe_mutation":
      return "intent only";
  }
}

function formatNoticeTime(timestamp: string): string {
  const match = /T(\d{2}:\d{2}:\d{2})/u.exec(timestamp);
  return match?.[1] ?? timestamp;
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
  options: TuiFrameRenderOptions = {},
): string[] {
  const lines: string[] = [];
  let currentStep = -1;
  for (const frame of frames) {
    if (frame.stepIndex !== currentStep) {
      currentStep = frame.stepIndex;
      lines.push(`step ${String(currentStep).padStart(3, "0")}`);
    }
    const marker = frame.id === state.selectedLoopFrameId ? ">" : " ";
    const statusText = isStreamingThinkingFrame(frame)
      ? `${frame.status.padEnd(8)}${streamingThinkingCursor(options.animationFrame ?? 0)}`
      : frame.status.padEnd(8);
    let line =
      `${marker} ${frame.phase.padEnd(12)} ` +
      `${statusText} ${sanitizeDisplayText(frame.title)}`;
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

const STREAMING_THINKING_CURSOR_FRAMES = ["•", "●", "⬤", "●"];

function buildLoopDetailLines(
  frame: LoopFrame | undefined,
  width: number,
  height: number,
  options: TuiFrameRenderOptions,
): string[] {
  if (!frame) return [];
  const detail = buildLoopFrameDetail(frame);
  if (isStreamingThinkingFrame(frame)) {
    return buildStreamingThinkingDetailLines(
      detail,
      width,
      height,
      streamingThinkingCursor(options.animationFrame ?? 0),
    );
  }
  const lines = [
    sanitizeDisplayText(detail.title),
    "",
    `id: ${detail.id}`,
    `step: ${detail.stepIndex}`,
    `phase: ${detail.phase}`,
    `status: ${detail.status}`,
    `time: ${detail.timestamp}`,
  ];
  if (detail.summary) {
    lines.push("", "Summary", ...wrapDisplayText(detail.summary, width));
  }
  if (detail.sections.length > 0) {
    lines.push("", "Sections");
    for (const section of detail.sections) {
      lines.push(`## ${sanitizeDisplayText(section.title)}`);
      lines.push(...wrapDisplayText(section.content.slice(0, 1200), width));
    }
  } else if (detail.rawDetail) {
    lines.push("", "Detail", ...wrapDisplayText(detail.rawDetail.slice(0, 4000), width));
  }
  if (detail.logPath) {
    lines.push("", "Log", detail.logPath);
  }
  return lines;
}

function isStreamingThinkingFrame(frame: LoopFrame): boolean {
  return (
    frame.phase === "model" &&
    frame.status === "running" &&
    frame.title === "model thinking"
  );
}

function buildStreamingThinkingDetailLines(
  detail: ReturnType<typeof buildLoopFrameDetail>,
  width: number,
  height: number,
  cursor: string,
): string[] {
  const thinking = detail.sections.find((section) => section.title === "thinking");
  const content = withStreamingCursor(thinking?.content ?? detail.rawDetail ?? "", cursor);
  const wrappedThinking = wrapDisplayText(content, width);
  if (height <= 4) {
    return wrappedThinking.slice(Math.max(0, wrappedThinking.length - Math.max(1, height)));
  }

  const header = [
    sanitizeDisplayText(detail.title),
    `step=${detail.stepIndex} status=${detail.status}`,
    ...(detail.summary ? wrapDisplayText(detail.summary, width) : []),
    "",
    "Thinking",
  ];
  const visibleHeader = header.slice(0, Math.max(0, height - 2));
  const availableThinkingLines = Math.max(1, height - visibleHeader.length);
  return [
    ...visibleHeader,
    ...wrappedThinking.slice(Math.max(0, wrappedThinking.length - availableThinkingLines)),
  ];
}

function withStreamingCursor(content: string, cursor: string): string {
  if (content.length === 0) return cursor;
  return content.endsWith("\n") ? `${content}${cursor}` : `${content} ${cursor}`;
}

function streamingThinkingCursor(animationFrame: number): string {
  return STREAMING_THINKING_CURSOR_FRAMES[
    positiveModulo(animationFrame, STREAMING_THINKING_CURSOR_FRAMES.length)
  ]!;
}

function positiveModulo(value: number, divisor: number): number {
  return ((value % divisor) + divisor) % divisor;
}

function loopPaneTitle(frames: LoopFrame[], focused: boolean): string {
  const summary = summarizeLoopFrames(frames);
  const parts = [`${summary.total}f`];
  if (summary.problemCount > 0) {
    parts.push(`${summary.problemCount}!`);
  }
  const label = `Agent Loop ${parts.join(" ")}`;
  return focused ? `* ${label} *` : label;
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

function joinPaneRows(left: string, right: string): string {
  return `${left}${right}`;
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
  const body = renderPtyScreenForDisplay(session, maxTailChars, maxLineWidth);
  return body ? `${ptyStatusLine(session)}\n\n${body}` : ptyStatusLine(session);
}

export function renderPtyScreenForDisplay(
  session: SessionView,
  maxTailChars = 4000,
  _maxLineWidth = 120,
): string {
  const tail = session.tail ?? "";
  return tail.length > maxTailChars ? tail.slice(-maxTailChars) : tail;
}

function ptyStatusLine(session: SessionView): string {
  return (
    `${session.session}: ${session.state} ` +
    `(cmd=${session.currentCommand ?? "?"}, ` +
    `rc=${session.returnCode ?? "?"}, ` +
    `offset=${session.tailOffset ?? "?"})`
  );
}

function ptyPaneTitle(
  session: SessionView | undefined,
  layout: TuiLayoutPlan,
): string {
  if (!session) return "PTY (read only)";
  const viewport = ptyViewportFromSession(session);
  if (!viewport) return "PTY (read only)";
  const fit = layout.ptyFitsViewport ? "fit" : "cropped";
  return `PTY ${session.session} agent ${viewport.cols}x${viewport.rows} ${fit} (read only)`;
}

function ptyViewportFromSession(
  session: SessionView | undefined,
): TuiPtyViewport | undefined {
  const rows = positiveInteger(session?.screenRows);
  const cols = positiveInteger(session?.screenCols);
  if (rows === undefined || cols === undefined) return undefined;
  return { rows, cols };
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
  maxBodyChars?: number,
  maxBodyLines?: number,
): string[] {
  const cappedByChars =
    typeof maxBodyChars === "number" &&
    Number.isFinite(maxBodyChars) &&
    maxBodyChars >= 0 &&
    text.length > maxBodyChars;
  const renderedText = cappedByChars
    ? `${text.slice(0, maxBodyChars)}\n[truncated ${text.length - maxBodyChars} chars]`
    : text;
  const lines = renderMarkdownForDisplay(renderedText, width);
  if (
    typeof maxBodyLines === "number" &&
    Number.isFinite(maxBodyLines) &&
    maxBodyLines >= 0 &&
    lines.length > maxBodyLines
  ) {
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

export function stripBlessedTags(text: string): string {
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

export function displayWidth(text: string): number {
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

export function graphemeClusters(text: string): string[] {
  if (!graphemeSegmenter) return Array.from(text);
  return Array.from(graphemeSegmenter.segment(text), (segment) => segment.segment);
}

const emojiClusterPattern =
  /[\u{1f1e6}-\u{1f1ff}\u{20e3}\ufe0f\u200d]|\p{Extended_Pictographic}|\p{Emoji_Presentation}/u;

export function clusterWidth(cluster: string): number {
  if (!cluster) return 0;
  if (emojiClusterPattern.test(cluster)) return 2;
  return Array.from(cluster).reduce(
    (width, ch) => width + Math.max(0, wcwidth(ch)),
    0,
  );
}
