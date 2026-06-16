import * as net from "node:net";
import { requestResidentHostJson } from "../runtime/resident-host.js";
import {
  parseModelGatewayResponse,
  type ModelGatewayRequest,
  type ModelGatewayResponse,
  type ModelGatewayRequestOptions,
  type ModelGatewayTerminalResponse,
} from "./gateway.js";

export async function requestModelGatewaySocket(options: {
  socketPath: string;
  request: ModelGatewayRequest;
  timeoutMs: number;
  onProgress?: ModelGatewayRequestOptions["onProgress"];
}): Promise<ModelGatewayTerminalResponse> {
  if (options.request.type === "model.generateTurn") {
    return await requestModelGatewaySocketStream(options);
  }
  return await requestResidentHostJson({
    socketPath: options.socketPath,
    request: options.request,
    timeoutMs: options.timeoutMs,
    parseResponse: (raw) =>
      requireTerminalResponse(parseModelGatewayResponse(raw, options.request.id)),
  });
}

async function requestModelGatewaySocketStream(options: {
  socketPath: string;
  request: ModelGatewayRequest;
  timeoutMs: number;
  onProgress?: ModelGatewayRequestOptions["onProgress"];
}): Promise<ModelGatewayTerminalResponse> {
  return await new Promise<ModelGatewayTerminalResponse>((resolve, reject) => {
    const socket = net.createConnection(options.socketPath);
    let buffer = "";
    let settled = false;
    let terminalReceived = false;
    let draining = false;
    let drainScheduled = false;
    let terminalResponse: ModelGatewayTerminalResponse | undefined;
    const lineQueue: string[] = [];

    const settle = (callback: () => void, close: "end" | "destroy" = "destroy"): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (close === "end") {
        socket.end();
      } else {
        socket.destroy();
      }
      callback();
    };

    const timer = setTimeout(() => {
      settle(() => reject(new Error("Timed out waiting for model gateway response")));
    }, options.timeoutMs);

    const drainLines = async (): Promise<void> => {
      if (draining || settled) {
        return;
      }
      draining = true;
      try {
        while (lineQueue.length > 0) {
          const line = lineQueue.shift()!;
          const message = parseModelGatewayResponse(line, options.request.id);
          if (message.type === "model.generateTurn.progress") {
            if (terminalReceived) {
              throw new Error("Invalid model gateway stream: progress received after terminal response");
            }
            await options.onProgress?.(message.progress);
            continue;
          }
          if (terminalReceived) {
            throw new Error("Invalid model gateway stream: duplicate terminal response");
          }
          terminalReceived = true;
          terminalResponse = message;
        }
      } catch (error) {
        settle(() => reject(error));
        return;
      } finally {
        draining = false;
      }

      const response = terminalResponse;
      if (response && !settled) {
        settle(() => resolve(response), "end");
      }
    };

    const enqueueLine = (line: string): void => {
      lineQueue.push(line);
      if (drainScheduled || draining || settled) {
        return;
      }
      drainScheduled = true;
      void Promise.resolve().then(() => {
        drainScheduled = false;
        return drainLines();
      });
    };

    socket.once("connect", () => {
      socket.write(`${JSON.stringify(options.request)}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      while (true) {
        const newlineIndex = buffer.indexOf("\n");
        if (newlineIndex < 0) {
          return;
        }
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        enqueueLine(line);
      }
    });

    socket.once("error", (error) => {
      settle(() => reject(error));
    });

    socket.once("end", () => {
      if (!settled) {
        settle(() => reject(new Error("Model gateway socket ended before response")));
      }
    });
  });
}

function requireTerminalResponse(
  response: ModelGatewayResponse,
): ModelGatewayTerminalResponse {
  if (response.type === "model.generateTurn.progress") {
    throw new Error("Invalid model gateway response: expected terminal response");
  }
  return response;
}
