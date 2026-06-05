import type { ConversationItem, LoopFrame } from "./types.js";

export type TuiMode = "input" | "browse";
export type TuiPane = "conversation" | "loop";

export type FollowBottomState = {
  conversation: boolean;
  loop: boolean;
};

export class TuiInteractionState {
  mode: TuiMode = "input";
  pane: TuiPane = "conversation";
  followBottom: FollowBottomState = {
    conversation: true,
    loop: true,
  };
  /** True when enterInput() deferred follow re-anchor; cleared when next sync restores it. */
  private followDeferred = false;
  selectedConversationItemId: string | undefined;
  selectedLoopFrameId: string | undefined;

  enterInput(): void {
    this.mode = "input";
    // Defer follow-bottom re-anchor: only restore follow when new content arrives
    // to avoid jarring snap after exiting browse mode.
    this.followBottom = { conversation: false, loop: false };
    this.followDeferred = true;
    this.selectedConversationItemId = undefined;
    this.selectedLoopFrameId = undefined;
  }

  enterBrowse(
    frames: LoopFrame[],
    pane: TuiPane = this.pane,
    conversation: ConversationItem[] = [],
  ): void {
    this.mode = "browse";
    this.pane = pane;
    this.followDeferred = false;
    if (pane === "loop") {
      this.ensureLoopSelection(frames);
    } else {
      this.ensureConversationSelection(conversation);
    }
  }

  switchPane(frames: LoopFrame[]): void {
    this.mode = "browse";
    this.pane = this.pane === "loop" ? "conversation" : "loop";
    if (this.pane === "loop") {
      this.ensureLoopSelection(frames);
    }
  }

  moveSelection(
    frames: LoopFrame[],
    delta: number,
    conversation: ConversationItem[] = [],
  ): void {
    this.mode = "browse";
    if (this.pane === "conversation") {
      this.followBottom.conversation = false;
      if (conversation.length === 0) {
        this.selectedConversationItemId = undefined;
        return;
      }
      const currentIndex = this.selectedConversationIndex(conversation);
      const nextIndex = clamp(currentIndex + delta, 0, conversation.length - 1);
      this.selectedConversationItemId = conversation[nextIndex]!.id;
      return;
    }

    // pane === "loop"
    this.followBottom.loop = false;
    if (frames.length === 0) {
      this.selectedLoopFrameId = undefined;
      return;
    }

    const currentIndex = this.selectedLoopIndex(frames);
    const nextIndex = clamp(currentIndex + delta, 0, frames.length - 1);
    this.selectedLoopFrameId = frames[nextIndex]!.id;
  }

  jumpTop(frames: LoopFrame[], conversation: ConversationItem[] = []): void {
    this.mode = "browse";
    if (this.pane === "conversation") {
      this.followBottom.conversation = false;
      if (conversation.length > 0) {
        this.selectedConversationItemId = conversation[0]!.id;
      }
      return;
    }
    // loop pane
    this.followBottom.loop = false;
    if (frames.length > 0) {
      this.selectedLoopFrameId = frames[0]!.id;
    }
  }

  jumpBottom(frames: LoopFrame[], conversation: ConversationItem[] = []): void {
    this.mode = "browse";
    if (this.pane === "conversation") {
      if (conversation.length > 0) {
        this.selectedConversationItemId = conversation.at(-1)!.id;
      }
      this.followBottom.conversation = true;
      return;
    }
    // loop pane
    if (frames.length > 0) {
      this.selectedLoopFrameId = frames.at(-1)!.id;
    }
    this.followBottom.loop = true;
  }

  toggleFollow(
    pane: TuiPane,
    conversation: ConversationItem[] = [],
    frames: LoopFrame[] = [],
  ): void {
    this.followDeferred = false;
    if (pane === "conversation") {
      this.followBottom.conversation = !this.followBottom.conversation;
      if (this.followBottom.conversation && conversation.length > 0) {
        this.selectLastConversationItem(conversation);
      }
      return;
    }
    // loop pane
    this.followBottom.loop = !this.followBottom.loop;
    if (this.followBottom.loop && frames.length > 0) {
      this.selectLastLoopFrame(frames);
    }
  }

  syncWithView(conversation: ConversationItem[] = [], frames: LoopFrame[] = []): void {
    this.ensureLoopSelection(frames);
    this.ensureConversationSelection(conversation);
    this.resolveFollowDeferral(conversation, frames);
    if (this.followBottom.conversation && conversation.length > 0) {
      this.selectLastConversationItem(conversation);
    }
    if (this.followBottom.loop && frames.length > 0) {
      this.selectLastLoopFrame(frames);
    }
  }

  // Side-specific compatibility wrappers: each handles only one side
  syncWithFrames(frames: LoopFrame[]): void {
    this.ensureLoopSelection(frames);
    if (this.followDeferred && frames.length > 0) {
      this.followBottom.loop = true;
      this.followDeferred = false;
    }
    if (this.followBottom.loop && frames.length > 0) {
      this.selectLastLoopFrame(frames);
    }
  }

  syncWithConversation(conversation: ConversationItem[]): void {
    this.ensureConversationSelection(conversation);
    if (this.followDeferred && conversation.length > 0) {
      this.followBottom = { conversation: true, loop: true };
      this.followDeferred = false;
    }
    if (this.followBottom.conversation && conversation.length > 0) {
      this.selectLastConversationItem(conversation);
    }
  }

  selectedLoopFrame(frames: LoopFrame[]): LoopFrame | undefined {
    if (!this.selectedLoopFrameId) return undefined;
    return frames.find((frame) => frame.id === this.selectedLoopFrameId);
  }

  selectedConversationItem(
    conversation: ConversationItem[],
  ): ConversationItem | undefined {
    if (!this.selectedConversationItemId) return undefined;
    return conversation.find((item) => item.id === this.selectedConversationItemId);
  }

  private resolveFollowDeferral(
    conversation: ConversationItem[],
    frames: LoopFrame[],
  ): void {
    if (!this.followDeferred) return;
    if (conversation.length > 0 || frames.length > 0) {
      this.followBottom = { conversation: true, loop: true };
      this.followDeferred = false;
    }
  }

  private ensureLoopSelection(frames: LoopFrame[]): void {
    if (frames.length === 0) {
      this.selectedLoopFrameId = undefined;
      return;
    }
    if (!this.selectedLoopFrame(frames)) {
      this.selectLastLoopFrame(frames);
    }
  }

  private selectLastLoopFrame(frames: LoopFrame[]): void {
    this.selectedLoopFrameId = frames.at(-1)?.id;
  }

  private ensureConversationSelection(conversation: ConversationItem[]): void {
    if (conversation.length === 0) {
      this.selectedConversationItemId = undefined;
      return;
    }
    if (!this.selectedConversationItem(conversation)) {
      this.selectLastConversationItem(conversation);
    }
  }

  private selectLastConversationItem(conversation: ConversationItem[]): void {
    this.selectedConversationItemId = conversation.at(-1)?.id;
  }

  private selectedLoopIndex(frames: LoopFrame[]): number {
    const idx = frames.findIndex((frame) => frame.id === this.selectedLoopFrameId);
    return idx === -1 ? frames.length - 1 : idx;
  }

  private selectedConversationIndex(conversation: ConversationItem[]): number {
    const idx = conversation.findIndex(
      (item) => item.id === this.selectedConversationItemId,
    );
    return idx === -1 ? conversation.length - 1 : idx;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
