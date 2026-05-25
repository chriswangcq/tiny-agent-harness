import { pathToFileURL } from "node:url";

let buffer = Buffer.alloc(0);
let rootUri = "";

process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  drain();
});

function drain() {
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd < 0) {
      return;
    }

    const header = buffer.subarray(0, headerEnd).toString("ascii");
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      throw new Error("missing content length");
    }

    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    const bodyEnd = bodyStart + length;
    if (buffer.length < bodyEnd) {
      return;
    }

    const body = buffer.subarray(bodyStart, bodyEnd).toString("utf-8");
    buffer = buffer.subarray(bodyEnd);
    handleMessage(JSON.parse(body));
  }
}

function handleMessage(message) {
  if (message.method === "initialize") {
    rootUri = message.params?.rootUri ?? "";
    respond(message.id, {
      capabilities: {
        definitionProvider: true,
        referencesProvider: true,
        documentSymbolProvider: true,
        hoverProvider: true,
        textDocumentSync: 1,
      },
    });
    return;
  }

  if (message.method === "shutdown") {
    respond(message.id, null);
    return;
  }

  if (message.method === "exit") {
    process.exit(0);
  }

  if (message.method === "textDocument/didOpen") {
    const uri = message.params.textDocument.uri;
    setTimeout(() => {
      notify("textDocument/publishDiagnostics", {
        uri,
        diagnostics: [
          {
            range: {
              start: { line: 0, character: 6 },
              end: { line: 0, character: 11 },
            },
            severity: 1,
            source: "fake-ts",
            code: "1001",
            message: "Fake diagnostic",
          },
        ],
      });
    }, 5);
    return;
  }

  if (message.method === "textDocument/documentSymbol") {
    respond(message.id, [
      {
        name: "Example",
        kind: 5,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 2, character: 1 },
        },
        selectionRange: {
          start: { line: 0, character: 13 },
          end: { line: 0, character: 20 },
        },
        children: [
          {
            name: "run",
            kind: 6,
            range: {
              start: { line: 1, character: 2 },
              end: { line: 1, character: 20 },
            },
            selectionRange: {
              start: { line: 1, character: 2 },
              end: { line: 1, character: 5 },
            },
          },
        ],
      },
    ]);
    return;
  }

  if (message.method === "textDocument/definition") {
    respond(message.id, {
      uri: targetUri("src/target.ts"),
      range: {
        start: { line: 3, character: 7 },
        end: { line: 3, character: 13 },
      },
    });
    return;
  }

  if (message.method === "textDocument/references") {
    respond(message.id, [
      {
        uri: message.params.textDocument.uri,
        range: {
          start: { line: 0, character: 13 },
          end: { line: 0, character: 20 },
        },
      },
      {
        uri: targetUri("src/target.ts"),
        range: {
          start: { line: 3, character: 7 },
          end: { line: 3, character: 13 },
        },
      },
    ]);
    return;
  }

  if (message.method === "textDocument/hover") {
    respond(message.id, {
      contents: {
        kind: "markdown",
        value: "class **Example**",
      },
      range: {
        start: { line: 0, character: 13 },
        end: { line: 0, character: 20 },
      },
    });
    return;
  }

  if (message.id !== undefined) {
    respond(message.id, null);
  }
}

function targetUri(relativePath) {
  if (!rootUri) {
    return pathToFileURL(relativePath).href;
  }
  return `${rootUri.replace(/\/$/, "")}/${relativePath}`;
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function notify(method, params) {
  write({ jsonrpc: "2.0", method, params });
}

function write(message) {
  const payload = JSON.stringify(message);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(payload, "utf-8")}\r\n\r\n${payload}`);
}
