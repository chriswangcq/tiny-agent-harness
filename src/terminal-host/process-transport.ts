import { ChildProcessJsonlTransport } from "../runtime/jsonl-child-transport.js";
import type { SpawnedProcessPort } from "../runtime/run-supervisor.js";
import type { TerminalHostTransportPort } from "./client.js";
import type { TerminalHostRequest, TerminalHostResponse } from "./protocol.js";

export class ChildProcessTerminalHostTransport
  implements TerminalHostTransportPort
{
  private readonly transport: ChildProcessJsonlTransport<
    TerminalHostRequest,
    TerminalHostResponse
  >;

  constructor(
    child: Pick<SpawnedProcessPort, "stdin" | "stdout" | "once" | "kill">,
    timeoutMs = 30_000,
  ) {
    this.transport = new ChildProcessJsonlTransport({
      child,
      label: "terminal-host",
      timeoutMs,
      shutdownRequest: ({ id, reason }) => ({
        schemaVersion: 1,
        id,
        type: "terminal.shutdown",
        reason,
      }),
    });
  }

  request(request: TerminalHostRequest): Promise<TerminalHostResponse> {
    return this.transport.request(request);
  }

  shutdown(reason = "client_shutdown"): Promise<void> {
    return this.transport.shutdown(reason);
  }
}
