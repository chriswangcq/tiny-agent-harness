export interface JsonRpcTransport {
  /** Write a raw JSON-RPC line (without trailing newline). */
  write(data: string): void;
  /** Register a handler for incoming data chunks. */
  onData(handler: (chunk: Buffer) => void): void;
  /** Register close handler. Transport calls this when the underlying stream closes. */
  onClose(handler: (code: number | null) => void): void;
  /** Register error handler. */
  onError(handler: (err: Error) => void): void;
  /** Clean shutdown. */
  destroy(): void;
}
