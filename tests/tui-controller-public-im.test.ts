import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  PublicImService,
  createInMemoryImStore,
  type PublicImServicePorts,
} from "../src/im/index.js";
import {
  TuiController,
  type TuiRendererPort,
  type TuiSessionLogPort,
} from "../src/tui/controller.js";
import type { TuiKey, TuiViewModel } from "../src/tui/types.js";

class FakeRenderer implements TuiRendererPort {
  keyHandler: ((key: TuiKey) => void) | undefined;
  messageHandler: ((text: string) => void) | undefined;
  renders: TuiViewModel[] = [];
  closed = false;

  render(view: TuiViewModel): void {
    this.renders.push(view);
  }

  onKey(handler: (key: TuiKey) => void): void {
    this.keyHandler = handler;
  }

  onMessage(handler: (text: string) => void): void {
    this.messageHandler = handler;
  }

  close(): void {
    this.closed = true;
  }
}

const emptySessionLogs: TuiSessionLogPort = {
  async read() {
    return [];
  },
  dispose() {},
};

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

function makeRunDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tui-controller-im-"));
}

function makeController(input: {
  runDir: string;
  service: PublicImService;
  renderer?: FakeRenderer;
}): { controller: TuiController; renderer: FakeRenderer } {
  const renderer = input.renderer ?? new FakeRenderer();
  return {
    renderer,
    controller: new TuiController({
      runDir: input.runDir,
      stateRoot: "/state",
      runId: "run-123",
      imService: input.service,
      renderer,
      sessionLogs: emptySessionLogs,
    }),
  };
}

let tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe("TuiController public IM behavior", () => {
  it("posts TUI user input to the public user-to-run channel", async () => {
    const runDir = makeRunDir();
    tmpDirs.push(runDir);
    const service = new PublicImService(fakePorts());
    const { controller } = makeController({ runDir, service });

    await controller.submitUserMessage("hello from tui");

    const projected = await service.readChannelMessages({
      stateRoot: "/state",
      from: "user:main",
      to: "run:run-123",
    });
    expect(projected.messages).toHaveLength(1);
    expect(projected.messages[0]).toMatchObject({
      role: "user",
      text: "hello from tui",
      from: "user:main",
      to: "run:run-123",
    });
  });

  it("projects public user and agent messages with controller-owned cursors", async () => {
    const runDir = makeRunDir();
    tmpDirs.push(runDir);
    const service = new PublicImService(fakePorts());
    const { controller, renderer } = makeController({ runDir, service });

    const userMessage = await service.postMessage({
      stateRoot: "/state",
      from: "user:main",
      to: "run:run-123",
      text: "new task",
    });
    const agentMessage = await service.sendMessage({
      stateRoot: "/state",
      from: "run:run-123",
      to: "user:main",
      kind: "status",
      text: "working",
    });

    await controller.pollOnce();
    await controller.pollOnce();

    const latest = renderer.renders.at(-1)!;
    expect(latest.conversation.map((item) => item.text)).toEqual([
      "new task",
      "working",
    ]);
    expect(latest.conversation.map((item) => item.id)).toEqual([
      `user:${userMessage.id}`,
      `agent:${agentMessage.id}`,
    ]);
  });
});
