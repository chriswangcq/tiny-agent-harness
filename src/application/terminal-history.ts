import { compactTerminalHistoryEntry } from "../terminal/history.js";
import type { TerminalHistoryLimits } from "../terminal/history.js";
import type { TerminalObservation } from "../terminal/types.js";

export type CompactObservationHistoryEntry = {
  type: "observation";
  observation: TerminalObservation | Record<string, unknown>;
};

export function toCompactTerminalHistoryEntry(
  observation: TerminalObservation | Record<string, unknown>,
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
