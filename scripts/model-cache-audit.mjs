#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DSML = "｜DSML｜";
const DSML_TOOL_CALLS_OPEN = `<${DSML}tool_calls>`;
const DSML_INVOKE_OPEN_PREFIX = `<${DSML}invoke name="`;

const args = parseArgs(process.argv.slice(2));
const transcriptPaths = resolveTranscriptPaths(args);
const reports = transcriptPaths.map((transcriptPath) =>
  analyzeTranscript(transcriptPath, args),
);

if (args.json) {
  console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
} else {
  for (const [index, report] of reports.entries()) {
    if (index > 0) console.log("");
    printReport(report, args);
  }
}

function parseArgs(argv) {
  const result = {
    target: undefined,
    all: false,
    json: false,
    verbose: false,
    dumpPromptsDir: undefined,
    minFragmentChars: 24,
  };

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--all") {
      result.all = true;
    } else if (arg === "--json") {
      result.json = true;
    } else if (arg === "--verbose") {
      result.verbose = true;
    } else if (arg === "--dump-prompts") {
      const value = argv[++index];
      if (!value) die("--dump-prompts requires a directory argument");
      result.dumpPromptsDir = value;
    } else if (arg.startsWith("--dump-prompts=")) {
      result.dumpPromptsDir = arg.slice("--dump-prompts=".length);
    } else if (arg.startsWith("--min-fragment-chars=")) {
      const value = Number(arg.slice("--min-fragment-chars=".length));
      if (!Number.isFinite(value) || value < 1) {
        die("--min-fragment-chars must be a positive number");
      }
      result.minFragmentChars = Math.trunc(value);
    } else if (arg === "-h" || arg === "--help") {
      printUsage();
      process.exit(0);
    } else if (!result.target) {
      result.target = arg;
    } else {
      die(`Unexpected argument: ${arg}`);
    }
  }

  return result;
}

function printUsage() {
  console.log(`Usage:
  node scripts/model-cache-audit.mjs [run-dir|transcript.jsonl]
  node scripts/model-cache-audit.mjs --all

Options:
  --json                     Print machine-readable JSON.
  --verbose                  Include raw provider usage records in text output.
  --dump-prompts <dir>       Write known/reconstructed model prompts to files.
  --min-fragment-chars=N     Minimum generated fragment size for carryover checks.

Default target is .tiny-agent/runs/latest.json.`);
}

function resolveTranscriptPaths(args) {
  if (args.all) {
    const runsRoot = path.resolve(".tiny-agent/runs");
    if (!fs.existsSync(runsRoot)) return [];
    return fs
      .readdirSync(runsRoot)
      .filter((entry) => entry.startsWith("run-"))
      .map((entry) => path.join(runsRoot, entry, "transcript.jsonl"))
      .filter((file) => fs.existsSync(file))
      .sort();
  }

  const target = args.target ?? defaultLatestRunDir();
  const resolved = path.resolve(target);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    const transcript = path.join(resolved, "transcript.jsonl");
    if (!fs.existsSync(transcript)) {
      die(`No transcript.jsonl under ${resolved}`);
    }
    return [transcript];
  }
  if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
    return [resolved];
  }

  die(`Cannot find run dir or transcript: ${target}`);
}

function defaultLatestRunDir() {
  const latestPath = path.resolve(".tiny-agent/runs/latest.json");
  if (!fs.existsSync(latestPath)) return ".tiny-agent/runs/latest";
  const latest = JSON.parse(fs.readFileSync(latestPath, "utf8"));
  return latest.runDir ?? ".tiny-agent/runs/latest";
}

function analyzeTranscript(transcriptPath, args) {
  const events = readJsonl(transcriptPath);
  const runStarted = events.find((event) => event.type === "run_started");
  const modelOutputs = events.filter(
    (event) => event.type === "model_output_received",
  );
  const modelRequests = events.filter((event) => event.type === "model_requested");
  const calls = [];
  const carryover = [];

  for (const event of modelOutputs) {
    calls.push(...modelCallsForOutput(event));
  }
  annotateCallPrefixReuse(calls);

  for (let index = 0; index < modelOutputs.length - 1; index++) {
    carryover.push(
      analyzeCarryover(
        modelOutputs[index],
        modelOutputs[index + 1],
        args.minFragmentChars,
      ),
    );
  }

  const providerTotals = summarizeProviderCache(calls);
  const promptDump = args.dumpPromptsDir
    ? dumpPrompts(args.dumpPromptsDir, transcriptPath, calls)
    : undefined;

  return {
    runId: runStarted?.runId ?? inferRunId(transcriptPath),
    transcriptPath,
    modelRequests: modelRequests.length,
    modelOutputs: modelOutputs.length,
    unfinishedModelRequests: Math.max(0, modelRequests.length - modelOutputs.length),
    providerCache: providerTotals,
    calls,
    carryover,
    promptDump,
  };
}

