import { describe, expect, it } from "vitest";
import {
  createImConsumerAddress,
  createImDirectionalChannelAddress,
  createImPairAddress,
  PublicImService,
  createInMemoryImStore,
  planImChannelLayout,
  planImRunBindingLayout,
  readJsonlFile,
  type PublicImMessage,
  type PublicImServicePorts,
} from "../src/im/index.js";

function fakePorts(): PublicImServicePorts & {
  store: ReturnType<typeof createInMemoryImStore>;
} {
  let idCounter = 0;
  let nowCounter = 0;
  return {
    store: createInMemoryImStore(),
    clock: {
      nowIso: () => {
        nowCounter += 1;
        return `2026-06-11T00:00:${String(nowCounter).padStart(2, "0")}.000Z`;
      },
    },
    ids: {
      newMessageId: (seed) => {
        idCounter += 1;
        return `msg-${seed.replace(/[^a-zA-Z0-9]+/g, "-")}-${idCounter}`;
      },
    },
  };
}

describe("PublicImService", () => {
  it("creates pair metadata and binds a run to an a2user pair", async () => {
    const ports = fakePorts();
    const service = new PublicImService(ports);

    const pair = await service.createPair({
      stateRoot: "/state",
      a: "member:team-p6/coder-1",
      b: "user:main",
      kind: "a2user",
    });
    const binding = await service.bindRun({
      stateRoot: "/state",
      runId: "run-123",
      self: "member:team-p6/coder-1",
      peer: "user:main",
      kind: "a2user",
    });

    expect(pair.kind).toBe("a2user");
    expect(binding).toMatchObject({
      runId: "run-123",
      self: "member:team-p6/coder-1",
      bindings: [
        {
          kind: "a2user",
          peer: "user:main",
          pairId: pair.pairId,
        },
      ],
    });
    const layout = planImRunBindingLayout("/state", "run-123");
    expect(ports.store.files.has(layout.bindingFile)).toBe(true);
  });

  it("reads pair messages with non-destructive cursor semantics", async () => {
    const service = new PublicImService(fakePorts());

    const first = await service.postMessage({
      stateRoot: "/state",
      from: "user:main",
      to: "member:team-p6/coder-1",
      text: "first",
    });
    const second = await service.postMessage({
      stateRoot: "/state",
      from: "user:main",
      to: "member:team-p6/coder-1",
      text: "second",
    });

    const initial = await service.receiveForPair({
      stateRoot: "/state",
      as: "member:team-p6/coder-1",
      with: "user:main",
    });
    expect(initial.messages.map((message) => message.text)).toEqual(["first", "second"]);
    expect(initial.nextCursor).toBe(second.id);

    await service.ackPair({
      stateRoot: "/state",
      as: "member:team-p6/coder-1",
      with: "user:main",
      messageId: first.id,
    });

    const afterAck = await service.receiveForPair({
      stateRoot: "/state",
      as: "member:team-p6/coder-1",
      with: "user:main",
    });
    expect(afterAck.messages.map((message) => message.text)).toEqual(["second"]);
    expect(afterAck.nextCursor).toBe(second.id);

    const explicitCursor = await service.receiveForPair({
      stateRoot: "/state",
      as: "member:team-p6/coder-1",
      with: "user:main",
      cursor: first.id,
    });
    expect(explicitCursor.messages.map((message) => message.id)).toEqual([second.id]);
  });

  it("aggregates inbound messages from multiple run bindings", async () => {
    const service = new PublicImService(fakePorts());

    await service.bindRun({
      stateRoot: "/state",
      runId: "run-123",
      self: "member:team-p6/coder-1",
      peer: "user:main",
      kind: "a2user",
    });
    await service.bindRun({
      stateRoot: "/state",
      runId: "run-123",
      self: "member:team-p6/coder-1",
      peer: "member:team-p6/reviewer-1",
      kind: "a2a",
    });
    const userMessage = await service.postMessage({
      stateRoot: "/state",
      from: "user:main",
      to: "member:team-p6/coder-1",
      text: "from user",
    });
    const agentMessage = await service.sendMessage({
      stateRoot: "/state",
      from: "member:team-p6/reviewer-1",
      to: "member:team-p6/coder-1",
      kind: "status",
      text: "from reviewer",
    });

    const result = await service.receiveForRun({ stateRoot: "/state", runId: "run-123" });
    expect(result.self).toBe("member:team-p6/coder-1");
    expect(result.messages.map((message) => message.text)).toEqual([
      "from user",
      "from reviewer",
    ]);
    expect(result.messages.map((message) => message.binding.kind)).toEqual([
      "a2user",
      "a2a",
    ]);

    await service.ackRunChannel({
      stateRoot: "/state",
      runId: "run-123",
      peer: "user:main",
      messageId: userMessage.id,
    });

    const afterAck = await service.receiveForRun({ stateRoot: "/state", runId: "run-123" });
    expect(afterAck.messages.map((message) => message.id)).toEqual([agentMessage.id]);
  });

  it("throws when receiving for an unbound run", async () => {
    const service = new PublicImService(fakePorts());
    await expect(service.receiveForRun({ stateRoot: "/state", runId: "missing" }))
      .rejects
      .toThrow(/IM run binding not found/);
  });

  it("reads channel messages for projection without consuming run cursors", async () => {
    const service = new PublicImService(fakePorts());
    await service.bindRun({
      stateRoot: "/state",
      runId: "run-123",
      self: "run:run-123",
      peer: "user:main",
      kind: "a2user",
    });
    const first = await service.postMessage({
      stateRoot: "/state",
      from: "user:main",
      to: "run:run-123",
      text: "first",
    });
    const second = await service.postMessage({
      stateRoot: "/state",
      from: "user:main",
      to: "run:run-123",
      text: "second",
    });

    const projected = await service.readChannelMessages({
      stateRoot: "/state",
      from: "user:main",
      to: "run:run-123",
      cursor: first.id,
    });
    expect(projected.messages.map((message) => message.id)).toEqual([second.id]);
    expect(projected.nextCursor).toBe(second.id);

    const runReceive = await service.receiveForRun({
      stateRoot: "/state",
      runId: "run-123",
    });
    expect(runReceive.messages.map((message) => message.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("lets projection consumers read independently from run ack cursors", async () => {
    const service = new PublicImService(fakePorts());
    await service.bindRun({
      stateRoot: "/state",
      runId: "run-123",
      self: "run:run-123",
      peer: "user:main",
      kind: "a2user",
    });
    const message = await service.postMessage({
      stateRoot: "/state",
      from: "user:main",
      to: "run:run-123",
      text: "visible to ui",
    });
    await service.ackRunChannel({
      stateRoot: "/state",
      runId: "run-123",
      peer: "user:main",
      messageId: message.id,
    });

    const runConsumerView = await service.receiveForPair({
      stateRoot: "/state",
      as: "run:run-123",
      with: "user:main",
    });
    const uiConsumerView = await service.receiveForPair({
      stateRoot: "/state",
      as: "run:run-123",
      with: "user:main",
      consumer: "ui:project-ui/run-123/user-inbound",
    });

    expect(runConsumerView.messages).toEqual([]);
    expect(uiConsumerView.messages.map((item) => item.id)).toEqual([message.id]);
  });

  it("requests explicit write locks for pair, channel, run binding, and cursor writes", async () => {
    const ports = fakePorts();
    const service = new PublicImService(ports);
    const stateRoot = "/state";
    const runId = "run-123";
    const self = "run:run-123";
    const peer = "user:main";

    await service.bindRun({
      stateRoot,
      runId,
      self,
      peer,
      kind: "a2user",
    });
    const message = await service.postMessage({
      stateRoot,
      from: peer,
      to: self,
      text: "hello",
    });
    await service.ackRunChannel({
      stateRoot,
      runId,
      peer,
      messageId: message.id,
    });

    const pair = createImPairAddress(self, peer);
    const inbound = createImDirectionalChannelAddress(peer, self);
    const runConsumer = createImConsumerAddress(`run:${runId}`);
    const acquired = ports.store.lockEvents
      .filter((event) => event.phase === "acquire")
      .map((event) => `${event.lockName}:${event.purpose}`);

    expect(acquired).toContain(`im-pair-${pair.pairId}:im-pair`);
    expect(acquired).toContain(`im-channel-${inbound.channelId}:im-channel-meta`);
    expect(acquired).toContain(`im-channel-${inbound.channelId}:im-channel-append`);
    expect(acquired).toContain(`im-run-binding-${runId}:im-run-binding`);
    expect(acquired).toContain(
      `im-cursor-${inbound.channelId}-${runConsumer.consumerId}:im-cursor`,
    );
  });

  it("imports explicit messages by merging, sorting, and deduping under the channel lock", async () => {
    const ports = fakePorts();
    const service = new PublicImService(ports);
    const stateRoot = "/state";
    const existing = await service.postMessage({
      stateRoot,
      from: "user:main",
      to: "run:run-123",
      text: "new project message",
    });

    const result = await service.importMessages({
      stateRoot,
      from: "user:main",
      to: "run:run-123",
      messages: [
        {
          id: "legacy-2",
          role: "user",
          kind: "message",
          text: "legacy later",
          createdAt: "2026-06-10T00:00:02.000Z",
        },
        {
          id: "legacy-1",
          role: "user",
          kind: "message",
          text: "legacy earlier",
          createdAt: "2026-06-10T00:00:01.000Z",
        },
        {
          id: existing.id,
          role: "user",
          kind: "message",
          text: "duplicate",
          createdAt: existing.createdAt,
        },
      ],
    });

    const layout = planImChannelLayout(stateRoot, "user:main", "run:run-123");
    const messages = await readJsonlFile<PublicImMessage>(
      ports.store,
      layout.messagesFile,
    );

    expect(result.importedIds).toEqual(["legacy-2", "legacy-1"]);
    expect(result.duplicateIds).toEqual([existing.id]);
    expect(messages.map((message) => message.id)).toEqual([
      "legacy-1",
      "legacy-2",
      existing.id,
    ]);
    expect(
      ports.store.lockEvents
        .filter((event) => event.phase === "acquire")
        .map((event) => `${event.lockName}:${event.purpose}`),
    ).toContain(`im-channel-${layout.channel.channelId}:im-channel-import`);
  });
});
