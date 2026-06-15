import { requestResidentHostJson } from "../runtime/resident-host.js";
import {
  parseModelGatewayResponse,
  type ModelGatewayRequest,
  type ModelGatewayResponse,
} from "./gateway.js";

export async function requestModelGatewaySocket(options: {
  socketPath: string;
  request: ModelGatewayRequest;
  timeoutMs: number;
}): Promise<ModelGatewayResponse> {
  return await requestResidentHostJson({
    socketPath: options.socketPath,
    request: options.request,
    timeoutMs: options.timeoutMs,
    parseResponse: (raw) => parseModelGatewayResponse(raw, options.request.id),
  });
}
