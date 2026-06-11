import { describe, it, expect } from "vitest";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { McpJsonRpcClient } from "../src/mcp/client.js";
import { HttpMcpTransport } from "../src/mcp/http-transport.js";

type RequestRecord = {
  method: string | undefined;
  url: string | undefined;
  headers: http.IncomingHttpHeaders;
  body: string;
};

async function startServer(
  handler: http.RequestListener,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    }),
  };
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf-8");
}

function jsonResponse(
  res: http.ServerResponse,
  id: unknown,
  result: unknown,
  extraHeaders?: Record<string, string>,
): void {
  res.writeHead(200, {
    "Content-Type": "application/json",
    ...extraHeaders,
  });
  res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

describe("HttpMcpTransport", () => {
  it("uses streamable HTTP, preserves request order, and reuses MCP session id", async () => {
    const requests: RequestRecord[] = [];
    const server = await startServer(async (req, res) => {
      const body = await readBody(req);
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      const message = body ? JSON.parse(body) : {};

      if (message.method === "initialize") {
        jsonResponse(
          res,
          message.id,
          { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "test", version: "1" } },
          { "MCP-Session-Id": "session-1" },
        );
        return;
      }

      if (message.method === "notifications/initialized") {
        expect(req.headers["mcp-session-id"]).toBe("session-1");
        res.writeHead(202);
        res.end();
        return;
      }

      if (message.method === "tools/list") {
        expect(req.headers["mcp-session-id"]).toBe("session-1");
        jsonResponse(res, message.id, { tools: [{ name: "hello" }] });
        return;
      }

      res.writeHead(500);
      res.end("unexpected request");
    });

    const client = new McpJsonRpcClient(
      new HttpMcpTransport({
        url: `${server.url}/mcp`,
        headers: { Authorization: "Bearer test" },
      }),
      1_000,
    );
    try {
      await client.initialize();
      const result = await client.listTools();
      expect(result).toEqual({ tools: [{ name: "hello" }] });
      expect(requests.map((r) => JSON.parse(r.body).method)).toEqual([
        "initialize",
        "notifications/initialized",
        "tools/list",
      ]);
      expect(requests.every((r) => r.headers.authorization === "Bearer test")).toBe(true);
    } finally {
      client.disconnect();
      await server.close();
    }
  });

  it("reads JSON-RPC responses from streamable HTTP SSE response bodies", async () => {
    const server = await startServer(async (req, res) => {
      const body = await readBody(req);
      const message = JSON.parse(body);
      if (message.method === "notifications/initialized") {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        result: message.method === "initialize"
          ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "test", version: "1" } }
          : { tools: [{ name: "from-sse" }] },
      })}\n\n`);
    });

    const client = new McpJsonRpcClient(
      new HttpMcpTransport({ url: `${server.url}/mcp` }),
      1_000,
    );
    try {
      await client.initialize();
      await expect(client.listTools()).resolves.toEqual({ tools: [{ name: "from-sse" }] });
    } finally {
      client.disconnect();
      await server.close();
    }
  });

  it("supports the legacy HTTP+SSE endpoint transport", async () => {
    let sseResponse: http.ServerResponse | undefined;
    const server = await startServer(async (req, res) => {
      if (req.method === "GET" && req.url === "/sse") {
        sseResponse = res;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write("event: endpoint\n");
        res.write("data: /messages\n\n");
        return;
      }

      if (req.method === "POST" && req.url === "/messages") {
        const body = await readBody(req);
        const message = JSON.parse(body);
        res.writeHead(202);
        res.end();
        if (message.id !== undefined && sseResponse) {
          sseResponse.write(`data: ${JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: message.method === "initialize"
              ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "legacy", version: "1" } }
              : { tools: [{ name: "legacy-tool" }] },
          })}\n\n`);
        }
        return;
      }

      res.writeHead(404);
      res.end();
    });

    const client = new McpJsonRpcClient(
      new HttpMcpTransport({ url: `${server.url}/sse`, mode: "sse" }),
      1_000,
    );
    try {
      await client.initialize();
      await expect(client.listTools()).resolves.toEqual({ tools: [{ name: "legacy-tool" }] });
    } finally {
      client.disconnect();
      sseResponse?.end();
      await server.close();
    }
  });
});
