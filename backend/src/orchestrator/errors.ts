/**
 * The orchestrator module's error vocabulary, in its own file so sibling
 * collaborators (ADR-013) can throw it without importing the facade —
 * `orchestrator.ts` re-exports it, so the `api` module's import surface
 * (`Orchestrator`, `OrchestratorError`) is unchanged.
 */

import type { Agent } from '../domain/types.js';

export class OrchestratorError extends Error {
  constructor(
    readonly code:
      | 'unknown_agent'
      | 'project_not_ready'
      | 'run_not_cancellable'
      | 'not_found'
      // restore (FR-44 / I-12): the API maps both to 409 with the code
      | 'session_gone'
      | 'project_archived'
      // N6: an approval action on a task not in awaiting_human_approval (409)
      | 'task_not_approvable'
      // #140: cancel on a task that is not running (terminal, or resting at
      // awaiting_human_approval where reject/request-changes are the verbs)
      | 'task_not_cancellable',
    message: string,
  ) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

/**
 * Resolve a configured agent or throw `unknown_agent` — the validation shared
 * by the facade (send/conversations) and the ProvisioningService
 * (createProject/bindSpecialistSession) since the ADR-013 split.
 */
export function mustAgent(agents: ReadonlyMap<string, Agent>, agentId: string): Agent {
  const agent = agents.get(agentId);
  if (!agent) throw new OrchestratorError('unknown_agent', `agent ${agentId} not configured`);
  return agent;
}
