import { describe, expect, it } from "vitest";
import {
  createImConsumerAddress,
  createImDirectionalChannelAddress,
  createImPairAddress,
  PublicImService,
  createInMemoryImStore,
  planImRunBindingLayout,
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
});
