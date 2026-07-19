/**
 * The N4b model router (ADR-012, ADR-008). Given the message and the available
 * specialists (identity + capabilities), it asks a small model — one cheap
 * Messages API call — which specialist should handle the turn and whether it is
 * a question or a task. It only PROPOSES: the deterministic selector still
 * chooses the session and the orchestrator enforces (01 §3, SEC-01).
 *
 * Architecture carve-out (ADR-012): this is the one place the Hub calls the
 * model OUTSIDE the exec seam — a session-independent control-plane decision,
 * never agent execution. It reuses the Claude OAuth token (no new secret), and
 * on ANY failure (model error, timeout, or a proposal naming an unknown
 * specialist) it falls back to the deterministic router, so automatic mode
 * never breaks a turn — worst case it routes exactly as N4a did.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { RouteInput, RouterPort } from '../domain/ports.js';
import { NOOP_LOGGER, type Logger } from '../domain/ports.js';
import type { RouteProposal } from '../domain/types.js';
import { DeterministicRouter } from './router.js';

/** Small, cheap model for the routing classification (ADR-012). */
const ROUTER_MODEL = 'claude-haiku-4-5';
/** Bound the router call so a slow model never stalls a turn; fallback on trip. */
const DEFAULT_TIMEOUT_MS = 8000;

export interface ModelRouterDeps {
  /** the Claude OAuth token, reused from real-mode config (ADR-012) */
  oauthToken: string;
  /** structured logging; only scalars, never the message payload (SEC-04/05) */
  logger?: Logger;
  /** overridable for tests; defaults to Haiku 4.5 */
  model?: string;
  timeoutMs?: number;
  /** injectable for tests — a fake Anthropic-shaped client */
  client?: Pick<Anthropic, 'messages'>;
}

/** What the model is asked to return; capabilities are grounded from config, not the model. */
interface ModelProposal {
  workType: 'question' | 'task';
  specialistId: string;
  reason: string;
}

export class ModelRouter implements RouterPort {
  private readonly client: Pick<Anthropic, 'messages'>;
  private readonly fallback = new DeterministicRouter();
  private readonly logger: Logger;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(deps: ModelRouterDeps) {
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.model = deps.model ?? ROUTER_MODEL;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // OAuth tokens authenticate via `Authorization: Bearer` + the oauth beta
    // header (not `x-api-key`). The token is never logged (SEC-04).
    this.client =
      deps.client ??
      new Anthropic({
        authToken: deps.oauthToken,
        defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
        timeout: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxRetries: 0, // the fallback IS the retry; don't stall the turn
      });
  }

  async route(input: RouteInput): Promise<RouteProposal> {
    const ids = input.specialists.map((s) => s.id);
    if (ids.length === 0) return this.fallback.route(input);

    try {
      const proposal = await this.callModel(input, ids);
      const specialist = input.specialists.find((s) => s.id === proposal.specialistId);
      if (!specialist) {
        // model named a specialist that doesn't exist — never trust it
        this.logger.warn('router.model_unknown_specialist', { conversationId: input.conversation.id });
        return this.fallback.route(input);
      }
      return {
        workType: proposal.workType,
        // capabilities stay grounded in config (the chosen specialist's), not
        // whatever the model might invent
        capabilities: specialist.capabilities ?? [],
        specialistId: specialist.id,
        reason: `model router (N4b): ${proposal.reason}`,
      };
    } catch (err) {
      // model error / timeout / malformed output → deterministic fallback.
      // Log the CLASS only, never the message or the model output (SEC-04/05).
      this.logger.warn('router.model_fallback', {
        conversationId: input.conversation.id,
        error: err instanceof Error ? err.name : 'unknown',
      });
      return this.fallback.route(input);
    }
  }

  private async callModel(input: RouteInput, ids: string[]): Promise<ModelProposal> {
    const roster = input.specialists
      .map((s) => `- ${s.id}: ${s.name} — ${s.role ?? 'specialist'} (capabilities: ${(s.capabilities ?? []).join(', ') || 'none'})`)
      .join('\n');

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 256,
      system:
        'You route a user message to the right specialist. Decide whether the ' +
        'message is a QUESTION (answer directly) or a TASK (do work), then pick ' +
        'the single best specialist for it from the roster by their capabilities. ' +
        'Reply with the specialist id exactly as given. Be concise in the reason.',
      messages: [
        {
          role: 'user',
          content: `Specialists:\n${roster}\n\nUser message:\n${input.message}`,
        },
      ],
      output_config: {
        format: {
          type: 'json_schema',
          name: 'route_proposal',
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              workType: { type: 'string', enum: ['question', 'task'] },
              specialistId: { type: 'string', enum: ids },
              reason: { type: 'string' },
            },
            required: ['workType', 'specialistId', 'reason'],
          },
        },
      },
    } as Anthropic.MessageCreateParamsNonStreaming);

    const text = response.content.find((b) => b.type === 'text');
    if (!text || text.type !== 'text') throw new Error('router: no text block in response');
    const parsed = JSON.parse(text.text) as ModelProposal;
    if (parsed.workType !== 'question' && parsed.workType !== 'task') {
      throw new Error('router: invalid workType');
    }
    if (typeof parsed.specialistId !== 'string') throw new Error('router: invalid specialistId');
    return parsed;
  }
}
