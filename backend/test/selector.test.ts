/**
 * Execution-target selector (ADR-008, N4a): the deterministic session choice
 * behind automatic mode. Pure — no orchestrator, no store.
 */

import { describe, expect, it } from 'vitest';
import { NoExecutionTargetError, selectExecutionTarget } from '../src/orchestrator/selector.js';
import type { RouteProposal } from '../src/domain/types.js';

const proposal: RouteProposal = {
  workType: 'task',
  capabilities: ['implementation', 'tests'],
  specialistId: 'claudio',
  reason: 'routed',
};

describe('selectExecutionTarget', () => {
  it('a project turn runs in the project primary session; a specialist session is noted as an alternative', () => {
    const d = selectExecutionTarget({
      proposal,
      projectPrimarySessionId: 'sess_project',
      specialistSessionId: 'sess_specialist',
    });
    expect(d).toEqual({
      specialistId: 'claudio',
      selectedSessionId: 'sess_project',
      reason: expect.stringContaining('primary session'),
      alternativesConsidered: ['specialist session sess_specialist'],
      workspaceStrategy: 'project-primary',
    });
  });

  it('the project primary wins even with no specialist session (no alternatives)', () => {
    const d = selectExecutionTarget({
      proposal,
      projectPrimarySessionId: 'sess_project',
      specialistSessionId: null,
    });
    expect(d).toMatchObject({ selectedSessionId: 'sess_project', alternativesConsidered: [] });
  });

  it("a project-less turn runs in the specialist's own session", () => {
    const d = selectExecutionTarget({
      proposal,
      projectPrimarySessionId: null,
      specialistSessionId: 'sess_specialist',
    });
    expect(d).toMatchObject({
      selectedSessionId: 'sess_specialist',
      workspaceStrategy: 'specialist-session',
    });
  });

  it('throws when there is neither a project primary nor a specialist session', () => {
    expect(() =>
      selectExecutionTarget({ proposal, projectPrimarySessionId: null, specialistSessionId: null }),
    ).toThrow(NoExecutionTargetError);
  });
});
