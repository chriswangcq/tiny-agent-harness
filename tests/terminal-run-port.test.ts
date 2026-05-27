import { describe, expect, it } from "vitest";
import { createTerminalRunPort } from "../src/application/terminal-run-port.js";
import type { PtyObservation } from "../src/terminal/types.js";

describe("createTerminalRunPort", () => {
  it("forwards PTY actions to TerminalService.handleAction", async () => {
    const calls: unknown[] = [];
    const observation: PtyObservation = {
      session: "default",
      owner: {
        kind: "shell",
        revision: 2,
        cwd: "/repo",
        promptSeq: 2,
        lastReturnCode: 0,
        promptNonce: "nonce",
      },
      action: { kind: "write_text", preview: "pwd" },
      result: "ok",
      events: [],
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
          expectedOwnerRevision: 1,
          text: "pwd",
        },
      }),
    ).resolves.toBe(observation);
    expect(calls).toEqual([
      {
        kind: "write_text",
        expectedOwnerRevision: 1,
        text: "pwd",
      },
    ]);
  });
});
