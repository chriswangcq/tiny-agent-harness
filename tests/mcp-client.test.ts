import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { McpJsonRpcClient } from "../src/mcp/client.js";
import type { JsonRpcTransport } from "../src/mcp/transport.js";

function makeFakeTransport(): JsonRpcTransport & { simulate: (data: string) => void; simulateClose: (code?: number | null) => void; simulateError: (err: Error) => void } {
  const dataHandlers: Array<(chunk: Buffer) => void> = [];
  const closeHandlers: Array<(code: number | null) => void> = [];
  const errorHandlers: Array<(err: Error) => void> = [];
  return {
    write: vi.fn(),
    onData(handler) { dataHandlers.push(handler); },
    onClose(handler) { closeHandlers.push(handler); },
    onError(handler) { errorHandlers.push(handler); },
    destroy: vi.fn(),
    simulate(data: string) { for (const h of dataHandlers) h(Buffer.from(data)); },
    simulateClose(code?: number | null) { for (const h of closeHandlers) h(code ?? null); },
    simulateError(err: Error) { for (const h of errorHandlers) h(err); },
  };
}

describe("McpJsonRpcClient", () => {
  let transport: ReturnType<typeof makeFakeTransport>;
  let client: McpJsonRpcClient;

  beforeEach(() => {
    transport = makeFakeTransport();
    client = new McpJsonRpcClient(transport, 500);
  });

  afterEach(() => {
    client.disconnect();
  });

  it("normal response", async () => {
    const p = client.sendRequest("test", { key: "val" });
    transport.simulate(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { ok: true } }) + "\n");
    const result = await p;
    expect(result).toEqual({ ok: true });
    expect(transport.write).toHaveBeenCalled();
  });

  it("chunked response", async () => {
    const p = client.sendRequest("test", {});
    transport.simulate('{ "jsonrpc": "2.0", "id": 1, "result');
    transport.simulate('": {"chunked": true} }\n');
    const result = await p;
    expect(result).toEqual({ chunked: true });
  });

  it("error response", async () => {
    const p = client.sendRequest("test", {});
    transport.simulate(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "bad" } }) + "\n");
    await expect(p).rejects.toThrow("MCP error -1: bad");
  });

  it("timeout", async () => {
    const p = client.sendRequest("slow", {}, 100);
    await expect(p).rejects.toThrow("timeout");
  });

  it("transport close rejects pending", async () => {
    const p = client.sendRequest("test", {});
    transport.simulateClose(1);
    await expect(p).rejects.toThrow("transport closed");
  });

  it("transport error rejects pending", async () => {
    const p = client.sendRequest("test", {});
    transport.simulateError(new Error("boom"));
    await expect(p).rejects.toThrow("boom");
  });

  it("disconnect clears pending", async () => {
    const p = client.sendRequest("test", {});
    client.disconnect();
    await expect(p).rejects.toThrow("disconnected");
  });

  it("closed transport rejects immediately", async () => {
    client.disconnect();
    await expect(client.sendRequest("test", {})).rejects.toThrow("transport closed");
  });
});
