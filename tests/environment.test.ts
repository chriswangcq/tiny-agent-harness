import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Environment } from "../src/environment/environment.js";
import {
  ENVIRONMENT_EVENT_LEVELS,
  environmentEventLevel,
  ioWaitMinLevel,
  type EnvironmentEvent,
} from "../src/types/environment.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeUserMessageEvent(
  id: string,
  text: string,
  channel = "default",
): EnvironmentEvent {
  const timestamp = "2026-05-25T12:00:00.000Z";
  return {
    id,
    kind: "user_message_received",
    source: "im",
    timestamp,
    message: {
      id: `msg-${id}`,
      channel,
      role: "user",
      text,
      createdAt: timestamp,
    },
  };
}

function makeSessionOutputEvent(id: string): EnvironmentEvent {
  return {
    id,
    kind: "session_output_available",
    source: "session",
    timestamp: "2026-05-25T12:00:00.000Z",
    session: "default",
    currentSession: "default",
    request: "session_observe",
    inputSeq: 1,
    level: ENVIRONMENT_EVENT_LEVELS.NOISE,
  };
}

// ===========================================================================
// Tests
// ===========================================================================

describe("Environment", () => {
  it("appendEvent stores event", () => {
    const env = new Environment();
    const event = makeUserMessageEvent("e1", "hello");

    expect(env.appendEvent(event)).toBe(true);

    expect(env.state.events.length).toBe(1);
    expect(env.state.events[0]).toEqual(event);
    expect(env.state.latestEventId).toBe("e1");
  });

  it("appendEvent returns false for duplicate event ids", () => {
    const env = new Environment();
    const event = makeUserMessageEvent("e1", "hello");

    expect(env.appendEvent(event)).toBe(true);
    expect(env.appendEvent(event)).toBe(false);

    expect(env.state.events).toEqual([event]);
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

  it("waitFor satisfaction does not consume the matched future event", async () => {
    const env = new Environment();

    const promise = env.waitFor({
      runId: "run-1",
      wait: {
        reason: "waiting for user",
        condition: { kind: "new_user_message", channel: "default" },
      },
    });

    const event = makeUserMessageEvent("e1", "deliver me");
    env.appendEvent(event);

    await expect(promise).resolves.toEqual(event);
    expect(env.consumeSince({ runId: "run-1" })).toEqual([event]);
    expect(env.consumeSince({ runId: "run-1" })).toEqual([]);
  });

  it("waitFor uses priority only and ignores legacy user-message channel filters", async () => {
    const env = new Environment();

    const promise = env.waitFor({
      runId: "run-1",
      wait: {
        reason: "waiting for user on default",
        condition: { kind: "new_user_message", channel: "default" },
      },
    });

    const event = makeUserMessageEvent("e-other", "wake even from other", "other");
    env.appendEvent(event);

    await expect(promise).resolves.toEqual(event);
  });

  it("waitFor ignores matching events that existed before registration", async () => {
    const env = new Environment();

    const historical = makeUserMessageEvent("e1", "already here");
    env.appendEvent(historical);

    const promise = env.waitFor({
      runId: "run-1",
      wait: {
        reason: "waiting for user",
        condition: { kind: "new_user_message", channel: "default" },
      },
    });

    const future = makeUserMessageEvent("e2", "new event");
    env.appendEvent(future);

    await expect(promise).resolves.toEqual(future);
  });

  it("waitFor satisfaction does not consume historical or matched future events", async () => {
    const env = new Environment();
    const historical = makeUserMessageEvent("e1", "already here");
    env.appendEvent(historical);

    const promise = env.waitFor({
      runId: "run-1",
      wait: {
        reason: "waiting for user",
        condition: { kind: "new_user_message", channel: "default" },
      },
    });

    const future = makeUserMessageEvent("e2", "future");
    env.appendEvent(future);

    await expect(promise).resolves.toEqual(future);
    expect(env.consumeSince({ runId: "run-1" })).toEqual([historical, future]);
  });

  it("waitFor with no condition wakes on a future meaningful environment event", async () => {
    const env = new Environment();

    const promise = env.waitFor({
      runId: "run-1",
      wait: { reason: "meaningful event" },
    });

    const event = makeUserMessageEvent("e-any", "wake");
    env.appendEvent(event);

    await expect(promise).resolves.toEqual(event);
  });

  it("waitFor with no minLevel ignores low-priority session output noise", async () => {
    const env = new Environment();
    let resolved = false;

    const promise = env
      .waitFor({
        runId: "run-1",
        wait: { reason: "default meaningful event wait" },
      })
      .then((event) => {
        resolved = true;
        return event;
      });

    env.appendEvent(makeSessionOutputEvent("session-low"));
    await Promise.resolve();
    expect(resolved).toBe(false);

    const userEvent = makeUserMessageEvent("e-user", "operator interrupt");
    env.appendEvent(userEvent);

    await expect(promise).resolves.toEqual(userEvent);
  });

  it("waitFor with explicit minLevel 0 still supports any-event waits", async () => {
    const env = new Environment();

    const promise = env.waitFor({
      runId: "run-1",
      wait: { reason: "explicit any event", minLevel: ENVIRONMENT_EVENT_LEVELS.ANY },
    });

    const event = makeSessionOutputEvent("session-low-explicit");
    env.appendEvent(event);

    await expect(promise).resolves.toEqual(event);
  });

  it("waitFor uses the run consume cursor so events arriving during a model turn are not lost", async () => {
    const env = new Environment();
    const initial = makeUserMessageEvent("e-initial", "initial");
    env.appendEvent(initial);
    expect(env.consumeSince({ runId: "run-1" })).toEqual([initial]);

    const duringTurn = makeUserMessageEvent("e-during-turn", "interrupt");
    env.appendEvent(duringTurn);

    await expect(
      env.waitFor({
        runId: "run-1",
        wait: { reason: "wait after model decision" },
      }),
    ).resolves.toEqual(duringTurn);
  });

  it("waitFor still sees model-turn events when the turn began with an empty environment", async () => {
    const env = new Environment();
    expect(env.consumeSince({ runId: "run-1" })).toEqual([]);

    const duringTurn = makeUserMessageEvent("e-during-empty-turn", "interrupt");
    env.appendEvent(duringTurn);

    await expect(
      env.waitFor({
        runId: "run-1",
        wait: { reason: "wait after empty model turn" },
      }),
    ).resolves.toEqual(duringTurn);
  });

  it("waitFor uses minLevel as the only event filter", async () => {
    const env = new Environment();

    const promise = env.waitFor({
      runId: "run-1",
      wait: {
        reason: "important session event",
        condition: { kind: "event", source: "session", minLevel: 10 },
      },
    });

    env.appendEvent({
      id: "session-low",
      kind: "session_output_available",
      source: "session",
      timestamp: "2026-05-25T12:00:00Z",
      session: "default",
      currentSession: "default",
      request: "session_observe",
      inputSeq: 1,
      level: 0,
    });
    const matching: EnvironmentEvent = {
      id: "session-ready",
      kind: "session_input_ready",
      source: "session",
      timestamp: "2026-05-25T12:00:01Z",
      session: "default",
      currentSession: "default",
      request: "session_observe",
      inputSeq: 2,
      level: 10,
    };
    env.appendEvent(matching);

    await expect(promise).resolves.toEqual(matching);
  });

  it("high-priority user messages wake legacy narrow session waits", async () => {
    const env = new Environment();

    const promise = env.waitFor({
      runId: "run-1",
      wait: {
        reason: "legacy narrow session wait",
        condition: {
          kind: "event",
          source: "session",
          eventKind: "session_returned_to_prompt",
          minLevel: 10,
        },
      },
    });

    const userEvent = makeUserMessageEvent("e-user", "operator interrupt");
    env.appendEvent(userEvent);

    await expect(promise).resolves.toEqual(userEvent);
  });

  it("treats user messages as highest-priority environment events", async () => {
    const env = new Environment();

    const promise = env.waitFor({
      runId: "run-1",
      wait: {
        reason: "wake only for high-priority events",
        condition: { kind: "event", minLevel: ENVIRONMENT_EVENT_LEVELS.USER_MESSAGE },
      },
    });

    env.appendEvent({
      id: "session-critical",
      kind: "session_unsynced",
      source: "session",
      timestamp: "2026-05-25T12:00:00Z",
      session: "default",
      currentSession: "default",
      request: "session_observe",
      inputSeq: 1,
      level: 50,
      reason: "prompt_spoof_suspected",
    });

    const userEvent = makeUserMessageEvent("e-user", "operator says continue");
    env.appendEvent(userEvent);

    await expect(promise).resolves.toEqual(userEvent);
  });

  it("normalizes user message levels even when level is missing or too low", () => {
    const userEvent = makeUserMessageEvent("e-user", "hello");
    const lowUserEvent = { ...userEvent, level: 0 };
    const highUserEvent = { ...userEvent, level: 200 };

    expect(environmentEventLevel(userEvent)).toBe(
      ENVIRONMENT_EVENT_LEVELS.USER_MESSAGE,
    );
    expect(environmentEventLevel(lowUserEvent)).toBe(
      ENVIRONMENT_EVENT_LEVELS.USER_MESSAGE,
    );
    expect(environmentEventLevel(highUserEvent)).toBe(200);
  });

  it("defaults io_wait to meaningful events unless minLevel 0 is explicit", () => {
    expect(ioWaitMinLevel({ reason: "default" })).toBe(
      ENVIRONMENT_EVENT_LEVELS.MEANINGFUL,
    );
    expect(ioWaitMinLevel({ reason: "any", minLevel: ENVIRONMENT_EVENT_LEVELS.ANY })).toBe(
      ENVIRONMENT_EVENT_LEVELS.ANY,
    );
    expect(
      ioWaitMinLevel({
        reason: "legacy nested any",
        condition: { kind: "event", minLevel: ENVIRONMENT_EVENT_LEVELS.ANY },
      }),
    ).toBe(ENVIRONMENT_EVENT_LEVELS.ANY);
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
        kind: "skill_run_started",
        source: "skill",
        timestamp: ts,
        skillRunId: "skillrun-123",
        skill: "coding-review",
        statePath: ".tiny-agent/skill-runs/skillrun-123/state.json",
        executionLogPath: ".tiny-agent/skill-runs/skillrun-123/execution.txt",
      },
    ];

    const reminder = Environment.renderReminder(events);

    expect(reminder).toContain("Environment reminder:");
    expect(reminder).toContain("[user@default] continue with option B");
    expect(reminder).toContain("[env-002]");
    expect(reminder).toContain("skill_run_started");
    expect(reminder).toContain("skillrun-123");
    expect(reminder).toContain("coding-review");
  });

  it("renderReminder formats skill events without undefined lines", () => {
    const ts = "2026-05-25T12:00:00Z";
    const events: EnvironmentEvent[] = [
      {
        id: "skill-001",
        kind: "skill_run_started",
        source: "skill",
        timestamp: ts,
        skillRunId: "skillrun-001",
        skill: "coding-review",
        statePath: ".tiny-agent/skill-runs/skillrun-001/state.json",
        executionLogPath: ".tiny-agent/skill-runs/skillrun-001/execution.txt",
      },
      {
        id: "skill-002",
        kind: "skill_review_pending",
        source: "skill",
        timestamp: ts,
        skillRunId: "skillrun-001",
        skill: "coding-review",
        statePath: ".tiny-agent/skill-runs/skillrun-001/state.json",
        reviewTaskPath: ".tiny-agent/skill-runs/skillrun-001/review-task.txt",
      },
      {
        id: "skill-003",
        kind: "skill_review_completed",
        source: "skill",
        timestamp: ts,
        skillRunId: "skillrun-001",
        skill: "coding-review",
        statePath: ".tiny-agent/skill-runs/skillrun-001/state.json",
        lessonsPath: ".tiny-agent/skills/coding-review/attachments/lessons.md",
      },
    ];

    const reminder = Environment.renderReminder(events);

    expect(reminder).toContain("skill_run_started");
    expect(reminder).toContain("skill_review_pending");
    expect(reminder).toContain("skill_review_completed");
    expect(reminder).toContain("skillrun-001");
    expect(reminder).not.toContain("undefined");
  });

  it("renderReminder returns empty string for no events", () => {
    const reminder = Environment.renderReminder([]);
    expect(reminder).toBe("");
  });

  it("waitFor observes events appended by another environment instance through JSONL", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "environment-jsonl-"));
    try {
      const eventsPath = path.join(dir, "events.jsonl");
      const writer = new Environment();
      writer.setEventsPath(eventsPath);
      const reader = new Environment();
      reader.setEventsPath(eventsPath);

      const promise = reader.waitFor({
        runId: "run-reader",
        wait: {
          reason: "wait for skill",
          condition: {
            kind: "event",
            eventKind: "skill_run_started",
            source: "skill",
          },
        },
      });

      const event: EnvironmentEvent = {
        id: "skill-jsonl-001",
        kind: "skill_run_started",
        source: "skill",
        timestamp: "2026-05-25T12:00:00Z",
        skillRunId: "skillrun-001",
        skill: "coding-review",
        statePath: ".tiny-agent/runs/run-1/skill-runs/skillrun-001/state.json",
      };
      writer.appendEvent(event);

      await expect(promise).resolves.toEqual(event);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
