import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createNodeImStore,
  createRunImSelfEndpoint,
  DEFAULT_RUN_USER_ENDPOINT,
  migrateLegacyRunIm,
  planImChannelLayout,
  planImCursorLayout,
  PublicImService,
  readJsonlFile,
  type PublicImMessage,
} from "../src/im/index.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "legacy-im-migration-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("legacy run IM migration", () => {
  it("imports legacy run files into public IM and preserves newer unconsumed project messages", async () => {
    const stateRoot = makeTempDir();
    const runId = "run-legacy";
    const runDir = path.join(stateRoot, "runs", runId);
    fs.mkdirSync(path.join(runDir, "im"), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "state.json"),
      `${JSON.stringify({ runId, status: "waiting_for_io" })}\n`,
    );
    fs.writeFileSync(
      path.join(runDir, "im", "default.inbox.jsonl"),
      [
        JSON.stringify({
          id: "legacy-user-1",
          channel: "default",
          role: "user",
          text: "old hello",
          createdAt: "2026-06-10T00:00:01.000Z",
        }),
        JSON.stringify({
          id: "legacy-user-2",
          channel: "default",
          role: "user",
          text: "old followup",
          createdAt: "2026-06-10T00:00:02.000Z",
        }),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(
      path.join(runDir, "im", "default.outbox.jsonl"),
      `${JSON.stringify({
        id: "legacy-agent-1",
        channel: "default",
        role: "agent",
        kind: "status",
        text: "old reply",
        createdAt: "2026-06-10T00:00:03.000Z",
      })}\n`,
    );

    const store = createNodeImStore();
    const service = new PublicImService({
      store,
      clock: { nowIso: () => "2026-06-15T00:00:00.000Z" },
      ids: { newMessageId: () => "modern-user-1" },
    });
    await service.postMessage({
      stateRoot,
      from: DEFAULT_RUN_USER_ENDPOINT,
      to: createRunImSelfEndpoint(runId),
      text: "new message after ui switch",
      metadata: { source: "project-ui" },
    });

    const summary = await migrateLegacyRunIm({
      stateRoot,
      store,
      service,
      nowIso: () => "2026-06-15T00:00:01.000Z",
    });

    expect(summary).toMatchObject({
      runsScanned: 1,
      runsChanged: 1,
      importedMessages: 3,
      duplicateMessages: 0,
      cursorsSet: 1,
    });
    expect(summary.runs[0]).toMatchObject({
      runId,
      bound: true,
      importedInboxCount: 2,
      importedOutboxCount: 1,
      cursorSetTo: "legacy-user-2",
    });

    const inbound = planImChannelLayout(
      stateRoot,
      DEFAULT_RUN_USER_ENDPOINT,
      createRunImSelfEndpoint(runId),
    );
    const inboundMessages = await readJsonlFile<PublicImMessage>(
      store,
      inbound.messagesFile,
    );
    expect(inboundMessages.map((message) => message.id)).toEqual([
      "legacy-user-1",
      "legacy-user-2",
      "modern-user-1",
    ]);
    const cursor = fs.readFileSync(
      planImCursorLayout(
        stateRoot,
        DEFAULT_RUN_USER_ENDPOINT,
        createRunImSelfEndpoint(runId),
        createRunImSelfEndpoint(runId),
      ).cursorFile,
      "utf-8",
    );
    expect(cursor).toBe("legacy-user-2");

    const runReceive = await service.receiveForRun({ stateRoot, runId });
    expect(runReceive.messages.map((message) => message.text)).toEqual([
      "new message after ui switch",
    ]);

    const outbound = planImChannelLayout(
      stateRoot,
      createRunImSelfEndpoint(runId),
      DEFAULT_RUN_USER_ENDPOINT,
    );
    const outboundMessages = await readJsonlFile<PublicImMessage>(
      store,
      outbound.messagesFile,
    );
    expect(outboundMessages.map((message) => message.text)).toEqual([
      "old reply",
    ]);
  });

  it("is idempotent and preserves an existing run cursor", async () => {
    const stateRoot = makeTempDir();
    const runId = "run-idempotent";
    const runDir = path.join(stateRoot, "runs", runId);
    fs.mkdirSync(path.join(runDir, "im"), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "state.json"),
      `${JSON.stringify({ runId, status: "waiting_for_io" })}\n`,
    );
    fs.writeFileSync(
      path.join(runDir, "im", "default.inbox.jsonl"),
      `${JSON.stringify({
        id: "legacy-user-1",
        channel: "default",
        role: "user",
        text: "old hello",
        createdAt: "2026-06-10T00:00:01.000Z",
      })}\n`,
    );

    const first = await migrateLegacyRunIm({ stateRoot });
    const second = await migrateLegacyRunIm({ stateRoot });
    const dryRunAfterMigration = await migrateLegacyRunIm({
      stateRoot,
      dryRun: true,
    });

    expect(first.importedMessages).toBe(1);
    expect(first.cursorsSet).toBe(1);
    expect(second.importedMessages).toBe(0);
    expect(second.duplicateMessages).toBe(1);
    expect(second.cursorsSet).toBe(0);
    expect(second.runs[0]).toMatchObject({
      hadBinding: true,
      bound: false,
      cursorAlreadyPresent: true,
    });
    expect(dryRunAfterMigration).toMatchObject({
      runsChanged: 0,
      importedMessages: 0,
      duplicateMessages: 1,
      cursorsSet: 0,
    });
  });

  it("dry-runs without writing public IM files", async () => {
    const stateRoot = makeTempDir();
    const runId = "run-dry";
    const runDir = path.join(stateRoot, "runs", runId);
    fs.mkdirSync(path.join(runDir, "im"), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "state.json"),
      `${JSON.stringify({ runId, status: "waiting_for_io" })}\n`,
    );
    fs.writeFileSync(
      path.join(runDir, "im", "default.inbox.jsonl"),
      `${JSON.stringify({
        id: "legacy-user-1",
        channel: "default",
        role: "user",
        text: "old hello",
        createdAt: "2026-06-10T00:00:01.000Z",
      })}\n`,
    );

    const summary = await migrateLegacyRunIm({ stateRoot, dryRun: true });

    expect(summary.dryRun).toBe(true);
    expect(summary.runs[0]).toMatchObject({
      bound: true,
      importedInboxCount: 1,
      wouldSetCursorTo: "legacy-user-1",
    });
    expect(fs.existsSync(path.join(stateRoot, "im"))).toBe(false);
  });
});
