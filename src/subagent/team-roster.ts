// Pure domain for the team roster / personnel directory.
// Durable runtime truth, not TUI state.
// No IO, no side effects, no global state.

export type TeamMemberStatus =
  | "active"
  | "idle"
  | "stale"
  | "offline"
  | "terminated";

export type TeamMemberAssignment = {
  id: string;
  title?: string;
  status?: string;
};

export type TeamMember = {
  /** Unique participant identity inside this team. */
  memberId: string;
  /** Role: coder, qa, reviewer, merge, observer, etc. */
  role: string;
  /** IM channel/address used by the master/control plane. */
  channel: string;
  /** Current agent run id, if this member is backed by a tiny-agent run. */
  runId?: string;
  /** Current assignment/instruction summary. */
  assignment?: TeamMemberAssignment;
  /** Human-readable current task/status line. */
  currentTask?: string;
  /** Lifecycle/presence status. */
  status: TeamMemberStatus;
  /** ISO timestamp of last heartbeat. */
  lastHeartbeat?: string;
  /** ISO timestamp of last submitted evidence. */
  lastEvidence?: string;
  /**
   * Optional facts supplied by task instructions or worker evidence.
   * Workspace, git branch, ledger id, service endpoint, capability labels, etc.
   * live here instead of being mandatory runtime schema.
   */
  metadata?: Record<string, string>;
};

export type TeamRosterEvent =
  | {
      kind: "member_added";
      eventId: string;
      memberId: string;
      role: string;
      channel: string;
      metadata?: Record<string, string>;
    }
  | {
      kind: "member_updated";
      eventId: string;
      memberId: string;
      patch: Partial<
        Pick<
          TeamMember,
          | "role"
          | "channel"
          | "runId"
          | "assignment"
          | "currentTask"
          | "metadata"
        >
      >;
    }
  | {
      kind: "member_status_changed";
      eventId: string;
      memberId: string;
      status: TeamMemberStatus;
      reason?: string;
    }
  | {
      kind: "member_heartbeat";
      eventId: string;
      memberId: string;
      timestamp: string;
      /** Optional evidence of work output, report path, commit, artifact, etc. */
      evidence?: string;
    }
  | {
      kind: "member_terminated";
      eventId: string;
      memberId: string;
      reason?: string;
    };

export type TeamRosterRejectionCode =
  | "member_exists"
  | "unknown_member"
  | "invalid_transition"
  | "member_already_terminated";

export type TeamRosterRejection = {
  code: TeamRosterRejectionCode;
  message: string;
};

export type TeamRosterResult =
  | { status: "applied"; state: TeamRosterState }
  | { status: "duplicate"; state: TeamRosterState }
  | { status: "rejected"; state: TeamRosterState; rejection: TeamRosterRejection };

export type TeamRosterState = {
  teamId: string;
  members: Record<string, TeamMember>;
  appliedEventIds: string[];
};

export type TeamRosterSummary = {
  teamId: string;
  totalMembers: number;
  membersByStatus: Record<TeamMemberStatus, number>;
  membersByRole: Record<string, number>;
  activeMembers: TeamMember[];
};

const VALID_TRANSITIONS: Record<TeamMemberStatus, Set<TeamMemberStatus>> = {
  active: new Set(["idle", "stale", "offline", "terminated"]),
  idle: new Set(["active", "stale", "offline", "terminated"]),
  stale: new Set(["active", "idle", "offline", "terminated"]),
  offline: new Set(["active", "idle", "stale", "terminated"]),
  terminated: new Set([]),
};

export function createTeamRosterState(teamId: string): TeamRosterState {
  return {
    teamId,
    members: {},
    appliedEventIds: [],
  };
}

export function applyTeamRosterEvent(
  state: TeamRosterState,
  event: TeamRosterEvent,
): TeamRosterResult {
  if (state.appliedEventIds.includes(event.eventId)) {
    return { status: "duplicate", state };
  }

  switch (event.kind) {
    case "member_added":
      return addMember(state, event);
    case "member_updated":
      return updateMember(state, event);
    case "member_status_changed":
      return changeMemberStatus(state, event);
    case "member_heartbeat":
      return recordHeartbeat(state, event);
    case "member_terminated":
      return terminateMember(state, event);
  }
}

export function summarizeTeamRoster(state: TeamRosterState): TeamRosterSummary {
  const members = Object.values(state.members);

  const membersByStatus = zeroStatusCounts();
  const membersByRole: Record<string, number> = {};

  for (const member of members) {
    membersByStatus[member.status] += 1;
    membersByRole[member.role] = (membersByRole[member.role] || 0) + 1;
  }

  return {
    teamId: state.teamId,
    totalMembers: members.length,
    membersByStatus,
    membersByRole,
    activeMembers: members.filter(
      (member) => member.status === "active" || member.status === "idle",
    ),
  };
}

