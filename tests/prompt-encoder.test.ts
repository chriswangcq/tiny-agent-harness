import { describe, expect, it } from "vitest";

import {
  PromptEncodingError,
  PythonPromptEncodeRunner,
  encodeV4PromptInput,
  type PromptEncodeProcessRunner,
} from "../src/model/prompt-encoder.js";

describe("PythonPromptEncodeRunner", () => {
  it("retries transient encoder failures before returning the encoded prompt", () => {
    const calls: Array<{ command: string; timeout: number; maxBuffer: number }> = [];
    const processRunner: PromptEncodeProcessRunner = (command, _args, options) => {
      calls.push({
        command,
        timeout: options.timeout,
        maxBuffer: options.maxBuffer,
      });
      if (calls.length === 1) {
        throw Object.assign(new Error("spawnSync python3 ETIMEDOUT"), {
          code: "ETIMEDOUT",
        });
      }
      return "encoded prompt";
    };
    const runner = new PythonPromptEncodeRunner({
      maxAttempts: 2,
      timeoutMs: 1234,
      maxBufferBytes: 5678,
      processRunner,
    });

    expect(runner.runEncode("payload")).toBe("encoded prompt");
    expect(calls).toEqual([
      { command: "python3", timeout: 1234, maxBuffer: 5678 },
      { command: "python3", timeout: 1234, maxBuffer: 5678 },
    ]);
  });

  it("throws a typed PromptEncodingError after all attempts fail", () => {
    const cause = Object.assign(new Error("spawnSync python3 ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    const runner = new PythonPromptEncodeRunner({
      maxAttempts: 2,
      timeoutMs: 10,
      maxBufferBytes: 20,
      processRunner: () => {
        throw cause;
      },
    });

    expect(() => runner.runEncode("payload")).toThrow(PromptEncodingError);
    try {
      runner.runEncode("payload");
    } catch (error) {
      expect(error).toMatchObject({
        name: "PromptEncodingError",
        code: "PROMPT_ENCODING_ERROR",
        details: {
          attempts: 2,
          inputBytes: Buffer.byteLength("payload", "utf-8"),
          timeoutMs: 10,
          maxBufferBytes: 20,
        },
      });
      expect((error as Error & { cause?: unknown }).cause).toBe(cause);
    }
  });
});

describe("encodeV4PromptInput", () => {
  it("serializes the DeepSeek V4 chat-template encoder input", () => {
    expect(
      JSON.parse(
        encodeV4PromptInput({
          messages: [{ role: "user", content: "hi" }],
        }),
      ),
    ).toEqual({
      messages: [{ role: "user", content: "hi" }],
      thinking_mode: "thinking",
    });
  });
});
