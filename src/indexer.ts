import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { scanRepository } from './scanner.js';
import { parseFile } from './parser.js';
import { Neo4jDb } from './neo4j-database.js';
import { embedTexts, nodeToText } from './embedder.js';
import type { IndexOptions, IndexResult, CodeNode, CodeEdge, IndexLevel, NodeType, EdgeType } from './types.js';
import type { ParseResult } from './parsers/base.js';

// ── Level filtering ───────────────────────────────────────────────────────────

const NODE_TYPES_BY_LEVEL: Record<IndexLevel, Set<NodeType>> = {
  low:  new Set(['FILE']),
  med:  new Set(['FILE', 'CLASS', 'INTERFACE']),
  high: new Set(['FILE', 'CLASS', 'INTERFACE', 'METHOD', 'FUNCTION']),
};

/** Edge types written per level. LOW stores no edges (file inventory only). */
const EDGE_TYPES_BY_LEVEL: Record<IndexLevel, Set<EdgeType>> = {
  low:  new Set(),
  med:  new Set(['CONTAINS', 'DEFINES', 'IMPORTS', 'EXTENDS', 'IMPLEMENTS']),
  high: new Set(['CONTAINS', 'DEFINES', 'IMPORTS', 'CALLS', 'EXTENDS', 'IMPLEMENTS', 'INJECTS', 'READS_CONFIG', 'READS_FIELD']),
};

/** Node types that receive vector embeddings per level. */
const EMBED_TYPES_BY_LEVEL: Record<IndexLevel, NodeType[]> = {
  low:  [],
  med:  ['CLASS', 'INTERFACE'],
  high: ['METHOD', 'FUNCTION', 'CLASS', 'INTERFACE'],
};

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Maximum lines of source code stored per node in Neo4j.
 * Keeps node size reasonable while retaining enough context for meaningful retrieval.
 * FILE nodes are excluded — their full source would be too large.
 */
const SOURCE_CODE_MAX_LINES = 100;
const CONFIG_EXTENSIONS = new Set(['.json', '.yaml', '.yml', '.toml', '.ini', '.properties', '.xml']);
const CONFIG_FILENAMES = new Set(['dockerfile', 'compose.yml', 'compose.yaml', 'codeowners']);

function isConfigurationFile(filePath: string): boolean {
  return CONFIG_EXTENSIONS.has(path.extname(filePath).toLowerCase())
    || CONFIG_FILENAMES.has(path.basename(filePath).toLowerCase());
}

/**
 * File path patterns that indicate pure data containers with no behaviour.
 * These are excluded from embedding to improve cosine similarity accuracy.
 */
const SKIP_EMBED_PATTERNS = [
  '/dto/', '/entity/', '/constant/', '/constants/',
  '/proxy/request/', '/proxy/response/',
  '/proxy/requests/', '/proxy/responses/',
  '/request/', '/response/',
];

function shouldEmbed(node: CodeNode): boolean {
  if (node.type === 'FILE') return false;
  const p = node.filePath.toLowerCase();
  return !SKIP_EMBED_PATTERNS.some(pat => p.includes(pat));
}

// ─────────────────────────────────────────────────────────────────────────────

export class Indexer {
  constructor(private db: Neo4jDb) {}

