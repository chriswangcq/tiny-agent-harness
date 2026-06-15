import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  PublicImService,
  createInMemoryImStore,
  handleImHostRequest,
  listenImHostSocket,
  parseImHostRequest,
  parseImHostResponse,
  requestImHostSocket,
  type ImHostContext,
  type PublicImServicePorts,
} from "../src/im/index.js";

function makeService(): PublicImService {
  const store = createInMemoryImStore();
  const ports: PublicImServicePorts = {
    store,
    clock: { nowIso: () => "2026-06-14T00:00:00.000Z" },
    ids: { newMessageId: (seed) => `msg-${seed}` },
  };
  return new PublicImService(ports);
}

function makeContext(): ImHostContext {
  return {
    stateRoot: "/state",
    runId: "run-1",
    selfEndpoint: "run:run-1",
    userEndpoint: "user:main",
  };
}

describe("im host protocol", () => {
  it("parses typed requests and rejects invalid payloads", () => {
    expect(
      parseImHostRequest(
        JSON.stringify({
          schemaVersion: 1,
          id: "req-1",
          type: "im.send",
          kind: "status",
          text: "hello",
        }),
      ),
    ).toMatchObject({
      id: "req-1",
      type: "im.send",
      kind: "status",
      text: "hello",
    });

    expect(() =>
      parseImHostRequest(JSON.stringify({ schemaVersion: 2, id: "bad", type: "im.recv" })),
    ).toThrow("schemaVersion must be 1");
    expect(() =>
      parseImHostRequest(JSON.stringify({ schemaVersion: 1, id: "bad", type: "im.send", kind: "message", text: "x" })),
    ).toThrow("kind must be status or error");
    expect(() =>
      parseImHostRequest(JSON.stringify({ schemaVersion: 1, id: "bad", type: "im.post" })),
    ).toThrow("text must be non-empty string");
  });

  it("rejects mismatched response ids at the parser boundary", () => {
    expect(() =>
      parseImHostResponse(
        JSON.stringify({
          schemaVersion: 1,
          id: "actual",
          ok: true,
          type: "im.result",
          command: "im.recv",
          data: {},
        }),
        "expected",
      ),
    ).toThrow("expected id expected, got actual");
  });

  it("resolves omitted run endpoints from explicit host context", async () => {
    const service = makeService();
    const context = makeContext();

    const bind = await handleImHostRequest(service, context, {
      schemaVersion: 1,
      id: "bind-1",
      type: "im.bind",
    });
    expect(bind.ok).toBe(true);

    const posted = await handleImHostRequest(service, context, {
      schemaVersion: 1,
      id: "post-1",
      type: "im.post",
      text: "hello",
    });
    expect(posted.ok).toBe(true);
    expect((posted as any).data).toMatchObject({
      from: "user:main",
      to: "run:run-1",
    });

    const received = await handleImHostRequest(service, context, {
      schemaVersion: 1,
      id: "recv-1",
      type: "im.recv",
    });
    expect(received.ok).toBe(true);
    expect((received as any).data).toMatchObject({
      as: "run:run-1",
      with: "user:main",
      count: 1,
    });
    expect((received as any).data.messages[0]).toMatchObject({
      text: "hello",
      from: "user:main",
      to: "run:run-1",
    });
  });

  it("roundtrips requests over the resident socket", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "im-host-socket-"));
    const socketPath = path.join(dir, "im-host.sock");
    const server = await listenImHostSocket({
      socketPath,
      service: makeService(),
      context: makeContext(),
    });

    try {
      const response = await requestImHostSocket({
        socketPath,
        timeoutMs: 1_000,
        request: {
          schemaVersion: 1,
          id: "send-1",
          type: "im.send",
          kind: "status",
          text: "ready",
        },
      });
      expect(response).toMatchObject({
        schemaVersion: 1,
        id: "send-1",
        ok: true,
        type: "im.result",
        command: "im.send",
      });
      expect((response as any).data).toMatchObject({
        from: "run:run-1",
        to: "user:main",
        kind: "status",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("supports shutdown responses that close the server and remove the socket path", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "im-host-shutdown-"));
    const socketPath = path.join(dir, "im-host.sock");
    const server = await listenImHostSocket({
      socketPath,
      service: makeService(),
      context: makeContext(),
    });

    try {
      const closed = new Promise<void>((resolve) => server.once("close", resolve));
      const response = await requestImHostSocket({
        socketPath,
        timeoutMs: 1_000,
        request: {
          schemaVersion: 1,
          id: "shutdown-1",
          type: "im.shutdown",
        },
      });
      expect(response).toEqual({
        schemaVersion: 1,
        id: "shutdown-1",
        ok: true,
        type: "im.shutdown.result",
      });
      await closed;
      expect(fs.existsSync(socketPath)).toBe(false);
    } finally {
      if (server.listening) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
