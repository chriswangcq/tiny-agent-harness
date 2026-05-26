import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ImCliTransport } from "../src/im/transport.js";
import type { AgentMessage, UserMessage } from "../src/types/environment.js";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "im-transport-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

function makeUserMessage(id: string, text: string, channel = "default"): UserMessage {
  return {
    id,
    channel,
    role: "user",
    text,
    createdAt: "2026-05-25T12:00:00.000Z",
  };
}

function makeAgentMessage(channel = "default"): AgentMessage {
  return {
    channel,
    role: "agent",
    kind: "status",
    text: "done",
    runId: "run-001",
    createdAt: "2026-05-25T12:00:01.000Z",
  };
}

function readJsonl(filePath: string): unknown[] {
  return fs
    .readFileSync(filePath, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as unknown);
}

describe("ImCliTransport", () => {
  it("post appends user messages and receive returns them with nextCursor", async () => {
    const baseDir = makeTmpDir();
    const transport = new ImCliTransport({ baseDir });
    const first = makeUserMessage("msg-1", "hello");
    const second = makeUserMessage("msg-2", "continue");

    await transport.post(first);
    await transport.post(second);

    await expect(transport.receive({ channel: "default" })).resolves.toEqual({
      messages: [first, second],
      nextCursor: "msg-2",
    });
    expect(readJsonl(path.join(baseDir, "default.inbox.jsonl"))).toEqual([
      first,
      second,
    ]);
  });

  it("receive filters messages after the supplied cursor", async () => {
    const baseDir = makeTmpDir();
    const transport = new ImCliTransport({ baseDir });
    const first = makeUserMessage("msg-1", "first");
    const second = makeUserMessage("msg-2", "second");
    const third = makeUserMessage("msg-3", "third");

    await transport.post(first);
    await transport.post(second);
    await transport.post(third);

    await expect(
      transport.receive({ channel: "default", cursor: "msg-1" }),
    ).resolves.toEqual({
      messages: [second, third],
      nextCursor: "msg-3",
    });
    await expect(
      transport.receive({ channel: "default", cursor: "msg-3" }),
    ).resolves.toEqual({
      messages: [],
      nextCursor: "msg-3",
    });
  });

  it("receive returns all messages when the supplied cursor is unknown", async () => {
    const baseDir = makeTmpDir();
    const transport = new ImCliTransport({ baseDir });
    const message = makeUserMessage("msg-1", "first");
    await transport.post(message);

    await expect(
      transport.receive({ channel: "default", cursor: "missing" }),
    ).resolves.toEqual({
      messages: [message],
      nextCursor: "msg-1",
    });
  });

  it("receive returns an empty batch for a missing inbox", async () => {
    const transport = new ImCliTransport({ baseDir: makeTmpDir() });

    await expect(transport.receive({ channel: "default" })).resolves.toEqual({
      messages: [],
      nextCursor: undefined,
    });
  });

  it("send appends agent messages to the outbox", async () => {
    const baseDir = makeTmpDir();
    const transport = new ImCliTransport({ baseDir });
    const message = makeAgentMessage();

    await transport.send(message);

    expect(readJsonl(path.join(baseDir, "default.outbox.jsonl"))).toEqual([
      message,
    ]);
  });

  it("ack writes the channel cursor", async () => {
    const baseDir = makeTmpDir();
    const transport = new ImCliTransport({ baseDir });

    await transport.ack({ channel: "default", messageId: "msg-42" });

    expect(
      fs.readFileSync(path.join(baseDir, "cursors", "default.cursor"), "utf-8"),
    ).toBe("msg-42");
  });

  it("pollNewMessages returns the receive message list", async () => {
    const baseDir = makeTmpDir();
    const transport = new ImCliTransport({ baseDir });
    const first = makeUserMessage("msg-1", "first");
    const second = makeUserMessage("msg-2", "second");
    await transport.post(first);
    await transport.post(second);

    await expect(
      transport.pollNewMessages({ channel: "default", cursor: "msg-1" }),
    ).resolves.toEqual([second]);
  });

  it("skips malformed JSONL lines and preserves valid messages", async () => {
    const baseDir = makeTmpDir();
    const inboxPath = path.join(baseDir, "default.inbox.jsonl");
    fs.mkdirSync(baseDir, { recursive: true });
    const valid = makeUserMessage("msg-1", "valid");
    fs.writeFileSync(
      inboxPath,
      `not-json\n${JSON.stringify(valid)}\n{\"unterminated\"\n`,
      "utf-8",
    );

    await expect(new ImCliTransport({ baseDir }).receive({ channel: "default" }))
      .resolves.toEqual({
        messages: [valid],
        nextCursor: "msg-1",
      });
  });

  it("keeps channels isolated", async () => {
    const baseDir = makeTmpDir();
    const transport = new ImCliTransport({ baseDir });
    const defaultMessage = makeUserMessage("msg-default", "default", "default");
    const opsMessage = makeUserMessage("msg-ops", "ops", "ops");

    await transport.post(defaultMessage);
    await transport.post(opsMessage);

    await expect(transport.receive({ channel: "default" })).resolves.toEqual({
      messages: [defaultMessage],
      nextCursor: "msg-default",
    });
    await expect(transport.receive({ channel: "ops" })).resolves.toEqual({
      messages: [opsMessage],
      nextCursor: "msg-ops",
    });
  });
});
