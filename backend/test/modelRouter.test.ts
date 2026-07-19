/**
 * ModelRouter (N4b, ADR-012) — offline, with an injected fake Anthropic client
 * so the message-aware router is tested without any network or credential. The
 * load-bearing property is graceful degradation: any failure falls back to the
 * deterministic router (the conversation's own specialist), never a broken turn.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Agent, RouteProposal } from '../src/domain/types.js';
import type { RouteInput } from '../src/domain/ports.js';
import { ModelRouter } from '../src/orchestrator/modelRouter.js';

const DEV: Agent = {
  id: 'dev',
  name: 'Claudio',
  role: 'Software Developer',
  instructions: 'You are the dev.',
  allowedTools: ['Read', 'Write', 'Edit', 'Bash'],
  runtime: 'claude-cli',
  defaultCaps: { maxTurns: 10, budgetUsd: 1, timeoutMs: 60_000 },
  capabilities: ['implement', 'refactor'],
};
const QA: Agent = {
  id: 'qa',
  name: 'Claudia',
  role: 'QA Specialist',
  instructions: 'You are QA.',
  allowedTools: ['Read', 'Grep', 'Bash'],
  runtime: 'claude-cli',
  defaultCaps: { maxTurns: 10, budgetUsd: 1, timeoutMs: 60_000 },
  capabilities: ['test', 'review'],
};

const INPUT: RouteInput = {
  message: 'please add a feature and verify it',
  specialists: [DEV, QA],
  conversation: { id: 'conv_1', projectId: 'proj_1', agentId: 'dev', mode: 'automatic' },
};

/** A fake Anthropic-shaped client whose create() returns one forced tool_use block. */
function fakeClient(reply: unknown | (() => never)) {
  const create = vi.fn(async () => {
    if (typeof reply === 'function') (reply as () => never)();
    return { content: [{ type: 'tool_use', id: 'toolu_1', name: 'route', input: reply }] };
  });
  return { client: { messages: { create } } as never, create };
}

describe('ModelRouter (ADR-012)', () => {
  it('routes to the specialist the model picks, grounding capabilities from config', async () => {
    const { client, create } = fakeClient({ workType: 'task', specialistId: 'qa', reason: 'needs verification' });
    const router = new ModelRouter({ oauthToken: 't', client });
    const proposal: RouteProposal = await router.route(INPUT);

    expect(create).toHaveBeenCalledOnce();
    expect(proposal.specialistId).toBe('qa');
    expect(proposal.workType).toBe('task');
    // capabilities come from the chosen specialist's config, not the model
    expect(proposal.capabilities).toEqual(['test', 'review']);
    expect(proposal.reason).toContain('model router');
  });

  it('falls back to the deterministic router when the model names an unknown specialist', async () => {
    const { client } = fakeClient({ workType: 'task', specialistId: 'ghost', reason: 'x' });
    const router = new ModelRouter({ oauthToken: 't', client });
    const proposal = await router.route(INPUT);
    // deterministic fallback = the conversation's own specialist (agentId)
    expect(proposal.specialistId).toBe('dev');
    expect(proposal.reason).toContain('deterministic');
  });

  it('falls back when the model call throws (error/timeout)', async () => {
    const { client } = fakeClient(() => {
      throw new Error('boom');
    });
    const router = new ModelRouter({ oauthToken: 't', client });
    const proposal = await router.route(INPUT);
    expect(proposal.specialistId).toBe('dev');
    expect(proposal.reason).toContain('deterministic');
  });

  it('falls back on malformed model output (invalid workType)', async () => {
    const { client } = fakeClient({ workType: 'nonsense', specialistId: 'qa', reason: 'x' });
    const router = new ModelRouter({ oauthToken: 't', client });
    const proposal = await router.route(INPUT);
    expect(proposal.specialistId).toBe('dev');
    expect(proposal.reason).toContain('deterministic');
  });

  it('short-circuits to the deterministic router with no specialists (no model call)', async () => {
    const { client, create } = fakeClient({ workType: 'task', specialistId: 'qa', reason: 'x' });
    const router = new ModelRouter({ oauthToken: 't', client });
    const proposal = await router.route({ ...INPUT, specialists: [] });
    expect(create).not.toHaveBeenCalled();
    expect(proposal.specialistId).toBe('dev'); // conversation agentId
  });
});
