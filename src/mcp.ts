/**
 * mcp.ts — MCP server entry point
 * ────────────────────────────────
 * Exposes five tools:
 *   index_repo      — index a local repo into Neo4j
 *   index_github    — clone + index a GitHub repo into Neo4j
 *   query_codebase  — semantic + structural search across indexed repos
 *   diagnose_issue  — root-cause diagnosis for production incidents
 *   get_stats       — show all indexed repos and node/edge counts
 *
 * Neo4j connection is configured via environment variables (see .env):
 *   NEO4J_URI, NEO4J_USER, NEO4J_PASSWORD, NEO4J_DATABASE
 */

import os from 'node:os';
import process from 'node:process';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { Indexer } from './indexer.js';
import { Retriever } from './retriever.js';
import { Analyzer } from './analyzer.js';
import { Neo4jDb } from './neo4j-database.js';
import { cloneOrPull } from './github.js';
import { countTokens } from '@anthropic-ai/tokenizer';

function tokenUsage(tool: string, input: string, output: string): string {
  const inputTokens = countTokens(input);
  const outputTokens = countTokens(output);
  process.stderr.write(`[tokens] ${tool} in:${inputTokens} out:${outputTokens}\n`);
  return `\n\nToken usage (Knowledge Graph MCP): input ${inputTokens}, output ${outputTokens}, total ${inputTokens + outputTokens}.`;
}

// Cloned repos land here — configurable via REPOS_DIR env var so the package
// directory stays clean. Defaults to the OS temp dir (mirrors codegraph pattern).
const REPOS_DIR  = process.env['REPOS_DIR']
  ?? path.join(os.tmpdir(), 'repo-knowledge-graph', 'repos');

// ── Singletons — one driver, reused across all tool calls ────────────────────

const neo4jDb   = new Neo4jDb();
const indexer   = new Indexer(neo4jDb);
const retriever = new Retriever(neo4jDb);
const analyzer  = new Analyzer();

// Verify connectivity and create schema on startup (idempotent)
try {
  await neo4jDb.verifyConnectivity();
  await neo4jDb.init();
  process.stderr.write('[mcp] connected to Neo4j ✓\n');
} catch (err) {
  process.stderr.write(`[mcp] ⚠ Neo4j connection failed: ${String(err)}\n`);
  process.stderr.write('[mcp]   Check NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD in .env\n');
  process.exit(1);
}

// ── Server ────────────────────────────────────────────────────────────────────

const server = new McpServer({
  name:    'repo-knowledge-graph',
  version: '2.0.0',
});

// ─── Tool: index_repo ─────────────────────────────────────────────────────────

server.tool(
  'index_repo',
  'Index a local repository into the knowledge graph',
  {
    repoPath: z.string().describe('Absolute path to the local repository'),
  },
  async ({ repoPath }) => {
    const absRepo  = path.resolve(repoPath);
    const repoName = path.basename(absRepo);

    const result = await indexer.index({ repoPath: absRepo, repoName });
    const count  = await indexer.embedNodes(absRepo, repoName);

    return {
      content: [{
        type: 'text',
        text: [
          `Indexed ${absRepo}`,
          `✓ ${result.filesScanned} files · ${result.nodesFound} nodes · ${result.edgesFound} edges · ${result.findingsFound} deterministic findings · ${count} embeddings (${result.durationMs}ms)`,
          `Stored in Neo4j database "${neo4jDb.database}" as repo "${repoName}"`,
        ].join('\n'),
      }],
    };
  },
);

// ─── Tool: index_github ───────────────────────────────────────────────────────

server.tool(
  'index_github',
  'Clone a GitHub repo and index it into the knowledge graph',
  {
    repo: z.string().describe('GitHub owner/repo or full URL, e.g. "expressjs/express"'),
  },
  async ({ repo }) => {
    const meta   = await cloneOrPull(repo, REPOS_DIR);
    const result = await indexer.index({ repoPath: meta.repoPath, repoName: meta.repoName });
    const count  = await indexer.embedNodes(meta.repoPath, meta.repoName);

    return {
      content: [{
        type: 'text',
        text: [
          `Cloned and indexed ${meta.repoUrl}`,
          `✓ ${result.filesScanned} files · ${result.nodesFound} nodes · ${result.edgesFound} edges · ${result.findingsFound} deterministic findings · ${count} embeddings (${result.durationMs}ms)`,
          `Stored in Neo4j database "${neo4jDb.database}" as repo "${meta.repoName}"`,
        ].join('\n'),
      }],
    };
  },
);

