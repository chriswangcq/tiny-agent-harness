import type { ConversationItem, LoopFrame } from "./types.js";

export type TuiMode = "input" | "browse";
export type TuiPane = "conversation" | "conversationDetail" | "loop" | "detail";

export type FollowBottomState = {
  conversation: boolean;
  loop: boolean;
};

export class TuiInteractionState {
  mode: TuiMode = "input";
  pane: TuiPane = "loop";
  followBottom: FollowBottomState = {
    conversation: true,
    loop: true,
  };
  selectedConversationItemId: string | undefined;
  selectedLoopFrameId: string | undefined;

  enterInput(): void {
    this.mode = "input";
    this.followBottom = { conversation: true, loop: true };
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
    if (pane === "loop" || pane === "detail") {
      this.ensureLoopSelection(frames);
    } else if (pane === "conversation" || pane === "conversationDetail") {
      this.ensureConversationSelection(conversation);
    }
  }

  enterDetail(frames: LoopFrame[]): void {
    this.enterBrowse(frames, "detail");
  }

  leaveDetail(frames: LoopFrame[]): void {
    this.enterBrowse(frames, "loop");
  }

  enterConversationDetail(conversation: ConversationItem[]): void {
    this.enterBrowse([], "conversationDetail", conversation);
  }

  leaveConversationDetail(conversation: ConversationItem[]): void {
    this.enterBrowse([], "conversation", conversation);
  }

  switchPane(frames: LoopFrame[]): void {
    this.mode = "browse";
    this.pane =
      this.pane === "loop" || this.pane === "detail" ? "conversation" : "loop";
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

    if (this.pane !== "loop") return;
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
      this.selectedConversationItemId = conversation.at(0)?.id;
      return;
    }
    if (this.pane !== "loop") return;
    this.followBottom.loop = false;
    if (this.pane === "loop" && frames.length > 0) {
      this.selectedLoopFrameId = frames[0]!.id;
    }
  }

  jumpBottom(frames: LoopFrame[]): void {
    if (this.pane === "detail" || this.pane === "conversationDetail") return;
    this.followBottom[this.pane] = true;
    if (this.pane === "loop") {
      this.selectLastLoopFrame(frames);
    }
  }

  toggleFollow(frames: LoopFrame[]): void {
    if (this.pane === "detail" || this.pane === "conversationDetail") return;
    const next = !this.followBottom[this.pane];
    this.followBottom[this.pane] = next;
    if (next && this.pane === "loop") {
      this.selectLastLoopFrame(frames);
    }
  }

  syncWithFrames(frames: LoopFrame[]): void {
    if (frames.length === 0) {
      this.selectedLoopFrameId = undefined;
      return;
    }
    if (this.mode === "input") {
      this.selectLastLoopFrame(frames);
      return;
    }
    if (this.pane !== "loop" && this.pane !== "detail") return;
    this.ensureLoopSelection(frames);
    if (this.pane === "loop" && this.followBottom.loop) {
      this.selectLastLoopFrame(frames);
    }
  }

  syncWithConversation(conversation: ConversationItem[]): void {
    if (conversation.length === 0) {
      this.selectedConversationItemId = undefined;
      return;
    }
    if (this.mode === "input") {
      this.selectLastConversationItem(conversation);
      return;
    }
    if (this.pane !== "conversation" && this.pane !== "conversationDetail") return;
    this.ensureConversationSelection(conversation);
    if (this.pane === "conversation" && this.followBottom.conversation) {
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