function readJsonl(file) {
  const events = [];
  const lines = fs.readFileSync(file, "utf8").split(/\n/u);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch (error) {
      throw new Error(`${file}:${index + 1}: invalid JSONL: ${error.message}`);
    }
  }
  return events;
}

function modelCallsForOutput(event) {
  const output = event.output ?? {};
  const thinking = output.thinking ?? {};
  const thinkingPrompt = stringOrUndefined(thinking.raw?.prompt);
  const decisionPrompt =
    stringOrUndefined(output.usage?.decision?.prompts?.[0]) ??
    reconstructDecisionPrompt(thinkingPrompt, thinking.content);

  return [
    ...phaseCalls({
      stepIndex: event.stepIndex,
      phase: "thinking",
      phaseUsage: output.usage?.thinking,
      fallbackPrompt: thinkingPrompt,
    }),
    ...phaseCalls({
      stepIndex: event.stepIndex,
      phase: "decision",
      phaseUsage: output.usage?.decision,
      fallbackPrompt: decisionPrompt,
    }),
  ];
}

function phaseCalls({ stepIndex, phase, phaseUsage, fallbackPrompt }) {
  const usages = Array.isArray(phaseUsage?.usages) ? phaseUsage.usages : [];
  const prompts = Array.isArray(phaseUsage?.prompts) ? phaseUsage.prompts : [];
  const count = Math.max(1, usages.length, prompts.length);
  const calls = [];

  for (let requestIndex = 0; requestIndex < count; requestIndex++) {
    const prompt = stringOrUndefined(prompts[requestIndex]) ??
      (requestIndex === 0 ? fallbackPrompt : undefined);
    const usage = isRecord(usages[requestIndex]) ? usages[requestIndex] : undefined;
    const call = {
      stepIndex,
      phase,
      requestIndex,
      prompt: prompt
        ? {
            chars: prompt.length,
            bytes: Buffer.byteLength(prompt, "utf8"),
            sha256: sha256(prompt),
          }
        : undefined,
      providerUsage: usage,
      providerCache: usage ? cacheStatsFromUsage(usage) : { status: "missing" },
    };
    if (prompt) {
      Object.defineProperty(call, "_promptText", {
        value: prompt,
        enumerable: false,
      });
    }
    calls.push(call);
  }

  return calls;
}

function annotateCallPrefixReuse(calls) {
  let previousPrompt;
  for (const call of calls) {
    call.prefixReuseFromPreviousCall = undefined;
    const prompt = promptByHashSource(call);
    if (previousPrompt && prompt) {
      const commonChars = commonPrefixLength(previousPrompt, prompt);
      call.prefixReuseFromPreviousCall = {
        commonChars,
        previousPromptChars: previousPrompt.length,
        ratio: previousPrompt.length === 0 ? 1 : commonChars / previousPrompt.length,
      };
    }
    if (prompt) previousPrompt = prompt;
  }
}

function promptByHashSource(call) {
  return call._promptText;
}

function analyzeCarryover(previousEvent, nextEvent, minFragmentChars) {
  const previous = previousEvent.output ?? {};
  const next = nextEvent.output ?? {};
  const previousPrompt = stringOrUndefined(previous.thinking?.raw?.prompt);
  const nextPrompt = stringOrUndefined(next.thinking?.raw?.prompt) ?? "";
  const previousThinking = stringOrUndefined(previous.thinking?.content) ?? "";
  const decisionPrompt = reconstructDecisionPrompt(
    previousPrompt,
    previousThinking,
  );
  const fragments = generatedFragments(previous.turn, minFragmentChars);
  const fragmentHits = fragments.map((fragment) => ({
    chars: fragment.length,
    preview: preview(fragment),
    present: nextPrompt.includes(fragment),
  }));

  return {
    fromStep: previousEvent.stepIndex,
    toStep: nextEvent.stepIndex,
    thinkingPresent:
      previousThinking.length >= minFragmentChars
        ? nextPrompt.includes(previousThinking)
        : undefined,
    generatedFragmentHits: fragmentHits,
    generatedFragmentsPresent:
      fragmentHits.length === 0
        ? undefined
        : fragmentHits.every((fragment) => fragment.present),
    previousThinkingPromptPrefixReuse: previousPrompt
      ? ratioObject(commonPrefixLength(previousPrompt, nextPrompt), previousPrompt.length)
      : undefined,
    previousDecisionPromptPrefixReuse: decisionPrompt
      ? ratioObject(commonPrefixLength(decisionPrompt, nextPrompt), decisionPrompt.length)
      : undefined,
  };
}

