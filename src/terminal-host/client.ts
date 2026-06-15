import type { TerminalPort } from "../run/orchestrator.js";
import type { ToolObservation, ToolRequest } from "../types/tools.js";
import { requestResidentHostJson } from "../runtime/resident-host.js";
import type {
  TerminalHostRequest,
  TerminalHostResponse,
} from "./protocol.js";
import { parseTerminalHostResponse } from "./protocol.js";

export interface TerminalHostTransportPort {
  request(request: TerminalHostRequest): Promise<TerminalHostResponse>;
}

export type TerminalHostRunPortDeps = {
  transport: TerminalHostTransportPort;
  newRequestId: () => string;
};

export function createTerminalHostRunPort(
  deps: TerminalHostRunPortDeps,
): TerminalPort {
  return {
    async execute(request: ToolRequest): Promise<ToolObservation> {
      const response = await deps.transport.request({
        schemaVersion: 1,
        id: deps.newRequestId(),
        type: "terminal.execute",
        request,
      });
      if (!response.ok) {
        throw new Error(
          `Terminal host request failed: ${response.error.code}: ${response.error.message}`,
        );
      }
      if (response.type !== "terminal.execute.result") {
        throw new Error(
          `Terminal host returned unexpected response type: ${response.type}`,
        );
      }
      return response.observation;
    },
  };
}

export async function requestTerminalHostSocket(options: {
  socketPath: string;
  request: TerminalHostRequest;
  timeoutMs: number;
}): Promise<TerminalHostResponse> {
  return await requestResidentHostJson({
    socketPath: options.socketPath,
    request: options.request,
    timeoutMs: options.timeoutMs,
    parseResponse: (raw) => parseTerminalHostResponse(raw, options.request.id),
  });
}
