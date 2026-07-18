/**
 * The execution-target selector (ADR-008, automatic mode): given the router's
 * proposal, choose — DETERMINISTICALLY, from real metadata — which session a
 * turn runs in. The session is a resource/authority decision the backend owns;
 * a model never makes it (01 §3, SEC-01).
 */

import type { ExecutionTargetDecision, RouteProposal } from '../domain/types.js';

export interface SelectTargetInput {
  proposal: RouteProposal;
  /** the project's primary substrate session, if this is a project conversation */
  projectPrimarySessionId: string | null;
  /** the routed specialist's own session, if one is bound (project-less work) */
  specialistSessionId: string | null;
}

/** Thrown when a routed turn has no session to run in — the orchestrator turns
 *  this into a clear `exec_refused` failure rather than guessing. */
export class NoExecutionTargetError extends Error {
  constructor(readonly specialistId: string) {
    super(
      `no execution target for specialist ${specialistId}: neither a project primary session nor a bound specialist session`,
    );
    this.name = 'NoExecutionTargetError';
  }
}

/**
 * Work that belongs to a project runs in the project's PRIMARY session — it has
 * the repo, unpublished local changes, local config and credentials; a
 * specialist runs its craft there per turn via `--append-system-prompt`
 * (B5-04). Only a project-less conversation runs in the specialist's own
 * session. The reason-driven cases for preferring a specialist session over the
 * primary (tooling the primary lacks, isolation, the primary being busy with a
 * safe parallel strategy — ADR-008) are recorded shape for N4b/N5; N4a
 * implements the two structural defaults and records the decision either way.
 */
export function selectExecutionTarget(input: SelectTargetInput): ExecutionTargetDecision {
  const { proposal, projectPrimarySessionId, specialistSessionId } = input;

  if (projectPrimarySessionId !== null) {
    return {
      specialistId: proposal.specialistId,
      selectedSessionId: projectPrimarySessionId,
      reason:
        'work belongs to the project — runs in its primary session, which has the repo, local changes and credentials',
      alternativesConsidered:
        specialistSessionId !== null ? [`specialist session ${specialistSessionId}`] : [],
      workspaceStrategy: 'project-primary',
    };
  }

  if (specialistSessionId !== null) {
    return {
      specialistId: proposal.specialistId,
      selectedSessionId: specialistSessionId,
      reason: "no project workspace — runs in the specialist's own session",
      alternativesConsidered: [],
      workspaceStrategy: 'specialist-session',
    };
  }

  throw new NoExecutionTargetError(proposal.specialistId);
}
