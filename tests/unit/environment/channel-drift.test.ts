import { describe, it, expect, beforeEach } from "vitest";
import { Environment } from "../../../src/environment/environment.js";
import type { IoWaitRequest, EnvironmentEvent } from "../../../src/types/index.js";

function makeUserMsg(channel: string, text: string): EnvironmentEvent {
  return {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    kind: "user_message_received",
    source: "im",
    timestamp: new Date().toISOString(),
    message: {
      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      channel,
      role: "user",
      text,
      createdAt: new Date().toISOString(),
    },
  };
}

function makeIoWait(channel: string): IoWaitRequest {
  return {
    reason: "test",
    condition: {
      kind: "new_user_message",
      channel,
    },
  };
}

describe("Environment priority-only io_wait compatibility", () => {
  let env: Environment;

  beforeEach(() => {
    env = new Environment();
  });

  it("legacy channel drift does not block priority-based waits", async () => {
    env.setBoundChannel("default");
    const waitReq = makeIoWait("cli");
    const origChannel = waitReq.condition.channel;
    const promise = env.waitFor({ runId: "run-1", wait: waitReq });
    env.appendEvent(makeUserMsg("default", "hello from default"));
    const result = await promise;
    expect(result.message.channel).toBe("default");
    // Original wait object NOT mutated
    expect(waitReq.condition.channel).toBe("cli");
    expect(waitReq.condition.channel).toBe(origChannel);
  });

  it("normal default->default path still works as a priority wait", async () => {
    env.setBoundChannel("default");
    const waitReq = makeIoWait("default");
    const promise = env.waitFor({ runId: "run-2", wait: waitReq });
    env.appendEvent(makeUserMsg("default", "hello"));
    const result = await promise;
    expect(result.message.channel).toBe("default");
    expect(result.message.text).toBe("hello");
  });

  it("without boundChannel, legacy condition.channel still does not filter events", async () => {
    const waitReq = makeIoWait("cli");
    const promise = env.waitFor({ runId: "run-3", wait: waitReq });
    env.appendEvent(makeUserMsg("default", "msg"));
    const result = await promise;
    expect(result.message.channel).toBe("default");
  });

  it("boundChannel=default + wait.channel=cli + no events yet -> waiter registered, wait not mutated", async () => {
    env.setBoundChannel("default");
    const waitReq = makeIoWait("cli");
    const orig = waitReq.condition.channel;
    expect(waitReq.condition.channel).toBe(orig);

    // Call waitFor BEFORE posting event (true future waiter)
    const promise = env.waitFor({ runId: "run-4", wait: waitReq });

    // Yield to microtask queue: promise should NOT be resolved yet
    await new Promise((r) => setTimeout(r, 0));

    // Original wait object must still not be mutated
    expect(waitReq.condition.channel).toBe("cli");

    // Now post the event
    const event = makeUserMsg("default", "late");
    env.appendEvent(event);

    const result = await promise;
    expect(result.message.channel).toBe("default");
    expect(waitReq.condition.channel).toBe("cli");
  });
});