// ─── Tool: query_codebase ─────────────────────────────────────────────────────

server.tool(
  'query_codebase',
  [
    'Retrieve relevant source code chunks from the indexed knowledge graph. Returns actual code so you can answer questions directly.',
    '',
    'EFFICIENCY RULES — follow these to minimise token cost:',
    '1. Prefer symbol= over a keyword question whenever you know the class or method name.',
    '   Symbol lookup is an exact index hit; keyword search embeds + scans the whole graph.',
    '2. For production incidents / alerts use diagnose_issue FIRST — it replaces 5+ query_codebase calls.',
    '3. Keep limit ≤ 4 (default). Only raise it if you got 0 useful results at limit=4.',
    '4. Keep depth = 1 (default). Only use depth=2 when you are deliberately tracing a specific call chain from a known symbol — it doubles the Neo4j work and the tokens returned.',
    '5. Do not repeat the same concept with different keywords — one well-targeted call beats three broad ones.',
    '6. After getting results, if you need full source for 2+ nodes use get_nodes_context([{file,line},...]) — one call instead of N sequential get_node_context calls.',
  ].join('\n'),
  {
    question: z.string().describe('The question or topic to find relevant code for. Ignored when symbol= is set — prefer symbol= for known class/method names.'),
    symbol:   z.string().optional().describe('Exact class or method name to look up (e.g. "ErpAdapterFactory"). Preferred over keyword question — cheaper and more precise.'),
    filePath: z.string().optional().describe('Focus on a specific file path'),
    nodeType: z.enum(['FILE', 'CLASS', 'FUNCTION', 'METHOD', 'INTERFACE']).optional()
                .describe('Filter by node type. Use METHOD to limit results to logic nodes only.'),
    depth:    z.number().nonnegative().optional().default(1).describe('BFS graph traversal depth (default 1). Depth 2 doubles Neo4j work and returned tokens — only use when explicitly tracing a call chain from a known symbol.'),
    limit:    z.number().nonnegative().optional().default(4).describe('Max results to return (default 4). Raising this increases token cost proportionally — only go above 4 if 4 results were insufficient.'),
    repo:     z.string().optional()
                .describe('Filter to a specific repo name (omit to search across all indexed repos)'),
  },
  async ({ question, symbol, filePath, nodeType, depth, limit, repo }) => {
    const requestText = JSON.stringify({ question, symbol, filePath, nodeType, depth, limit, repo });
    const chunks = await retriever.retrieve({
      question,
      ...(symbol   !== undefined && { symbol }),
      ...(filePath !== undefined && { filePath }),
      ...(nodeType !== undefined && { nodeType }),
      maxDepth: depth,
      limit,
      repoName: repo,
    });

    if (chunks.length === 0) {
      const responseText = 'No relevant code found. Try symbol= with an exact class/method name, or broaden the question.';
      return {
        content: [{
          type: 'text',
          text: responseText + tokenUsage('query_codebase', requestText, responseText),
        }],
      };
    }

    // ── Fetch caller/callee counts in one round-trip ──────────────────────────
    const callCounts = await neo4jDb.getCallCounts(chunks.map(c => c.node.id));

    // ── Compact grouped-by-file format ────────────────────────────────────────
    // Groups multiple results from the same file under one path header.
    // Shows the repo name when results span multiple repos.
    const byFile = new Map<string, typeof chunks>();
    for (const c of chunks) {
      const existing = byFile.get(c.node.filePath) ?? [];
      existing.push(c);
      byFile.set(c.node.filePath, existing);
    }

    // Detect if results span multiple repos
    const distinctRepos = new Set(chunks.map(c => c.node.repoName ?? ''));
    const repoLabel     = repo
      ?? (distinctRepos.size === 1 ? [...distinctRepos][0] : `${distinctRepos.size} repos`);

    const blocks = [...byFile.entries()].map(([fp, fileChunks]) => {
      const methods = fileChunks.map((c) => {
        const loc    = `L${c.node.startLine}`;
        const sig    = c.sourceLines[0]?.trim() ?? c.node.firstLine ?? c.node.name;
        const counts = callCounts.get(c.node.id);
        const graph  = counts
          ? ` ← ${counts.callerCount} caller${counts.callerCount !== 1 ? 's' : ''} · ${counts.calleeCount} callee${counts.calleeCount !== 1 ? 's' : ''}`
          : '';
        return `  [${c.node.type} ${loc}] ${sig}${graph}`;
      }).join('\n');
      return `${fp}\n${methods}`;
    }).join('\n\n');

    const responseText = `Repo: ${repoLabel} | ${chunks.length} results\n\n${blocks}`;
    return {
      content: [{
        type: 'text',
        text: responseText + tokenUsage('query_codebase', requestText, responseText),
      }],
    };
  },
);

