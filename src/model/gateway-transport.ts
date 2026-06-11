import { ChildProcessJsonlTransport } from "../runtime/jsonl-child-transport.js";
import type { SpawnedProcessPort } from "../runtime/run-supervisor.js";
import type {
  ModelGatewayRequest,
  ModelGatewayResponse,
  ModelGatewayTransportPort,
} from "./gateway.js";

export class ChildProcessModelGatewayTransport
  implements ModelGatewayTransportPort
{
  private readonly transport: ChildProcessJsonlTransport<
    ModelGatewayRequest,
    ModelGatewayResponse
  >;

  constructor(
    child: Pick<SpawnedProcessPort, "stdin" | "stdout" | "once" | "kill">,
    timeoutMs = 120_000,
  ) {
    this.transport = new ChildProcessJsonlTransport({
      child,
      label: "model-gateway",
      timeoutMs,
      shutdownRequest: ({ id, reason }) => ({
        schemaVersion: 1,
        id,
        type: "model.shutdown",
        reason,
      }),
    });
  }

  request(request: ModelGatewayRequest): Promise<ModelGatewayResponse> {
    return this.transport.request(request);
  }

  shutdown(reason = "client_shutdown"): Promise<void> {
    return this.transport.shutdown(reason);
  }
}
