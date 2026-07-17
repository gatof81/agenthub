/**
 * In-process SSE broadcaster (ADR-004): a plain pub/sub keyed by
 * conversation — no new infrastructure (R-10). Implements the domain's
 * HubNotifier so the orchestrator never imports the api module. The store
 * remains the source of truth; anything dropped here is recoverable over
 * REST (NFR-07).
 */

import type { HubNotifier, IndexedRunEvent, RunStateNotification } from '../domain/ports.js';
import { sseFromRunEvent } from '../domain/projections.js';
import type { ProjectStatus, RunSummary, UsageRecord } from '../domain/types.js';

export interface OutboundSse {
  event: string;
  data: unknown;
  /** present ONLY on replayable events (08 §3) */
  id?: number;
}

type Subscriber = (e: OutboundSse) => void;

export class Broadcaster implements HubNotifier {
  private readonly byConversation = new Map<string, Set<Subscriber>>();
  private readonly byProject = new Map<string, Set<Subscriber>>();

  subscribe(conversationId: string, projectId: string | null, cb: Subscriber): () => void {
    const conv = this.byConversation.get(conversationId) ?? new Set();
    conv.add(cb);
    this.byConversation.set(conversationId, conv);
    // A direct specialist conversation (N3b-2) has no project, so no
    // project.state routing — only the per-conversation index.
    const proj = projectId !== null ? this.byProject.get(projectId) ?? new Set() : null;
    if (proj) {
      proj.add(cb);
      this.byProject.set(projectId!, proj);
    }
    return () => {
      conv.delete(cb);
      if (proj) proj.delete(cb);
    };
  }

  private emitConversation(conversationId: string, e: OutboundSse): void {
    for (const cb of this.byConversation.get(conversationId) ?? []) cb(e);
  }

  // — HubNotifier —

  runState(conversationId: string, n: RunStateNotification): void {
    this.emitConversation(conversationId, {
      event: 'run.state',
      data: {
        runId: n.runId,
        state: n.state,
        ...(n.errorCode ? { error: n.errorCode } : {}),
        ...(n.killOutcome ? { killOutcome: n.killOutcome } : {}),
        ...(n.sweepResult ? { sweepResult: n.sweepResult } : {}),
      },
    });
  }

  replayable(conversationId: string, runMessageId: string, rows: IndexedRunEvent[]): void {
    for (const row of rows) {
      for (const wire of sseFromRunEvent(runMessageId, row.event)) {
        this.emitConversation(conversationId, { ...wire, id: row.index });
      }
    }
  }

  usage(conversationId: string, usage: UsageRecord): void {
    this.emitConversation(conversationId, {
      event: 'run.usage',
      data: {
        runId: usage.runId,
        totalCostUsd: usage.totalCostUsd,
        numTurns: usage.numTurns,
        source: usage.source,
      },
    });
  }

  summary(conversationId: string, summary: RunSummary): void {
    this.emitConversation(conversationId, { event: 'run.summary', data: summary });
  }

  projectState(projectId: string, status: ProjectStatus): void {
    // emitted on every conversation stream of the project (08 §3)
    for (const cb of this.byProject.get(projectId) ?? []) {
      cb({ event: 'project.state', data: { status } });
    }
  }
}
