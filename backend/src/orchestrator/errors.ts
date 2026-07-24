/**
 * The orchestrator module's error vocabulary, in its own file so sibling
 * collaborators (ADR-013) can throw it without importing the facade —
 * `orchestrator.ts` re-exports it, so the `api` module's import surface
 * (`Orchestrator`, `OrchestratorError`) is unchanged.
 */

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
      | 'task_not_approvable',
    message: string,
  ) {
    super(message);
    this.name = 'OrchestratorError';
  }
}
