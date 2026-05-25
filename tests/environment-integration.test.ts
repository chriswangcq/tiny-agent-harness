import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Environment } from "../src/environment/environment.js";
import { ImCliTransport } from "../src/im/transport.js";
import type { EnvironmentEvent, IoWaitRequest } from "../src/types/environment.js";
import type { UserMessage } from "../src/types/environment.js";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "env-integration-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

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
        id: "env-002",
        kind: "session_state_changed",
        source: "bash",
        timestamp: "2026-05-25T12:00:03Z",
        session: "server",
        previousState: "running",
        nextState: "idle",
      },
      {
        id: "env-003",
        kind: "command_finished",
        source: "bash",
        timestamp: "2026-05-25T12:00:04Z",
        session: "test",
        commandId: "cmd-123",
        returnCode: 1,
        outputLogPath: ".tiny-agent/sessions/test.log",
      },
      {
        id: "env-004",
        kind: "command_timed_out",
        source: "bash",
        timestamp: "2026-05-25T12:00:05Z",
        session: "build",
        commandId: "cmd-456",
        outputLogPath: ".tiny-agent/sessions/build.log",
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
    expect(reminder).toContain("user_message_received");
    expect(reminder).toContain('channel=default');
    expect(reminder).toContain("continue with option B");
    expect(reminder).toContain("session_state_changed");
    expect(reminder).toContain("running -> idle");
    expect(reminder).toContain("command_finished");
    expect(reminder).toContain("rc=1");
    expect(reminder).toContain("command_timed_out");
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
      kind: "command_finished",
      source: "bash",
      timestamp: "2026-01-01T00:00:00Z",
      session: "s",
      commandId: "c1",
      returnCode: 0,
      outputLogPath: "log",
    };
    const evt2: EnvironmentEvent = {
      id: "e2",
      kind: "command_finished",
      source: "bash",
      timestamp: "2026-01-01T00:00:01Z",
      session: "s",
      commandId: "c2",
      returnCode: 0,
      outputLogPath: "log",
    };

    env.appendEvent(evt1);
    env.appendEvent(evt2);

    const first = env.consumeSince({ runId: "run-1" });
    expect(first).toHaveLength(2);

    const second = env.consumeSince({ runId: "run-1" });
    expect(second).toHaveLength(0);
  });

  it("waitFor resolves immediately when matching event already exists", async () => {
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

    const result = await env.waitFor({
      runId: "run-1",
      wait: {
        condition: { kind: "new_user_message", channel: "default" },
      },
    });
    expect(result.id).toBe("e-im-1");
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
    const baseDir = makeTmpDir();
    const transport = new ImCliTransport({ baseDir });
    const env = new Environment();

    await transport.post({
      id: "msg-001",
      channel: "default",
      role: "user",
      text: "fix the bug",
      createdAt: "2026-01-01T00:00:00Z",
    });
    await transport.post({
      id: "msg-002",
      channel: "default",
      role: "user",
      text: "also add tests",
      createdAt: "2026-01-01T00:00:01Z",
    });

    const result = await transport.receive({ channel: "default" });
    for (const msg of result.messages) {
      env.appendEvent({
        id: `env-im-${msg.id}`,
        kind: "user_message_received",
        source: "im",
        timestamp: msg.createdAt,
        message: msg,
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
    const baseDir = makeTmpDir();
    const transport = new ImCliTransport({ baseDir });
    const env = new Environment();

    const waitPromise = env.waitFor({
      runId: "run-1",
      wait: {
        reason: "need user input",
        condition: { kind: "new_user_message", channel: "default" },
      },
    });

    setTimeout(async () => {
      await transport.post({
        id: "msg-003",
        channel: "default",
        role: "user",
        text: "go ahead",
        createdAt: "2026-01-01T00:00:02Z",
      });

      const result = await transport.receive({ channel: "default" });
      for (const msg of result.messages) {
        env.appendEvent({
          id: `env-im-${msg.id}`,
          kind: "user_message_received",
          source: "im",
          timestamp: msg.createdAt,
          message: msg,
        });
      }
    }, 50);

    const event = await waitPromise;
    expect(event.kind).toBe("user_message_received");
    expect((event as any).message.text).toBe("go ahead");
  });
});