function generatedFragments(turn, minFragmentChars) {
  const fragments = [];
  if (!isRecord(turn)) return fragments;
  if (turn.kind === "tool_call") {
    collectStringLeaves(turn.toolCall?.arguments, fragments, minFragmentChars);
  } else if (turn.kind === "io_wait") {
    const wait = JSON.stringify(turn.wait ?? {});
    if (wait.length >= minFragmentChars) fragments.push(wait);
  } else if (turn.kind === "invalid_output") {
    const rawDecision = stringOrUndefined(turn.rawDecision);
    if (rawDecision && rawDecision.length >= minFragmentChars) {
      fragments.push(rawDecision);
    }
  }
  return fragments;
}

function collectStringLeaves(value, fragments, minFragmentChars) {
  if (typeof value === "string") {
    if (value.length >= minFragmentChars) fragments.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, fragments, minFragmentChars);
    return;
  }
  if (isRecord(value)) {
    for (const item of Object.values(value)) {
      collectStringLeaves(item, fragments, minFragmentChars);
    }
  }
}

function reconstructDecisionPrompt(thinkingPrompt, thinking) {
  if (!thinkingPrompt) return undefined;
  const sanitized = sanitizeThinkingForDecisionPrompt(stringOrUndefined(thinking) ?? "");
  return [
    thinkingPrompt,
    sanitized,
    `</think>\n\n${DSML_TOOL_CALLS_OPEN}\n${DSML_INVOKE_OPEN_PREFIX}`,
  ].join("");
}

function sanitizeThinkingForDecisionPrompt(content) {
  const withoutDsmlBlocks = content
    .replace(/<｜DSML｜tool_calls>[\s\S]*?(?:<\/｜DSML｜tool_calls>|$)/gu, "")
    .replace(/<｜DSML｜invoke name="[^"]*">[\s\S]*?(?:<\/｜DSML｜invoke>|$)/gu, "");
  const safeLines = withoutDsmlBlocks
    .split(/\r?\n/u)
    .filter((line) => !line.includes("｜tool"))
    .filter((line) => !line.includes("｜DSML｜"))
    .filter((line) => !line.includes("<tool_call"))
    .filter((line) => !line.includes("</tool_call>"));
  const sanitized = safeLines.join("\n").trim();
  return sanitized || "Prior thinking contained only decision-frame markup and was omitted.";
}

function summarizeProviderCache(calls) {
  let hitTokens = 0;
  let missTokens = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let callsWithUsage = 0;
  let callsWithCacheFields = 0;

  for (const call of calls) {
    const stats = call.providerCache;
    if (call.providerUsage) callsWithUsage++;
    if (stats.status === "ok") {
      callsWithCacheFields++;
      hitTokens += stats.hitTokens;
      missTokens += stats.missTokens;
      promptTokens += stats.promptTokens ?? stats.hitTokens + stats.missTokens;
    }
    const completion = numericField(call.providerUsage, [
      "completion_tokens",
      "completionTokens",
    ]);
    if (completion !== undefined) completionTokens += completion;
  }

  return {
    calls: calls.length,
    callsWithUsage,
    callsWithCacheFields,
    hitTokens,
    missTokens,
    promptTokens,
    completionTokens,
    hitRate:
      hitTokens + missTokens > 0 ? hitTokens / (hitTokens + missTokens) : undefined,
  };
}

function cacheStatsFromUsage(usage) {
  const hitTokens = numericField(usage, [
    "prompt_cache_hit_tokens",
    "promptCacheHitTokens",
    "cached_tokens",
    "cachedTokens",
    "cache_read_input_tokens",
    "cacheReadInputTokens",
  ]);
  const nestedCachedTokens = numericField(usage.prompt_tokens_details, [
    "cached_tokens",
    "cachedTokens",
  ]);
  const missTokens = numericField(usage, [
    "prompt_cache_miss_tokens",
    "promptCacheMissTokens",
    "cache_creation_input_tokens",
    "cacheCreationInputTokens",
  ]);
  const promptTokens = numericField(usage, ["prompt_tokens", "promptTokens"]);
  const resolvedHitTokens = hitTokens ?? nestedCachedTokens;

  if (resolvedHitTokens === undefined && missTokens === undefined) {
    return { status: "usage_without_cache_fields", promptTokens };
  }

  const hit = resolvedHitTokens ?? 0;
  const miss = missTokens ?? Math.max(0, (promptTokens ?? hit) - hit);
  return {
    status: "ok",
    hitTokens: hit,
    missTokens: miss,
    promptTokens: promptTokens ?? hit + miss,
    hitRate: hit + miss > 0 ? hit / (hit + miss) : undefined,
  };
}

