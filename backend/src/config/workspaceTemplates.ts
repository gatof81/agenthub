/**
 * Workspace templates the deployment offers (ADR-006, FR-45).
 *
 * A project must declare the substrate template its session is built from,
 * and the value has no sane default — falling back to the agent's template is
 * exactly the conflation ADR-006 removed. So the client has to send one,
 * which means it has to be able to *know* one: this is the list it picks from.
 *
 * Deployment config, not code (SEC-10): template ids are substrate-side
 * identifiers of a particular deployment, so the repo ships only the example.
 */

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

export class WorkspaceTemplateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceTemplateConfigError';
  }
}

export interface WorkspaceTemplate {
  /** the substrate's template id — opaque to the Hub */
  id: string;
  /** what the owner sees when choosing */
  name: string;
  description?: string;
}

interface RawTemplate {
  id?: unknown;
  name?: unknown;
  description?: unknown;
}

function validate(raw: RawTemplate, i: number): WorkspaceTemplate {
  const where = `workspaceTemplates[${i}]`;
  if (typeof raw.id !== 'string' || raw.id.trim() === '') {
    throw new WorkspaceTemplateConfigError(`${where}: id required`);
  }
  if (typeof raw.name !== 'string' || raw.name.trim() === '') {
    throw new WorkspaceTemplateConfigError(`${where}: name required`);
  }
  return {
    id: raw.id,
    name: raw.name,
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
  };
}

export function parseWorkspaceTemplatesYaml(text: string): WorkspaceTemplate[] {
  const doc = parse(text) as { workspaceTemplates?: RawTemplate[] } | null;
  // Absent is a legal config, not an error: a deployment that has not declared
  // its templates yet still boots. The API surfaces the empty list and project
  // creation fails loudly at 422 — better than the Hub refusing to start over
  // a field only one route needs.
  if (!doc?.workspaceTemplates) return [];
  if (!Array.isArray(doc.workspaceTemplates)) {
    throw new WorkspaceTemplateConfigError('`workspaceTemplates:` must be a list');
  }
  const seen = new Set<string>();
  return doc.workspaceTemplates.map((raw, i) => {
    const t = validate(raw, i);
    if (seen.has(t.id)) throw new WorkspaceTemplateConfigError(`duplicate template id: ${t.id}`);
    seen.add(t.id);
    return t;
  });
}

export function loadWorkspaceTemplates(path: string): WorkspaceTemplate[] {
  return parseWorkspaceTemplatesYaml(readFileSync(path, 'utf8'));
}
