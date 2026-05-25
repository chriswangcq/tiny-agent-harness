import { describe, it, expect, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ViewModelBuilder } from "../src/tui/view-model-builder.js";
import { ImCliTransport } from "../src/im/transport.js";
import type { UserMessage, AgentMessage } from "../src/types/environment.js";

let tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tui-im-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("TUI IM integration", () => {
  it("ViewModelBuilder.addImUserMessage adds user conversation items", () => {
    const builder = new ViewModelBuilder();
    const msg: UserMessage = {
      id: "msg-001",
      channel: "default",
      role: "user",
      text: "hello agent",
      createdAt: "2026-01-01T00:00:00Z",
    };

    builder.addImUserMessage(msg);
    const vm = builder.getViewModel();

    expect(vm.conversation).toHaveLength(1);
    expect(vm.conversation[0]).toMatchObject({
      kind: "user",
      channel: "default",
      text: "hello agent",
    });
  });

  it("ViewModelBuilder.addImUserMessage deduplicates by message id", () => {
    const builder = new ViewModelBuilder();
    const msg: UserMessage = {
      id: "msg-001",
      channel: "default",
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
      channel: "default",
      role: "agent",
      kind: "final",
      text: "done",
      createdAt: "2026-01-01T00:00:01Z",
    };

    builder.addImAgentMessage(msg);
    const vm = builder.getViewModel();

    expect(vm.conversation).toHaveLength(1);
    expect(vm.conversation[0]).toMatchObject({
      kind: "agent",
      text: "done",
      messageKind: "final",
    });
  });

  it("ViewModelBuilder.addImAgentMessage deduplicates", () => {
    const builder = new ViewModelBuilder();
    const msg: AgentMessage = {
      channel: "default",
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

  it("ImCliTransport.receiveSync reads inbox messages", () => {
    const baseDir = makeTmpDir();
    const transport = new ImCliTransport({ baseDir });

    fs.mkdirSync(baseDir, { recursive: true });
    const inboxPath = path.join(baseDir, "default.inbox.jsonl");
    const msgs = [
      { id: "m1", channel: "default", role: "user", text: "first", createdAt: "2026-01-01T00:00:00Z" },
      { id: "m2", channel: "default", role: "user", text: "second", createdAt: "2026-01-01T00:00:01Z" },
    ];
    fs.writeFileSync(inboxPath, msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");

    const result = transport.receiveSync({ channel: "default" });
    expect(result.messages).toHaveLength(2);
    expect(result.nextCursor).toBe("m2");

    const result2 = transport.receiveSync({ channel: "default", cursor: "m2" });
    expect(result2.messages).toHaveLength(0);
  });

  it("ImCliTransport.readOutboxSync reads agent messages", () => {
    const baseDir = makeTmpDir();
    const transport = new ImCliTransport({ baseDir });

    fs.mkdirSync(baseDir, { recursive: true });
    const outboxPath = path.join(baseDir, "default.outbox.jsonl");
    const msgs = [
      { channel: "default", role: "agent", kind: "status", text: "working", createdAt: "2026-01-01T00:00:00Z" },
      { channel: "default", role: "agent", kind: "final", text: "done", createdAt: "2026-01-01T00:00:01Z" },
    ];
    fs.writeFileSync(outboxPath, msgs.map((m) => JSON.stringify(m)).join("\n") + "\n");

    const result = transport.readOutboxSync({ channel: "default" });
    expect(result.messages).toHaveLength(2);
    expect(result.messages[0]!.text).toBe("working");
    expect(result.messages[1]!.text).toBe("done");
  });

  it("full TUI IM loop: post → receiveSync → addImUserMessage → viewModel", async () => {
    const baseDir = makeTmpDir();
    const transport = new ImCliTransport({ baseDir });
    const builder = new ViewModelBuilder();

    await transport.post({
      id: "msg-tui-001",
      channel: "default",
      role: "user",
      text: "fix the tests",
      createdAt: "2026-01-01T00:00:00Z",
    });

    const result = transport.receiveSync({ channel: "default" });
    for (const msg of result.messages) {
      builder.addImUserMessage(msg);
    }

    const vm = builder.getViewModel();
    expect(vm.conversation).toHaveLength(1);
    expect(vm.conversation[0]).toMatchObject({
      kind: "user",
      text: "fix the tests",
      channel: "default",
    });
  });
});
