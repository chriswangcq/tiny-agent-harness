import { compactTerminalHistoryEntry } from "../terminal/history.js";
import type { TerminalHistoryLimits } from "../terminal/history.js";
import type { PtyObservation } from "../terminal/types.js";

export type CompactObservationHistoryEntry = {
  type: "observation";
  observation: PtyObservation | Record<string, unknown>;
};

export function toCompactTerminalHistoryEntry(
  observation: PtyObservation | Record<string, unknown>,
  limits: Partial<TerminalHistoryLimits> = {},
): CompactObservationHistoryEntry {
  const compact = compactTerminalHistoryEntry(
    { type: "terminal_observation", observation },
    limits,
  );

  return {
    type: "observation",
    observation: compact.observation,
  };
}
