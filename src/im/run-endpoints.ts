export const DEFAULT_RUN_USER_ENDPOINT = "user:main";

export function createRunImSelfEndpoint(runId: string): string {
  return `run:${runId}`;
}
