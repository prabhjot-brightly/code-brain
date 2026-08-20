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

  parts.push(`\nUse only the graph-resolved epicentre, call chain, deterministic findings, and linked incident evidence above. Cite their identifiers in the rootCause and fix. Treat runtime evidence as corroborating context, not proof of an unrepresented code path. If the evidence does not establish a cause, state "insufficient evidence" and do not invent a fix. Call report_diagnosis with: location (file/line/function of the root cause), rootCause (why it fails), fix (specific code change), confidence, affectedCallers, suggestedTest.`);

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
   * Throws if the Anthropic API is unavailable or the API key is missing.
   *
   * Typical token usage:
   *   Input:  ~600–900 tokens  (prompt + tool schema)
   *   Output: ~250–350 tokens  (structured JSON from tool call)
   *   Cost:   ~$0.0001 per diagnosis at Haiku 4.5 rates
   */
  async analyze(ctx: DiagnosisContext): Promise<DiagnosisResult> {
    const response = await this.client.messages.create({
      model:      this.model,
      // 1024 is enough for the structured JSON output (~300 tokens actual).
      // Increase to 2048 only if you observe truncated responses.
      max_tokens:  1024,
      tools:       [DIAGNOSIS_TOOL],
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
    return {
      location:        inp['location']        as DiagnosisResult['location'],
      rootCause:       inp['rootCause']        as string,
      fix:             inp['fix']              as string,
      confidence:      inp['confidence']       as DiagnosisResult['confidence'],
      affectedCallers: (inp['affectedCallers'] as string[]) ?? [],
      suggestedTest:   inp['suggestedTest']    as string,
    };
  }
}
