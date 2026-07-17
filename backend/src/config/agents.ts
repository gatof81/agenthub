/**
 * Agent configuration loader (FR-02, BX-01): agents are config-defined in
 * Phase 1. Real definitions live in gitignored deployment config; the repo
 * ships only `agents.example.yaml` (SEC-10 — instructions carry personal
 * project context and are treated as sensitive).
 */

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { Agent } from '../domain/types.js';

export class AgentConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentConfigError';
  }
}

interface RawAgent {
  /** rejected, not read (ADR-006) — see the guard in parseAgent */
  sessionTemplateId?: unknown;
  id?: unknown;
  name?: unknown;
  instructions?: unknown;
  allowedTools?: unknown;
  runtime?: unknown;
  defaultCaps?: { maxTurns?: unknown; budgetUsd?: unknown; timeoutMs?: unknown };
  /** Specialist identity fields (N3, ADR-008) — both optional */
  role?: unknown;
  capabilities?: unknown;
}

function validateAgent(raw: RawAgent, index: number): Agent {
  const where = `agents[${index}]`;
  if (typeof raw.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(raw.id)) {
    throw new AgentConfigError(`${where}: id must be a stable slug`);
  }
  if (typeof raw.name !== 'string' || raw.name.trim() === '') {
    throw new AgentConfigError(`${where}: name required`);
  }
  if (typeof raw.instructions !== 'string' || raw.instructions.trim() === '') {
    throw new AgentConfigError(`${where}: instructions required`);
  }
  // I-7 at the config layer: never empty-meaning-all (FR-11, SEC-02)
  if (
    !Array.isArray(raw.allowedTools) ||
    raw.allowedTools.length === 0 ||
    raw.allowedTools.some((t) => typeof t !== 'string' || t.trim() === '')
  ) {
    throw new AgentConfigError(
      `${where}: allowedTools must be a non-empty list of tool names (I-7 — an agent without an explicit allowlist is unrepresentable)`,
    );
  }
  // An agent used to declare `sessionTemplateId`. It no longer may: the
  // workspace belongs to the project (ADR-006, FR-45), and a role that
  // carries one cannot be reused across repos. Reject it loudly rather than
  // ignore it — a silently dropped template would provision the wrong
  // workspace and look like a config that worked.
  if (raw.sessionTemplateId !== undefined) {
    throw new AgentConfigError(
      `${where}: sessionTemplateId no longer belongs on an agent — the workspace is the project's (ADR-006). Move it to the project.`,
    );
  }
  if (raw.runtime !== 'claude-cli') {
    throw new AgentConfigError(`${where}: runtime must be "claude-cli" (only Phase-1 value)`);
  }
  const caps = raw.defaultCaps ?? {};
  const maxTurns = Number(caps.maxTurns);
  const budgetUsd = Number(caps.budgetUsd);
  const timeoutMs = Number(caps.timeoutMs);
  if (!(maxTurns > 0) || !(budgetUsd > 0) || !(timeoutMs > 0)) {
    throw new AgentConfigError(
      `${where}: defaultCaps.{maxTurns,budgetUsd,timeoutMs} must all be positive (FR-17 hard limits from day 1)`,
    );
  }
  // Specialist identity fields (N3, ADR-008), both optional. `role` is a
  // display/label string; `capabilities` are free-form tags the router (N4)
  // will select on. Validated when present so a typo (e.g. a scalar where a
  // list belongs) fails at load, not silently at routing time.
  if (raw.role !== undefined && (typeof raw.role !== 'string' || raw.role.trim() === '')) {
    throw new AgentConfigError(`${where}: role, when set, must be a non-empty string`);
  }
  if (
    raw.capabilities !== undefined &&
    (!Array.isArray(raw.capabilities) ||
      raw.capabilities.some((c) => typeof c !== 'string' || c.trim() === ''))
  ) {
    throw new AgentConfigError(
      `${where}: capabilities, when set, must be a list of non-empty strings`,
    );
  }
  return {
    id: raw.id,
    name: raw.name,
    instructions: raw.instructions,
    allowedTools: raw.allowedTools as string[],
    runtime: 'claude-cli',
    defaultCaps: { maxTurns, budgetUsd, timeoutMs },
    ...(raw.role !== undefined ? { role: raw.role } : {}),
    ...(raw.capabilities !== undefined ? { capabilities: raw.capabilities as string[] } : {}),
  };
}

export function parseAgentsYaml(text: string): Map<string, Agent> {
  const doc = parse(text) as { agents?: RawAgent[] } | null;
  if (!doc || !Array.isArray(doc.agents) || doc.agents.length === 0) {
    throw new AgentConfigError('config must contain a non-empty `agents:` list');
  }
  const map = new Map<string, Agent>();
  doc.agents.forEach((raw, i) => {
    const agent = validateAgent(raw, i);
    if (map.has(agent.id)) throw new AgentConfigError(`duplicate agent id: ${agent.id}`);
    map.set(agent.id, agent);
  });
  return map;
}

export function loadAgents(path: string): Map<string, Agent> {
  return parseAgentsYaml(readFileSync(path, 'utf8'));
}
