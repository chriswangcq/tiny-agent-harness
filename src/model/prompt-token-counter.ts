import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { V4ChatMessage } from "../types/model.js";

export interface PromptTokenCounter {
  countMessages(messages: readonly V4ChatMessage[]): number;
}

export type DeepSeekV4PromptTokenCounterOptions = {
  encodeScriptPath?: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_ENCODE_SCRIPT = path.resolve(
  __dirname,
  "../../scripts/encode-prompt.py",
);

export class DeepSeekV4PromptTokenCounter implements PromptTokenCounter {
  private readonly encodeScriptPath: string;

  constructor(options: DeepSeekV4PromptTokenCounterOptions = {}) {
    this.encodeScriptPath = options.encodeScriptPath ?? DEFAULT_ENCODE_SCRIPT;
  }

  countMessages(messages: readonly V4ChatMessage[]): number {
    if (messages.length === 0) {
      return 0;
    }
    const encoded = execFileSync("python3", [this.encodeScriptPath], {
      input: JSON.stringify({ messages, thinking_mode: "thinking" }),
      encoding: "utf-8",
      timeout: 10_000,
    });
    return conservativePromptTokenCount(encoded);
  }
}

export function conservativePromptTokenCount(text: string): number {
  let count = 0;
  const segments = text.match(/[\p{Script=Han}\p{Emoji_Presentation}]|[A-Za-z0-9_]+|\s+|./gu) ?? [];
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
