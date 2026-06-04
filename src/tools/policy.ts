import type { ToolRequest } from "../types/tools.js";

export type ToolPolicyStatus = "approved" | "rejected";

export type ToolPolicySeverity = "info" | "warning" | "error";

export type ToolPolicyRuleCode =
  | "safe_terminal_key"
  | "safe_terminal_write"
  | "safe_session_tool"
  | "dangerous_recursive_delete"
  | "dangerous_disk_write"
  | "dangerous_filesystem_format"
  | "dangerous_permission_change"
  | "dangerous_pipe_to_shell"
  | "dangerous_privileged_command"
  | "dangerous_force_push"
  | "dangerous_fork_bomb"
  | "dangerous_secret_read"
  | "dangerous_system_path_write"
  | "dangerous_overlong_input"
  | "warning_network_transfer"
  | "warning_global_package_install"
  | "warning_recursive_permission_change"
  | "warning_ownership_change"
  | "warning_git_push";

export type ToolPolicyFinding = {
  code: ToolPolicyRuleCode;
  severity: ToolPolicySeverity;
  message: string;
};

export type ToolPolicyOptions = {
  allowDangerousTerminalWrites?: boolean;
  maxWriteLength?: number;
};

export type ToolPolicyDecision = {
  status: ToolPolicyStatus;
  reason: string;
  findings: ToolPolicyFinding[];
  warnings: string[];
};

type Rule = {
  code: ToolPolicyRuleCode;
  severity: ToolPolicySeverity;
  message: string;
  pattern: RegExp;
};

const DEFAULT_MAX_WRITE_LENGTH = 32_000;

const SYSTEM_PATH = String.raw`\/etc\/|\/usr\/|\/bin\/|\/sbin\/|\/System\/|\/Library\/|\/boot\/|\/dev\/|\/proc\/|\/sys\/`;

