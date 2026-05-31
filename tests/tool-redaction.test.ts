import { describe, expect, it } from "vitest";
import {
  redactSensitiveText,
  redactTerminalWriteText,
  shouldRedactTerminalWritePayload,
  terminalWritePayloadPlaceholder,
} from "../src/tools/redaction.js";

describe("tool redaction core", () => {
  it("redacts environment-style secret assignments", () => {
    expect(
      redactSensitiveText(
        "export DEEPSEEK_API_KEY=ds-secret-value TOKEN='abc123' normal=value",
      ),
    ).toBe("export DEEPSEEK_API_KEY=[redacted] TOKEN=[redacted] normal=value");
  });

  it("redacts json-style secret properties", () => {
    expect(
      redactSensitiveText('{"api_key":"ds-secret-value","name":"demo","password":"pw"}'),
    ).toBe('{"api_key": "[redacted]","name":"demo","password": "[redacted]"}');
  });

  it("redacts private keys and bearer tokens", () => {
    const text = [
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
      "-----BEGIN PRIVATE KEY-----",
      "secret-material",
      "-----END PRIVATE KEY-----",
      "sk-abcdefghijklmnopqrstuvwxyz",
    ].join("\n");

    expect(redactSensitiveText(text)).toBe(
      [
        "Authorization: Bearer [redacted]",
        "[redacted private key]",
        "[redacted secret]",
      ].join("\n"),
    );
  });

  it("detects long terminal write payloads by byte length", () => {
    const text = "x".repeat(513);

    expect(shouldRedactTerminalWritePayload(text)).toBe(true);
    expect(redactTerminalWriteText(text)).toBe(terminalWritePayloadPlaceholder(text));
  });

  it("detects base64-like terminal write payloads", () => {
    const text = "a".repeat(128);

    expect(shouldRedactTerminalWritePayload(text)).toBe(true);
    expect(redactTerminalWriteText(text)).toBe(
      "[redacted terminal_write payload 128 bytes]",
    );
  });

  it("keeps ordinary terminal writes readable while redacting embedded secrets", () => {
    expect(redactTerminalWriteText("echo $PWD && export OPENAI_API_KEY=sk-test\n")).toBe(
      "echo $PWD && export OPENAI_API_KEY=[redacted]\n",
    );
  });
});
