export { ViewModelBuilder } from "./view-model-builder.js";
export {
  buildLoopFrameDetail,
  projectLoopFrameDetail,
  buildRunBrowserControlIntent,
  buildRunBrowserControlIntentDisplay,
  formatRunBrowserControlAction,
  buildRunBrowserView,
  buildRunIndex,
  compareRuns,
  matchesLoopFrame,
  nextLoopFrameIndex,
  queryLoopFrames,
  summarizeLoopFrames,
} from "./debugger.js";
export { BlessedRenderer } from "./renderer.js";
export { ProjectUiController, parseProjectUiCommand } from "./controller.js";
export { createRuntimeWorkbenchClient } from "./workbench-client.js";
export {
  TeamLifecycleAuditReader,
  projectLifecycleAuditEvents,
  readTeamLifecycleAuditProjection,
} from "./lifecycle-audit-projection.js";
export { DEFAULT_TUI_LIMITS } from "./types.js";
export type {
  DebuggerRunSnapshot,
  LoopFrameDetail,
  LoopFrameDetailSection,
  LoopFrameDetailInput,
  LoopFrameQuery,
  RunBrowserControlAction,
  RunBrowserControlActionLabel,
  RunBrowserControlIntentDisplay,
  RunBrowserControlError,
  RunBrowserControlIntent,
  RunBrowserControlRequest,
  RunBrowserDetail,
  RunBrowserOptions,
  RunBrowserRow,
  RunBrowserSelected,
  RunBrowserView,
  RunComparison,
  RunComparisonChange,
  RunIndexRow,
} from "./debugger.js";
export type {
  LifecycleAuditProjectionResult,
  LifecycleAuditProjectionState,
  ReadTeamLifecycleAuditProjectionInput,
  TeamLifecycleAuditReaderOptions,
} from "./lifecycle-audit-projection.js";
export type {
  TuiViewModel,
  RunHeaderView,
  ConversationItem,
  LoopFrame,
  SessionView,
  SessionTailUpdate,
  ActiveSkillView,
  Selection,
  TuiKey,
  TuiLimits,
  TuiRenderer,
} from "./types.js";
export type {
  RuntimeWorkbenchClientOptions,
  TuiWorkbenchClientPort,
  TuiWorkbenchSessionPort,
} from "./workbench-client.js";

// Team dashboard view model
export {
  buildTeamDashboardViewModel,
  redactDashboardDisplay,
} from "./team-dashboard-view-model.js";
export type {
  TeamDashboardInput,
  TeamDashboardRun,
  TeamDashboardViewModel,
  TeamDashboardSection,
  TeamDashboardSectionKind,
  TeamDashboardRow,
  TeamDashboardSelection,
  TeamDashboardFailureSummary,
  DashboardRowStatus,
  LifecycleAuditEventItem,
} from "./team-dashboard-view-model.js";
