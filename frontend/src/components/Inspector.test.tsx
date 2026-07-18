import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Run, RunDetail } from '../lib/api.js';
import { Inspector } from './Inspector.js';

const BASE_RUN: Run = {
  id: 'run_1',
  conversationId: 'conv_1',
  messageId: 'msg_1',
  state: 'completed',
  killOutcome: null,
  errorCode: null,
  errorDetail: null,
  targetSessionId: null,
  targetDecision: null,
  startedAt: null,
};

function detailWith(run: Partial<Run>): RunDetail {
  return {
    run: { ...BASE_RUN, ...run },
    activity: { commands: [], files: [], denials: [], items: [] },
    segments: [],
    usage: null,
    summary: null,
  };
}

const render = (detail: RunDetail): string =>
  renderToStaticMarkup(createElement(Inspector, { open: true, detail, onClose: () => {} }));

describe('Inspector — routing decision (ADR-008, N4a)', () => {
  it('shows who ran, where, why and the alternatives for an automatic run', () => {
    const out = render(
      detailWith({
        targetSessionId: 'sess_primary',
        targetDecision: {
          specialistId: 'dev',
          selectedSessionId: 'sess_primary',
          reason: 'work belongs to the project — runs in its primary session',
          alternativesConsidered: ['specialist session s_claudio'],
          workspaceStrategy: 'project-primary',
        },
      }),
    );
    expect(out).toContain('Routing decision');
    expect(out).toContain('dev');
    expect(out).toContain('sess_primary');
    expect(out).toContain('project-primary');
    expect(out).toContain('runs in its primary session');
    expect(out).toContain('Alternatives considered (1)');
    expect(out).toContain('specialist session s_claudio');
  });

  it('omits the routing section entirely for a direct run', () => {
    const out = render(detailWith({ targetDecision: null }));
    expect(out).not.toContain('Routing decision');
  });
});
