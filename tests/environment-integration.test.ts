import { describe, it, expect } from "vitest";
import { Environment } from "../src/environment/environment.js";
import {
  PublicImService,
  createInMemoryImStore,
  type PublicImMessage,
  type PublicImServicePorts,
} from "../src/im/index.js";
import type { EnvironmentEvent } from "../src/types/environment.js";
import type { UserMessage } from "../src/types/environment.js";

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

function toEnvironmentUserMessage(message: PublicImMessage): UserMessage {
  return {
    id: message.id,
    channel: message.channelId,
    role: "user",
    text: message.text,
    createdAt: message.createdAt,
    metadata: {
      from: message.from,
      to: message.to,
      pairId: message.pairId,
    },
  };
}

describe("Environment reminder rendering", () => {
  it("renderReminder produces correct format for all event kinds", () => {
    const events: EnvironmentEvent[] = [
      {
        id: "env-001",
        kind: "user_message_received",
        source: "im",
        timestamp: "2026-05-25T12:00:00Z",
        message: {
          id: "msg-001",
          channel: "default",
          role: "user",
          text: "continue with option B",
          createdAt: "2026-05-25T12:00:00Z",
        },
      },
      {
        id: "env-005",
        kind: "skill_run_started",
        source: "skill",
        timestamp: "2026-05-25T12:00:06Z",
        skillRunId: "sr-001",
        skill: "review",
        statePath: ".tiny-agent/skill-runs/sr-001/state.json",
        executionLogPath: ".tiny-agent/skill-runs/sr-001/execution.txt",
      },
    ];

    const reminder = Environment.renderReminder(events);

    expect(reminder).toContain("Environment reminder:");
    expect(reminder).toContain("[user@default] continue with option B");
    expect(reminder).toContain("skill_run_started");
    expect(reminder).toContain("sr-001");
  });

  it("renderReminder returns empty string for no events", () => {
    expect(Environment.renderReminder([])).toBe("");
  });
});

describe("Environment consumeSince + waitFor closed loop", () => {
  it("consumeSince returns events and advances cursor", () => {
    const env = new Environment();
    const evt1: EnvironmentEvent = {
      id: "e1",
      kind: "skill_run_started",
      source: "skill",
      timestamp: "2026-01-01T00:00:00Z",
      skillRunId: "sr-1",
      skill: "review",
      statePath: "state-1.json",
    };
    const evt2: EnvironmentEvent = {
      id: "e2",
      kind: "skill_run_closed",
      source: "skill",
      timestamp: "2026-01-01T00:00:01Z",
      skillRunId: "sr-1",
      skill: "review",
      statePath: "state-1.json",
    };

    env.appendEvent(evt1);
    env.appendEvent(evt2);

    const first = env.consumeSince({ runId: "run-1" });
    expect(first).toHaveLength(2);

    const second = env.consumeSince({ runId: "run-1" });
    expect(second).toHaveLength(0);
  });

  it("waitFor ignores matching events that already exist unless a future event arrives", async () => {
    const env = new Environment();
    const msg: UserMessage = {
      id: "msg-1",
      channel: "default",
      role: "user",
      text: "hello",
      createdAt: "2026-01-01T00:00:00Z",
    };
    const evt: EnvironmentEvent = {
      id: "e-im-1",
      kind: "user_message_received",
      source: "im",
      timestamp: "2026-01-01T00:00:00Z",
      message: msg,
    };

    env.appendEvent(evt);

    const waitPromise = env.waitFor({
      runId: "run-1",
      wait: {
        condition: { kind: "new_user_message", channel: "default" },
      },
    });
    env.appendEvent({
      ...evt,
      id: "e-im-2",
      message: { ...msg, id: "msg-2", text: "future" },
    });
    const result = await waitPromise;
    expect(result.id).toBe("e-im-2");
  });

  it("waitFor resolves when a future event arrives", async () => {
    const env = new Environment();

    const waitPromise = env.waitFor({
      runId: "run-1",
      wait: {
        condition: { kind: "new_user_message", channel: "test" },
      },
    });

    setTimeout(() => {
      env.appendEvent({
        id: "e-im-2",
        kind: "user_message_received",
        source: "im",
        timestamp: "2026-01-01T00:00:01Z",
        message: {
          id: "msg-2",
          channel: "test",
          role: "user",
          text: "delayed",
          createdAt: "2026-01-01T00:00:01Z",
        },
      });
    }, 50);

    const result = await waitPromise;
    expect(result.id).toBe("e-im-2");
  });
});

describe("IM → Environment bridge", () => {
  it("posted IM messages become environment events", async () => {
    const service = new PublicImService(fakePorts());
    const env = new Environment();

    await service.postMessage({
      stateRoot: "/state",
      from: "user:main",
      to: "run:run-1",
      text: "fix the bug",
    });
    await service.postMessage({
      stateRoot: "/state",
      from: "user:main",
      to: "run:run-1",
      text: "also add tests",
    });

    const result = await service.readChannelMessages({
      stateRoot: "/state",
      from: "user:main",
      to: "run:run-1",
    });
    for (const msg of result.messages) {
      env.appendEvent({
        id: `env-im-${msg.id}`,
        kind: "user_message_received",
        source: "im",
        timestamp: msg.createdAt,
        message: toEnvironmentUserMessage(msg),
      });
    }

    const consumed = env.consumeSince({ runId: "run-1" });
    expect(consumed).toHaveLength(2);
    expect(consumed[0]!.kind).toBe("user_message_received");
    expect((consumed[0] as any).message.text).toBe("fix the bug");
    expect(consumed[1]!.kind).toBe("user_message_received");
    expect((consumed[1] as any).message.text).toBe("also add tests");

    const reminder = Environment.renderReminder(consumed);
    expect(reminder).toContain("fix the bug");
    expect(reminder).toContain("also add tests");
  });

  it("IM bridge + waitFor resolves io_wait for new_user_message", async () => {
    const service = new PublicImService(fakePorts());
    const env = new Environment();

    const waitPromise = env.waitFor({
      runId: "run-1",
      wait: {
        reason: "need user input",
        condition: { kind: "new_user_message", channel: "default" },
      },
    });

    setTimeout(async () => {
      await service.postMessage({
        stateRoot: "/state",
        from: "user:main",
        to: "run:run-1",
        text: "go ahead",
      });

      const result = await service.readChannelMessages({
        stateRoot: "/state",
        from: "user:main",
        to: "run:run-1",
      });
      for (const msg of result.messages) {
        env.appendEvent({
          id: `env-im-${msg.id}`,
          kind: "user_message_received",
          source: "im",
          timestamp: msg.createdAt,
          message: toEnvironmentUserMessage(msg),
        });
      }
    }, 50);

    const event = await waitPromise;
    expect(event.kind).toBe("user_message_received");
    expect((event as any).message.text).toBe("go ahead");
  });
});
