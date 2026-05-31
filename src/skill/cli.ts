import { spawnSync } from "node:child_process";
import * as path from "node:path";
import * as fs from "node:fs";
import type { EnvironmentPort, EnvironmentEvent } from "../types/environment.js";
import { SkillRunStore } from "./store.js";
import { SkillDiscovery } from "./discovery.js";

export class SkillCli {
  constructor(
    private readonly store: SkillRunStore,
    private readonly discovery: SkillDiscovery,
    private readonly environment: EnvironmentPort,
    private readonly skillsDir: string,
  ) {}

  handleList(): { skills: Array<{ name: string; description: string; tags?: string[] }> } {
    return { skills: this.discovery.list() };
  }

  handleShow(
    name: string,
  ):
    | { name: string; manifest?: unknown; readmePath: string; contentLineCount: number }
    | { ok: false; error: string } {
    const result = this.discovery.show(name);
    if (!result) {
      return { ok: false as const, error: `Skill not found: ${name}` };
    }
    return {
      name: result.name,
      manifest: result.manifest,
      readmePath: result.readmePath,
      contentLineCount: result.contentLineCount,
    };
  }

  handleRun(
    name: string,
    args?: unknown,
  ):
    | {
        ok: true;
        skillRunId: string;
        skill: string;
        status: string;
        statePath: string;
        executionLogPath: string;
      }
    | { ok: false; error: string } {
    const shown = this.discovery.show(name);
    if (!shown) {
      return { ok: false, error: `Skill not found: ${name}` };
    }

    const { manifest } = shown;
    if (!manifest?.entry) {
      return { ok: false, error: `Skill "${name}" has no entry` };
    }

    const run = this.store.create({ skill: name, args });

    const skillDir = path.join(this.skillsDir, name);
    const entryPath = path.join(skillDir, manifest.entry);

    this.emitEvent({
      id: `skill-evt-${Date.now()}`,
      kind: "skill_run_started",
      source: "skill",
      timestamp: new Date().toISOString(),
      skillRunId: run.skillRunId,
      skill: name,
      statePath: run.statePath,
      executionLogPath: run.executionLogPath,
    });

    const result = spawnSync(entryPath, [], {
      cwd: skillDir,
      input: args ? JSON.stringify(args) : undefined,
      encoding: "utf-8",
    });

    const output = result.stdout ?? "";
    fs.writeFileSync(run.executionLogPath, output, "utf-8");

    this.store.updateReturnCode(run.skillRunId, result.status ?? 1);

    return {
      ok: true,
      skillRunId: run.skillRunId,
      skill: name,
      status: "running",
      statePath: run.statePath,
      executionLogPath: run.executionLogPath,
    };
  }

  handleStatus(): {
    activeRuns: Array<{
      skillRunId: string;
      skill: string;
      status: string;
      executionReturnCode?: number;
      executionLogPath: string;
      reviewTaskPath?: string;
    }>;
  } {
    return { activeRuns: this.store.listActive() };
  }

  handleClose(
    skillRunId: string,
    review: "none" | "required",
    summary: string,
  ):
    | { ok: true; skillRunId: string; status: string; reviewTaskPath?: string }
    | { ok: false; error: string } {
    const run = this.store.get(skillRunId);
    if (!run) {
      return { ok: false, error: `Skill run not found: ${skillRunId}` };
    }
    if (run.status !== "running") {
      return {
        ok: false,
        error: `Skill run ${skillRunId} is not running (status: ${run.status})`,
      };
    }

    const closed = this.store.close(skillRunId, { review, summary });

    const eventKind: EnvironmentEvent["kind"] =
      review === "required" ? "skill_review_pending" : "skill_run_closed";

    this.emitEvent({
      id: `skill-evt-${Date.now()}`,
      kind: eventKind,
      source: "skill",
      timestamp: new Date().toISOString(),
      skillRunId: closed.skillRunId,
      skill: closed.skill,
      statePath: closed.statePath,
      reviewTaskPath: closed.reviewTaskPath,
    });

    return {
      ok: true,
      skillRunId: closed.skillRunId,
      status: closed.status,
      reviewTaskPath: closed.reviewTaskPath,
    };
  }

  handleReviewComplete(
    skillRunId: string,
    reviewData: { summary: string; lessons: string[] },
  ):
    | { ok: true; skillRunId: string; status: string; lessonsPath?: string }
    | { ok: false; error: string } {
    const run = this.store.get(skillRunId);
    if (!run) {
      return { ok: false, error: `Skill run not found: ${skillRunId}` };
    }
    if (run.status !== "review_pending") {
      return {
        ok: false,
        error: `Skill run ${skillRunId} is not pending review (status: ${run.status})`,
      };
    }

    const completed = this.store.reviewComplete(skillRunId, reviewData);

    this.emitEvent({
      id: `skill-evt-${Date.now()}`,
      kind: "skill_review_completed",
      source: "skill",
      timestamp: new Date().toISOString(),
      skillRunId: completed.skillRunId,
      skill: completed.skill,
      statePath: completed.statePath,
      lessonsPath: completed.lessonsPath,
    });

    return {
      ok: true,
      skillRunId: completed.skillRunId,
      status: completed.status,
      lessonsPath: completed.lessonsPath,
    };
  }

  handleValidate(name: string): { ok: boolean; errors: string[]; warnings: string[] } {
    return this.discovery.validate(name);
  }

  private emitEvent(
    event: Extract<EnvironmentEvent, { source: "skill" }>,
  ): void {
    this.environment.appendEvent(event);
  }
}
