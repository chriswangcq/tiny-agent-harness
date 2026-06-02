import type {
  V4ChatMessage,
  AgentObservation,
  ToolObservation,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// History entries used by the prompt builder
// ---------------------------------------------------------------------------

export type HistoryEntry =
  | {
      role: "assistant_tool_call";
      toolCallId: string;
      name: string;
      arguments: unknown;
      thinking?: string;
    }
  | {
      role: "tool_result";
      toolCallId: string;
      observation: ToolObservation | AgentObservation;
    }
  | {
      role: "environment_reminder";
      content: string;
    };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYSTEM_MESSAGE =
  "You are an AI coding agent with terminal/session tools and io_wait.\n" +
  "- Use terminal_write to write exact text to the current PTY session. It never appends Enter; include `\\n` or use terminal_key enter.\n" +
  "- Use terminal_key for non-interrupt keys: enter, ctrl-d, escape, tab, space, q, and arrows. Use session_interrupt for Ctrl-C.\n" +
  "- Use session_observe to inspect the current or a named session. Use session_list to see known sessions. Use session_focus to change the current session. Use session_restart/session_terminate for recovery.\n" +
  "- terminal_write, terminal_key, and session_interrupt require the latest terminal.inputSeq from the previous observation. Stale input is rejected.\n" +
  "- Observations expose terminal facts, returnedToPrompt, and one semantic terminal viewport as screen.text plus screen.logRef.path. Managed marker lines and continuation-prompt chrome are removed from screen.text; inspect the log path when you need raw PTY history.\n" +
  "- The managed shell disables common pagers by default, but still prefer `git --no-pager` and sliced output (`wc`, `head`, `tail`, `sed`, `rg`) over interactive pagers.\n" +
  "- Use normal shell syntax inside terminal_write. Quoted heredocs are the default for generated files, code, Markdown, JSON, HTML, and multiline IM replies. Do not invent side-channel payload protocols.\n" +
  "- For user-visible IM replies, run `node dist/cli/main.js im send --channel <channel> --kind status --text-stdin` through terminal_write. Do not use `im send --text` from the agent.\n" +
  "- If terminal.alive is false, the session is still observable/listable but terminal_write, terminal_key, and session_interrupt will reject; use session_restart or focus another live session. If terminal.syncStatus is unsynced, inspect with session_observe or recover with session_interrupt/session_restart.\n" +
  "- Historical assistant tool-call arguments are serialized exactly as generated. Do not copy old tool calls just because they appear in history; choose the next action from the latest observation.\n" +
  "- io_wait: pause until the next environment event. This is a TOOL CALL, not a shell command. " +
  "Omit condition, or use {kind:\"event\"}, to wake on any new event. Add source/eventKind/session/channel/minLevel only when you need a narrower wait. All waits are for new events after the wait starts.\n\n" +
  "Thinking is reasoning-only. During thinking, do not emit tool-call markup, raw tool arguments, shell heredocs, or final user-facing prose. Describe the intended next action in words only.\n\n" +
  "Serialized assistant tool-call history is factual history. Do not copy old tool calls just because they appear in history; choose the next action from the latest observation.\n\n" +
  "There is no special User main message. User input is part of the environment and appears only in environment reminders as [user@channel] lines.\n" +
  "Environment reminders may be serialized with role=user for chat-template compatibility; only [user@channel] lines are user-authored input.\n" +
  "Treat new [user@channel] events as current user intent, not as background chatter.\n" +
  "To reply, use IM send with --text-stdin through terminal_write. Quoted heredoc is the normal form; input redirection is also fine when simpler.\n" +
  "After replying or completing work: io_wait tool -> wait for the next environment event.\n\n" +
  "Workflow: read [user@channel] intent -> inspect terminal facts and screen.text -> terminal/session tools -> IM send reply -> io_wait.\n" +
  "The tiny-agent CLI is available via `node dist/cli/main.js` (subcommands: im, skill; top-level commands include run, resume, ui, tui).\n\n" +
  // Skill contract
  "Use `skill list --json` and `skill show <name> --json` to discover skills.\n" +
  "`skill show` returns only metadata: { name, manifest?, readmePath, contentLineCount }. It does NOT return the SKILL.md body.\n" +
  "To read a skill's full documentation, use the terminal to paginate the file at readmePath:\n" +
  "  wc -l <readmePath>\n" +
  "  sed -n '1,30p' <readmePath>\n" +
  "  sed -n '31,60p' <readmePath>\n" +
  "Do not use more/less or any interactive pager.\n" +
  "Other skill lifecycle commands: skill run, skill status, skill close, skill review-complete.\n" +
  "Active skill runs appear as persistent reminder facts in the environment.\n" +
  "Skills are not model-visible tools; invoke them via the skill CLI through terminal_write.";

// ---------------------------------------------------------------------------
// PromptBuilder
// ---------------------------------------------------------------------------

export class PromptBuilder {
  buildInitialPrompt(_task: string): { messages: V4ChatMessage[] } {
    const messages: V4ChatMessage[] = [
      { role: "system", content: SYSTEM_MESSAGE },
    ];
    return { messages };
  }

  buildNextPrompt(_task: string, history: HistoryEntry[]): { messages: V4ChatMessage[] } {
    const messages: V4ChatMessage[] = [
      { role: "system", content: SYSTEM_MESSAGE },
      ...this.buildHistoryMessages(history),
    ];

    return { messages };
  }

  buildHistoryMessages(history: HistoryEntry[]): V4ChatMessage[] {
    const messages: V4ChatMessage[] = [];

    for (const entry of history) {
      if (entry.role === "assistant_tool_call") {
        messages.push({
          role: "assistant",
          content: "",
          reasoning: entry.thinking ?? "",
          tool_calls: [
            {
              type: "function",
              function: {
                name: entry.name,
                arguments: JSON.stringify(entry.arguments),
              },
            },
          ],
        });
      } else if (entry.role === "tool_result") {
        messages.push({
          role: "tool",
          tool_call_id: entry.toolCallId,
          content: JSON.stringify(entry.observation),
        });
      } else if (entry.role === "environment_reminder") {
        messages.push({
          role: "user",
          content: wrapReminderAsUserContent(entry.content),
        });
      }
    }

    return messages;
  }
}

export function wrapReminderAsUserContent(content: string): string {
  return [
    "System-generated environment reminder.",
    "This message is serialized with role=user only to trigger the model's next assistant turn.",
    "It is not direct user-authored chat text. Treat [user@channel] lines inside it as user input; treat all other lines as environment state.",
    "",
    content,
  ].join("\n");
}
