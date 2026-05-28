import { describe, expect, it } from "vitest";
import { createTerminalRunPort } from "../src/application/terminal-run-port.js";
import type { PtyObservation } from "../src/terminal/types.js";

describe("createTerminalRunPort", () => {
  it("forwards PTY actions to TerminalService.handleAction", async () => {
    const calls: unknown[] = [];
    const observation: PtyObservation = {
      session: "default",
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
      },
      action: { kind: "write_text", preview: "pwd" },
      result: "ok",
      eventCount: 0,
      returnedToPrompt: false,
    };
    const port = createTerminalRunPort({
      async handleAction(action) {
        calls.push(action);
        return observation;
      },
    });

    await expect(
      port.execute({
        action: {
          kind: "write_text",
          expectedInputSeq: 1,
          text: "pwd",
        },
      }),
    ).resolves.toBe(observation);
    expect(calls).toEqual([
      {
        kind: "write_text",
        expectedInputSeq: 1,
        text: "pwd",
      },
    ]);
  });
});
