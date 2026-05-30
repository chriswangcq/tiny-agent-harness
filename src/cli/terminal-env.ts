/**
 * Minimal seam for building the PTY env with the bound IM channel.
 * Extracted from src/cli/main.ts to allow testing without importing main.ts
 * (main.ts has a top-level `main().catch(...)` side-effect).
 */

/**
 * Strip undefined values from a ProcessEnv-like object,
 * returning a plain Record<string, string> suitable for child process env.
 */
export function cleanEnv(
  env: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
}

/**
 * Build the env object for the ManagedTerminalRuntime,
 * ensuring TAH_RUN_CHANNEL is always set to the bound channel.
 * Existing TAH_RUN_CHANNEL in the source env is overwritten.
 */
export function buildCliTerminalEnv(
  env: NodeJS.ProcessEnv,
  channel: string,
): Record<string, string> {
  const cleaned = cleanEnv(env);
  cleaned["TAH_RUN_CHANNEL"] = channel;
  return cleaned;
}
