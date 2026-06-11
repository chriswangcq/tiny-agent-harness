import { describe, expect, it } from "vitest";
import {
  PublicImService,
  createInMemoryImStore,
  type PublicImMessage,
  type PublicImServicePorts,
} from "../src/im/index.js";
import type { AgentMessage, UserMessage } from "../src/types/environment.js";
import { ViewModelBuilder } from "../src/tui/view-model-builder.js";

function fakePorts(): PublicImServicePorts {
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

function toUserMessage(message: PublicImMessage): UserMessage {
  return {
    id: message.id,
    channel: message.channelId,
    role: "user",
    text: message.text,
    createdAt: message.createdAt,
    metadata: { from: message.from, to: message.to },
  };
}

function toAgentMessage(message: PublicImMessage): AgentMessage {
  return {
    id: message.id,
    channel: message.channelId,
    role: "agent",
    kind: message.kind === "error" ? "error" : "status",
    text: message.text,
    createdAt: message.createdAt,
    metadata: { from: message.from, to: message.to },
  };
}

describe("TUI IM integration", () => {
  it("ViewModelBuilder.addImUserMessage adds user conversation items", () => {
    const builder = new ViewModelBuilder();
    const msg: UserMessage = {
      id: "msg-001",
      channel: "public-user-channel",
      role: "user",
      text: "hello agent",
      createdAt: "2026-01-01T00:00:00Z",
    };

    builder.addImUserMessage(msg);
    const vm = builder.getViewModel();

    expect(vm.conversation).toHaveLength(1);
    expect(vm.conversation[0]).toMatchObject({
      kind: "user",
      channel: "public-user-channel",
      text: "hello agent",
    });
  });

  it("ViewModelBuilder.addImUserMessage deduplicates by message id", () => {
    const builder = new ViewModelBuilder();
    const msg: UserMessage = {
      id: "msg-001",
      channel: "public-user-channel",
      role: "user",
      text: "hello",
      createdAt: "2026-01-01T00:00:00Z",
    };

    builder.addImUserMessage(msg);
    builder.addImUserMessage(msg);
    const vm = builder.getViewModel();

    expect(vm.conversation).toHaveLength(1);
  });

  it("ViewModelBuilder.addImAgentMessage adds agent conversation items", () => {
    const builder = new ViewModelBuilder();
    const msg: AgentMessage = {
      id: "agent-1",
      channel: "public-agent-channel",
      role: "agent",
      kind: "status",
      text: "done",
      createdAt: "2026-01-01T00:00:01Z",
    };

    builder.addImAgentMessage(msg);
    const vm = builder.getViewModel();

    expect(vm.conversation).toHaveLength(1);
    expect(vm.conversation[0]).toMatchObject({
      kind: "agent",
      text: "done",
      messageKind: "status",
    });
  });

  it("ViewModelBuilder.addImAgentMessage deduplicates", () => {
    const builder = new ViewModelBuilder();
    const msg: AgentMessage = {
      id: "agent-1",
      channel: "public-agent-channel",
      role: "agent",
      kind: "status",
      text: "working...",
      createdAt: "2026-01-01T00:00:01Z",
    };

    builder.addImAgentMessage(msg);
    builder.addImAgentMessage(msg);
    const vm = builder.getViewModel();

    expect(vm.conversation).toHaveLength(1);
  });

  it("projects public user channel messages into the TUI view model", async () => {
    const service = new PublicImService(fakePorts());
    const builder = new ViewModelBuilder();

    await service.postMessage({
      stateRoot: "/state",
      from: "user:main",
      to: "run:run-123",
      text: "fix the tests",
    });
    const result = await service.readChannelMessages({
      stateRoot: "/state",
      from: "user:main",
      to: "run:run-123",
    });
    for (const message of result.messages) {
      builder.addImUserMessage(toUserMessage(message));
    }

    const vm = builder.getViewModel();
    expect(vm.conversation).toHaveLength(1);
    expect(vm.conversation[0]).toMatchObject({
      kind: "user",
      text: "fix the tests",
    });
  });

  it("projects public agent channel messages into the TUI view model", async () => {
    const service = new PublicImService(fakePorts());
    const builder = new ViewModelBuilder();

    await service.sendMessage({
      stateRoot: "/state",
      from: "run:run-123",
      to: "user:main",
      kind: "status",
      text: "done",
    });
    const result = await service.readChannelMessages({
      stateRoot: "/state",
      from: "run:run-123",
      to: "user:main",
    });
    for (const message of result.messages) {
      builder.addImAgentMessage(toAgentMessage(message));
    }

    const vm = builder.getViewModel();
    expect(vm.conversation).toHaveLength(1);
    expect(vm.conversation[0]).toMatchObject({
      kind: "agent",
      text: "done",
      messageKind: "status",
    });
  });
});
