/**
 * The N5b report extractor (ADR-009): turns a specialist run's output into a
 * typed work product — `ImplementationReport` after a dev step, `QaReport`
 * (with the load-bearing `verdict`) after a QA step. Same shape as the router
 * (ADR-012): a deterministic, mechanical fake for the offline suite, and a
 * model call (Messages API forced tool, reusing the Claude OAuth token) in
 * `real` mode behind the same port. A model never decides authority; the
 * verdict only drives the supervisor's loop, which the orchestrator enforces.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  DesignBriefInput,
  QaReportInput,
  ReportExtractorPort,
  ReportInput,
} from '../domain/ports.js';
import { NOOP_LOGGER, type Logger } from '../domain/ports.js';
import type { DesignBrief, ImplementationReport, QaReport } from '../domain/types.js';

const EXTRACTOR_MODEL = 'claude-haiku-4-5';
const DEFAULT_TIMEOUT_MS = 12_000;

/**
 * Mechanical extractor — grounds every field in the run's summary, never a
 * model. Used offline, and as the real extractor's fallback. Its QA verdict is
 * a simple marker rule (`CHANGES_REQUIRED` in the output → changes_required,
 * else passed) so tests can drive the loop deterministically.
 */
export class DeterministicReportExtractor implements ReportExtractorPort {
  extractImplementation(input: ReportInput): Promise<ImplementationReport> {
    return Promise.resolve({
      objective: input.objective,
      summary: input.assistantOutput.slice(0, 2000) || (input.summary?.objective ?? ''),
      filesChanged: input.summary?.filesTouched ?? [],
      commandsRun: input.summary?.commandsRun ?? [],
      testsRun: [],
      knownRisks: [],
      commitOrPatch: null,
    });
  }

  extractQa(input: QaReportInput): Promise<QaReport> {
    const verdict: QaReport['verdict'] = /CHANGES_REQUIRED/.test(input.assistantOutput)
      ? 'changes_required'
      : 'passed';
    return Promise.resolve({
      requirementsReviewed: [input.objective].filter(Boolean),
      testsRun: input.summary?.commandsRun ?? [],
      passed: verdict === 'passed' ? (input.summary?.commandsRun ?? []) : [],
      failed: [],
      regressions: [],
      verdict,
    });
  }

  extractDesign(input: DesignBriefInput): Promise<DesignBrief> {
    return Promise.resolve({
      objective: input.objective,
      constraints: [],
      // the consult's advice IS the output text; mechanical, never invented
      approach: input.assistantOutput.slice(0, 4000) || 'no design output produced',
      risks: [],
      outOfScope: [],
    });
  }
}

export interface ModelReportExtractorDeps {
  oauthToken: string;
  logger?: Logger;
  model?: string;
  timeoutMs?: number;
  client?: Pick<Anthropic, 'messages'>;
}

const IMPL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    objective: { type: 'string' },
    summary: { type: 'string' },
    filesChanged: { type: 'array', items: { type: 'string' } },
    commandsRun: { type: 'array', items: { type: 'string' } },
    testsRun: { type: 'array', items: { type: 'string' } },
    knownRisks: { type: 'array', items: { type: 'string' } },
    commitOrPatch: { type: 'string' },
  },
  required: ['objective', 'summary', 'filesChanged', 'commandsRun', 'testsRun', 'knownRisks'],
} as const;

const QA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    requirementsReviewed: { type: 'array', items: { type: 'string' } },
    testsRun: { type: 'array', items: { type: 'string' } },
    passed: { type: 'array', items: { type: 'string' } },
    failed: { type: 'array', items: { type: 'string' } },
    regressions: { type: 'array', items: { type: 'string' } },
    verdict: { type: 'string', enum: ['passed', 'changes_required'] },
  },
  required: ['requirementsReviewed', 'testsRun', 'passed', 'failed', 'regressions', 'verdict'],
} as const;

const DESIGN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    objective: { type: 'string' },
    constraints: { type: 'array', items: { type: 'string' } },
    approach: { type: 'string' },
    risks: { type: 'array', items: { type: 'string' } },
    outOfScope: { type: 'array', items: { type: 'string' } },
  },
  required: ['objective', 'constraints', 'approach', 'risks', 'outOfScope'],
} as const;

export class ModelReportExtractor implements ReportExtractorPort {
  private readonly client: Pick<Anthropic, 'messages'>;
  private readonly fallback = new DeterministicReportExtractor();
  private readonly logger: Logger;
  private readonly model: string;

  constructor(deps: ModelReportExtractorDeps) {
    this.logger = deps.logger ?? NOOP_LOGGER;
    this.model = deps.model ?? EXTRACTOR_MODEL;
    this.client =
      deps.client ??
      new Anthropic({
        authToken: deps.oauthToken,
        defaultHeaders: { 'anthropic-beta': 'oauth-2025-04-20' },
        timeout: deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxRetries: 0,
      });
  }

