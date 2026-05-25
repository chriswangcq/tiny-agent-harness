import * as fs from "node:fs";
import * as path from "node:path";
import type { SkillRunState, ActiveSkillRunSummary } from "../types/skill.js";

export class SkillRunStore {
  private readonly skillRunsDir: string;
  private readonly skillsDir: string;
  private counter = 0;

  constructor(options: { skillRunsDir: string; skillsDir: string }) {
    this.skillRunsDir = options.skillRunsDir;
    this.skillsDir = options.skillsDir;
  }

  create(options: { skill: string; args?: unknown }): SkillRunState {
    this.counter++;
    const skillRunId = `skillrun-${Date.now()}-${String(this.counter).padStart(3, "0")}`;
    const runDir = path.join(this.skillRunsDir, skillRunId);
    fs.mkdirSync(runDir, { recursive: true });

    const statePath = path.join(runDir, "state.json");
    const executionLogPath = path.join(runDir, "execution.txt");
    fs.writeFileSync(executionLogPath, "", "utf-8");

    const state: SkillRunState = {
      skillRunId,
      skill: options.skill,
      status: "running",
      startedAt: new Date().toISOString(),
      args: options.args,
      executionLogPath,
      statePath,
    };

    this.persist(state);
    return state;
  }

  get(skillRunId: string): SkillRunState | undefined {
    const statePath = path.join(this.skillRunsDir, skillRunId, "state.json");
    if (!fs.existsSync(statePath)) return undefined;
    return JSON.parse(fs.readFileSync(statePath, "utf-8")) as SkillRunState;
  }

  listActive(): ActiveSkillRunSummary[] {
    if (!fs.existsSync(this.skillRunsDir)) return [];

    const entries = fs.readdirSync(this.skillRunsDir, { withFileTypes: true });
    const result: ActiveSkillRunSummary[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const state = this.get(entry.name);
      if (state && (state.status === "running" || state.status === "review_pending")) {
        result.push({
          skillRunId: state.skillRunId,
          skill: state.skill,
          status: state.status,
          executionReturnCode: state.executionReturnCode,
          executionLogPath: state.executionLogPath,
          reviewTaskPath: state.reviewTaskPath,
        });
      }
    }
    return result;
  }

  close(
    skillRunId: string,
    options: { review: "none" | "required"; summary: string },
  ): SkillRunState {
    const state = this.get(skillRunId);
    if (!state) throw new Error(`Skill run not found: ${skillRunId}`);

    if (options.review === "none") {
      state.status = "closed";
      state.closedAt = new Date().toISOString();
    } else {
      state.status = "review_pending";
      const reviewTaskPath = path.join(this.skillRunsDir, skillRunId, "review-task.txt");
      fs.writeFileSync(reviewTaskPath, options.summary, "utf-8");
      state.reviewTaskPath = reviewTaskPath;
    }

    this.persist(state);
    return state;
  }

  reviewComplete(
    skillRunId: string,
    reviewData: { summary: string; lessons: string[] },
  ): SkillRunState {
    const state = this.get(skillRunId);
    if (!state) throw new Error(`Skill run not found: ${skillRunId}`);

    state.status = "closed";
    state.closedAt = new Date().toISOString();

    if (reviewData.lessons.length > 0) {
      const attachDir = path.join(this.skillsDir, state.skill, "attachments");
      fs.mkdirSync(attachDir, { recursive: true });
      const lessonsPath = path.join(attachDir, "lessons.md");

      const lines = [
        `\n## ${skillRunId}`,
        "",
        reviewData.summary,
        "",
        ...reviewData.lessons.map((l) => `- ${l}`),
        "",
      ];

      fs.appendFileSync(lessonsPath, lines.join("\n"), "utf-8");
      state.lessonsPath = lessonsPath;
    }

    this.persist(state);
    return state;
  }

  updateReturnCode(skillRunId: string, returnCode: number): void {
    const state = this.get(skillRunId);
    if (!state) throw new Error(`Skill run not found: ${skillRunId}`);
    state.executionReturnCode = returnCode;
    this.persist(state);
  }

  private persist(state: SkillRunState): void {
    fs.writeFileSync(state.statePath, JSON.stringify(state, null, 2), "utf-8");
  }
}
