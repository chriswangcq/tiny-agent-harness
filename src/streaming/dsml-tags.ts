import type {
  StreamTagAction,
  StreamTagDefinition,
} from "./tag-router.js";

export const DSML_STREAM_TAGS = {
  thinkingClose: "</think>",
  toolCallsOpen: "<｜DSML｜tool_calls>",
  toolCallsClose: "</｜DSML｜tool_calls>",
  invokeOpenPrefix: "<｜DSML｜invoke name=\"",
  invokeEchoPrefix: "invoke name=\"",
  invokeClose: "</｜DSML｜invoke>",
  parameterOpenPrefix: "<｜DSML｜parameter",
  parameterClose: "</｜DSML｜parameter>",
  endOfSentence: "<｜end▁of▁sentence｜>",
  legacyToolCallOpen: "<tool_call",
  legacyToolCallClose: "</tool_call>",
  legacyToolMarker: "｜tool",
} as const;

export type DsmlStreamTagId =
  | "thinking.close"
  | "dsml.tool_calls.open"
  | "dsml.tool_calls.close"
  | "dsml.invoke.open_prefix"
  | "dsml.invoke.echo_prefix"
  | "dsml.invoke.close"
  | "dsml.parameter.open_prefix"
  | "dsml.parameter.close"
  | "dsml.end_of_sentence"
  | "legacy.tool_call.open"
  | "legacy.tool_call.close"
  | "legacy.tool_marker";

export type DsmlStreamActions = Partial<
  Record<DsmlStreamTagId, StreamTagAction>
>;

export function createDsmlStreamTagDefinitions(
  actions: DsmlStreamActions = {},
): StreamTagDefinition[] {
  return [
    {
      id: "thinking.close",
      tag: DSML_STREAM_TAGS.thinkingClose,
      modes: ["thinking", "text", "decision"],
      action: actions["thinking.close"],
    },
    {
      id: "dsml.tool_calls.open",
      tag: DSML_STREAM_TAGS.toolCallsOpen,
      modes: ["thinking", "text", "decision"],
      action: actions["dsml.tool_calls.open"],
    },
    {
      id: "dsml.tool_calls.close",
      tag: DSML_STREAM_TAGS.toolCallsClose,
      modes: ["tool_calls", "invoke", "parameter", "decision"],
      action: actions["dsml.tool_calls.close"],
    },
    {
      id: "dsml.invoke.open_prefix",
      tag: DSML_STREAM_TAGS.invokeOpenPrefix,
      modes: ["tool_calls", "decision", "text"],
      action: actions["dsml.invoke.open_prefix"],
    },
    {
      id: "dsml.invoke.echo_prefix",
      tag: DSML_STREAM_TAGS.invokeEchoPrefix,
      modes: ["tool_calls", "decision", "text"],
      action: actions["dsml.invoke.echo_prefix"],
    },
    {
      id: "dsml.invoke.close",
      tag: DSML_STREAM_TAGS.invokeClose,
      modes: ["invoke", "parameter", "tool_calls", "decision"],
      action: actions["dsml.invoke.close"],
    },
    {
      id: "dsml.parameter.open_prefix",
      tag: DSML_STREAM_TAGS.parameterOpenPrefix,
      modes: ["invoke", "tool_calls", "decision"],
      action: actions["dsml.parameter.open_prefix"],
    },
    {
      id: "dsml.parameter.close",
      tag: DSML_STREAM_TAGS.parameterClose,
      modes: ["parameter", "invoke", "decision"],
      action: actions["dsml.parameter.close"],
    },
    {
      id: "dsml.end_of_sentence",
      tag: DSML_STREAM_TAGS.endOfSentence,
      modes: ["text", "tool_calls", "invoke", "parameter", "decision"],
      action: actions["dsml.end_of_sentence"],
    },
    {
      id: "legacy.tool_call.open",
      tag: DSML_STREAM_TAGS.legacyToolCallOpen,
      modes: ["thinking", "text", "decision"],
      action: actions["legacy.tool_call.open"],
    },
    {
      id: "legacy.tool_call.close",
      tag: DSML_STREAM_TAGS.legacyToolCallClose,
      modes: ["thinking", "text", "decision"],
      action: actions["legacy.tool_call.close"],
    },
    {
      id: "legacy.tool_marker",
      tag: DSML_STREAM_TAGS.legacyToolMarker,
      modes: ["thinking", "text", "decision"],
      action: actions["legacy.tool_marker"],
    },
  ];
}
