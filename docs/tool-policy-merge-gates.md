# ToolPolicy Merge Gates

> Generated 2026-06-05 from audit of `P024: ToolPolicy merge hygiene`.
> Current main commit: `4955585` "merge: land loop detail source selection"

## What Landed In Main

The following ToolPolicy surface is fully present and tested in current `main`:

| File | Lines | Status |
|------|-------|--------|
| `src/tools/policy.ts` | 282 | Stable. Types, 17 rule codes, pattern-based evaluator, overlong-input check, `allowDangerousTerminalWrites` escape hatch. |
| `src/tools/reviewer.ts` | 35 | Stable. `AlwaysApproveReviewer` (demo default) and `ToolPolicyReviewer` (policy-aware adapter). |
| `src/tools/index.ts` | re-export | Re-exports both reviewers and `evaluateToolPolicy`. |
| `tests/tool-policy.test.ts` | 522 | 41 tests covering all rule categories, overlong, safe writes, warnings, and escape hatch. |
| `tests/tool-catalog-reviewer.test.ts` | 212 | 9 tests including `ToolPolicyReviewer` approval, warning, and rejection paths. |

All 839 tests across 67 test files pass (including PTY integration tests).

### Policy Rule Coverage

Current `evaluateToolPolicy` covers these `ToolPolicyRuleCode` values:

**Dangerous (error, rejected without escape hatch):**
- `dangerous_recursive_delete` — `rm -rf` targeting root/home/wildcard
- `dangerous_disk_write` — `dd` to/from `/dev/`
- `dangerous_filesystem_format` — `mkfs`
- `dangerous_permission_change` — `chmod -R` targeting system paths
- `dangerous_pipe_to_shell` — `curl | bash`, `bash <(curl)`
- `dangerous_privileged_command` — `sudo rm/chmod/chown/dd/mkfs/shutdown`
- `dangerous_force_push` — `git push --force` / `-f` / `+ref`
- `dangerous_fork_bomb` — `:(){ :|:& };:`
- `dangerous_secret_read` — reading `.env`, `ak.txt`, `.ssh/id_*`, credentials
- `dangerous_system_path_write` — redirect/tee/cp/mv to system dirs
- `dangerous_overlong_input` — write exceeds max length (default 32k)

**Warning (approved with findings):**
- `warning_network_transfer` — `curl`/`wget`
- `warning_global_package_install` — `npm -g`/`yarn global`
- `warning_recursive_permission_change` — `chmod -R`
- `warning_ownership_change` — `chown`
- `warning_git_push` — `git push`

**Safe (info):**
- `safe_terminal_key` — constrained key allowlist
- `safe_terminal_write` — approved after evaluation
- `safe_session_tool` — session management and read tools

## What Was Intentionally Deferred / Not Merged

### Removed rule codes (present in older branches, intentionally absent from main)

| Old Rule Code | Branch Found | Reason Removed |
|---------------|-------------|----------------|
| `warning_file_delete` | `codex/team/runtime-tool-policy` (351-line version) | Too noisy; normal `rm` for project files is a valid workflow. `dangerous_recursive_delete` already catches the destructive case. |
| `warning_permission_change` | `codex/team/runtime-tool-policy` | Folded into `warning_recursive_permission_change` and `dangerous_permission_change`. Non-recursive `chmod` is deliberately allowed. |
| `warning_network_write` | `codex/team/runtime-tool-policy` | Ambiguous scope; network transfers are already covered by `warning_network_transfer`. Write-side policy would require distinguishing safe local saves from remote uploads. |

### Design decisions kept in main

- **Array-based rules over record-based findings**: Current main uses `Rule[]` arrays with inline patterns, making each rule self-contained with its own regex. The older `FINDINGS: Record<...>` pattern in `runtime-tool-policy` separated the finding metadata from the matching logic, which was harder to extend.
- **Patterns embedded in rules, not in evaluator**: Each rule carries its own `pattern: RegExp`. The evaluator is generic (`findingsForRules`). Adding a new rule only requires adding to the array.
- **`maxWriteLength` option**: Added in current main (32k default). Older branches used a hardcoded `MAX_POLICY_TEXT_CHARS = 20_000` constant.
- **Extended `SYSTEM_PATH`**: Current main covers `/boot`, `/dev`, `/proc`, `/sys` in addition to the older set (`/etc`, `/usr`, `/bin`, `/sbin`, `/System`, `/Library`).

## Stale Branches (Read-Only Reference)

These branches contain older or alternative ToolPolicy implementations. They are read-only references; their content has been superseded by current main.

| Branch | policy.ts Lines | Status |
|--------|----------------|--------|
| `codex/team/tool-policy-evaluator` | 282 | **Same as main.** Already merged/landed. |
| `codex/team/tool-policy-risk-display` | 253 | **Earlier version.** Missing overlong check, fewer SYSTEM_PATH entries, older constant naming. Superseded. |
| `codex/team/tool-policy-runtime-review` | 253 | **Earlier version.** Same state as risk-display. Superseded. |
| `codex/team/runtime-tool-policy` | 351 | **Older, diverged.** Record-style findings, deprecated rule codes (`warning_file_delete`, `warning_permission_change`, `warning_network_write`), 20k hardcoded limit, narrower SYSTEM_PATH. Superseded. |
| `codex/team/tool-policy-merge-hygiene` | N/A | **Misnamed.** This branch is about token usage normalization, not tool policy. Irrelevant to ToolPolicy merge hygiene. |

### Parallel fresh branches (created alongside this branch)

| Branch | Status |
|--------|--------|
| `codex/parallel/20260605-0912-tool-policy-evaluator-fresh` | Sibling parallel task. |
| `codex/parallel/20260605-0912-tool-policy-risk-display-fresh` | Sibling parallel task. |
| `codex/parallel/20260605-0912-tool-policy-transcript-fresh` | Sibling parallel task. |

These are active parallel work items, not stale branches.

## Cleanliness Check

- No stale imports or references to removed modules found in `src/` or `tests/`.
- No hardcoded branch names or worktree paths in source files.
- No references to deleted rule codes (`warning_file_delete`, `warning_permission_change`, `warning_network_write`).
- All policy imports use relative paths within `src/tools/` (`./policy.js`, `./reviewer.js`).

## Boundaries

The ToolPolicy module's current contract:

1. **Pure function evaluator**: `evaluateToolPolicy(request, options?)` is a pure function. No filesystem, no process state, no network.
2. **Reviewer adapter**: `ToolPolicyReviewer` wraps the evaluator as a `ToolReviewDecision` for the orchestrator's review port. Default runtime still uses `AlwaysApproveReviewer` for demo mode.
3. **Display-only redaction is separate**: `src/tui/redaction.ts` handles TUI display sanitization. It is not part of the policy module and does not affect agent-visible context.
4. **No runtime enforcement by default**: The policy evaluator exists but the demo `AlwaysApproveReviewer` bypasses it. Switching to `ToolPolicyReviewer` is a configuration change at the orchestrator level.

## Follow-Up Candidates

These are explicitly NOT in scope for this hygiene slice but may be worth future work:

1. **Switch default reviewer to ToolPolicyReviewer** — currently `AlwaysApproveReviewer` is the demo default. Activating policy review would require a configuration toggle and integration tests.
2. **Policy review transcript events** — risk findings from policy evaluation could be surfaced in TUI detail views.
3. **Workspace-scoped policy files** — `.tiny-agent/tool-policy.json` for per-project rule customization.
4. **Review approval UX** — TUI control panel for approving/rejecting policy-flagged terminal writes.