  /**
   * Parse `repoPath`, enrich every node with source code context, and persist
   * nodes + edges to Neo4j in batches.
   *
   * Any existing data for the same `repoName` is cleared first so re-indexing
   * always produces a clean, consistent graph.
   */
  async index(opts: IndexOptions): Promise<IndexResult> {
    const start    = Date.now();
    const repoName = opts.repoName ?? path.basename(opts.repoPath);
    const level: IndexLevel = opts.level ?? 'high';
    const allowedNodeTypes = NODE_TYPES_BY_LEVEL[level];
    const allowedEdgeTypes = EDGE_TYPES_BY_LEVEL[level];

    process.stderr.write(`[indexer] clearing existing data for repo "${repoName}" (level: ${level})…\n`);
    await this.db.clearRepo(repoName);

    const filePaths = scanRepository(opts.repoPath, opts.scan);
    process.stderr.write(`[indexer] scanning ${filePaths.length} files at level=${level}…\n`);

    const allNodes:          CodeNode[] = [];
    const allEdges:          CodeEdge[] = [];
    const allExtendsRefs:    CodeEdge[] = [];
    const allImplementsRefs: CodeEdge[] = [];
    const allInjectsRefs:    CodeEdge[] = [];

    if (level === 'low') {
      // Fast path — no parsing. Just emit one FILE node per scanned file.
      for (const absPath of filePaths) {
        const relPath = path.relative(opts.repoPath, absPath).replace(/\\/g, '/');
        allNodes.push({
          id:         `${repoName}::${relPath}:FILE:${relPath}:0`,
          type:       'FILE',
          name:       path.basename(absPath),
          filePath:   relPath,
          startLine:  1,
          endLine:    1,
          hash:       '',
          repoName,
          repoPath:   opts.repoPath,
          sourceCode: '',
          firstLine:  '',
          indexLevel: 'low',
        });
      }
    } else {
      for (const absPath of filePaths) {
        try {
          const parsed: ParseResult = parseFile(absPath, opts.repoPath);
          const ids = new Map(parsed.nodes.map(node => [node.id, `${repoName}::${node.id}`]));

          let sourceLines: string[] = [];
          try {
            sourceLines = fs.readFileSync(absPath, 'utf8').split('\n');
          } catch {
            // unreadable — nodes will have empty sourceCode
          }

          for (const node of parsed.nodes) {
            if (!allowedNodeTypes.has(node.type)) continue;

            let sourceCode = '';
            let firstLine  = '';

            if (node.type !== 'FILE' && sourceLines.length > 0) {
              const lineStart = node.startLine - 1;
              const lineEnd   = Math.min(node.endLine, lineStart + SOURCE_CODE_MAX_LINES);
              sourceCode      = sourceLines.slice(lineStart, lineEnd).join('\n');
              firstLine       = (sourceLines[lineStart] ?? '').trim().slice(0, 500);
            } else if (node.type === 'FILE' && sourceLines.length > 0) {
              firstLine = (sourceLines[0] ?? '').trim().slice(0, 500);
              if (isConfigurationFile(absPath)) {
                sourceCode = sourceLines.slice(0, SOURCE_CODE_MAX_LINES).join('\n');
              }
            }

            allNodes.push({
              ...node,
              id:         ids.get(node.id)!,
              repoName,
              repoPath:   opts.repoPath,
              sourceCode,
              firstLine,
              indexLevel: level,
            });
          }

          for (const edge of parsed.edges) {
            if (!allowedEdgeTypes.has(edge.type)) continue;
            allEdges.push({
              ...edge,
              source: ids.get(edge.source) ?? edge.source,
              target: edge.type === 'CALLS' || edge.type === 'READS_CONFIG'
                ? edge.target
                : (ids.get(edge.target) ?? edge.target),
            });
          }

          if (allowedEdgeTypes.has('EXTENDS')) {
            for (const ref of parsed.extendsRefs) {
              allExtendsRefs.push({
                source:     `${repoName}::${ref.sourceId}`,
                target:     ref.targetName,
                type:       'EXTENDS',
                confidence: 1.0,
                resolution: 'ast',
              });
            }
            for (const ref of parsed.implementsRefs) {
              allImplementsRefs.push({
                source:     `${repoName}::${ref.sourceId}`,
                target:     ref.targetName,
                type:       'IMPLEMENTS',
                confidence: 1.0,
                resolution: 'ast',
              });
            }
          }

          if (allowedEdgeTypes.has('INJECTS')) {
            for (const ref of parsed.injectsRefs) {
              allInjectsRefs.push({
                source:     `${repoName}::${ref.sourceId}`,
                target:     ref.targetName,
                type:       'INJECTS',
                confidence: 1.0,
                resolution: 'ast',
              });
            }
          }

        } catch (err) {
          process.stderr.write(`[indexer] skipping ${absPath}: ${String(err)}\n`);
        }
      }
    }

    await this.db.batchUpsertNodes(allNodes);

    const callEdges  = allEdges.filter(e => e.type === 'CALLS');
    const otherEdges = allEdges.filter(e => e.type !== 'CALLS' && e.type !== 'EXTENDS' && e.type !== 'IMPLEMENTS');

    if (otherEdges.length > 0) {
      process.stderr.write(`[indexer] writing ${otherEdges.length} structural edges to Neo4j…\n`);
      await this.db.batchUpsertEdges(otherEdges);
    }

    if (callEdges.length > 0) {
      process.stderr.write(`[indexer] resolving ${callEdges.length} CALLS edges by name…\n`);
      await this.db.batchUpsertCallEdges(callEdges, repoName);
    }

    const inheritanceEdges = [...allExtendsRefs, ...allImplementsRefs, ...allInjectsRefs];
    if (inheritanceEdges.length > 0) {
      process.stderr.write(
        `[indexer] resolving ${allExtendsRefs.length} EXTENDS + ${allImplementsRefs.length} IMPLEMENTS + ${allInjectsRefs.length} INJECTS edges…\n`,
      );
      await this.db.batchUpsertInheritanceEdges(inheritanceEdges, repoName);
    }

    return {
      filesScanned: filePaths.length,
      nodesFound:   allNodes.length,
      edgesFound:   allEdges.length,
      findingsFound: 0,
      durationMs:   Date.now() - start,
    };
  }

  /**
   * Generate 384-dim embeddings for every logic-bearing node in `repoName`
   * and persist them directly on each (:CodeNode) in Neo4j.
   *
   * The embedding is stored as a `float[]` property and is automatically
   * picked up by the vector index for ANN semantic search.
   *
   * Call this after `index()` — it reads nodes from Neo4j (source code
   * already stored, no disk access needed for text generation).
   */
  async embedNodes(
    _repoPath: string,   // kept for API compatibility; source is in Neo4j now
    repoName:  string,
    level: IndexLevel = 'high',
  ): Promise<number> {
    const types = EMBED_TYPES_BY_LEVEL[level];
    if (types.length === 0) return 0;

    const buckets = await Promise.all(types.map(t => this.db.nodesByType(t, repoName)));
    const targets = buckets.flat().filter(shouldEmbed);

    if (targets.length === 0) return 0;

    process.stderr.write(`[embedder] generating embeddings for ${targets.length} nodes…\n`);

    // Build embedding text: "METHOD process: public void process(Exchange ex)…"
    // The `firstLine` stored in Neo4j already has the signature — no disk I/O needed.
    const texts = targets.map(n => nodeToText(n, n.firstLine ?? ''));

    const vecs = await embedTexts(texts, 'document');

    await this.db.setEmbeddingsBatch(
      targets.map((n, i) => ({ nodeId: n.id, vec: vecs[i]! })),
    );

    process.stderr.write(`[embedder] ✓ ${vecs.length} embeddings stored in Neo4j\n`);
    return vecs.length;
  }
}