const DANGEROUS_TERMINAL_WRITE_RULES: Rule[] = [
  {
    code: "dangerous_recursive_delete",
    severity: "error",
    message: "Recursive delete targets a root, home, or wildcard path.",
    pattern:
      /\brm\s+-[^\n;]*[rR][fF]?[^\n;]*\s+(?:"\/"|'\/'|\/(?:\s|$)|\/\*|~(?:\/|\s|$)|["']?\$HOME["']?(?:\/|\s|$))/u,
  },
  {
    code: "dangerous_disk_write",
    severity: "error",
    message: "Raw disk write or destructive device input/output was requested.",
    pattern: /\bdd\s+[^;\n]*(?:\bof=\/dev\/|\bif=\/dev\/(?:zero|urandom))/u,
  },
  {
    code: "dangerous_filesystem_format",
    severity: "error",
    message: "Filesystem formatting command was requested.",
    pattern: /\bmkfs(?:\.[\w-]+)?\b/u,
  },
  {
    code: "dangerous_permission_change",
    severity: "error",
    message: "Recursive broad permission change targets a root, home, or system path.",
    pattern: new RegExp(
      String.raw`\bchmod\s+-R\s+\S+\s+(?:"\/"|'\/'|\/(?:\s|$)|\/\*|~(?:\/|\s|$)|["']?\$HOME["']?(?:\/|\s|$)|\/(?:etc|usr|bin|sbin|System|Library|boot|dev|proc|sys)\b)`,
      "u",
    ),
  },
  {
    // Pipe | bash, pipe | sudo -E bash, pipe | sudo --preserve-env bash,
    // bash <(curl ...), source <(wget ...)
    code: "dangerous_pipe_to_shell",
    severity: "error",
    message: "Downloaded content is executed in a shell (pipe or process substitution).",
    pattern:
      /\b(?:curl|wget)\b[^;\n|]*\|\s*(?:sudo(?:\s+(?:-[A-Za-z]+|--[A-Za-z][A-Za-z-]*)\b)*\s+)?(?:ba)?sh\b|(?:bash|sh|source|\.)\s+<\(\s*(?:curl|wget)\b/u,
  },
  {
    code: "dangerous_privileged_command",
    severity: "error",
    message: "Privileged destructive system command was requested.",
    pattern:
      /\bsudo\s+(?:rm|chmod|chown|dd|mkfs|shutdown|reboot|halt|poweroff)\b/u,
  },
  {
    code: "dangerous_force_push",
    severity: "error",
    message: "Force push can rewrite remote history.",
    pattern:
      /\bgit\s+push\b[^\n;]*(?:--force(?:-with-lease)?|[+-]f(?:\s|$)|\+[a-zA-Z][\w/.-]*)/u,
  },
  {
    code: "dangerous_fork_bomb",
    severity: "error",
    message: "Fork bomb pattern was requested.",
    pattern: /:\s*\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/u,
  },
  {
    code: "dangerous_secret_read",
    severity: "error",
    message: "Terminal write attempts to read a likely secret file.",
    pattern:
      /\b(?:cat|less|more|head|tail|sed|awk|grep|rg)\b[^\n;]*(?:~\/\.ssh\/(?:id_[\w-]+|config)|(?:^|[\s/])(?:ak\.txt|\.env(?:\.(?:local|production|development|test|staging|prod|dev))?|\.npmrc|\.netrc|\.git-credentials|id_rsa|id_ecdsa|id_ed25519|[^\s/]+\.pem|[^\s/]+\.key|[^\s/]+\.p12|credentials|secrets)(?:\s|$))/u,
  },
  {
    // Write to a system directory.
    //   a) Redirect / tee – destination follows the operator.
    //   b) cp / mv / install / touch / mkdir – greedy .* ensures only the LAST
    //      system-path token matches; $ terminator handles input without \n.
    code: "dangerous_system_path_write",
    severity: "error",
    message: "Terminal write attempts to modify a system directory.",
    pattern: new RegExp(
      String.raw`(?:>\s*|>>\s*|\btee\s+(?:-a\s+)?)(?:${SYSTEM_PATH})` +
      String.raw`|\b(?:cp|mv|install|touch|mkdir)\b.*\s(?:${SYSTEM_PATH})\S*\s*(?:[;\n]|$)`,
      "u",
    ),
  },
];

const WARNING_TERMINAL_WRITE_RULES: Rule[] = [
  {
    code: "warning_network_transfer",
    severity: "warning",
    message: "Network transfer command may fetch unreviewed remote content.",
    pattern: /\b(?:curl|wget)\b/u,
  },
  {
    code: "warning_global_package_install",
    severity: "warning",
    message: "Global package installation mutates the developer environment.",
    pattern:
      /\b(?:npm|pnpm|yarn)\s+(?:install|add)\b[^\n;]*(?:\s-g(?:$|\s)|--global\b)|\byarn\s+global\s+(?:add|upgrade)\b/u,
  },
  {
    code: "warning_recursive_permission_change",
    severity: "warning",
    message: "Recursive permission changes can be hard to undo.",
    pattern: /\bchmod\s+-R\b/u,
  },
  {
    code: "warning_ownership_change",
    severity: "warning",
    message: "Ownership changes can break local project access and are hard to undo.",
    pattern: /\bchown\b/u,
  },
  {
    code: "warning_git_push",
    severity: "warning",
    message: "Git push changes remote state.",
    pattern: /\bgit\s+push\b/u,
  },
];

export function evaluateToolPolicy(
  request: ToolRequest,
  options: ToolPolicyOptions = {},
): ToolPolicyDecision {
  const terminalRequest = request.request;

  if (terminalRequest.kind === "terminal_write") {
    return evaluateTerminalWrite(terminalRequest.text, options);
  }

  if (terminalRequest.kind === "terminal_key") {
    return approved("Terminal key input is allowed.", [
      {
        code: "safe_terminal_key",
        severity: "info",
        message: "Terminal key input is constrained to the current session key allowlist.",
      },
    ]);
  }

  return approved("Session/read tool is allowed.", [
    {
      code: "safe_session_tool",
      severity: "info",
      message: "Session and read-only terminal tools are allowed by default.",
    },
  ]);
}

function evaluateTerminalWrite(
  text: string,
  options: ToolPolicyOptions,
): ToolPolicyDecision {
  const maxLen = options.maxWriteLength ?? DEFAULT_MAX_WRITE_LENGTH;

  const dangerousFindings = findingsForRules(text, DANGEROUS_TERMINAL_WRITE_RULES);
  const warningFindings = findingsForRules(text, WARNING_TERMINAL_WRITE_RULES);

  if (text.length > maxLen) {
    const overlongFinding: ToolPolicyFinding = {
      code: "dangerous_overlong_input",
      severity: "error",
      message: `Terminal write text exceeds maximum length of ${maxLen} characters.`,
    };
    const allFindings = [overlongFinding, ...dangerousFindings, ...warningFindings];
    const allWarnings = warningFindings.map((f) => f.message);
    return {
      status: "rejected",
      reason: `Rejected by tool policy: terminal write text is overlong (${text.length} > ${maxLen} chars).`,
      findings: allFindings,
      warnings: allWarnings,
    };
  }

  if (dangerousFindings.length > 0 && !options.allowDangerousTerminalWrites) {
    const findings = [...dangerousFindings, ...warningFindings];
    return {
      status: "rejected",
      reason: `Rejected by tool policy: ${dangerousFindings[0]?.message}`,
      findings,
      warnings: warningFindings.map((f) => f.message),
    };
  }

  const allowedDangerousWarnings = options.allowDangerousTerminalWrites
    ? dangerousFindings.map((finding) => ({
        ...finding,
        severity: "warning" as const,
        message: `Allowed dangerous terminal write by explicit policy option: ${finding.message}`,
      }))
    : [];
  const findings = [
    ...allowedDangerousWarnings,
    ...warningFindings,
    {
      code: "safe_terminal_write" as const,
      severity: "info" as const,
      message: "Terminal write is allowed after policy evaluation.",
    },
  ];
  const warnings = findings
    .filter((f) => f.code !== "safe_terminal_write")
    .map((f) => f.message);

  return {
    status: "approved",
    reason:
      warnings.length > 0
        ? `Approved by tool policy with ${warnings.length} warning(s).`
        : "Approved by tool policy.",
    findings,
    warnings,
  };
}

function findingsForRules(text: string, rules: Rule[]): ToolPolicyFinding[] {
  return rules
    .filter((rule) => rule.pattern.test(text))
    .map((rule) => ({
      code: rule.code,
      severity: rule.severity,
      message: rule.message,
    }));
}

function approved(
  reason: string,
  findings: ToolPolicyFinding[] = [],
): ToolPolicyDecision {
  return { status: "approved", reason, findings, warnings: [] };
}
