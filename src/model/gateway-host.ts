import type { ModelPort } from "../run/orchestrator.js";
import { listenResidentHostSocket } from "../runtime/resident-host.js";
import {
  parseModelGatewayRequest,
  type ModelGatewayRequest,
  type ModelGatewayResponse,
} from "./gateway.js";
import type { ModelProgressEvent } from "../types/index.js";

export async function handleModelGatewayRequest(
  model: ModelPort,
  request: ModelGatewayRequest,
  options: {
    onProgress?: (event: ModelProgressEvent) => void | Promise<void>;
  } = {},
): Promise<ModelGatewayResponse> {
  if (request.type === "model.shutdown") {
    return {
      schemaVersion: 1,
      id: request.id,
      ok: true,
      type: "model.shutdown.result",
    };
  }

  try {
    return {
      schemaVersion: 1,
      id: request.id,
      ok: true,
      type: "model.generateTurn.result",
      output: await model.generateTurn(request.context, {
        tools: request.tools,
        onProgress: options.onProgress,
      }),
    };
  } catch (error) {
    return {
      schemaVersion: 1,
      id: request.id,
      ok: false,
      type: "model.error",
      error: {
        code: "MODEL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function listenModelGatewaySocket(options: {
  model: ModelPort;
  socketPath: string;
  onShutdown?: () => Promise<void> | void;
}) {
  return await listenResidentHostSocket({
    socketPath: options.socketPath,
    handleLine: async (line, connection) => {
      let request: ModelGatewayRequest;
      try {
        request = parseModelGatewayRequest(line);
      } catch (error) {
        return {
          responseLine: JSON.stringify({
            schemaVersion: 1,
            id: "unknown",
            ok: false,
            type: "model.error",
            error: {
              code: "BAD_REQUEST",
              message: error instanceof Error ? error.message : String(error),
            },
          }),
        };
      }

      const response = await handleModelGatewayRequest(options.model, request, {
        onProgress: async (progress) => {
          connection.sendLine(
            JSON.stringify({
              schemaVersion: 1,
              id: request.id,
              ok: true,
              type: "model.generateTurn.progress",
              progress,
            } satisfies ModelGatewayResponse),
          );
        },
      });
      if (request.type === "model.shutdown") {
        await options.onShutdown?.();
      }
      return {
        responseLine: JSON.stringify(response),
        close: request.type === "model.shutdown",
      };
    },
  });
}
