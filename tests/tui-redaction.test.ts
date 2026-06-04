import { describe, expect, it } from "vitest";
import {
  redactSensitiveDisplayText,
  redactTerminalWriteDisplayText,
  shouldRedactTerminalWriteDisplayPayload,
  terminalWriteDisplayPlaceholder,
} from "../src/tui/redaction.js";

describe("TUI display redaction", () => {
  it("redacts environment-style secret assignments for display", () => {
    expect(
      redactSensitiveDisplayText(
        "export DEEPSEEK_API_KEY=ds-secret-value TOKEN='abc123' normal=value",
      ),
    ).toBe("export DEEPSEEK_API_KEY=[redacted] TOKEN=[redacted] normal=value");
  });

  it("redacts json-style secret properties for display", () => {
    expect(
      redactSensitiveDisplayText(
        '{"api_key":"ds-secret-value","name":"demo","password":"pw"}',
      ),
    ).toBe('{"api_key": "[redacted]","name":"demo","password": "[redacted]"}');
  });

  it("redacts private keys and bearer tokens for display", () => {
    const text = [
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "-----BEGIN PRIVATE KEY-----",
      "secret-material",
      "-----END PRIVATE KEY-----",
      "sk-4a7b3c8d2e1f9a6b5c",
    ].join("\n");

    expect(redactSensitiveDisplayText(text)).toBe(
      [
        "Authorization: Bearer [redacted]",
        "[redacted private key]",
        "[redacted secret]",
      ].join("\n"),
    );
  });

  it("redacts sk-/ds- prefixed secret keys with high entropy", () => {
    expect(redactSensitiveDisplayText("key=sk-4a7b3c8d2e1f9a6b5c")).toBe(
      "key=[redacted secret]",
    );
    expect(redactSensitiveDisplayText("key=ds-9f3a2c8b1e5d7f4a6b9c0")).toBe(
      "key=[redacted secret]",
    );
  });

  it("does not redact sk-/ds- prefixed names without enough digits", () => {
    expect(redactSensitiveDisplayText("using sk-learn for ML")).toBe(
      "using sk-learn for ML",
    );
    expect(redactSensitiveDisplayText("using sk-learn-model-v2-beta-test")).toBe(
      "using sk-learn-model-v2-beta-test",
    );
  });

  it("detects long terminal write display payloads by byte length", () => {
    const text = "x".repeat(513);

    expect(shouldRedactTerminalWriteDisplayPayload(text)).toBe(true);
    expect(redactTerminalWriteDisplayText(text)).toBe(
      terminalWriteDisplayPlaceholder(text),
    );
  });

  it("detects base64-like terminal write display payloads", () => {
    const text = "a".repeat(128);

    expect(shouldRedactTerminalWriteDisplayPayload(text)).toBe(true);
    expect(redactTerminalWriteDisplayText(text)).toBe(
      "[redacted terminal_write payload 128 bytes]",
    );
  });

  it("keeps ordinary terminal writes readable while redacting embedded display secrets", () => {
    expect(
      redactTerminalWriteDisplayText("echo $PWD && export OPENAI_API_KEY=sk-test\n"),
    ).toBe("echo $PWD && export OPENAI_API_KEY=[redacted]\n");
  });
});
