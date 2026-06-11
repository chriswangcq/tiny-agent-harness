import * as readline from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { ModelPort } from "../run/orchestrator.js";
import {
  parseModelGatewayRequest,
  serializeModelGatewayResponse,
  type ModelGatewayRequest,
  type ModelGatewayResponse,
} from "./gateway.js";

export async function handleModelGatewayRequest(
  model: ModelPort,
  request: ModelGatewayRequest,
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

export async function serveModelGateway(options: {
  model: ModelPort;
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

    let request: ModelGatewayRequest;
    try {
      request = parseModelGatewayRequest(line);
    } catch (error) {
      options.output.write(
        serializeModelGatewayResponse({
          schemaVersion: 1,
          id: "unknown",
          ok: false,
          type: "model.error",
          error: {
            code: "BAD_REQUEST",
            message: error instanceof Error ? error.message : String(error),
          },
        }),
      );
      continue;
    }

    const response = await handleModelGatewayRequest(options.model, request);
    options.output.write(serializeModelGatewayResponse(response));
    if (request.type === "model.shutdown") {
      await options.onShutdown?.();
      lines.close();
      break;
    }
  }
}
