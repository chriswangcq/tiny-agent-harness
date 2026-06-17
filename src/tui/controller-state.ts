import { createRunImSelfEndpoint } from "../im/index.js";
import type { WorkbenchViewUpdated } from "../runtime/project-workbench.js";
import type {
  ConversationItem,
  TuiNoticeItem,
  TuiViewModel,
} from "./types.js";

export type TuiControllerState = {
  selectedRunId?: string;
  lastWorkbenchView?: TuiViewModel;
  localNotices: readonly TuiNoticeItem[];
  pendingUserEchoes: readonly ConversationItem[];
};

export function createTuiControllerState(input: {
  selectedRunId?: string;
  lastWorkbenchView?: TuiViewModel;
  localNotices?: readonly TuiNoticeItem[];
  pendingUserEchoes?: readonly ConversationItem[];
} = {}): TuiControllerState {
  return {
    selectedRunId: input.selectedRunId,
    lastWorkbenchView: input.lastWorkbenchView,
    localNotices: [...(input.localNotices ?? [])],
    pendingUserEchoes: [...(input.pendingUserEchoes ?? [])],
  };
}

export function applyWorkbenchViewUpdate(
  state: TuiControllerState,
  event: WorkbenchViewUpdated,
): TuiControllerState {
  return {
    ...state,
    selectedRunId: event.selectedRunId,
    lastWorkbenchView: event.view,
    pendingUserEchoes: prunePendingEchoes(state.pendingUserEchoes, event.view),
  };
}

export function setControllerSelectedRun(
  state: TuiControllerState,
  selectedRunId: string | undefined,
): TuiControllerState {
  return { ...state, selectedRunId };
}

export function addControllerNotice(
  state: TuiControllerState,
  notice: TuiNoticeItem,
): TuiControllerState {
  return {
    ...state,
    localNotices: appendUniqueById(state.localNotices, notice),
  };
}

export function addPendingUserEcho(
  state: TuiControllerState,
  item: ConversationItem,
): TuiControllerState {
  if (item.kind !== "user") {
    return state;
  }
  const baseView = state.lastWorkbenchView;
  if (baseView?.conversation.some((existing) => existing.id === item.id)) {
    return state;
  }
  return {
    ...state,
    pendingUserEchoes: appendUniqueById(state.pendingUserEchoes, item),
  };
}

export function buildControllerRenderView(input: {
  state: TuiControllerState;
  emptyView: TuiViewModel;
}): TuiViewModel {
  return withLocalConversationItems(
    withLocalNotices(
      input.state.lastWorkbenchView ?? input.emptyView,
      input.state.localNotices,
    ),
    input.state.pendingUserEchoes,
  );
}

export function pendingUserEchoFromPost(input: {
  data: Record<string, unknown>;
  fallback: {
    id: string;
    timestamp: string;
    runId: string;
    text: string;
  };
}): ConversationItem {
  const posted = isRecord(input.data.posted) ? input.data.posted : input.data;
  const message = isRecord(posted.message) ? posted.message : undefined;
  const id = typeof message?.id === "string" ? `user:${message.id}` : input.fallback.id;
  const timestamp =
    typeof message?.createdAt === "string"
      ? message.createdAt
      : input.fallback.timestamp;
  const channel =
    typeof message?.to === "string"
      ? message.to
      : createRunImSelfEndpoint(input.fallback.runId);
  const text = typeof message?.text === "string" ? message.text : input.fallback.text;
  return {
    id,
    kind: "user",
    timestamp,
    channel,
    text,
  };
}

function withLocalConversationItems(
  view: TuiViewModel,
  localItems: readonly ConversationItem[],
): TuiViewModel {
  if (localItems.length === 0) {
    return view;
  }
  const seen = new Set(view.conversation.map((item) => item.id));
  const conversation = [...view.conversation];
  for (const item of localItems) {
    if (seen.has(item.id)) {
      continue;
    }
    seen.add(item.id);
    conversation.push(item);
  }
  return {
    ...view,
    conversation,
  };
}

function withLocalNotices(
  view: TuiViewModel,
  notices: readonly TuiNoticeItem[],
): TuiViewModel {
  if (notices.length === 0) {
    return view;
  }
  const seen = new Set((view.notices ?? []).map((notice) => notice.id));
  const merged = [...(view.notices ?? [])];
  for (const notice of notices) {
    if (seen.has(notice.id)) {
      continue;
    }
    seen.add(notice.id);
    merged.push(notice);
  }
  return {
    ...view,
    notices: merged,
  };
}

function prunePendingEchoes(
  pending: readonly ConversationItem[],
  view: TuiViewModel,
): ConversationItem[] {
  const seen = new Set(view.conversation.map((item) => item.id));
  return pending.filter((item) => !seen.has(item.id));
}

function appendUniqueById<T extends { id: string }>(
  items: readonly T[],
  item: T,
): T[] {
  if (items.some((existing) => existing.id === item.id)) {
    return [...items];
  }
  return [...items, item];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
