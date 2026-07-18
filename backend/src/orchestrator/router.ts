/**
 * The N4a deterministic router (ADR-008). It proposes the conversation's own
 * specialist — its pin (direct) or a project's default agent — carrying that
 * specialist's declared capabilities. It reads no model: the message-aware
 * router that picks a specialist by capability is N4b, behind the same
 * `RouterPort`, so the automatic flow (selector, decision, inspector) is
 * shippable and fully offline-testable first. The offline suite always runs
 * this one.
 */

import type { RouteInput, RouterPort } from '../domain/ports.js';
import type { RouteProposal } from '../domain/types.js';

export class DeterministicRouter implements RouterPort {
  route(input: RouteInput): Promise<RouteProposal> {
    const specialistId = input.conversation.agentId;
    const specialist = input.specialists.find((s) => s.id === specialistId);
    return Promise.resolve({
      workType: 'task',
      capabilities: specialist?.capabilities ?? [],
      specialistId,
      reason:
        "deterministic default routing (N4a) — the conversation's specialist; the model router lands in N4b",
    });
  }
}
