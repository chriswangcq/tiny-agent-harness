import { describe, it, expect } from "vitest";
import { Environment } from "../src/environment/environment.js";
import type { EnvironmentEvent } from "../src/types/environment.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserMessageEvent(id: string, text: string): EnvironmentEvent {
  return {
    id,
    kind: "user_message_received",
    source: "im",
    timestamp: new Date().toISOString(),
    message: {
      id: `msg-${id}`,
      channel: "default",
      role: "user",
      text,
      createdAt: new Date().toISOString(),
    },
  };
}

function makeCommandFinishedEvent(id: string, session: string): EnvironmentEvent {
  return {
    id,
    kind: "command_finished",
    source: "bash",
    timestamp: new Date().toISOString(),
    session,
    commandId: `cmd-${id}`,
    returnCode: 0,
    outputLogPath: `.tiny-agent/sessions/${session}.log`,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Environment", () => {
  it("appendEvent stores event", () => {
    const env = new Environment();
    const event = makeUserMessageEvent("e1", "hello");

    env.appendEvent(event);

    expect(env.state.events.length).toBe(1);
    expect(env.state.events[0]).toEqual(event);
    expect(env.state.latestEventId).toBe("e1");
  });

  it("consumeSince returns new events", () => {
    const env = new Environment();
    const e1 = makeUserMessageEvent("e1", "hello");
    const e2 = makeUserMessageEvent("e2", "world");

    env.appendEvent(e1);
    env.appendEvent(e2);

    const first = env.consumeSince({ runId: "run-1" });
    expect(first).toEqual([e1, e2]);

    // Second call should return empty — cursor has advanced past both events
    const second = env.consumeSince({ runId: "run-1" });
    expect(second).toEqual([]);
  });

  it("consumeSince with cursor returns only new events", () => {
    const env = new Environment();
    const e1 = makeUserMessageEvent("e1", "first");
    const e2 = makeUserMessageEvent("e2", "second");
    const e3 = makeUserMessageEvent("e3", "third");

    env.appendEvent(e1);
    env.appendEvent(e2);

    // Consume first two events
    const batch1 = env.consumeSince({ runId: "run-1" });
    expect(batch1).toEqual([e1, e2]);

    // Append a third event
    env.appendEvent(e3);

    // consumeSince should return only the new event
    const batch2 = env.consumeSince({ runId: "run-1" });
    expect(batch2).toEqual([e3]);
  });

  it("waitFor resolves on matching event", async () => {
    const env = new Environment();

    const promise = env.waitFor({
      runId: "run-1",
      wait: {
        reason: "waiting for user",
        condition: { kind: "new_user_message", channel: "default" },
      },
    });

    // Append a matching event after waitFor is called
    const event = makeUserMessageEvent("e1", "hello");
    env.appendEvent(event);

    const resolved = await promise;
    expect(resolved).toEqual(event);
  });

  it("waitFor resolves immediately if matching event exists", async () => {
    const env = new Environment();

    // Append a matching event before calling waitFor
    const event = makeUserMessageEvent("e1", "already here");
    env.appendEvent(event);

    const resolved = await env.waitFor({
      runId: "run-1",
      wait: {
        reason: "waiting for user",
        condition: { kind: "new_user_message", channel: "default" },
      },
    });

    expect(resolved).toEqual(event);
  });

  it("renderReminder formats events", () => {
    const ts = "2026-05-25T12:00:00Z";
    const events: EnvironmentEvent[] = [
      {
        id: "env-001",
        kind: "user_message_received",
        source: "im",
        timestamp: ts,
        message: {
          id: "msg-001",
          channel: "default",
          role: "user",
          text: "continue with option B",
          createdAt: ts,
        },
      },
      {
        id: "env-002",
        kind: "command_finished",
        source: "bash",
        timestamp: ts,
        session: "test",
        commandId: "cmd-123",
        returnCode: 1,
        outputLogPath: ".tiny-agent/sessions/test.log",
      },
    ];

    const reminder = Environment.renderReminder(events);

    expect(reminder).toContain("Environment reminder:");
    expect(reminder).toContain("[env-001]");
    expect(reminder).toContain("user_message_received");
    expect(reminder).toContain("continue with option B");
    expect(reminder).toContain("[env-002]");
    expect(reminder).toContain("command_finished");
    expect(reminder).toContain("rc=1");
    expect(reminder).toContain("cmd-123");
  });

  it("renderReminder returns empty string for no events", () => {
    const reminder = Environment.renderReminder([]);
    expect(reminder).toBe("");
  });
});
