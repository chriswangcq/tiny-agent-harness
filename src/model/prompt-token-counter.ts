import type { V4ChatMessage } from "../types/model.js";
import {
  PythonPromptEncodeRunner,
  encodeV4PromptInput,
  type PromptEncodeRunner,
} from "./prompt-encoder.js";

export type EncodeRunner = PromptEncodeRunner;
export { PythonPromptEncodeRunner as PythonEncodeRunner };

export interface PromptTokenCounter {
  countMessages(messages: readonly V4ChatMessage[]): number;
}

export type DeepSeekV4PromptTokenCounterOptions = {
  encodeScriptPath?: string;
  encodeRunner?: EncodeRunner;
  encodeTimeoutMs?: number;
  encodeMaxBufferBytes?: number;
};

export class DeepSeekV4PromptTokenCounter implements PromptTokenCounter {
  private readonly encodeRunner: EncodeRunner;

  constructor(options: DeepSeekV4PromptTokenCounterOptions = {}) {
    if (options.encodeRunner) {
      this.encodeRunner = options.encodeRunner;
    } else {
      this.encodeRunner = new PythonPromptEncodeRunner({
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

    const input = encodeV4PromptInput({
      messages,
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