// ─── Tool: get_node_context ─────────────────────────────────────────────────

server.tool(
  'get_node_context',
  'Retrieve the bounded source body and documentation for the method or function at an exact file and line. Use after query_codebase identifies a candidate; do not use for broad discovery. If you need more than one node, use get_nodes_context instead — one call beats N sequential calls.',
  {
    file: z.string().describe('Exact or partial indexed file path'),
    line: z.number().int().positive().describe('A line contained by the method or function'),
    repo: z.string().optional().describe('Indexed repository to search'),
    maxLines: z.number().int().min(1).max(100).optional().default(20)
      .describe('Maximum stored source lines to return (default 20, maximum 100). Pass a higher value only when you need the full method body.'),
  },
  async ({ file, line, repo, maxLines }) => {
    const requestText = JSON.stringify({ file, line, repo, maxLines });
    const candidates = await neo4jDb.getNodeAtLine(line, file, repo);
    const node = candidates[0];
    if (!node) {
      const responseText = 'No method or function was resolved at that file and line.';
      return {
        content: [{
          type: 'text' as const,
          text: responseText + tokenUsage('get_node_context', requestText, responseText),
        }],
      };
    }

    const source = (node.sourceCode ?? '')
      .split('\n')
      .slice(0, maxLines)
      .join('\n');
    const identity = node.qualifiedName ?? node.name;
    const header = [
      `${node.type} ${identity}`,
      `Location: ${node.filePath}:${node.startLine}-${node.endLine}`,
      `Language: ${node.language || 'unknown'}`,
      node.documentation ? `Documentation:\n${node.documentation}` : '',
      'Source:',
    ].filter(Boolean).join('\n');

    const responseBody = `${header}\n${source || node.firstLine || '(source unavailable)'}`;
    return {
      content: [{
        type: 'text' as const,
        text: responseBody + tokenUsage('get_node_context', requestText, responseBody),
      }],
    };
  },
);

// ─── Tool: get_nodes_context ──────────────────────────────────────────────────

server.tool(
  'get_nodes_context',
  [
    'Retrieve source and documentation for MULTIPLE methods/functions in one call.',
    'Use this instead of calling get_node_context repeatedly — one round-trip instead of N, significantly reducing input token overhead.',
    'Each node is identified by {file, line}. Pass all nodes you need at once.',
  ].join('\n'),
  {
    nodes: z.array(
      z.object({
        file: z.string().describe('Exact or partial indexed file path'),
        line: z.number().int().positive().describe('A line contained by the method or function'),
        repo: z.string().optional().describe('Indexed repository to search'),
      }),
    ).min(1).max(10).describe('List of nodes to fetch (max 10)'),
    maxLines: z.number().int().min(1).max(100).optional().default(20)
      .describe('Maximum source lines per node (default 20). Pass higher only when you need full method bodies.'),
  },
  async ({ nodes, maxLines }) => {
    const requestText = JSON.stringify({ nodes, maxLines });

    const results = await Promise.all(
      nodes.map(async ({ file, line, repo }) => {
        const candidates = await neo4jDb.getNodeAtLine(line, file, repo);
        const node = candidates[0];
        if (!node) return `${file}:${line} — not found`;

        const source = (node.sourceCode ?? '')
          .split('\n')
          .slice(0, maxLines)
          .join('\n');
        const identity = node.qualifiedName ?? node.name;
        return [
          `── ${node.type} ${identity}  (${node.filePath}:${node.startLine}-${node.endLine})`,
          node.documentation ? `Doc: ${node.documentation}` : '',
          source || node.firstLine || '(source unavailable)',
        ].filter(Boolean).join('\n');
      }),
    );

    const responseBody = results.join('\n\n');
    return {
      content: [{
        type: 'text' as const,
        text: responseBody + tokenUsage('get_nodes_context', requestText, responseBody),
      }],
    };
  },
);

