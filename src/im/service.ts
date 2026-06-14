import {
  createImConsumerAddress,
  createImDirectionalChannelAddress,
  createImPairAddress,
  normalizeImEndpoint,
  type ImEndpoint,
} from "./address.js";
import {
  planImChannelLayout,
  planImCursorLayout,
  planImPairLayout,
  planImRunBindingLayout,
} from "./layout.js";
import {
  appendJsonlFile,
  readJsonFile,
  readJsonlFile,
  writeJsonFile,
  type ImStorePort,
} from "./store.js";

export const PUBLIC_IM_SCHEMA_VERSION = 1;

export type PublicImPairKind = "a2user" | "a2a" | "team" | "control" | "direct";

export type PublicImMessageRole = "user" | "agent" | "system";

export type PublicImMessageKind = "message" | "status" | "error";

export type PublicImPairRecord = {
  schemaVersion: typeof PUBLIC_IM_SCHEMA_VERSION;
  pairId: string;
  pairKey: string;
  kind: PublicImPairKind | string;
  endpoints: [string, string];
  channels: Record<string, string>;
  createdAt: string;
};

export type PublicImChannelMetaRecord = {
  schemaVersion: typeof PUBLIC_IM_SCHEMA_VERSION;
  pairId: string;
  channelId: string;
  channelKey: string;
  from: string;
  to: string;
  createdAt: string;
};

export type PublicImRunBinding = {
  kind: PublicImPairKind | string;
  peer: string;
  pairId: string;
  inboundChannelId: string;
  outboundChannelId: string;
};

export type PublicImRunBindingRecord = {
  schemaVersion: typeof PUBLIC_IM_SCHEMA_VERSION;
  runId: string;
  self: string;
  bindings: PublicImRunBinding[];
  updatedAt: string;
};

export type PublicImMessage = {
  schemaVersion: typeof PUBLIC_IM_SCHEMA_VERSION;
  id: string;
  pairId: string;
  channelId: string;
  from: string;
  to: string;
  role: PublicImMessageRole;
  kind: PublicImMessageKind;
  text: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
};

export type PublicImReceiveResult = {
  messages: PublicImMessage[];
  nextCursor?: string;
  cursorFound?: false;
};

export type PublicImRunReceiveMessage = PublicImMessage & {
  binding: PublicImRunBinding;
};

export type PublicImRunReceiveResult = {
  runId: string;
  self: string;
  messages: PublicImRunReceiveMessage[];
  nextCursors: Record<string, string | undefined>;
};

export type PublicImServicePorts = {
  store: ImStorePort;
  clock: { nowIso: () => string };
  ids: { newMessageId: (seed: string) => string };
};

export class PublicImService {
  constructor(private readonly ports: PublicImServicePorts) {}

  async createPair(input: {
    stateRoot: string;
    a: string;
    b: string;
    kind?: PublicImPairKind | string;
  }): Promise<PublicImPairRecord> {
    const pair = createImPairAddress(input.a, input.b);
    const pairLayout = planImPairLayout(input.stateRoot, pair.endpointA, pair.endpointB);
    const first = createImDirectionalChannelAddress(pair.endpointA, pair.endpointB);
    const second = createImDirectionalChannelAddress(pair.endpointB, pair.endpointA);

    return this.ports.store.withWriteLock(
      {
        stateRoot: input.stateRoot,
        lockName: pairLockName(pair.pairId),
        purpose: "im-pair",
      },
      async () => {
        const existing = await readJsonFile<PublicImPairRecord>(
          this.ports.store,
          pairLayout.pairFile,
        );
        if (existing) {
          await this.ensureChannelMeta(input.stateRoot, pair.endpointA, pair.endpointB, existing, existing.createdAt);
          await this.ensureChannelMeta(input.stateRoot, pair.endpointB, pair.endpointA, existing, existing.createdAt);
          return existing;
        }

        const createdAt = this.ports.clock.nowIso();
        const record: PublicImPairRecord = {
          schemaVersion: PUBLIC_IM_SCHEMA_VERSION,
          pairId: pair.pairId,
          pairKey: pair.pairKey,
          kind: input.kind ?? "direct",
          endpoints: [pair.endpointA.canonical, pair.endpointB.canonical],
          channels: {
            [first.channelKey]: first.channelId,
            [second.channelKey]: second.channelId,
          },
          createdAt,
        };

        await writeJsonFile(this.ports.store, pairLayout.pairFile, record);
        await this.ensureChannelMeta(input.stateRoot, pair.endpointA, pair.endpointB, record, createdAt);
        await this.ensureChannelMeta(input.stateRoot, pair.endpointB, pair.endpointA, record, createdAt);
        return record;
      },
    );
  }

