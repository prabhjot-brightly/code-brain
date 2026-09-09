/**
 * analyzer.ts
 * ───────────
 * Intelligence layer: takes a DiagnosisContext assembled by the Retriever and
 * calls the Claude API to produce a structured diagnosis — root cause, fix,
 * confidence level, and supporting details.
 *
 * The analysis is forced via tool_use so the result is always a well-typed
 * JSON object that can be formatted by the MCP tool caller.
 *
 * Token budget design:
 *   • Model: claude-haiku-4-5 by default ($1/$5 per M — 5× cheaper than Opus).
 *     Override with DIAGNOSIS_MODEL env var when higher reasoning is needed.
 *   • Epicentre: up to EPICENTRE_LINES of source (the part that matters most).
 *   • Callers/callees: signature + doc only — the model only needs to see
 *     what calls what, not the full body of every neighbour.
 *   • max_tokens: 1024 — the structured JSON output is ~300 tokens.
 *
 * Typical cost per call: ~600–900 input tokens + ~300 output tokens ≈ $0.0001.
 */

import Anthropic from '@anthropic-ai/sdk';
import process from 'node:process';
import type { CodeNode, DiagnosisContext } from './types.js';

// ── Result type ────────────────────────────────────────────────────────────────

export interface DiagnosisResult {
  location: {
    file:     string;
    line:     number;
    function: string;
  };
  /** Plain-English explanation of why the issue occurs and under what condition. */
  rootCause:       string;
  /** Concrete code-level suggestion — prefer a specific change, not generic advice. */
  fix:             string;
  /** How certain the diagnosis is given the available context. */
  confidence:      'high' | 'medium' | 'low';
  /** Other functions in the call chain that may need to change. */
  affectedCallers: string[];
  /** What a regression test catching this bug would assert. */
  suggestedTest:   string;
}

// ── Tool definition ────────────────────────────────────────────────────────────

const DIAGNOSIS_TOOL: Anthropic.Tool = {
  name:        'report_diagnosis',
  description: 'Report the structured root-cause diagnosis of a production issue',
  input_schema: {
    type: 'object' as const,
    properties: {
      location: {
        type: 'object',
        description: 'Exact location of the root cause in the codebase',
        properties: {
          file:     { type: 'string', description: 'Repo-relative file path' },
          line:     { type: 'number', description: '1-based line number where the issue occurs' },
          function: { type: 'string', description: 'Method or function name at that location' },
        },
        required: ['file', 'line', 'function'],
      },
      rootCause: {
        type: 'string',
        description: 'Why the issue occurs — what is null/unset/missing/wrong and under what condition',
      },
      fix: {
        type: 'string',
        description: 'The concrete code change needed to fix it; prefer a specific patch over generic advice',
      },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'high = cause is clear from the code; medium = likely but uncertain; low = educated guess',
      },
      affectedCallers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Names of other functions in the call chain that may also need changes',
      },
      suggestedTest: {
        type: 'string',
        description: 'What a regression test would assert to prevent this from regressing',
      },
    },
    required: ['location', 'rootCause', 'fix', 'confidence', 'affectedCallers', 'suggestedTest'],
  },
};

// ── Result types ───────────────────────────────────────────────────────────────

export interface AnalyzeUsage {
  inputTokens:         number;
  outputTokens:        number;
  cacheReadTokens:     number;
  cacheCreationTokens: number;
  estimatedCostUsd:    number;
}

export interface AnalyzeResult {
  diagnosis: DiagnosisResult;
  usage:     AnalyzeUsage;
}

// ── Model pricing (USD per 1M tokens) ─────────────────────────────────────────

