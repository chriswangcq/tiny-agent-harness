import { describe, expect, it } from "vitest";
import {
  PublicImService,
  createInMemoryImStore,
  type PublicImServicePorts,
} from "../src/im/index.js";
import {
  DEFAULT_RUN_USER_ENDPOINT,
  ackPublicRunUserMessage,
  createRunImSelfEndpoint,
  ensureDefaultRunImBinding,
  receivePublicRunIm,
  receivePublicRunUserMessages,
  resolveRunImEndpoints,
  selectUserPeerMessages,
} from "../src/cli/run-im.js";

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

describe("public run IM adapter", () => {
  it("derives default run and user endpoints", () => {
    expect(createRunImSelfEndpoint("run-123")).toBe("run:run-123");
    expect(resolveRunImEndpoints({ runId: "run-123" })).toEqual({
      selfEndpoint: "run:run-123",
      userEndpoint: DEFAULT_RUN_USER_ENDPOINT,
    });
  });

  it("binds the default run a2user pair", async () => {
    const service = new PublicImService(fakePorts());

    const binding = await ensureDefaultRunImBinding({
      service,
      stateRoot: "/state",
      runId: "run-123",
    });

    expect(binding).toMatchObject({
      runId: "run-123",
      self: "run:run-123",
      bindings: [
        {
          kind: "a2user",
          peer: "user:main",
        },
      ],
    });
  });

  it("receives all run messages but selects only user-peer messages", async () => {
    const service = new PublicImService(fakePorts());
    await ensureDefaultRunImBinding({ service, stateRoot: "/state", runId: "run-123" });
    await service.bindRun({
      stateRoot: "/state",
      runId: "run-123",
      self: "run:run-123",
      peer: "member:team-p6/reviewer-1",
      kind: "a2a",
    });

    const userMessage = await service.postMessage({
      stateRoot: "/state",
      from: "user:main",
      to: "run:run-123",
      text: "start task",
    });
    await service.sendMessage({
      stateRoot: "/state",
      from: "member:team-p6/reviewer-1",
      to: "run:run-123",
      kind: "status",
      text: "review note",
    });

    const all = await receivePublicRunIm({ service, stateRoot: "/state", runId: "run-123" });
    expect(all.messages.map((message) => message.text)).toEqual([
      "start task",
      "review note",
    ]);
    expect(selectUserPeerMessages(all).map((message) => message.id)).toEqual([
      userMessage.id,
    ]);
    await expect(
      receivePublicRunUserMessages({ service, stateRoot: "/state", runId: "run-123" }),
    ).resolves.toMatchObject([{ id: userMessage.id }]);
  });

  it("acks only the default user peer channel", async () => {
    const service = new PublicImService(fakePorts());
    await ensureDefaultRunImBinding({ service, stateRoot: "/state", runId: "run-123" });
    await service.bindRun({
      stateRoot: "/state",
      runId: "run-123",
      self: "run:run-123",
      peer: "member:team-p6/reviewer-1",
      kind: "a2a",
    });
    const userMessage = await service.postMessage({
      stateRoot: "/state",
      from: "user:main",
      to: "run:run-123",
      text: "start task",
    });
    const reviewerMessage = await service.sendMessage({
      stateRoot: "/state",
      from: "member:team-p6/reviewer-1",
      to: "run:run-123",
      kind: "status",
      text: "review note",
    });

    await ackPublicRunUserMessage({
      service,
      stateRoot: "/state",
      runId: "run-123",
      messageId: userMessage.id,
    });

    const all = await receivePublicRunIm({ service, stateRoot: "/state", runId: "run-123" });
    expect(all.messages.map((message) => message.id)).toEqual([reviewerMessage.id]);
  });
});
