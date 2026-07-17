/** Agent config loader (FR-02, SEC-10, I-7 at the config layer). */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AgentConfigError, parseAgentsYaml } from '../src/config/agents.js';

const EXAMPLE = readFileSync(
  fileURLToPath(new URL('../agents.example.yaml', import.meta.url)),
  'utf8',
);

describe('agent config (FR-02)', () => {
  it('parses the shipped agents.example.yaml (SEC-10 keeps real config out of the repo)', () => {
    const agents = parseAgentsYaml(EXAMPLE);
    const dev = agents.get('dev')!;
    expect(dev.runtime).toBe('claude-cli');
    expect(dev.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Write', 'Edit', 'Bash']); // 08 §5
    expect(dev.defaultCaps.maxTurns).toBeGreaterThan(0);
  });

  it('parses the specialist role + capabilities (N3, ADR-008)', () => {
    const agents = parseAgentsYaml(EXAMPLE);
    expect(agents.get('dev')!.role).toBe('Software Developer');
    expect(agents.get('dev')!.capabilities).toContain('implementation');
    expect(agents.get('qa')!.role).toBe('QA Specialist');
    // QA reads and runs, never writes implementation (ADR-009/010)
    expect(agents.get('qa')!.allowedTools).toEqual(['Read', 'Grep', 'Glob', 'Bash']);
  });

  it('role + capabilities are optional — a bare agent still loads', () => {
    const bare = `
agents:
  - id: plain
    name: Plain
    instructions: x
    allowedTools: [Read]
    runtime: claude-cli
    defaultCaps: { maxTurns: 1, budgetUsd: 1, timeoutMs: 1000 }
`;
    const plain = parseAgentsYaml(bare).get('plain')!;
    expect(plain.role).toBeUndefined();
    expect(plain.capabilities).toBeUndefined();
  });

  it('rejects a malformed role / capabilities (typo caught at load, not routing)', () => {
    expect(() => parseAgentsYaml(EXAMPLE.replace('role: Software Developer', 'role: ""'))).toThrow(
      /role/,
    );
    expect(() =>
      parseAgentsYaml(
        EXAMPLE.replace('capabilities: [implementation, refactoring, debugging, tests]', 'capabilities: nope'),
      ),
    ).toThrow(/capabilities/);
  });

  it('rejects an empty allowlist — I-7 starts at the config layer', () => {
    const bad = EXAMPLE.replace('allowedTools: [Read, Grep, Glob, Write, Edit, Bash]', 'allowedTools: []');
    expect(() => parseAgentsYaml(bad)).toThrow(AgentConfigError);
    expect(() => parseAgentsYaml(bad)).toThrow(/allowlist|allowedTools/);
  });

  it('rejects non-positive caps (FR-17)', () => {
    const bad = EXAMPLE.replace('maxTurns: 30', 'maxTurns: 0');
    expect(() => parseAgentsYaml(bad)).toThrow(AgentConfigError);
  });

  it("rejects sessionTemplateId on an agent — the workspace is the project's (ADR-006)", () => {
    // The guard this PR leads with: an agent declaring a workspace is a role
    // carrying a repo, which ADR-006 removed. Rejecting beats ignoring — a
    // silently dropped template provisions the WRONG workspace and looks like
    // a config that worked.
    const yaml = `
agents:
  - id: dev
    name: Developer
    instructions: dev
    allowedTools: [Read]
    sessionTemplateId: default
    runtime: claude-cli
    defaultCaps: { maxTurns: 10, budgetUsd: 1, timeoutMs: 60000 }
`;
    expect(() => parseAgentsYaml(yaml)).toThrow(/sessionTemplateId/);
    // and it must say where the field went, not merely that it is unwelcome
    expect(() => parseAgentsYaml(yaml)).toThrow(/project/);
  });

  it('rejects unknown runtimes and duplicate ids', () => {
    expect(() => parseAgentsYaml(EXAMPLE.replace('runtime: claude-cli', 'runtime: warp-drive'))).toThrow(
      AgentConfigError,
    );
    const doc = parseAgentsYaml(EXAMPLE);
    expect(doc.size).toBe(2); // dev + qa specialists (N3)
    const dup = `${EXAMPLE}\n  - id: dev\n    name: Dup\n    instructions: x\n    allowedTools: [Read]\n    runtime: claude-cli\n    defaultCaps: { maxTurns: 1, budgetUsd: 1, timeoutMs: 1000 }\n`;
    expect(() => parseAgentsYaml(dup)).toThrow(/duplicate/);
  });
});
