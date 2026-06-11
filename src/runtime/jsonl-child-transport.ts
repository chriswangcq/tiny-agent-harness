import type { SpawnedProcessPort } from "./run-supervisor.js";

type JsonlRequest = {
  id: string;
  type: string;
};

type JsonlResponse = {
  id: string;
};

type PendingRequest<Response> = {
  resolve: (response: Response) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export type ChildProcessJsonlTransportOptions<Request extends JsonlRequest> = {
  child: Pick<SpawnedProcessPort, "stdin" | "stdout" | "once" | "kill">;
  label: string;
  timeoutMs: number;
  shutdownRequest: (input: { id: string; reason: string }) => Request;
};

export class ChildProcessJsonlTransport<
  Request extends JsonlRequest,
  Response extends JsonlResponse,
> {
  private readonly pending = new Map<string, PendingRequest<Response>>();
  private buffer = "";
  private closed = false;

  constructor(
    private readonly options: ChildProcessJsonlTransportOptions<Request>,
  ) {
    options.child.stdout?.on("data", (chunk: Buffer | string) => {
      this.buffer += chunk.toString();
      this.drain();
    });
    options.child.once("exit", (code, signal) => {
      this.closed = true;
      this.rejectAll(
        new Error(
          `${this.options.label} exited before replying (code=${code}, signal=${signal})`,
        ),
      );
    });
  }

  request(request: Request): Promise<Response> {
    if (this.closed) {
      return Promise.reject(
        new Error(`${this.options.label} transport is closed`),
      );
    }
    if (!this.options.child.stdin) {
      return Promise.reject(
        new Error(`${this.options.label} stdin is not available`),
      );
    }

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(
          new Error(
            `${this.options.label} request timeout: ${request.type} (${this.options.timeoutMs}ms)`,
          ),
        );
      }, this.options.timeoutMs);
      this.pending.set(request.id, { resolve, reject, timer });
      this.options.child.stdin!.write(`${JSON.stringify(request)}\n`);
    });
  }

  async shutdown(reason = "client_shutdown"): Promise<void> {
    if (this.closed) {
      return;
    }

    let graceful = false;
    try {
      await this.request(
        this.options.shutdownRequest({
          id: `shutdown-${Date.now()}`,
          reason,
        }),
      );
      graceful = true;
    } catch {
      // Best-effort cleanup.
    }

    this.closed = true;
    if (!graceful) {
      this.options.child.kill("SIGTERM");
    }
  }

  private drain(): void {
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline === -1) {
        return;
      }

      const raw = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!raw) {
        continue;
      }

      let response: Response;
      try {
        response = JSON.parse(raw) as Response;
      } catch {
        continue;
      }

      const pending = this.pending.get(response.id);
      if (!pending) {
        continue;
      }

      clearTimeout(pending.timer);
      this.pending.delete(response.id);
      pending.resolve(response);
    }
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
