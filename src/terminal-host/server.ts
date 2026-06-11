import * as readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { TerminalPort } from "../run/orchestrator.js";
import {
  parseTerminalHostRequest,
  serializeTerminalHostResponse,
  terminalHostErrorResponse,
  type TerminalHostRequest,
  type TerminalHostResponse,
} from "./protocol.js";

export async function handleTerminalHostRequest(
  terminal: TerminalPort,
  request: TerminalHostRequest,
): Promise<TerminalHostResponse> {
  if (request.type === "terminal.shutdown") {
    return {
      schemaVersion: 1,
      id: request.id,
      ok: true,
      type: "terminal.shutdown.result",
    };
  }

  try {
    return {
      schemaVersion: 1,
      id: request.id,
      ok: true,
      type: "terminal.execute.result",
      observation: await terminal.execute(request.request),
    };
  } catch (error) {
    return terminalHostErrorResponse({
      id: request.id,
      message: error instanceof Error ? error.message : String(error),
      code: "TERMINAL_ERROR",
    });
  }
}

export async function serveTerminalHost(options: {
  terminal: TerminalPort;
  input: Readable;
  output: Writable;
  onShutdown?: () => Promise<void> | void;
}): Promise<void> {
  const lines = readline.createInterface({
    input: options.input,
    crlfDelay: Infinity,
  });

  for await (const line of lines) {
    if (line.trim().length === 0) {
      continue;
    }

    let request: TerminalHostRequest;
    try {
      request = parseTerminalHostRequest(line);
    } catch (error) {
      options.output.write(
        serializeTerminalHostResponse(
          terminalHostErrorResponse({
            message: error instanceof Error ? error.message : String(error),
            code: "BAD_REQUEST",
          }),
        ),
      );
      continue;
    }

    const response = await handleTerminalHostRequest(options.terminal, request);
    options.output.write(serializeTerminalHostResponse(response));
    if (request.type === "terminal.shutdown") {
      await options.onShutdown?.();
      lines.close();
      break;
    }
  }
}
