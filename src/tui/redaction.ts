// Display-only redaction for TUI. Must never be imported by model context, runtime state, or transcript paths.
export type DisplayRedactionOptions = {
  terminalWritePayloadBytes?: number;
};

export const DEFAULT_DISPLAY_REDACTION_OPTIONS: Required<DisplayRedactionOptions> = {
  terminalWritePayloadBytes: 512,
};

const PRIVATE_KEY_PATTERN =
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu;

const ENV_SECRET_ASSIGNMENT_PATTERN =
  /\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD|PASSWD|AUTH)[A-Z0-9_]*)\s*=\s*(['"]?)([^\s'"]+)\2/giu;

const JSON_SECRET_PROPERTY_PATTERN =
  /(["'])([^"']*(?:api[_-]?key|token|secret|password|passwd|auth)[^"']*)\1\s*:\s*(["'])(.*?)\3/giu;

const BEARER_TOKEN_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gu;
const SECRET_KEY_PATTERN = /\b(?:sk|ds)-(?=[A-Za-z0-9_-]*\d[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{18,}\b/gu;

export function redactSensitiveDisplayText(text: string): string {
  return text
    .replace(PRIVATE_KEY_PATTERN, "[redacted private key]")
    .replace(ENV_SECRET_ASSIGNMENT_PATTERN, (_match, name: string) => {
      return `${name}=[redacted]`;
    })
    .replace(
      JSON_SECRET_PROPERTY_PATTERN,
      (_match, quote: string, key: string, valueQuote: string) => {
        return `${quote}${key}${quote}: ${valueQuote}[redacted]${valueQuote}`;
      },
    )
    .replace(BEARER_TOKEN_PATTERN, "Bearer [redacted]")
    .replace(SECRET_KEY_PATTERN, "[redacted secret]");
}

export function shouldRedactTerminalWriteDisplayPayload(
  text: string,
  options: DisplayRedactionOptions = {},
): boolean {
  const resolved = { ...DEFAULT_DISPLAY_REDACTION_OPTIONS, ...options };
  if (Buffer.byteLength(text, "utf8") > resolved.terminalWritePayloadBytes) {
    return true;
  }

  const line = text.trim();
  return line.length >= 128 && line.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(line);
}

export function terminalWriteDisplayPlaceholder(text: string): string {
  return `[redacted terminal_write payload ${Buffer.byteLength(text, "utf8")} bytes]`;
}

export function redactTerminalWriteDisplayText(
  text: string,
  options: DisplayRedactionOptions = {},
): string {
  if (shouldRedactTerminalWriteDisplayPayload(text, options)) {
    return terminalWriteDisplayPlaceholder(text);
  }
  return redactSensitiveDisplayText(text);
}
