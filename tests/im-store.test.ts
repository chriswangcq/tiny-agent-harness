import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createInMemoryImStore, createNodeImStore, readJsonlFile } from "../src/im/index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tiny-agent-im-store-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("createNodeImStore", () => {
  it("creates and releases directory locks under the explicit state root", async () => {
    const stateRoot = makeTempDir();
    const store = createNodeImStore();
    const lockName = "im-channel-test";
    const lockDir = path.join(stateRoot, "locks", `${lockName}.lock`);

    await store.withWriteLock(
      { stateRoot, lockName, purpose: "im-channel-append" },
      async () => {
        expect(fs.existsSync(lockDir)).toBe(true);
        expect(fs.existsSync(path.join(lockDir, "owner.json"))).toBe(true);
      },
    );

    expect(fs.existsSync(lockDir)).toBe(false);
  });

  it("serializes competing lock holders for the same lock name", async () => {
    const stateRoot = makeTempDir();
    const store = createNodeImStore();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;

    const first = store.withWriteLock(
      { stateRoot, lockName: "im-run-binding-run-1", purpose: "first" },
      async () => {
        order.push("first-start");
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        order.push("first-end");
      },
    );

    await waitFor(() => order.includes("first-start"));

    const second = store.withWriteLock(
      { stateRoot, lockName: "im-run-binding-run-1", purpose: "second" },
      async () => {
        order.push("second");
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(order).toEqual(["first-start"]);

    releaseFirst?.();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("writes text atomically without leaving successful temp files", async () => {
    const stateRoot = makeTempDir();
    const store = createNodeImStore();
    const filePath = path.join(stateRoot, "im", "run-bindings", "run-1.json");

    await store.writeText(filePath, "{\"ok\":true}\n");

    expect(fs.readFileSync(filePath, "utf-8")).toBe("{\"ok\":true}\n");
    const siblings = fs.readdirSync(path.dirname(filePath));
    expect(siblings.filter((entry) => entry.includes(".tmp."))).toEqual([]);
  });
});

describe("readJsonlFile", () => {
  it("ignores an incomplete trailing JSONL line during lock-free reads", async () => {
    const store = createInMemoryImStore({
      "/state/im/channels/channel-1/messages.jsonl": [
        JSON.stringify({ id: "msg-1", text: "ready" }),
        "{\"id\":\"msg-2\"",
      ].join("\n"),
    });

    await expect(
      readJsonlFile<{ id: string; text: string }>(
        store,
        "/state/im/channels/channel-1/messages.jsonl",
      ),
    ).resolves.toEqual([{ id: "msg-1", text: "ready" }]);
  });

  it("rejects malformed complete JSONL lines", async () => {
    const store = createInMemoryImStore({
      "/state/im/channels/channel-1/messages.jsonl": `${JSON.stringify({ id: "msg-1" })}\n{bad}\n`,
    });

    await expect(
      readJsonlFile<{ id: string }>(
        store,
        "/state/im/channels/channel-1/messages.jsonl",
      ),
    ).rejects.toThrow();
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for predicate");
}
