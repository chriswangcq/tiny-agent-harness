import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

export interface PromptEncodeRunner {
  runEncode(input: string): string;
}

export type PromptEncodeProcessRunner = (
  command: string,
  args: string[],
  options: {
    input: string;
    encoding: "utf-8";
    maxBuffer: number;
    timeout: number;
  },
) => string;

export type PythonPromptEncodeRunnerOptions = {
  scriptPath?: string;
  command?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  maxAttempts?: number;
  processRunner?: PromptEncodeProcessRunner;
};

export const DEFAULT_PROMPT_ENCODE_TIMEOUT_MS = 10_000;
export const DEFAULT_PROMPT_ENCODE_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const DEFAULT_PROMPT_ENCODE_SCRIPT = path.resolve(
  __dirname,
  "../../scripts/encode-prompt.py",
);

export class PromptEncodingError extends Error {
  readonly code = "PROMPT_ENCODING_ERROR";

  constructor(
    message: string,
    options?: {
      cause?: unknown;
      attempts?: number;
      inputBytes?: number;
      timeoutMs?: number;
      maxBufferBytes?: number;
    },
  ) {
    super(message, { cause: options?.cause });
    this.name = "PromptEncodingError";
    this.details = {
      attempts: options?.attempts,
      inputBytes: options?.inputBytes,
      timeoutMs: options?.timeoutMs,
      maxBufferBytes: options?.maxBufferBytes,
    };
  }

  readonly details: {
    attempts?: number;
    inputBytes?: number;
    timeoutMs?: number;
    maxBufferBytes?: number;
  };
}

export class PythonPromptEncodeRunner implements PromptEncodeRunner {
  private readonly command: string;
  private readonly scriptPath: string;
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;
  private readonly maxAttempts: number;
  private readonly processRunner: PromptEncodeProcessRunner;

  constructor(options: PythonPromptEncodeRunnerOptions = {}) {
    this.command = options.command ?? "python3";
    this.scriptPath = options.scriptPath ?? DEFAULT_PROMPT_ENCODE_SCRIPT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PROMPT_ENCODE_TIMEOUT_MS;
    this.maxBufferBytes =
      options.maxBufferBytes ?? DEFAULT_PROMPT_ENCODE_MAX_BUFFER_BYTES;
    this.maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? 1));
    this.processRunner = options.processRunner ?? defaultProcessRunner;
  }

  runEncode(input: string): string {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      try {
        const encoded = this.processRunner(this.command, [this.scriptPath], {
          input,
          encoding: "utf-8",
          maxBuffer: this.maxBufferBytes,
          timeout: this.timeoutMs,
        });
        if (encoded.length === 0) {
          throw new Error("encoder returned empty output");
        }
        return encoded;
      } catch (error) {
        lastError = error;
      }
    }

    throw new PromptEncodingError(
      `DeepSeek V4 prompt encoding failed after ${this.maxAttempts} attempt(s): ${errorMessage(lastError)}`,
      {
        cause: lastError,
        attempts: this.maxAttempts,
        inputBytes: Buffer.byteLength(input, "utf-8"),
        timeoutMs: this.timeoutMs,
        maxBufferBytes: this.maxBufferBytes,
      },
    );
  }
}

export function encodeV4PromptInput(input: {
  messages: unknown;
  thinkingMode?: "thinking" | "chat";
}): string {
  return JSON.stringify({
    messages: input.messages,
    thinking_mode: input.thinkingMode ?? "thinking",
  });
}

function defaultProcessRunner(
  command: string,
  args: string[],
  options: {
    input: string;
    encoding: "utf-8";
    maxBuffer: number;
    timeout: number;
  },
): string {
  return execFileSync(command, args, options);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}
