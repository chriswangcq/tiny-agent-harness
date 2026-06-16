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
  runtimeHostSocket?: string;
  imRunId?: string;
  imSelfEndpoint?: string;
  imUserEndpoint?: string;
  skillRunsDir?: string;
  sessionsDir?: string;
  skillsDir?: string;
  transcriptPath?: string;
  environmentEventsPath?: string;
  codeqHostSocket?: string;
  codeqHostRunId?: string;
  skillHostSocket?: string;
  skillHostRunId?: string;
  mcpHostSocket?: string;
  mcpHostRunId?: string;
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
  delete cleaned.TAH_IM_HOST_SOCKET;
  delete cleaned.TAH_RUNTIME_HOST_SOCKET;

  assignIfDefined(cleaned, "TAH_RUN_ID", options.runId);
  assignIfDefined(cleaned, "TAH_RUN_DIR", options.runDir);
  assignIfDefined(cleaned, "TAH_STATE_DIR", options.stateDir ?? options.runDir);
  assignIfDefined(cleaned, "TAH_PROJECT_STATE_DIR", options.projectStateDir);
  assignIfDefined(cleaned, "TAH_RUNTIME_HOST_SOCKET", options.runtimeHostSocket);
  assignIfDefined(cleaned, "TAH_IM_RUN_ID", options.imRunId ?? options.runId);
  assignIfDefined(cleaned, "TAH_IM_SELF_ENDPOINT", options.imSelfEndpoint);
  assignIfDefined(cleaned, "TAH_IM_USER_ENDPOINT", options.imUserEndpoint);
  assignIfDefined(cleaned, "TAH_SKILL_RUNS_DIR", options.skillRunsDir);
  assignIfDefined(cleaned, "TAH_SESSIONS_DIR", options.sessionsDir);
  assignIfDefined(cleaned, "TAH_SKILLS_DIR", options.skillsDir);
  assignIfDefined(cleaned, "TAH_TRANSCRIPT_PATH", options.transcriptPath);
  assignIfDefined(cleaned, "TAH_CODEQ_HOST_SOCKET", options.codeqHostSocket);
  assignIfDefined(
    cleaned,
    "TAH_CODEQ_HOST_RUN_ID",
    options.codeqHostRunId ?? options.runId,
  );
  assignIfDefined(cleaned, "TAH_SKILL_HOST_SOCKET", options.skillHostSocket);
  assignIfDefined(
    cleaned,
    "TAH_SKILL_HOST_RUN_ID",
    options.skillHostRunId ?? options.runId,
  );
  assignIfDefined(cleaned, "TAH_MCP_HOST_SOCKET", options.mcpHostSocket);
  assignIfDefined(
    cleaned,
    "TAH_MCP_HOST_RUN_ID",
    options.mcpHostRunId ?? options.runId,
  );
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
