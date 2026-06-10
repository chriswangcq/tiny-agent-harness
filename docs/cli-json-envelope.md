# CLI JSON Envelope Convention

## Purpose

All capability subcommands (`tiny-agent im`, `tiny-agent skill`, `tiny-agent mcp`, `tiny-agent codeq`) produce machine-readable JSON output through standardized success and failure envelopes. Agents parse capability results through terminal/session boundaries without special-casing every command.

## Convention

Every JSON line written to stdout is one envelope:

### Success envelope

```json
{
  "ok": true,
  "tool": "<tool-name>",
  "version": "<semver>",
  "cwd": "<optional>",
  "...command-specific fields..."
}
```

### Failure envelope (stdout or stderr)

```json
{
  "ok": false,
  "tool": "<tool-name>",
  "version": "<semver>",
  "cwd": "<optional>",
  "errorCode": "<code>",
  "error": "<human message>",
  "details": "<optional>"
}
```

## Implementation

- `src/cli/envelope.ts` provides `successEnvelope()` and `failureEnvelope()` helpers.
- Each CLI's `output()`/`writeStdout()` function wraps data in the appropriate envelope.
- `die()` functions write a failure envelope to stderr and exit.
- `output()` detects `ok: false` in wrapped data and routes to failure envelope on stdout.

## Tool Names and Versions

| Tool  | Name    | Version |
|-------|---------|---------|
| IM    | "im"    | 0.1.0   |
| Skill | "skill" | 0.1.0   |
| MCP   | "mcp"   | 0.1.0   |
| CodeQ | "codeq" | 0.1.0   |

## Exceptions

### codeq (Code Intelligence CLI)

`tiny-agent codeq` has its own established envelope format (`CodeIntelSuccess<T>` / `CodeIntelFailure`) defined in `src/code-intel/types.ts`. It is read-only for now and compatible with this convention: it uses `ok`, `tool`, `version`, `cwd`, `error` fields matching the standard shape.

### listen-mode commands

`tiny-agent im listen --json` streams individual message JSON objects line-by-line rather than a single envelope. This is by design for streaming use cases.

## Backward Compatibility

- Existing fields (id, channel, messages, skills, servers, etc.) are preserved inside the envelope.
- The envelope only adds `tool`, `version`, and optionally `cwd`.
- Non-JSON output (human-readable mode) is unchanged.
- `--json` flag behavior is unchanged; envelope wrapping is transparent to callers who just use `--json`.
