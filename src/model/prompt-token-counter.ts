import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";

import type { V4ChatMessage } from "../types/model.js";

export interface EncodeRunner {
  runEncode(input: string): string;
}

const DEFAULT_ENCODE_TIMEOUT_MS = 10_000;
const DEFAULT_ENCODE_MAX_BUFFER_BYTES = 2 * 1024 * 1024;

export class PythonEncodeRunner implements EncodeRunner {
  private readonly scriptPath: string;
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;

  constructor(options: {
    scriptPath?: string;
    timeoutMs?: number;
    maxBufferBytes?: number;
  } = {}) {
    this.scriptPath = options.scriptPath ?? DEFAULT_ENCODE_SCRIPT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_ENCODE_TIMEOUT_MS;
    this.maxBufferBytes =
      options.maxBufferBytes ?? DEFAULT_ENCODE_MAX_BUFFER_BYTES;
  }

  runEncode(input: string): string {
    return execFileSync("python3", [this.scriptPath], {
      input,
      encoding: "utf-8",
      maxBuffer: this.maxBufferBytes,
      timeout: this.timeoutMs,
    });
  }
}

export interface PromptTokenCounter {
  countMessages(messages: readonly V4ChatMessage[]): number;
}

export type DeepSeekV4PromptTokenCounterOptions = {
  encodeScriptPath?: string;
  encodeRunner?: EncodeRunner;
  encodeTimeoutMs?: number;
  encodeMaxBufferBytes?: number;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ENCODE_SCRIPT = path.resolve(
  __dirname,
  "../../scripts/encode-prompt.py",
);

export class DeepSeekV4PromptTokenCounter implements PromptTokenCounter {
  private readonly encodeRunner: EncodeRunner;

  constructor(options: DeepSeekV4PromptTokenCounterOptions = {}) {
    if (options.encodeRunner) {
      this.encodeRunner = options.encodeRunner;
    } else {
      this.encodeRunner = new PythonEncodeRunner({
        scriptPath: options.encodeScriptPath,
        timeoutMs: options.encodeTimeoutMs,
        maxBufferBytes: options.encodeMaxBufferBytes,
      });
    }
  }

  countMessages(messages: readonly V4ChatMessage[]): number {
    if (messages.length === 0) {
      return 0;
    }

    const input = JSON.stringify({
      messages,
      thinking_mode: "thinking",
    });

    try {
      const encoded = this.encodeRunner.runEncode(input);
      if (encoded.length === 0) {
        throw new Error("encoder returned empty output");
      }
      return conservativePromptTokenCount(encoded);
    } catch {
      return conservativePromptTokenCount(input);
    }
  }
}

export function conservativePromptTokenCount(text: string): number {
  let count = 0;
  const segments =
    text.match(
      /[\p{Script=Han}\p{Emoji_Presentation}]|[A-Za-z0-9_]+|\s+|./gu,
    ) ?? [];
  for (const segment of segments) {
    if (/^\s+$/u.test(segment)) {
      count += 1;
    } else if (/^[A-Za-z0-9_]+$/u.test(segment)) {
      count += Math.max(1, Math.ceil(segment.length / 4));
    } else {
      count += 1;
    }
  }
  return count;
}
