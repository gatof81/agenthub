/**
 * Deterministic router (ADR-008, N4a): proposes the conversation's specialist,
 * carrying its capabilities. The model-based router is N4b.
 */

import { describe, expect, it } from 'vitest';
import { DeterministicRouter } from '../src/orchestrator/router.js';
import type { Agent } from '../src/domain/types.js';

const claudio: Agent = {
  id: 'claudio',
  name: 'Claudio',
  instructions: 'dev',
  allowedTools: ['Read', 'Bash'],
  runtime: 'claude-cli',
  defaultCaps: { maxTurns: 10, budgetUsd: 2, timeoutMs: 60_000 },
  role: 'Software Developer',
  capabilities: ['implementation', 'tests'],
};

describe('DeterministicRouter', () => {
  it("proposes the conversation's specialist with its declared capabilities", async () => {
    const proposal = await new DeterministicRouter().route({
      message: 'add per-municipality enrollment',
      specialists: [claudio],
      conversation: { id: 'c1', projectId: 'p1', agentId: 'claudio', mode: 'automatic' },
    });
    expect(proposal.specialistId).toBe('claudio');
    expect(proposal.capabilities).toEqual(['implementation', 'tests']);
    expect(proposal.workType).toBe('task');
    expect(proposal.reason).toContain('N4a');
  });

  it('falls back to empty capabilities when the specialist is not in the list', async () => {
    const proposal = await new DeterministicRouter().route({
      message: 'hi',
      specialists: [],
      conversation: { id: 'c1', projectId: null, agentId: 'ghost', mode: 'automatic' },
    });
    expect(proposal.specialistId).toBe('ghost');
    expect(proposal.capabilities).toEqual([]);
  });
});