  async bindRun(input: {
    stateRoot: string;
    runId: string;
    self: string;
    peer: string;
    kind?: PublicImPairKind | string;
  }): Promise<PublicImRunBindingRecord> {
    const self = normalizeImEndpoint(input.self);
    const peer = normalizeImEndpoint(input.peer);
    const pair = await this.createPair({
      stateRoot: input.stateRoot,
      a: self.canonical,
      b: peer.canonical,
      kind: input.kind,
    });
    const inbound = createImDirectionalChannelAddress(peer, self);
    const outbound = createImDirectionalChannelAddress(self, peer);
    const binding: PublicImRunBinding = {
      kind: input.kind ?? pair.kind,
      peer: peer.canonical,
      pairId: pair.pairId,
      inboundChannelId: inbound.channelId,
      outboundChannelId: outbound.channelId,
    };

    return this.ports.store.withWriteLock(
      {
        stateRoot: input.stateRoot,
        lockName: runBindingLockName(input.runId),
        purpose: "im-run-binding",
      },
      async () => {
        const layout = planImRunBindingLayout(input.stateRoot, input.runId);
        const existing = await readJsonFile<PublicImRunBindingRecord>(
          this.ports.store,
          layout.bindingFile,
        );
        const next: PublicImRunBindingRecord = {
          schemaVersion: PUBLIC_IM_SCHEMA_VERSION,
          runId: input.runId,
          self: self.canonical,
          bindings: upsertBinding(existing?.bindings ?? [], binding),
          updatedAt: this.ports.clock.nowIso(),
        };
        await writeJsonFile(this.ports.store, layout.bindingFile, next);
        return next;
      },
    );
  }

  async postMessage(input: {
    stateRoot: string;
    from: string;
    to: string;
    text: string;
    metadata?: Record<string, unknown>;
  }): Promise<PublicImMessage> {
    return this.appendMessage({ ...input, role: "user", kind: "message" });
  }

  async sendMessage(input: {
    stateRoot: string;
    from: string;
    to: string;
    kind: "status" | "error";
    text: string;
    metadata?: Record<string, unknown>;
  }): Promise<PublicImMessage> {
    return this.appendMessage({ ...input, role: "agent" });
  }

  async receiveForPair(input: {
    stateRoot: string;
    as: string;
    with: string;
    cursor?: string;
  }): Promise<PublicImReceiveResult> {
    const self = normalizeImEndpoint(input.as);
    const peer = normalizeImEndpoint(input.with);
    const channelLayout = planImChannelLayout(input.stateRoot, peer, self);
    const cursorLayout = planImCursorLayout(input.stateRoot, peer, self, self);
    const cursor =
      input.cursor ??
      (await this.ports.store.readText(cursorLayout.cursorFile))?.trim() ??
      undefined;
    const messages = await readJsonlFile<PublicImMessage>(
      this.ports.store,
      channelLayout.messagesFile,
    );
    return sliceAfterCursor(messages, cursor);
  }