// ─── Tool: diagnose_issue ─────────────────────────────────────────────────────

server.tool(
  'diagnose_issue',
  [
    'Diagnose a production problem from Neo4j evidence. Generates a root cause only when the alert includes an exact code location resolved in the graph.',
    '',
    'USE THIS FIRST for any production incident, alert, or error report before calling query_codebase.',
    'A single diagnose_issue call assembles epicentre + callers + callees + related tests from the graph.',
    'If the alert has no exact graph-resolved code location, it returns semantic candidates and the missing evidence instead of an invented root cause.',
    '',
    'Accepts a natural-language question plus optional stack trace, error message, and vendor-neutral runtime evidence.',
  ].join('\n'),
  {
    question:     z.string().describe('Natural language description of the problem, e.g. "SyncService crashes with NPE on TWH sync"'),
    stackTrace:   z.string().optional().describe('Full stack trace from production logs — parsed for file/line hints'),
    errorMessage: z.string().optional().describe('Exact exception or error message from production'),
    runtimeEvidence: z.string().optional().describe('Compact provider-neutral observations, e.g. route, trace ID, deployment ID, dependency latency, resource pressure, and timestamp. This is caller-supplied context, not Neo4j code evidence.'),
    file:         z.string().optional().describe('File name or partial path hint, e.g. "SyncEventService.java"'),
    line:         z.number().optional().describe('Line number from the stack trace'),
    repo:         z.string().optional().describe('Limit diagnosis to a specific indexed repo (omit to search all repos)'),
  },
  async ({ question, stackTrace, errorMessage, runtimeEvidence, file, line, repo }) => {
    const requestText = JSON.stringify({ question, stackTrace, errorMessage, runtimeEvidence, file, line, repo });

    // ── 1. Assemble context from the graph ──────────────────────────────────
    let context;
    try {
      context = await retriever.diagnoseContext({
        question,
        stackTrace,
        errorMessage,
        runtimeEvidence,
        file,
        line,
        repoName: repo,
      });
    } catch (err) {
      return {
        content: [{
          type: 'text' as const,
          text: `Failed to retrieve context from Neo4j: ${String(err)}`,
        }],
      };
    }

    // ── 2. Build the graph-only summary (always returned, even without AI) ──
    let epicentreBlock = '⚠  No incident location or relevant code was resolved in Neo4j.';
    if (context.epicentre && context.evidenceLevel === 'exact') {
      epicentreBlock = [
        `📍 Epicentre: \`${context.epicentre.name}\``,
        `   File: ${context.epicentre.filePath}  Line: ${context.epicentre.startLine}`,
        `   ${context.epicentre.firstLine ?? ''}`,
      ].join('\n');
    } else if (context.epicentre) {
      epicentreBlock = [
        '⚠  No exact incident location resolved in Neo4j.',
        `   Semantic candidate only: ${context.epicentre.name}  (${context.epicentre.filePath}:${context.epicentre.startLine})`,
      ].join('\n');
    }

    // Only include sections that have data — empty sections waste tokens
    const sections: string[] = [epicentreBlock];

    if (context.callers.length > 0) {
      sections.push(
        `\nCallers (${context.callers.length}):`,
        ...context.callers.map(n => `  • ${n.name}  (${n.filePath}:${n.startLine})`),
      );
    }
    if (context.callees.length > 0) {
      sections.push(
        `\nCallees (${context.callees.length}):`,
        ...context.callees.map(n => `  • ${n.name}  (${n.filePath}:${n.startLine})`),
      );
    }
    if (context.relatedTests.length > 0) {
      sections.push(
        `\nRelated tests (${context.relatedTests.length}):`,
        ...context.relatedTests.map(n => `  • ${n.name}  (${n.filePath}:${n.startLine})`),
      );
    }
    if (context.staticFindings.length > 0) {
      sections.push(
        `\nDeterministic findings (${context.staticFindings.length}):`,
        ...context.staticFindings.map(finding =>
          `  • ${finding.ruleId} (${finding.filePath}:${finding.line}) — ${finding.message}`,
        ),
      );
    }
    if (context.linkedEvidence.length > 0) {
      sections.push(
        `\nLinked incident evidence (${context.linkedEvidence.length}):`,
        ...context.linkedEvidence.map(evidence =>
          `  • ${evidence.id} (${evidence.observedAt ?? 'time unknown'}) — ${evidence.summary}`,
        ),
      );
    }

    const graphSummary = sections.join('\n');

    // ── 3. AI analysis (requires ANTHROPIC_API_KEY) ──────────────────────────
    let aiSection = '';
    if (context.evidenceLevel !== 'exact') {
      aiSection = [
        '',
        '── Evidence gap ──',
        'The graph cannot determine the root cause from this alert alone.',
        'Provide a stack trace or failing file and line to resolve code evidence. Include trace, route, dependency, deployment, or resource observations as runtimeEvidence when available.',
      ].join('\n');
    } else try {
      const { diagnosis, usage } = await analyzer.analyze(context);

      const confidenceEmoji = diagnosis.confidence === 'high'   ? '🟢'
                            : diagnosis.confidence === 'medium' ? '🟡'
                            : '🔴';

      const cacheInfo = usage.cacheReadTokens > 0
        ? ` (${usage.cacheReadTokens} cached)`
        : usage.cacheCreationTokens > 0
          ? ` (${usage.cacheCreationTokens} written to cache)`
          : '';
      const costInfo = usage.estimatedCostUsd > 0
        ? `  cost: $${usage.estimatedCostUsd.toFixed(6)}`
        : '';

      aiSection = [
        '',
        '─'.repeat(60),
        `${confidenceEmoji} AI Diagnosis  (confidence: ${diagnosis.confidence})`,
        '',
        `📍 Location: ${diagnosis.location.file}  :  line ${diagnosis.location.line}  —  \`${diagnosis.location.function}\``,
        '',
        `⚠  Root cause:\n${diagnosis.rootCause}`,
        '',
        `✅ Fix:\n${diagnosis.fix}`,
        '',
        diagnosis.affectedCallers.length > 0
          ? `🔗 Also check: ${diagnosis.affectedCallers.join(', ')}`
          : '',
        '',
        `🧪 Suggested test: ${diagnosis.suggestedTest}`,
        '',
        `── Analyzer API: in:${usage.inputTokens}${cacheInfo} out:${usage.outputTokens}${costInfo} ──`,
      ].filter(l => l !== '').join('\n');

    } catch (err) {
      const hint = String(err).includes('API key')
        ? 'Set ANTHROPIC_API_KEY in .env to enable AI diagnosis.'
        : `AI analysis failed: ${String(err)}`;
      aiSection = `\n── AI diagnosis unavailable ──\n${hint}`;
    }

    const responseText = graphSummary + aiSection;
    return {
      content: [{
        type: 'text' as const,
        text: responseText + tokenUsage('diagnose_issue', requestText, responseText),
      }],
    };
  },
);

