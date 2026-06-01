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
      "sk-abcdefghijklmnopqrstuvwxyz",
    ].join("\n");

    expect(redactSensitiveDisplayText(text)).toBe(
      [
        "Authorization: Bearer [redacted]",
        "[redacted private key]",
        "[redacted secret]",
      ].join("\n"),
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