  async extractImplementation(input: ReportInput): Promise<ImplementationReport> {
    try {
      const body = await this.callTool<ImplementationReport>(
        'submit_implementation_report',
        'Summarize what the developer implemented into a structured report.',
        IMPL_SCHEMA,
        this.implPrompt(input),
      );
      return {
        objective: body.objective ?? input.objective,
        summary: body.summary ?? '',
        filesChanged: body.filesChanged ?? [],
        commandsRun: body.commandsRun ?? [],
        testsRun: body.testsRun ?? [],
        knownRisks: body.knownRisks ?? [],
        commitOrPatch: body.commitOrPatch ?? null,
      };
    } catch (err) {
      // impl-report failure is not safety-critical → mechanical fallback
      this.logger.warn('report.extract_fallback', { kind: 'implementation', error: errName(err) });
      return this.fallback.extractImplementation(input);
    }
  }

  async extractQa(input: QaReportInput): Promise<QaReport> {
    try {
      const body = await this.callTool<QaReport>(
        'submit_qa_report',
        'Summarize the QA review into a structured report. verdict=passed only if QA found no failures or regressions.',
        QA_SCHEMA,
        this.qaPrompt(input),
      );
      const verdict: QaReport['verdict'] = body.verdict === 'passed' ? 'passed' : 'changes_required';
      return {
        requirementsReviewed: body.requirementsReviewed ?? [],
        testsRun: body.testsRun ?? [],
        passed: body.passed ?? [],
        failed: body.failed ?? [],
        regressions: body.regressions ?? [],
        verdict,
      };
    } catch (err) {
      // SAFE fallback: an extraction failure must NEVER auto-pass QA — default
      // to changes_required so the task loops back rather than falsely advancing
      // toward approval.
      this.logger.warn('report.extract_fallback', { kind: 'qa', error: errName(err) });
      return {
        requirementsReviewed: [],
        testsRun: [],
        passed: [],
        failed: ['report extraction failed — QA verdict could not be determined'],
        regressions: [],
        verdict: 'changes_required',
      };
    }
  }

  async extractDesign(input: DesignBriefInput): Promise<DesignBrief> {
    try {
      const body = await this.callTool<DesignBrief>(
        'submit_design_brief',
        'Summarize the architect consult into a structured design brief.',
        DESIGN_SCHEMA,
        this.designPrompt(input),
      );
      return {
        objective: body.objective ?? input.objective,
        constraints: body.constraints ?? [],
        approach: body.approach ?? '',
        risks: body.risks ?? [],
        outOfScope: body.outOfScope ?? [],
      };
    } catch (err) {
      // advisory, never a gate (ADR-015) → mechanical fallback
      this.logger.warn('report.extract_fallback', { kind: 'design', error: errName(err) });
      return this.fallback.extractDesign(input);
    }
  }

  private async callTool<T>(
    toolName: string,
    toolDescription: string,
    schema: unknown,
    prompt: string,
  ): Promise<Partial<T>> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ name: toolName, description: toolDescription, input_schema: schema as never }],
      tool_choice: { type: 'tool', name: toolName },
    });
    const toolUse = response.content.find((b) => b.type === 'tool_use');
    if (!toolUse || toolUse.type !== 'tool_use') throw new Error('extractor: no tool_use block');
    return toolUse.input as Partial<T>;
  }

  private implPrompt(input: ReportInput): string {
    return (
      `Objective:\n${input.objective}\n\n` +
      `What the developer reported doing:\n${input.assistantOutput}\n\n` +
      `Mechanical grounding — files touched: ${(input.summary?.filesTouched ?? []).join(', ') || 'none'}; ` +
      `commands run: ${(input.summary?.commandsRun ?? []).join(', ') || 'none'}.`
    );
  }

  private designPrompt(input: DesignBriefInput): string {
    return (
      `Objective:\n${input.objective}\n\n` +
      `The implementer's design question:\n${input.question || '(none stated)'}\n\n` +
      `What the architect advised:\n${input.assistantOutput}`
    );
  }

  private qaPrompt(input: QaReportInput): string {
    return (
      `Objective:\n${input.objective}\n\n` +
      `Implementation under review:\n${JSON.stringify(input.implementationReport)}\n\n` +
      `What QA reported:\n${input.assistantOutput}\n\n` +
      `Commands run: ${(input.summary?.commandsRun ?? []).join(', ') || 'none'}.`
    );
  }
}

function errName(err: unknown): string {
  return err instanceof Error ? err.name : 'unknown';
}
