/**
 * Module-boundary lint (B1-11, 07 §2): the dependency arrows of the modular
 * monolith are enforced by tooling, not discipline. A new module must be
 * registered here WITH its allowed dependencies before code can import it.
 */

import js from '@eslint/js';
import boundaries from 'eslint-plugin-boundaries';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    plugins: { boundaries },
    settings: {
      'import/resolver': {
        typescript: { alwaysTryTypes: true, project: './tsconfig.json' },
      },
      'boundaries/elements': [
        { type: 'app', pattern: 'src/main.ts', mode: 'file' },
        { type: 'domain', pattern: 'src/domain' },
        { type: 'store', pattern: 'src/store' },
        { type: 'orchestrator', pattern: 'src/orchestrator' },
        { type: 'runtime', pattern: 'src/runtime' },
        { type: 'substrate', pattern: 'src/substrate' },
        { type: 'api', pattern: 'src/api' },
        { type: 'backup', pattern: 'src/backup' },
        { type: 'config', pattern: 'src/config' },
        { type: 'observability', pattern: 'src/observability' },
      ],
    },
    rules: {
      // The 07 §2 arrows plus universal leaf access:
      // api→orch, api→store, orch→rt, orch→store, rt→sub, bk→store; config
      // feeds api/orch/rt/sub; every module may import domain (and config,
      // where listed); domain depends on nothing.
      'boundaries/element-types': [
        'error',
        {
          default: 'disallow',
          policies: [
            { from: [{ type: 'domain' }], allow: [{ type: 'domain' }] },
            { from: [{ type: 'store' }], allow: [{ type: 'store' }, { type: 'domain' }] },
            {
              from: [{ type: 'orchestrator' }],
              allow: [
                { type: 'orchestrator' },
                { type: 'domain' },
                { type: 'store' },
                { type: 'runtime' },
                { type: 'config' },
              ],
            },
            {
              from: [{ type: 'runtime' }],
              allow: [
                { type: 'runtime' },
                { type: 'domain' },
                { type: 'substrate' },
                { type: 'config' },
              ],
            },
            {
              from: [{ type: 'substrate' }],
              allow: [{ type: 'substrate' }, { type: 'domain' }, { type: 'config' }],
            },
            {
              from: [{ type: 'api' }],
              allow: [
                { type: 'api' },
                { type: 'domain' },
                { type: 'orchestrator' },
                { type: 'store' },
                { type: 'config' },
                { type: 'observability' },
              ],
            },
            {
              from: [{ type: 'backup' }],
              allow: [{ type: 'backup' }, { type: 'domain' }, { type: 'store' }, { type: 'config' }],
            },
            { from: [{ type: 'config' }], allow: [{ type: 'config' }, { type: 'domain' }] },
            // observability (logger/metrics): depends only on domain
            // interfaces (Logger/Metrics/RunState); store gauges are injected
            // callbacks, not a store import
            {
              from: [{ type: 'observability' }],
              allow: [{ type: 'observability' }, { type: 'domain' }],
            },
            // the composition root wires everything (and only it may)
            {
              from: [{ type: 'app' }],
              allow: [
                { type: 'api' },
                { type: 'orchestrator' },
                { type: 'runtime' },
                { type: 'substrate' },
                { type: 'store' },
                { type: 'backup' },
                { type: 'config' },
                { type: 'observability' },
                { type: 'domain' },
              ],
            },
          ],
        },
      ],
      'boundaries/no-unknown-files': 'error',
      'boundaries/no-unknown-dependencies': 'error',
    },
  },
  {
    files: ['**/*.ts'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // SEC-05 / 13 §5 no-payload-logging: nothing in src logs by default;
      // the composition root opts out explicitly for startup facts only.
      'no-console': 'error',
    },
  },
);
