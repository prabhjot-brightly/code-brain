/**
 * neo4j-database.ts — auto-loads .env from the project root on first import.
 * ──────────────────
 * Full Neo4j persistence layer for the repo knowledge graph.
 *
 * Each code node is stored as a (:CodeNode) node with ALL available context:
 *   id, type, name, filePath, repoName, repoPath,
 *   startLine, endLine, hash, sourceCode, firstLine, embedding
 *
 * Edges are stored as typed Neo4j relationships:
 *   CONTAINS | DEFINES | IMPORTS | CALLS | REFERENCES | EXTENDS | IMPLEMENTS
 *
 * A vector index on `embedding` enables fast ANN semantic search.
 *
 * Connection settings come from environment variables (see .env):
 *   NEO4J_URI        default: neo4j://127.0.0.1:7687
 *   NEO4J_USER       default: neo4j
 *   NEO4J_PASSWORD   default: neo4j
 *   NEO4J_DATABASE   default: codebrain
 */

import neo4j, { Driver, Session } from 'neo4j-driver';
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  CodeNode, CodeEdge, StaticFinding, IncidentEvidence,
  EvaluationRecord, EvaluationMetrics,
} from './types.js';

// ── Auto-load .env from project root (no dotenv dependency) ──────────────────
(function loadEnvFile() {
  try {
    const dir     = path.dirname(fileURLToPath(import.meta.url));
    const envPath = path.join(dir, '..', '.env');
    const lines   = fs.readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const m = line.match(/^\s*([\w]+)\s*=\s*(.*)$/);
      if (!m || !m[1]) continue;
      const key = m[1];
      const val = (m[2] ?? '').replace(/^["']|["']$/g, '').trim();
      if (!(key in process.env)) process.env[key] = val; // don't override shell env
    }
  } catch {
    // no .env — rely on environment variables already in process.env
  }
})();

// ── Constants ─────────────────────────────────────────────────────────────────

export const VECTOR_INDEX = 'codeNodeEmbeddings';
export const FULLTEXT_INDEX = 'codeNodeText';
export const VECTOR_DIMS  = 384;

/** Minimum cosine similarity to qualify as a semantic seed. */
export const SEMANTIC_THRESHOLD = 0.30;

/** Batch size for UNWIND node upserts — source-code properties make 100 safer for large repos. */
const NODE_CHUNK  = 100;
/** Batch size for UNWIND edge upserts. */
const EDGE_CHUNK  = 1000;
/** Batch size for SET embedding updates. */
const EMB_CHUNK   = 200;
/** Delete chunk size when clearing a repo. */
const DEL_CHUNK   = 5000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface VectorHit {
  node:  CodeNode;
  score: number;
}

export interface RepoStats {
  name:      string;
  path:      string;
  nodeCount: number;
  byType:    Record<string, number>;
}

export interface GlobalStats {
  repos:       RepoStats[];
  totalNodes:  number;
  totalEdges:  number;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Strip undefined/null values so Neo4j doesn't choke on them. */
function nodeProps(n: CodeNode): Record<string, unknown> {
  return {
    id:            n.id,
    type:          n.type,
    name:          n.name,
    filePath:      n.filePath,
    repoName:      n.repoName      ?? '',
    repoPath:      n.repoPath      ?? '',
    startLine:     n.startLine,
    endLine:       n.endLine,
    hash:          n.hash,
    qualifiedName: n.qualifiedName ?? n.name,
    language:      n.language ?? '',
    sourceCode:    n.sourceCode    ?? '',
    firstLine:     n.firstLine     ?? '',
    documentation: n.documentation ?? '',
  };
}

/** Read a CodeNode back from a Neo4j map projection. */
function toCodeNode(raw: Record<string, unknown>): CodeNode {
  return {
    id:            raw['id']            as string,
    type:          raw['type']          as CodeNode['type'],
    name:          raw['name']          as string,
    filePath:      raw['filePath']      as string,
    repoName:      raw['repoName']      as string | undefined,
    repoPath:      raw['repoPath']      as string | undefined,
    startLine:     raw['startLine']     as number,
    endLine:       raw['endLine']       as number,
    hash:          raw['hash']          as string,
    qualifiedName: raw['qualifiedName'] as string | undefined,
    language:      raw['language']      as string | undefined,
    sourceCode:    raw['sourceCode']    as string | undefined,
    firstLine:     raw['firstLine']     as string | undefined,
    documentation: raw['documentation'] as string | undefined,
  };
}

// Cypher map projection reused in every RETURN — includes all context fields
const NODE_PROJECTION = `n {
  .id, .type, .name, .filePath,
  .repoName, .repoPath,
  .startLine, .endLine,
  .hash, .qualifiedName, .language, .sourceCode, .firstLine,
  .documentation
}`;

// ── Main class ────────────────────────────────────────────────────────────────

export class Neo4jDb {
  private driver: Driver;
  readonly database: string;

  constructor(
    uri      = process.env['NEO4J_URI']      ?? 'neo4j://127.0.0.1:7687',
    user     = process.env['NEO4J_USER']     ?? 'neo4j',
    password = process.env['NEO4J_PASSWORD'] ?? 'neo4j',
    database = process.env['NEO4J_DATABASE'] ?? 'codebrain',
  ) {
    this.driver   = neo4j.driver(uri, neo4j.auth.basic(user, password), {
      // Return JS numbers instead of neo4j.Integer objects — safe for our
      // line numbers which are well within the 53-bit safe integer range.
      disableLosslessIntegers: true,
    });
    this.database = database;
  }

  private session(): Session {
    return this.driver.session({ database: this.database });
  }

  // ── Schema setup ─────────────────────────────────────────────────────────────

  /**
   * Create constraint, property indexes, and the vector index.
   * Idempotent — safe to call on every startup.
   */
  async init(): Promise<void> {
    const s = this.session();
    try {
      // Unique constraint on id
      await s.run(
        `CREATE CONSTRAINT unique_node_id IF NOT EXISTS
         FOR (n:CodeNode) REQUIRE n.id IS UNIQUE`,
      ).catch(ignoreAlreadyExists);

      // Property indexes for fast point-lookups
      for (const prop of ['name', 'filePath', 'type', 'repoName'] as const) {
        await s.run(
          `CREATE INDEX node_${prop} IF NOT EXISTS
           FOR (n:CodeNode) ON (n.${prop})`,
        ).catch(ignoreAlreadyExists);
      }

      // Vector index for ANN semantic search
      await s.run(
        `CREATE VECTOR INDEX ${VECTOR_INDEX} IF NOT EXISTS
         FOR (n:CodeNode) ON (n.embedding)
         OPTIONS {indexConfig: {
           \`vector.dimensions\`: ${VECTOR_DIMS},
           \`vector.similarity_function\`: 'cosine'
         }}`,
      ).catch(ignoreAlreadyExists);

      // Complements embeddings for exact error codes, configuration keys,
      // symbols, and framework names that semantic search can dilute.
      await s.run(
        `CREATE FULLTEXT INDEX ${FULLTEXT_INDEX} IF NOT EXISTS
         FOR (n:CodeNode) ON EACH [n.name, n.filePath, n.firstLine, n.documentation, n.sourceCode]`,
      ).catch(ignoreAlreadyExists);

      for (const [label, property] of [
        ['StaticFinding', 'id'],
        ['IncidentEvidence', 'id'],
        ['Evaluation', 'id'],
      ] as const) {
        await s.run(
          `CREATE CONSTRAINT unique_${label.toLowerCase()}_${property} IF NOT EXISTS
           FOR (n:${label}) REQUIRE n.${property} IS UNIQUE`,
        ).catch(ignoreAlreadyExists);
      }

    } finally {
      await s.close();
    }
  }

  // ── Repo management ───────────────────────────────────────────────────────────

  /**
   * Delete ALL nodes (and their relationships) that belong to `repoName`.
   * Called before re-indexing to ensure a clean slate.
   */
  async clearRepo(repoName: string): Promise<void> {
    const s = this.session();
    try {
      let deleted = 1;
      while (deleted > 0) {
        const res = await s.run(
          `MATCH (n:CodeNode {repoName: $repoName})
           WITH n LIMIT ${DEL_CHUNK}
           DETACH DELETE n
           RETURN count(n) AS cnt`,
          { repoName },
        );
        deleted = (res.records[0]?.get('cnt') as number) ?? 0;
      }
    } finally {
      await s.close();
    }
  }

  // ── Bulk node upsert ──────────────────────────────────────────────────────────

  /**
   * Upsert nodes in batches using UNWIND for maximum throughput.
   * Each node carries full context: sourceCode, firstLine, repoName, etc.
   */
  async batchUpsertNodes(nodes: CodeNode[]): Promise<void> {
    if (nodes.length === 0) return;
    const s = this.session();
    try {
      for (let i = 0; i < nodes.length; i += NODE_CHUNK) {
        const batch = nodes.slice(i, i + NODE_CHUNK).map(nodeProps);
        await s.run(
          `UNWIND $batch AS data
           MERGE (n:CodeNode {id: data.id})
           SET   n += data`,
          { batch },
        );
      }
    } finally {
      await s.close();
    }
  }

  async batchUpsertStaticFindings(findings: StaticFinding[], repoName: string): Promise<void> {
    if (findings.length === 0) return;
    const s = this.session();
    try {
      const batch = findings.map(finding => ({ ...finding, repoName }));
      await s.run(
        `UNWIND $batch AS data
         MATCH (code:CodeNode {id: data.nodeId})
         MERGE (finding:StaticFinding {id: data.id})
         SET finding += data
         MERGE (code)-[:HAS_FINDING]->(finding)`,
        { batch },
      );
    } finally {
      await s.close();
    }
  }

  async getStaticFindings(nodeIds: string[]): Promise<StaticFinding[]> {
    if (nodeIds.length === 0) return [];
    const s = this.session();
    try {
      const res = await s.run(
        `MATCH (:CodeNode)-[:HAS_FINDING]->(finding:StaticFinding)
         WHERE finding.nodeId IN $nodeIds
         RETURN finding { .id, .repoName, .ruleId, .severity, .message, .nodeId, .filePath, .line } AS finding
         ORDER BY CASE finding.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`,
        { nodeIds },
      );
      return res.records.map(record => record.get('finding') as StaticFinding);
    } finally {
      await s.close();
    }
  }

  async upsertIncidentEvidence(evidence: IncidentEvidence): Promise<void> {
    const s = this.session();
    const serviceId = evidence.service ? `${evidence.repoName ?? ''}::service::${evidence.service}` : null;
    const routeId = evidence.route ? `${serviceId ?? ''}::route::${evidence.route}` : null;
    const deploymentId = evidence.deploymentId ? `${evidence.repoName ?? ''}::deployment::${evidence.deploymentId}` : null;
    const dependencyId = evidence.dependency ? `${evidence.repoName ?? ''}::dependency::${evidence.dependency}` : null;
    try {
      await s.run(
        `MERGE (incident:IncidentEvidence {id: $evidence.id})
         SET incident += $evidence
         FOREACH (_ IN CASE WHEN $serviceId IS NULL THEN [] ELSE [1] END |
           MERGE (service:Service {id: $serviceId}) SET service.name = $evidence.service
           MERGE (incident)-[:OBSERVED_IN]->(service))
         FOREACH (_ IN CASE WHEN $routeId IS NULL THEN [] ELSE [1] END |
           MERGE (route:Route {id: $routeId}) SET route.path = $evidence.route
           MERGE (incident)-[:ON_ROUTE]->(route))
         FOREACH (_ IN CASE WHEN $deploymentId IS NULL THEN [] ELSE [1] END |
           MERGE (deployment:Deployment {id: $deploymentId}) SET deployment.name = $evidence.deploymentId, deployment.version = $evidence.version
           MERGE (incident)-[:AT_DEPLOYMENT]->(deployment))
         FOREACH (_ IN CASE WHEN $dependencyId IS NULL THEN [] ELSE [1] END |
           MERGE (dependency:Dependency {id: $dependencyId}) SET dependency.name = $evidence.dependency
           MERGE (incident)-[:DEPENDS_ON]->(dependency))
         WITH incident
         UNWIND $linkedCodeIds AS nodeId
         MATCH (code:CodeNode {id: nodeId})
         MERGE (incident)-[:AFFECTS]->(code)`,
        { evidence: { ...evidence, linkedCodeIds: undefined }, serviceId, routeId, deploymentId, dependencyId, linkedCodeIds: evidence.linkedCodeIds ?? [] },
      );
    } finally {
      await s.close();
    }
  }

  async getEvidenceForCode(nodeId: string): Promise<IncidentEvidence[]> {
    const s = this.session();
    try {
      const res = await s.run(
        `MATCH (incident:IncidentEvidence)-[:AFFECTS]->(:CodeNode {id: $nodeId})
         RETURN incident { .id, .repoName, .source, .observedAt, .service, .environment, .route, .traceId, .deploymentId, .version, .dependency, .summary }
           AS incident
         ORDER BY incident.observedAt DESC LIMIT 3`,
        { nodeId },
      );
      return res.records.map(record => record.get('incident') as IncidentEvidence);
    } finally {
      await s.close();
    }
  }

  async recordEvaluation(record: EvaluationRecord): Promise<void> {
    const s = this.session();
    try {
      await s.run(`MERGE (evaluation:Evaluation {id: $record.id}) SET evaluation += $record`, { record });
    } finally {
      await s.close();
    }
  }

  async getEvaluationMetrics(repoName?: string): Promise<EvaluationMetrics> {
    const s = this.session();
    try {
      const res = await s.run(
        `MATCH (evaluation:Evaluation)
         WHERE $repoName IS NULL OR evaluation.repoName = $repoName
         RETURN count(evaluation) AS total,
          coalesce(toFloat(sum(CASE WHEN evaluation.madeCausalClaim AND evaluation.resolvedCorrectly THEN 1 ELSE 0 END)) / nullif(sum(CASE WHEN evaluation.madeCausalClaim THEN 1 ELSE 0 END), 0), 0.0) AS precision,
          coalesce(avg(CASE WHEN evaluation.expectedCauseIdentified THEN 1.0 ELSE 0.0 END), 0.0) AS recall,
          coalesce(toFloat(sum(CASE WHEN evaluation.madeCausalClaim AND NOT evaluation.supportedByEvidence THEN 1 ELSE 0 END)) / nullif(sum(CASE WHEN evaluation.madeCausalClaim THEN 1 ELSE 0 END), 0), 0.0) AS unsupportedClaimRate,
                coalesce(avg(evaluation.latencyMs), 0.0) AS averageLatencyMs,
                coalesce(avg(evaluation.estimatedCostUsd), 0.0) AS averageCostUsd`,
        { repoName: repoName ?? null },
      );
      const metrics = res.records[0];
      return {
        total: metrics?.get('total') as number ?? 0,
        precision: metrics?.get('precision') as number ?? 0,
        recall: metrics?.get('recall') as number ?? 0,
        unsupportedClaimRate: metrics?.get('unsupportedClaimRate') as number ?? 0,
        averageLatencyMs: metrics?.get('averageLatencyMs') as number ?? 0,
        averageCostUsd: metrics?.get('averageCostUsd') as number ?? 0,
      };
    } finally {
      await s.close();
    }
  }

  // ── Bulk edge upsert ──────────────────────────────────────────────────────────

  /**
   * Upsert edges in batches.
   * Edges are grouped by type so we can use a static relationship label
   * in Cypher (Neo4j does not support dynamic rel types without APOC).
   * Edge types come from our own EdgeType enum — safe to interpolate.
   *
   * CALLS edges are excluded here — their target is a callee *name*, not a
   * node ID.  Use batchUpsertCallEdges() to resolve and persist them.
   */
  async batchUpsertEdges(edges: CodeEdge[]): Promise<void> {
    if (edges.length === 0) return;

    // CALLS edges use name-based targets — handled separately
    const nonCallEdges = edges.filter(e => e.type !== 'CALLS');
    if (nonCallEdges.length === 0) return;

    // Group by relationship type
    const byType = new Map<string, Array<{ source: string; target: string; properties: Record<string, unknown> }>>();
    for (const e of nonCallEdges) {
      const list = byType.get(e.type) ?? [];
      list.push({
        source: e.source,
        target: e.target,
        properties: {
          confidence: e.confidence ?? 1,
          resolution: e.resolution ?? 'structural',
          ...(e.sourceLine !== undefined && { sourceLine: e.sourceLine }),
        },
      });
      byType.set(e.type, list);
    }

    const s = this.session();
    try {
      for (const [type, typeEdges] of byType) {
        for (let i = 0; i < typeEdges.length; i += EDGE_CHUNK) {
          const batch = typeEdges.slice(i, i + EDGE_CHUNK);
          // `type` is from EdgeType union — not user-supplied, no injection risk
          await s.run(
            `UNWIND $batch AS e
             MATCH (src:CodeNode {id: e.source})
             MATCH (tgt:CodeNode {id: e.target})
             MERGE (src)-[rel:${type}]->(tgt)
             SET rel += e.properties`,
            { batch },
          );
        }
      }
    } finally {
      await s.close();
    }
  }

  /**
   * Resolve and upsert CALLS edges by callee name within the same repo.
   *
   * The parser emits CALLS edges where `target` is the callee function/method
   * name (not a node ID).  This method looks up matching nodes by name inside
   * the repo and creates the [:CALLS] relationship.
   *
  * Ambiguous names are restricted to methods in the caller's file; otherwise
  * only a unique match in the repository is connected. This prefers a
  * smaller, trustworthy graph over cross-module false-positive call edges.
   */
  async batchUpsertCallEdges(
    edges:    CodeEdge[],
    repoName: string,
  ): Promise<void> {
    const callEdges = edges.filter(e => e.type === 'CALLS');
    if (callEdges.length === 0) return;

    const s = this.session();
    try {
      for (let i = 0; i < callEdges.length; i += EDGE_CHUNK) {
        const batch = callEdges.slice(i, i + EDGE_CHUNK).map(e => ({
          source: e.source,
          callee: e.target,   // target holds the callee name, not an ID
          properties: {
            confidence: e.confidence ?? 0.4,
            resolution: e.resolution ?? 'heuristic',
            ...(e.sourceLine !== undefined && { sourceLine: e.sourceLine }),
          },
        }));
        await s.run(
          `UNWIND $batch AS e
           MATCH (src:CodeNode {id: e.source})
           MATCH (tgt:CodeNode {name: e.callee, repoName: $repoName})
           WHERE tgt.type IN ['METHOD', 'FUNCTION']
           WITH src, e, collect(tgt) AS candidates
           WITH src, e, candidates,
             [c IN candidates WHERE c.filePath = src.filePath] AS sameFile
           WITH src, e, CASE
             WHEN size(candidates) = 1 THEN candidates
             WHEN size(sameFile) > 0   THEN sameFile
             ELSE candidates[0..3]
           END AS resolved
           UNWIND resolved AS tgt
           MERGE (src)-[rel:CALLS]->(tgt)
           SET rel += e.properties`,
          { batch, repoName },
        );
      }
    } finally {
      await s.close();
    }
  }

  // ── Embeddings ────────────────────────────────────────────────────────────────

  /**
   * Persist embedding vectors directly on the CodeNode nodes.
   * Stored as a float[] property, indexed by the vector index for ANN search.
   * Float32Array → regular number[] for Neo4j driver compatibility.
   */
  async setEmbeddingsBatch(
    pairs: Array<{ nodeId: string; vec: Float32Array }>,
  ): Promise<void> {
    if (pairs.length === 0) return;
    const s = this.session();
    try {
      for (let i = 0; i < pairs.length; i += EMB_CHUNK) {
        const batch = pairs.slice(i, i + EMB_CHUNK).map(({ nodeId, vec }) => ({
          id:        nodeId,
          embedding: Array.from(vec),   // Float32Array → plain JS number[]
        }));
        await s.run(
          `UNWIND $batch AS data
           MATCH (n:CodeNode {id: data.id})
           SET   n.embedding = data.embedding`,
          { batch },
        );
      }
    } finally {
      await s.close();
    }
  }

  // ── Vector (semantic) search ──────────────────────────────────────────────────

  /**
   * ANN search using the Neo4j vector index.
   * Returns at most `topK` nodes whose cosine similarity to `queryVec` ≥ threshold.
   */
  async vectorSearch(
    queryVec:  Float32Array,
    threshold: number,
    topK:      number,
    repoName?: string,
  ): Promise<VectorHit[]> {
    const s   = this.session();
    const vec = Array.from(queryVec);       // must be plain number[]
    try {
      // Neo4j filters after ANN candidate selection. Fetch a bounded larger
      // candidate pool when constrained to one repo so other repos cannot crowd
      // out its best matches before the repo filter is applied.
      const candidateCount = repoName === undefined
        ? topK
        : Math.max(topK * 10, 50);
      const res = await s.run(
        `CALL db.index.vector.queryNodes($index, $k, $vec)
         YIELD node AS n, score
         WHERE score >= $threshold
           AND ($repoName IS NULL OR n.repoName = $repoName)
         RETURN ${NODE_PROJECTION} AS node, score
         ORDER BY score DESC`,
        {
          index:    VECTOR_INDEX,
          k:        neo4j.int(candidateCount),
          vec,
          threshold,
          repoName: repoName ?? null,
        },
      );
      return res.records.map(r => ({
        node:  toCodeNode(r.get('node') as Record<string, unknown>),
        score: r.get('score') as number,
      }));
    } finally {
      await s.close();
    }
  }

  /**
   * Full-text code search. Results are filtered by repo after candidate
   * selection, so repo-scoped searches use a bounded larger candidate pool.
   */
  async fullTextSearch(
    query: string,
    topK: number,
    repoName?: string,
  ): Promise<VectorHit[]> {
    if (!query.trim()) return [];
    const s = this.session();
    const candidateCount = repoName === undefined ? topK : Math.max(topK * 10, 50);
    try {
      const res = await s.run(
        `CALL db.index.fulltext.queryNodes($index, $query)
         YIELD node AS n, score
         WITH n, score
         ORDER BY score DESC
         LIMIT $candidateCount
         WITH n, score
         WHERE ($repoName IS NULL OR n.repoName = $repoName)
         RETURN ${NODE_PROJECTION} AS node, score
         ORDER BY score DESC
         LIMIT $limit`,
        {
          index: FULLTEXT_INDEX,
          query,
          limit: neo4j.int(topK),
          candidateCount: neo4j.int(candidateCount),
          repoName: repoName ?? null,
        },
      );
      return res.records.map(r => ({
        node: toCodeNode(r.get('node') as Record<string, unknown>),
        score: r.get('score') as number,
      }));
    } finally {
      await s.close();
    }
  }

  // ── Call-graph expansion ─────────────────────────────────────────────────────

  /**
   * Return the direct callers and callees of `seedIds` via CALLS edges only.
   *
   * This replaces the old generic BFS (CONTAINS|DEFINES|CALLS) which:
   *   - mixed structural containment edges with runtime call edges
   *   - only traversed outbound (missing callers entirely)
   *   - returned FILE/CLASS nodes that were immediately discarded
   *
   * Now only METHOD/FUNCTION nodes are returned, tagged with direction so the
   * retriever can score them differently:
   *   'callee'  — outbound CALLS: what this method invokes (direct dependency)
   *   'caller'  — inbound  CALLS: what triggers this method (blast-radius source)
   *
   * Single Neo4j round-trip via UNION; no multi-hop traversal needed at depth 1
   * because the semantic seeds are already the right entry points.
   */
  async callsGraph(
    seedIds: string[],
    maxDepth = 1,
    repoName?: string,
  ): Promise<{ node: CodeNode; direction: 'caller' | 'callee'; distance: number }[]> {
    if (seedIds.length === 0) return [];
    const s = this.session();
    const hops = Math.trunc(Math.max(1, Math.min(maxDepth, 3)));
    try {
      const res = await s.run(
        // Callees: what the seed methods call
        `MATCH path = (seed:CodeNode)-[rels:CALLS*1..${hops}]->(n:CodeNode)
         WHERE seed.id IN $seedIds
           AND NOT n.id IN $seedIds
           AND n.type IN ['METHOD', 'FUNCTION']
           AND all(rel IN rels WHERE coalesce(rel.confidence, 0) >= 0.5)
           AND ($repoName IS NULL OR n.repoName = $repoName)
         RETURN ${NODE_PROJECTION} AS node, 'callee' AS direction, min(length(path)) AS distance
         UNION
         MATCH path = (n:CodeNode)-[rels:CALLS*1..${hops}]->(seed:CodeNode)
         WHERE seed.id IN $seedIds
           AND NOT n.id IN $seedIds
           AND n.type IN ['METHOD', 'FUNCTION']
           AND all(rel IN rels WHERE coalesce(rel.confidence, 0) >= 0.5)
           AND ($repoName IS NULL OR n.repoName = $repoName)
         RETURN ${NODE_PROJECTION} AS node, 'caller' AS direction, min(length(path)) AS distance`,
        { seedIds, repoName: repoName ?? null },
      );
      return res.records.map(r => ({
        node:      toCodeNode(r.get('node') as Record<string, unknown>),
        direction: r.get('direction') as 'caller' | 'callee',
        distance:  r.get('distance') as number,
      }));
    } finally {
      await s.close();
    }
  }

  /**
   * @deprecated Use callsGraph() — it separates callers from callees and
   * filters to logic nodes only, avoiding the CLASS/FILE noise this method
   * returns and the missing-callers problem from outbound-only traversal.
   */
  async bfsNeighbors(seedIds: string[], maxDepth: number): Promise<CodeNode[]> {
    if (seedIds.length === 0) return [];
    const s     = this.session();
    const depth = Math.trunc(Math.max(1, Math.min(maxDepth, 3)));
    try {
      const res = await s.run(
        `MATCH (seed:CodeNode) WHERE seed.id IN $seedIds
         MATCH (seed)-[:CONTAINS|DEFINES|CALLS*1..${depth}]->(n:CodeNode)
         WHERE NOT n.id IN $seedIds
         RETURN DISTINCT ${NODE_PROJECTION} AS node`,
        { seedIds },
      );
      return res.records.map(r =>
        toCodeNode(r.get('node') as Record<string, unknown>),
      );
    } finally {
      await s.close();
    }
  }

  // ── Point lookups ─────────────────────────────────────────────────────────────

  async findNodesByName(name: string, repoName?: string): Promise<CodeNode[]> {
    const s = this.session();
    try {
      const res = await s.run(
        `MATCH (n:CodeNode {name: $name})
         WHERE $repoName IS NULL OR n.repoName = $repoName
         RETURN ${NODE_PROJECTION} AS node`,
        { name, repoName: repoName ?? null },
      );
      return res.records.map(r => toCodeNode(r.get('node') as Record<string, unknown>));
    } finally {
      await s.close();
    }
  }

  async nodesInFile(filePath: string, repoName?: string): Promise<CodeNode[]> {
    const s = this.session();
    try {
      const res = await s.run(
        `MATCH (n:CodeNode {filePath: $filePath})
         WHERE $repoName IS NULL OR n.repoName = $repoName
         RETURN ${NODE_PROJECTION} AS node`,
        { filePath, repoName: repoName ?? null },
      );
      return res.records.map(r => toCodeNode(r.get('node') as Record<string, unknown>));
    } finally {
      await s.close();
    }
  }

  async nodesByType(type: string, repoName?: string): Promise<CodeNode[]> {
    const s = this.session();
    try {
      const res = await s.run(
        `MATCH (n:CodeNode {type: $type})
         WHERE $repoName IS NULL OR n.repoName = $repoName
         RETURN ${NODE_PROJECTION} AS node`,
        { type, repoName: repoName ?? null },
      );
      return res.records.map(r => toCodeNode(r.get('node') as Record<string, unknown>));
    } finally {
      await s.close();
    }
  }

  // ── Diagnostic / call-graph queries ──────────────────────────────────────────

  /**
   * Find the METHOD or FUNCTION node that contains `line` in the given file.
   *
   * For TS/JS files parsed with tree-sitter, startLine/endLine are accurate, so
   * the range check is exact.  For other languages (regex fallback) endLine equals
   * startLine, so we fall back to the node whose startLine is closest (and ≤) line.
   *
   * `fileHint` is matched with CONTAINS so a partial name like "SyncService" works.
   * Returns up to 3 candidates ordered from most-specific to least.
   */
  async getNodeAtLine(
    line:      number,
    fileHint:  string,
    repoName?: string,
  ): Promise<CodeNode[]> {
    const s = this.session();
    try {
      const res = await s.run(
        `MATCH (n:CodeNode)
         WHERE ($repoName IS NULL OR n.repoName = $repoName)
           AND n.filePath CONTAINS $fileHint
           AND n.type IN ['METHOD', 'FUNCTION']
           AND n.startLine <= $line
         WITH n,
           // Prefer nodes whose endLine actually encloses the target line
           CASE WHEN n.endLine >= $line AND n.endLine > n.startLine
             THEN (n.endLine - n.startLine)   // smaller range = more specific
             ELSE 999999
           END AS specificity
         ORDER BY specificity ASC, n.startLine DESC
         LIMIT 3
         RETURN ${NODE_PROJECTION} AS node`,
        { line, fileHint, repoName: repoName ?? null },
      );
      return res.records.map(r => toCodeNode(r.get('node') as Record<string, unknown>));
    } finally {
      await s.close();
    }
  }

  /**
   * Return all nodes that directly or transitively call the node with `nodeId`.
   * Traverses incoming [:CALLS] edges up to `depth` hops.
   * `n` is aliased to the caller so NODE_PROJECTION works without modification.
   */
  async getCallers(nodeId: string, depth = 2): Promise<CodeNode[]> {
    const s    = this.session();
    const hops = Math.trunc(Math.max(1, Math.min(depth, 4)));
    try {
      const res = await s.run(
        `MATCH (n:CodeNode)-[:CALLS*1..${hops}]->(target:CodeNode {id: $nodeId})
         RETURN DISTINCT ${NODE_PROJECTION} AS node`,
        { nodeId },
      );
      return res.records.map(r => toCodeNode(r.get('node') as Record<string, unknown>));
    } finally {
      await s.close();
    }
  }

  /**
   * Return all nodes directly or transitively called by the node with `nodeId`.
   * Traverses outgoing [:CALLS] edges up to `depth` hops.
   * `n` is aliased to the callee so NODE_PROJECTION works without modification.
   */
  async getCallees(nodeId: string, depth = 2): Promise<CodeNode[]> {
    const s    = this.session();
    const hops = Math.trunc(Math.max(1, Math.min(depth, 4)));
    try {
      const res = await s.run(
        `MATCH (seed:CodeNode {id: $nodeId})-[:CALLS*1..${hops}]->(n:CodeNode)
         RETURN DISTINCT ${NODE_PROJECTION} AS node`,
        { nodeId },
      );
      return res.records.map(r => toCodeNode(r.get('node') as Record<string, unknown>));
    } finally {
      await s.close();
    }
  }

  /**
   * Return caller and callee counts for a batch of node IDs in one round-trip.
   * Used by query_codebase to annotate results without extra tool calls.
   */
  async getCallCounts(nodeIds: string[]): Promise<Map<string, { callerCount: number; calleeCount: number }>> {
    if (nodeIds.length === 0) return new Map();
    const s = this.session();
    try {
      const res = await s.run(
        `UNWIND $nodeIds AS nid
         MATCH (n:CodeNode {id: nid})
         OPTIONAL MATCH (caller:CodeNode)-[:CALLS]->(n)
         OPTIONAL MATCH (n)-[:CALLS]->(callee:CodeNode)
         RETURN nid,
                count(DISTINCT caller) AS callerCount,
                count(DISTINCT callee) AS calleeCount`,
        { nodeIds },
      );
      const out = new Map<string, { callerCount: number; calleeCount: number }>();
      for (const rec of res.records) {
        const id  = rec.get('nid') as string;
        const cc  = rec.get('callerCount');
        const ec  = rec.get('calleeCount');
        out.set(id, {
          callerCount: typeof cc === 'object' ? (cc as { low: number }).low : Number(cc),
          calleeCount: typeof ec === 'object' ? (ec as { low: number }).low : Number(ec),
        });
      }
      return out;
    } finally {
      await s.close();
    }
  }

  // ── Stats ─────────────────────────────────────────────────────────────────────

  async getStats(): Promise<GlobalStats> {
    const s = this.session();
    try {
      // Node counts grouped by repo + type
      const nodeRes = await s.run(
        `MATCH (n:CodeNode)
         RETURN n.repoName AS repo, n.repoPath AS path, n.type AS type, count(n) AS cnt`,
      );

      const repoMap = new Map<string, { path: string; byType: Record<string, number>; nodeCount: number }>();
      for (const rec of nodeRes.records) {
        const repo = rec.get('repo')  as string;
        const path = rec.get('path')  as string;
        const type = rec.get('type')  as string;
        const cnt  = rec.get('cnt')   as number;
        if (!repoMap.has(repo)) repoMap.set(repo, { path, byType: {}, nodeCount: 0 });
        const entry = repoMap.get(repo)!;
        entry.byType[type]  = (entry.byType[type] ?? 0) + cnt;
        entry.nodeCount    += cnt;
      }

      // Total edge count
      const edgeRes    = await s.run(`MATCH ()-[r]->() RETURN count(r) AS cnt`);
      const totalEdges = (edgeRes.records[0]?.get('cnt') as number) ?? 0;
      const totalNodes = [...repoMap.values()].reduce((s, r) => s + r.nodeCount, 0);

      const repos = [...repoMap.entries()].map(([name, info]) => ({
        name,
        path:      info.path,
        nodeCount: info.nodeCount,
        byType:    info.byType,
      }));

      return { repos, totalNodes, totalEdges };
    } finally {
      await s.close();
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  async verifyConnectivity(): Promise<void> {
    await this.driver.verifyConnectivity({ database: this.database });
  }

  async close(): Promise<void> {
    await this.driver.close();
  }
}

// ── Internal helper ───────────────────────────────────────────────────────────

function ignoreAlreadyExists(err: unknown): void {
  const msg = String(err);
  if (
    msg.includes('already exists') ||
    msg.includes('EquivalentSchemaRuleAlreadyExists') ||
    msg.includes('AlreadyIndexed')
  ) return;
  throw err;
}