function dumpPrompts(dir, transcriptPath, calls) {
  const absDir = path.resolve(dir);
  fs.mkdirSync(absDir, { recursive: true });
  const manifest = [];
  const source = path.basename(path.dirname(transcriptPath));

  for (const call of calls) {
    const prompt = call._promptText;
    if (!prompt) continue;
    const fileName = `${source}-step-${String(call.stepIndex).padStart(3, "0")}-${call.phase}-${call.requestIndex}.prompt.txt`;
    const filePath = path.join(absDir, fileName);
    fs.writeFileSync(filePath, prompt, "utf8");
    manifest.push({
      stepIndex: call.stepIndex,
      phase: call.phase,
      requestIndex: call.requestIndex,
      filePath,
      chars: prompt.length,
      bytes: Buffer.byteLength(prompt, "utf8"),
      sha256: sha256(prompt),
    });
  }

  const manifestPath = path.join(absDir, `${source}-manifest.json`);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
  return { dir: absDir, manifestPath, prompts: manifest.length };
}

function printReport(report, args) {
  console.log(`Model cache audit: ${report.runId}`);
  console.log(`transcript: ${report.transcriptPath}`);
  console.log(
    `model requests=${report.modelRequests} outputs=${report.modelOutputs} unfinished=${report.unfinishedModelRequests}`,
  );
  const cache = report.providerCache;
  console.log(
    `provider cache: usageCalls=${cache.callsWithUsage}/${cache.calls} cacheFieldCalls=${cache.callsWithCacheFields}/${cache.calls} hit=${cache.hitTokens} miss=${cache.missTokens} hitRate=${formatPercent(cache.hitRate)}`,
  );
  if (cache.callsWithCacheFields === 0) {
    console.log(
      "provider cache note: no prompt_cache_* fields found in this transcript; use a new run after adapter usage logging is enabled.",
    );
  }
  if (report.promptDump) {
    console.log(
      `prompt dump: ${report.promptDump.prompts} files -> ${report.promptDump.manifestPath}`,
    );
  }

  console.log("");
  console.log("API calls");
  console.log(
    [
      "idx",
      "step",
      "phase",
      "req",
      "promptBytes",
      "prevPrefix",
      "cacheHit",
      "cacheMiss",
      "cacheRate",
      "usage",
    ].join("\t"),
  );
  report.calls.forEach((call, index) => {
    const provider = call.providerCache;
    console.log(
      [
        index,
        call.stepIndex,
        call.phase,
        call.requestIndex,
        call.prompt?.bytes ?? "unknown",
        formatPercent(call.prefixReuseFromPreviousCall?.ratio),
        provider.hitTokens ?? "",
        provider.missTokens ?? "",
        formatPercent(provider.hitRate),
        provider.status,
      ].join("\t"),
    );
    if (args.verbose && call.providerUsage) {
      console.log(`  rawUsage=${JSON.stringify(call.providerUsage)}`);
    }
  });

  console.log("");
  console.log("Generated context carryover");
  console.log(
    [
      "from",
      "to",
      "thinking",
      "fragments",
      "prevThinkingPrefix",
      "prevDecisionPrefix",
    ].join("\t"),
  );
  for (const item of report.carryover) {
    const fragments =
      item.generatedFragmentsPresent === undefined
        ? "n/a"
        : `${item.generatedFragmentHits.filter((hit) => hit.present).length}/${item.generatedFragmentHits.length}`;
    console.log(
      [
        item.fromStep,
        item.toStep,
        item.thinkingPresent === undefined ? "n/a" : item.thinkingPresent ? "yes" : "NO",
        fragments,
        formatPercent(item.previousThinkingPromptPrefixReuse?.ratio),
        formatPercent(item.previousDecisionPromptPrefixReuse?.ratio),
      ].join("\t"),
    );
    if (args.verbose) {
      for (const hit of item.generatedFragmentHits.filter((hit) => !hit.present)) {
        console.log(`  missingFragment chars=${hit.chars} preview=${JSON.stringify(hit.preview)}`);
      }
    }
  }
}

function ratioObject(commonChars, totalChars) {
  return {
    commonChars,
    totalChars,
    ratio: totalChars === 0 ? 1 : commonChars / totalChars,
  };
}

function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a.charCodeAt(index) === b.charCodeAt(index)) {
    index++;
  }
  return index;
}

function numericField(object, keys) {
  if (!isRecord(object)) return undefined;
  for (const key of keys) {
    const value = object[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function stringOrUndefined(value) {
  return typeof value === "string" ? value : undefined;
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

function preview(text) {
  return text.length <= 120 ? text : `${text.slice(0, 117)}...`;
}

function formatPercent(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
  return `${(value * 100).toFixed(1)}%`;
}

function inferRunId(transcriptPath) {
  return path.basename(path.dirname(transcriptPath));
}

function die(message) {
  console.error(`model-cache-audit: ${message}`);
  process.exit(1);
}