const MODEL_RATES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  'claude-haiku-4-5':          { input: 0.80,  output: 4.00,  cacheRead: 0.08,  cacheWrite: 1.00  },
  'claude-haiku-4-5-20251001': { input: 0.80,  output: 4.00,  cacheRead: 0.08,  cacheWrite: 1.00  },
  'claude-sonnet-4-6':         { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  'claude-opus-4-7':           { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
};

function estimateCost(model: string, input: number, output: number, cacheRead: number, cacheWrite: number): number {
  const r = MODEL_RATES[model];
  if (!r) return 0;
  const M = 1_000_000;
  return (input * r.input + output * r.output + cacheRead * r.cacheRead + cacheWrite * r.cacheWrite) / M;
}

// ── Static system prompt (cached across calls) ────────────────────────────────

const SYSTEM_PROMPT =
  'You are a senior software engineer performing root-cause analysis on a production incident. ' +
  'Use only the graph-resolved epicentre, call chain, deterministic findings, and linked incident evidence provided. ' +
  'Cite their identifiers in the rootCause and fix. ' +
  'Treat runtimeEvidence as corroborating context, not proof of an unrepresented code path. ' +
  'If the evidence does not establish a cause, state "insufficient evidence" and do not invent a fix. ' +
  'Call report_diagnosis with: location (file/line/function of root cause), rootCause (why it fails), ' +
  'fix (specific code change), confidence, affectedCallers, suggestedTest.';

// ── Token budget constants ─────────────────────────────────────────────────────

/** Lines of epicentre source to include — this is the key evidence. */
const EPICENTRE_LINES = 15;
/** Max callers/callees to include in the prompt. */
const MAX_NEIGHBOURS  = 3;
/** Max related tests to include. */
const MAX_TESTS       = 2;

// ── Prompt renderers ───────────────────────────────────────────────────────────

/**
 * Render the epicentre node with full source (up to EPICENTRE_LINES).
 * This is the primary evidence — it gets the most context.
 */
function renderEpicentre(node: CodeNode): string {
  const doc = node.documentation
    ? `// ${node.documentation.split('\n')[0]?.trim().slice(0, 120)}\n`
    : '';
  const src = (node.sourceCode ?? node.firstLine ?? '')
    .split('\n')
    .slice(0, EPICENTRE_LINES)
    .join('\n');
  return [
    `[${node.type}] ${node.name}  •  ${node.filePath}:${node.startLine}`,
    '```',
    doc + src,
    '```',
  ].join('\n');
}

/**
 * Render a peripheral node (caller, callee, test) with signature only.
 * The model only needs to know what it is and where — not the full body.
 * Sending the full source of every neighbour is where most tokens go to waste.
 */
function renderSignature(node: CodeNode): string {
  const doc = node.documentation
    ? ` // ${node.documentation.split('\n')[0]?.trim().slice(0, 80)}`
    : '';
  const sig = (node.firstLine ?? node.sourceCode?.split('\n')[0] ?? node.name).trim();
  return `  • ${node.filePath}:${node.startLine}  ${sig}${doc}`;
}

function buildPrompt(ctx: DiagnosisContext): string {
  const parts: string[] = [
    `Problem: ${ctx.question}`,
  ];

  if (ctx.errorMessage) {
    parts.push(`Error: ${ctx.errorMessage}`);
  }
  if (ctx.stackTrace) {
    // Only include the first 8 lines of the stack trace — the rest is noise
    const traceLines = ctx.stackTrace.trim().split('\n').slice(0, 8).join('\n');
    parts.push(`Stack trace (top):\n${traceLines}`);
  }
  if (ctx.runtimeEvidence) {
    parts.push(`Runtime evidence (caller-supplied; not graph proof):\n${ctx.runtimeEvidence}`);
  }
  if (ctx.staticFindings.length > 0) {
    parts.push('\nDeterministic static findings (risk signals, not runtime proof):');
    ctx.staticFindings.forEach(finding => parts.push(
      `  • ${finding.ruleId} (${finding.filePath}:${finding.line}): ${finding.message}`,
    ));
  }
  if (ctx.linkedEvidence.length > 0) {
    parts.push('\nLinked incident evidence:');
    ctx.linkedEvidence.forEach(evidence => parts.push(
      `  • ${evidence.id} (${evidence.observedAt ?? 'time unknown'}): ${evidence.summary}`,
    ));
  }

  if (ctx.epicentre) {
    parts.push(`\nEpicentre (failure location):\n${renderEpicentre(ctx.epicentre)}`);
  }

  if (ctx.callers.length > 0) {
    parts.push(`\nCallers (what calls the epicentre):`);
    ctx.callers.slice(0, MAX_NEIGHBOURS).forEach(n => parts.push(renderSignature(n)));
  }

  if (ctx.callees.length > 0) {
    parts.push(`\nCallees (what the epicentre calls — potential null sources):`);
    ctx.callees.slice(0, MAX_NEIGHBOURS).forEach(n => parts.push(renderSignature(n)));
  }

  if (ctx.relatedTests.length > 0) {
    parts.push(`\nRelated tests:`);
    ctx.relatedTests.slice(0, MAX_TESTS).forEach(n => parts.push(renderSignature(n)));
  }

  return parts.join('\n');
}

// ── Analyzer class ─────────────────────────────────────────────────────────────

export class Analyzer {
  private readonly client: Anthropic;
  readonly model: string;

  constructor(apiKey?: string) {
    this.client = new Anthropic({ apiKey });
    // Default model is read from DIAGNOSIS_MODEL env var.
    // Override in .env: set DIAGNOSIS_MODEL=claude-opus-5 for deeper reasoning.
    this.model  = process.env['DIAGNOSIS_MODEL'] ?? 'sparkai-developer-claude';
  }

  /**
   * Run root-cause analysis on a DiagnosisContext assembled by the Retriever.
   * Forces structured output via tool_use so the result is always parseable.
   *
   * The static system prompt and tool schema are marked cache_control:ephemeral
   * so repeated calls within 5 minutes pay only the cache-read rate (~10× cheaper).
   *
   * Returns the diagnosis alongside actual Anthropic API token counts and cost.
   */
  async analyze(ctx: DiagnosisContext): Promise<AnalyzeResult> {
    const response = await this.client.messages.create({
      model:      this.model,
      max_tokens: 1024,
      system: [
        { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
      ],
      tools: [
        // cache_control on the last tool caches the entire tools array
        { ...DIAGNOSIS_TOOL, cache_control: { type: 'ephemeral' } } as Anthropic.Tool,
      ],
      tool_choice: { type: 'tool', name: 'report_diagnosis' },
      messages:    [{ role: 'user', content: buildPrompt(ctx) }],
    });

    const toolBlock = response.content.find(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );
    if (!toolBlock) {
      throw new Error('[analyzer] Claude did not call report_diagnosis — check the API response');
    }

    const inp = toolBlock.input as Record<string, unknown>;
    const diagnosis: DiagnosisResult = {
      location:        inp['location']        as DiagnosisResult['location'],
      rootCause:       inp['rootCause']        as string,
      fix:             inp['fix']              as string,
      confidence:      inp['confidence']       as DiagnosisResult['confidence'],
      affectedCallers: (inp['affectedCallers'] as string[]) ?? [],
      suggestedTest:   inp['suggestedTest']    as string,
    };

    const u = response.usage;
    const cacheRead  = u.cache_read_input_tokens    ?? 0;
    const cacheWrite = u.cache_creation_input_tokens ?? 0;
    const usage: AnalyzeUsage = {
      inputTokens:         u.input_tokens,
      outputTokens:        u.output_tokens,
      cacheReadTokens:     cacheRead,
      cacheCreationTokens: cacheWrite,
      estimatedCostUsd:    estimateCost(this.model, u.input_tokens, u.output_tokens, cacheRead, cacheWrite),
    };

    process.stderr.write(
      `[analyzer] in:${u.input_tokens} cache_read:${cacheRead} cache_write:${cacheWrite} out:${u.output_tokens} cost:$${usage.estimatedCostUsd.toFixed(6)}\n`,
    );

    return { diagnosis, usage };
  }
}
