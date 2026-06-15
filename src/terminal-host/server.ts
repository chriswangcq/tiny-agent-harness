import type { TerminalPort } from "../run/orchestrator.js";
import { listenResidentHostSocket } from "../runtime/resident-host.js";
import {
  parseTerminalHostRequest,
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

export async function listenTerminalHostSocket(options: {
  terminal: TerminalPort;
  socketPath: string;
  onShutdown?: () => Promise<void> | void;
}) {
  return await listenResidentHostSocket({
    socketPath: options.socketPath,
    handleLine: async (line) => {
      let request: TerminalHostRequest;
      try {
        request = parseTerminalHostRequest(line);
      } catch (error) {
        return {
          responseLine: JSON.stringify(
            terminalHostErrorResponse({
              message: error instanceof Error ? error.message : String(error),
              code: "BAD_REQUEST",
            }),
          ),
        };
      }

      const response = await handleTerminalHostRequest(options.terminal, request);
      if (request.type === "terminal.shutdown") {
        await options.onShutdown?.();
      }
      return {
        responseLine: JSON.stringify(response),
        close: request.type === "terminal.shutdown",
      };
    },
  });
}