  async receiveForRun(input: {
    stateRoot: string;
    runId: string;
  }): Promise<PublicImRunReceiveResult> {
    const binding = await this.readRunBinding(input.stateRoot, input.runId);
    const runConsumer = createImConsumerAddress(`run:${input.runId}`);
    const messages: PublicImRunReceiveMessage[] = [];
    const nextCursors: Record<string, string | undefined> = {};

    for (const item of binding.bindings) {
      const self = normalizeImEndpoint(binding.self);
      const peer = normalizeImEndpoint(item.peer);
      const channelLayout = planImChannelLayout(input.stateRoot, peer, self);
      const cursorLayout = planImCursorLayout(input.stateRoot, peer, self, runConsumer.consumer);
      const cursor = (await this.ports.store.readText(cursorLayout.cursorFile))?.trim() ?? undefined;
      const channelMessages = await readJsonlFile<PublicImMessage>(
        this.ports.store,
        channelLayout.messagesFile,
      );
      const result = sliceAfterCursor(channelMessages, cursor);
      nextCursors[item.inboundChannelId] = result.nextCursor;
      for (const message of result.messages) {
        messages.push({ ...message, binding: item });
      }
    }

    messages.sort((left, right) => {
      const byTime = left.createdAt.localeCompare(right.createdAt);
      return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
    });

    return {
      runId: input.runId,
      self: binding.self,
      messages,
      nextCursors,
    };
  }

  async readChannelMessages(input: {
    stateRoot: string;
    from: string;
    to: string;
    cursor?: string;
  }): Promise<PublicImReceiveResult> {
    const from = normalizeImEndpoint(input.from);
    const to = normalizeImEndpoint(input.to);
    const channelLayout = planImChannelLayout(input.stateRoot, from, to);
    const messages = await readJsonlFile<PublicImMessage>(
      this.ports.store,
      channelLayout.messagesFile,
    );
    return sliceAfterCursor(messages, input.cursor);
  }

  async ackPair(input: {
    stateRoot: string;
    as: string;
    with: string;
    messageId: string;
  }): Promise<void> {
    const self = normalizeImEndpoint(input.as);
    const peer = normalizeImEndpoint(input.with);
    const cursorLayout = planImCursorLayout(input.stateRoot, peer, self, self);
    await this.ports.store.withWriteLock(
      {
        stateRoot: input.stateRoot,
        lockName: cursorLockName(cursorLayout.channel.channelId, cursorLayout.consumer.consumerId),
        purpose: "im-cursor",
      },
      () => this.ports.store.writeText(cursorLayout.cursorFile, input.messageId),
    );
  }

  async ackRunChannel(input: {
    stateRoot: string;
    runId: string;
    peer: string;
    messageId: string;
  }): Promise<void> {
    const binding = await this.readRunBinding(input.stateRoot, input.runId);
    const self = normalizeImEndpoint(binding.self);
    const peer = normalizeImEndpoint(input.peer);
    const runConsumer = createImConsumerAddress(`run:${input.runId}`);
    const cursorLayout = planImCursorLayout(input.stateRoot, peer, self, runConsumer.consumer);
    await this.ports.store.withWriteLock(
      {
        stateRoot: input.stateRoot,
        lockName: cursorLockName(cursorLayout.channel.channelId, cursorLayout.consumer.consumerId),
        purpose: "im-cursor",
      },
      () => this.ports.store.writeText(cursorLayout.cursorFile, input.messageId),
    );
  }

  async readRunBinding(
    stateRoot: string,
    runId: string,
  ): Promise<PublicImRunBindingRecord> {
    const layout = planImRunBindingLayout(stateRoot, runId);
    const binding = await readJsonFile<PublicImRunBindingRecord>(
      this.ports.store,
      layout.bindingFile,
    );
    if (!binding) {
      throw new Error(`IM run binding not found for ${runId}`);
    }
    return binding;
  }

