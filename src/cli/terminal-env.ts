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

export type CliTerminalEnvOptions = {
  runId?: string;
  runDir?: string;
  stateDir?: string;
  projectStateDir?: string;
  imStateDir?: string;
  imRunId?: string;
  imSelfEndpoint?: string;
  imUserEndpoint?: string;
  skillRunsDir?: string;
  sessionsDir?: string;
  skillsDir?: string;
  transcriptPath?: string;
  environmentEventsPath?: string;
};

/**
 * Build the env object for the ManagedTerminalRuntime, injecting the current
 * run identity and run-scoped paths so CLI tools executed inside the PTY never
 * need to guess which run they belong to.
 */
export function buildCliTerminalEnv(
  env: NodeJS.ProcessEnv,
  options: CliTerminalEnvOptions = {},
): Record<string, string> {
  const cleaned = cleanEnv(env);
  delete cleaned.TAH_IM_DIR;
  delete cleaned.TAH_RUN_CHANNEL;
  delete cleaned.TAH_IM_CHANNEL;

  assignIfDefined(cleaned, "TAH_RUN_ID", options.runId);
  assignIfDefined(cleaned, "TAH_RUN_DIR", options.runDir);
  assignIfDefined(cleaned, "TAH_STATE_DIR", options.stateDir ?? options.runDir);
  assignIfDefined(cleaned, "TAH_PROJECT_STATE_DIR", options.projectStateDir);
  assignIfDefined(cleaned, "TAH_IM_STATE_DIR", options.imStateDir);
  assignIfDefined(cleaned, "TAH_IM_RUN_ID", options.imRunId ?? options.runId);
  assignIfDefined(cleaned, "TAH_IM_SELF_ENDPOINT", options.imSelfEndpoint);
  assignIfDefined(cleaned, "TAH_IM_USER_ENDPOINT", options.imUserEndpoint);
  assignIfDefined(cleaned, "TAH_SKILL_RUNS_DIR", options.skillRunsDir);
  assignIfDefined(cleaned, "TAH_SESSIONS_DIR", options.sessionsDir);
  assignIfDefined(cleaned, "TAH_SKILLS_DIR", options.skillsDir);
  assignIfDefined(cleaned, "TAH_TRANSCRIPT_PATH", options.transcriptPath);
  assignIfDefined(
    cleaned,
    "TAH_ENVIRONMENT_EVENTS_PATH",
    options.environmentEventsPath,
  );
  return cleaned;
}

function assignIfDefined(
  env: Record<string, string>,
  key: string,
  value: string | undefined,
): void {
  if (value !== undefined) {
    env[key] = value;
  }
}
