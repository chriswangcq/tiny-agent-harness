import { describe, expect, it } from "vitest";
import { createTerminalRunPort } from "../src/application/terminal-run-port.js";
import type { TerminalObservation } from "../src/terminal/types.js";

describe("createTerminalRunPort", () => {
  it("forwards terminal tool requests to TerminalService.handleAction", async () => {
    const calls: unknown[] = [];
    const observation: TerminalObservation = {
      currentSession: "default",
      observedSession: "default",
      terminal: {
        inputSeq: 2,
        alive: true,
        syncStatus: { kind: "trusted" },
        lastShellPrompt: {
          cwd: "/repo",
          promptSeq: 2,
          lastReturnCode: 0,
        },
        lastContinuationPrompt: null,
        termination: null,
        foregroundProcess: null,
      },
      request: "terminal_write",
      result: "ok",
      returnedToPrompt: false,
      screen: {
        text: "pwd",
        rows: 24,
        cols: 80,
        window: {
          startLine: 0,
          endLine: 1,
          totalLines: 1,
          cols: 80,
          rows: 24,
          hasOlder: false,
          hasNewer: false,
        },
        truncated: false,
        logRef: { path: "managed-pty://default" },
      },
    };
    const port = createTerminalRunPort({
      async handleAction(request) {
        calls.push(request);
        return observation;
      },
    });

    await expect(
      port.execute({
        request: {
          kind: "terminal_write",
          expectedInputSeq: 1,
          text: "pwd",
        },
      }),
    ).resolves.toBe(observation);
    expect(calls).toEqual([
      {
        kind: "terminal_write",
        expectedInputSeq: 1,
        text: "pwd",
      },
    ]);
  });
});