  private async appendMessage(input: {
    stateRoot: string;
    from: string;
    to: string;
    role: PublicImMessageRole;
    kind: PublicImMessageKind;
    text: string;
    metadata?: Record<string, unknown>;
  }): Promise<PublicImMessage> {
    const from = normalizeImEndpoint(input.from);
    const to = normalizeImEndpoint(input.to);
    const pair = await this.createPair({
      stateRoot: input.stateRoot,
      a: from.canonical,
      b: to.canonical,
      kind: "direct",
    });
    const channel = createImDirectionalChannelAddress(from, to);
    const channelLayout = planImChannelLayout(input.stateRoot, from, to);
    const message: PublicImMessage = {
      schemaVersion: PUBLIC_IM_SCHEMA_VERSION,
      id: this.ports.ids.newMessageId(`${from.canonical}->${to.canonical}`),
      pairId: pair.pairId,
      channelId: channel.channelId,
      from: from.canonical,
      to: to.canonical,
      role: input.role,
      kind: input.kind,
      text: input.text,
      createdAt: this.ports.clock.nowIso(),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    await this.ports.store.withWriteLock(
      {
        stateRoot: input.stateRoot,
        lockName: channelLockName(channel.channelId),
        purpose: "im-channel-append",
      },
      async () => {
        await this.ensureChannelMetaUnlocked(input.stateRoot, from, to, pair, message.createdAt);
        await appendJsonlFile(this.ports.store, channelLayout.messagesFile, message);
      },
    );
    return message;
  }

  private async ensureChannelMeta(
    stateRoot: string,
    from: ImEndpoint,
    to: ImEndpoint,
    pair: PublicImPairRecord,
    createdAt: string,
  ): Promise<void> {
    const channel = createImDirectionalChannelAddress(from, to);
    await this.ports.store.withWriteLock(
      {
        stateRoot,
        lockName: channelLockName(channel.channelId),
        purpose: "im-channel-meta",
      },
      () => this.ensureChannelMetaUnlocked(stateRoot, from, to, pair, createdAt),
    );
  }

  private async ensureChannelMetaUnlocked(
    stateRoot: string,
    from: ImEndpoint,
    to: ImEndpoint,
    pair: PublicImPairRecord,
    createdAt: string,
  ): Promise<void> {
    const channel = createImDirectionalChannelAddress(from, to);
    const layout = planImChannelLayout(stateRoot, from, to);
    const existing = await readJsonFile<PublicImChannelMetaRecord>(
      this.ports.store,
      layout.metaFile,
    );
    if (existing) {
      return;
    }
    await writeJsonFile(this.ports.store, layout.metaFile, {
      schemaVersion: PUBLIC_IM_SCHEMA_VERSION,
      pairId: pair.pairId,
      channelId: channel.channelId,
      channelKey: channel.channelKey,
      from: from.canonical,
      to: to.canonical,
      createdAt,
    } satisfies PublicImChannelMetaRecord);
  }
}

function pairLockName(pairId: string): string {
  return `im-pair-${pairId}`;
}

function channelLockName(channelId: string): string {
  return `im-channel-${channelId}`;
}

function runBindingLockName(runId: string): string {
  return `im-run-binding-${runId}`;
}

function cursorLockName(channelId: string, consumerId: string): string {
  return `im-cursor-${channelId}-${consumerId}`;
}

function upsertBinding(
  bindings: PublicImRunBinding[],
  binding: PublicImRunBinding,
): PublicImRunBinding[] {
  const next = bindings.filter(
    (existing) => existing.peer !== binding.peer || existing.kind !== binding.kind,
  );
  next.push(binding);
  return next.sort((left, right) => `${left.kind}:${left.peer}`.localeCompare(`${right.kind}:${right.peer}`));
}

function sliceAfterCursor(
  messages: PublicImMessage[],
  cursor: string | undefined,
): PublicImReceiveResult {
  if (!cursor) {
    return {
      messages,
      nextCursor: messages.length > 0 ? messages[messages.length - 1]!.id : undefined,
    };
  }
  const index = messages.findIndex((message) => message.id === cursor);
  if (index < 0) {
    return { messages: [], nextCursor: cursor, cursorFound: false };
  }
  const next = messages.slice(index + 1);
  return {
    messages: next,
    nextCursor: next.length > 0 ? next[next.length - 1]!.id : cursor,
  };
}
