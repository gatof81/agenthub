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

  it('rejects an empty allowlist — I-7 starts at the config layer', () => {
    const bad = EXAMPLE.replace('allowedTools: [Read, Grep, Glob, Write, Edit, Bash]', 'allowedTools: []');
    expect(() => parseAgentsYaml(bad)).toThrow(AgentConfigError);
    expect(() => parseAgentsYaml(bad)).toThrow(/allowlist|allowedTools/);
  });

  it('rejects non-positive caps (FR-17)', () => {
    const bad = EXAMPLE.replace('maxTurns: 30', 'maxTurns: 0');
    expect(() => parseAgentsYaml(bad)).toThrow(AgentConfigError);
  });

  it('rejects unknown runtimes and duplicate ids', () => {
    expect(() => parseAgentsYaml(EXAMPLE.replace('runtime: claude-cli', 'runtime: warp-drive'))).toThrow(
      AgentConfigError,
    );
    const doc = parseAgentsYaml(EXAMPLE);
    expect(doc.size).toBe(1);
    const dup = `${EXAMPLE}\n  - id: dev\n    name: Dup\n    instructions: x\n    allowedTools: [Read]\n    sessionTemplateId: default\n    runtime: claude-cli\n    defaultCaps: { maxTurns: 1, budgetUsd: 1, timeoutMs: 1000 }\n`;
    expect(() => parseAgentsYaml(dup)).toThrow(/duplicate/);
  });
});
