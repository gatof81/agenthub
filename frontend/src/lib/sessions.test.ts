import { describe, expect, it } from 'vitest';
import { ownerVisibleSessions, type SessionListing, type SessionRow } from './api.js';

function row(over: Partial<SessionRow>): SessionRow {
  return {
    sessionId: 's',
    name: 'S',
    status: 'running',
    ownerUsername: 'owner-admin',
    createdAt: null,
    lastConnectedAt: null,
    projectId: null,
    projectName: null,
    ownership: null,
    ...over,
  };
}

function listing(sessions: SessionRow[]): SessionListing {
  return { scope: 'all', sessions };
}

describe('ownerVisibleSessions (ADR-007)', () => {
  it("hides the Hub's generic legacy-technical sessions", () => {
    const hub = row({ sessionId: 'h', ownership: 'legacy-technical', projectId: 'p', projectName: 'P' });
    const mine = row({ sessionId: 'm', ownership: 'owner', projectId: 'p2', projectName: 'P2' });
    const unbound = row({ sessionId: 'u', ownership: null });

    const visible = ownerVisibleSessions(listing([hub, mine, unbound]));

    expect(visible.map((s) => s.sessionId)).toEqual(['m', 'u']);
  });

  it('keeps owner-account project sessions and unbound personal sessions', () => {
    const visible = ownerVisibleSessions(
      listing([row({ ownership: 'owner' }), row({ ownership: null })]),
    );
    expect(visible).toHaveLength(2);
  });

  it('empties the list when everything is Hub-owned', () => {
    const visible = ownerVisibleSessions(
      listing([row({ ownership: 'legacy-technical' }), row({ ownership: 'legacy-technical' })]),
    );
    expect(visible).toEqual([]);
  });
});