export function lookupMember(
  state: TeamRosterState,
  memberId: string,
): TeamMember | undefined {
  return state.members[memberId];
}

export function listMembersByRole(
  state: TeamRosterState,
  role: string,
): TeamMember[] {
  return Object.values(state.members)
    .filter((member) => member.role === role)
    .sort((a, b) => a.memberId.localeCompare(b.memberId));
}

export function listMembersByStatus(
  state: TeamRosterState,
  status: TeamMemberStatus,
): TeamMember[] {
  return Object.values(state.members)
    .filter((member) => member.status === status)
    .sort((a, b) => a.memberId.localeCompare(b.memberId));
}

function addMember(
  state: TeamRosterState,
  event: Extract<TeamRosterEvent, { kind: "member_added" }>,
): TeamRosterResult {
  if (state.members[event.memberId]) {
    return reject(
      state,
      "member_exists",
      `Team member ${event.memberId} already exists.`,
    );
  }

  const member: TeamMember = {
    memberId: event.memberId,
    role: event.role,
    channel: event.channel,
    ...(event.metadata ? { metadata: event.metadata } : {}),
    status: "idle",
  };

  return applied(withEvent(state, event.eventId, {
    members: {
      ...state.members,
      [event.memberId]: member,
    },
  }));
}

function updateMember(
  state: TeamRosterState,
  event: Extract<TeamRosterEvent, { kind: "member_updated" }>,
): TeamRosterResult {
  const existing = state.members[event.memberId];
  if (!existing) {
    return reject(
      state,
      "unknown_member",
      `Team member ${event.memberId} does not exist.`,
    );
  }

  if (existing.status === "terminated") {
    return reject(
      state,
      "member_already_terminated",
      `Team member ${event.memberId} is terminated.`,
    );
  }

  const updated: TeamMember = {
    ...existing,
    ...event.patch,
    status: existing.status,
    lastHeartbeat: existing.lastHeartbeat,
    lastEvidence: existing.lastEvidence,
  };

  return applied(withEvent(state, event.eventId, {
    members: {
      ...state.members,
      [event.memberId]: updated,
    },
  }));
}

function changeMemberStatus(
  state: TeamRosterState,
  event: Extract<TeamRosterEvent, { kind: "member_status_changed" }>,
): TeamRosterResult {
  const existing = state.members[event.memberId];
  if (!existing) {
    return reject(
      state,
      "unknown_member",
      `Team member ${event.memberId} does not exist.`,
    );
  }

  if (existing.status === event.status) {
    return { status: "duplicate", state };
  }

  const allowed = VALID_TRANSITIONS[existing.status];
  if (!allowed.has(event.status)) {
    return reject(
      state,
      "invalid_transition",
      `Cannot transition team member ${event.memberId} from ${existing.status} to ${event.status}.`,
    );
  }

  return applied(withEvent(state, event.eventId, {
    members: {
      ...state.members,
      [event.memberId]: {
        ...existing,
        status: event.status,
      },
    },
  }));
}

function recordHeartbeat(
  state: TeamRosterState,
  event: Extract<TeamRosterEvent, { kind: "member_heartbeat" }>,
): TeamRosterResult {
  const existing = state.members[event.memberId];
  if (!existing) {
    return reject(
      state,
      "unknown_member",
      `Team member ${event.memberId} does not exist.`,
    );
  }

  return applied(withEvent(state, event.eventId, {
    members: {
      ...state.members,
      [event.memberId]: {
        ...existing,
        lastHeartbeat: event.timestamp,
        ...(event.evidence ? { lastEvidence: event.timestamp } : {}),
      },
    },
  }));
}

function terminateMember(
  state: TeamRosterState,
  event: Extract<TeamRosterEvent, { kind: "member_terminated" }>,
): TeamRosterResult {
  const existing = state.members[event.memberId];
  if (!existing) {
    return reject(
      state,
      "unknown_member",
      `Team member ${event.memberId} does not exist.`,
    );
  }

  if (existing.status === "terminated") {
    return { status: "duplicate", state };
  }

  return applied(withEvent(state, event.eventId, {
    members: {
      ...state.members,
      [event.memberId]: {
        ...existing,
        status: "terminated",
      },
    },
  }));
}

function withEvent(
  state: TeamRosterState,
  eventId: string,
  patch: Partial<TeamRosterState>,
): TeamRosterState {
  return {
    ...state,
    ...patch,
    appliedEventIds: [...state.appliedEventIds, eventId],
  };
}

function applied(state: TeamRosterState): TeamRosterResult {
  return { status: "applied", state };
}

function reject(
  state: TeamRosterState,
  code: TeamRosterRejectionCode,
  message: string,
): TeamRosterResult {
  return { status: "rejected", state, rejection: { code, message } };
}

function zeroStatusCounts(): Record<TeamMemberStatus, number> {
  return {
    active: 0,
    idle: 0,
    stale: 0,
    offline: 0,
    terminated: 0,
  };
}