// ─── Tool: ingest_incident_evidence ──────────────────────────────────────────

server.tool(
  'ingest_incident_evidence',
  'Store provider-neutral runtime observations and link them to service, route, deployment, dependency, and an exact code location when supplied.',
  {
    id:            z.string().describe('Stable incident or evidence identifier from the source system'),
    summary:       z.string().describe('Normalized observation, without vendor-specific query syntax'),
    repo:          z.string().optional().describe('Indexed repository to link'),
    source:        z.string().optional().describe('Origin label, such as alerting, tracing, logs, or CI/CD'),
    observedAt:    z.string().optional().describe('ISO-8601 observation timestamp'),
    service:       z.string().optional(),
    environment:   z.string().optional(),
    route:         z.string().optional(),
    traceId:       z.string().optional(),
    deploymentId:  z.string().optional(),
    version:       z.string().optional(),
    dependency:    z.string().optional(),
    file:          z.string().optional().describe('Affected file hint for an exact code link'),
    line:          z.number().optional().describe('Affected code line for an exact code link'),
  },
  async ({ id, summary, repo, source, observedAt, service, environment, route, traceId, deploymentId, version, dependency, file, line }) => {
    const codeNodes = file && line !== undefined
      ? await neo4jDb.getNodeAtLine(line, file, repo)
      : [];
    await neo4jDb.upsertIncidentEvidence({
      id, summary, repoName: repo, source, observedAt, service, environment, route,
      traceId, deploymentId, version, dependency, linkedCodeIds: codeNodes.slice(0, 1).map(node => node.id),
    });
    const linked = codeNodes[0];
    return {
      content: [{
        type: 'text' as const,
        text: linked
          ? `Stored evidence ${id} and linked it to ${linked.filePath}:${linked.startLine} (${linked.name}).`
          : `Stored evidence ${id}. No exact code location was linked.`,
      }],
    };
  },
);

