const SENSITIVE_KEY_RE = /^(authorization|cookie|set-cookie|proxy-authorization|x-api-key|api-key|token|access-token|refresh-token|secret|password)$/iu;
const HEADER_RE = /^\s*([^:]+):\s*(.*)$/u;

export function redactSensitive(value: unknown): unknown {
  return redactValue(value);
}

function redactValue(value: unknown, key?: string): unknown {
  if (isSensitiveKey(key)) return "<redacted>";
  if (Array.isArray(value)) return redactArray(value);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = redactValue(childValue, childKey);
    }
    return out;
  }
  if (typeof value === "string") return redactString(value);
  return value;
}

function redactArray(values: unknown[]): unknown[] {
  return values.map((value, index) => {
    const previous = values[index - 1];
    if (typeof previous === "string" && isHeaderFlag(previous) && typeof value === "string") {
      return redactHeaderString(value);
    }
    return redactValue(value);
  });
}

function redactString(value: string): string {
  return redactHeaderString(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/\-=]+/gu, "Bearer <redacted>")
    .replace(/\b(api[_-]?key|token|secret|password)=([^&\s]+)/giu, "$1=<redacted>");
}

function redactHeaderString(value: string): string {
  const match = HEADER_RE.exec(value);
  if (!match) return value;
  const [, headerName] = match;
  const normalizedHeaderName = headerName.trim();
  if (!isSensitiveKey(normalizedHeaderName)) return value;
  return `${normalizedHeaderName}: <redacted>`;
}

function isHeaderFlag(value: string): boolean {
  return value === "--header" || value === "-H";
}

function isSensitiveKey(key: string | undefined): boolean {
  return Boolean(key && SENSITIVE_KEY_RE.test(key));
}