// ─── Tools: evaluation ───────────────────────────────────────────────────────

server.tool(
  'record_evaluation',
  'Record a reviewed diagnosis outcome to measure accuracy, unsupported claims, latency, and estimated cost.',
  {
    id:                  z.string(),
    repo:                z.string().optional(),
    incidentId:          z.string().optional(),
    madeCausalClaim:     z.boolean().describe('Whether the diagnosis asserted a concrete root cause rather than insufficient evidence'),
    resolvedCorrectly:   z.boolean(),
    expectedCauseIdentified: z.boolean().describe('Whether the reviewed diagnosis recovered the known resolved cause'),
    supportedByEvidence: z.boolean(),
    latencyMs:           z.number().nonnegative(),
    estimatedCostUsd:    z.number().nonnegative(),
  },
  async ({ id, repo, incidentId, madeCausalClaim, resolvedCorrectly, expectedCauseIdentified, supportedByEvidence, latencyMs, estimatedCostUsd }) => {
    await neo4jDb.recordEvaluation({
      id, repoName: repo, incidentId, madeCausalClaim, resolvedCorrectly, expectedCauseIdentified, supportedByEvidence, latencyMs, estimatedCostUsd,
    });
    return { content: [{ type: 'text' as const, text: `Recorded evaluation ${id}.` }] };
  },
);

server.tool(
  'get_evaluation_metrics',
  'Return reviewed-diagnosis precision, evidence support rate, latency, and estimated cost.',
  { repo: z.string().optional() },
  async ({ repo }) => {
    const metrics = await neo4jDb.getEvaluationMetrics(repo);
    return { content: [{ type: 'text' as const, text: JSON.stringify(metrics) }] };
  },
);

// ─── Tool: get_stats ──────────────────────────────────────────────────────────

server.tool(
  'get_stats',
  'Show what is currently indexed in the knowledge graph. Call this only once per session to confirm which repos are available — do not call it before every query.',
  {},
  async () => {
    const stats = await neo4jDb.getStats();

    if (stats.repos.length === 0) {
      return {
        content: [{
          type: 'text',
          text: 'No repos indexed yet. Use index_repo or index_github to get started.',
        }],
      };
    }

    const repoBlocks = stats.repos.map(r => {
      const typeLines = Object.entries(r.byType)
        .sort((a, b) => b[1] - a[1])
        .map(([t, c]) => `    ${t.padEnd(12)} ${c}`)
        .join('\n');
      return `  ${r.name}\n    Path: ${r.path}\n    Nodes: ${r.nodeCount}\n${typeLines}`;
    }).join('\n\n');

    return {
      content: [{
        type: 'text',
        text: [
          `Neo4j Knowledge Graph  (db: ${neo4jDb.database})`,
          `Total nodes: ${stats.totalNodes}   Total edges: ${stats.totalEdges}`,
          '',
          'Indexed repos:',
          repoBlocks,
        ].join('\n'),
      }],
    };
  },
);

// ─── Start ────────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
