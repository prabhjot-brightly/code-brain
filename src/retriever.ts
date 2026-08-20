import { Neo4jDb, SEMANTIC_THRESHOLD } from './neo4j-database.js';
import { embedTexts, DEFAULT_CACHE_DIR } from './embedder.js';
import { parseStackTrace, extractLineHints } from './stack-trace-parser.js';
import type { RetrievalQuery, ContextChunk, CodeNode, DiagnosisContext } from './types.js';

// ── Tuning ────────────────────────────────────────────────────────────────────

/**
 * How many top vector-search seeds to expand from via callsGraph.
 * 3 high-quality seeds bound the downstream call-graph traversal.
 */
const MAX_SEMANTIC_SEEDS = 3;
const MAX_LEXICAL_SEEDS = 3;

/**
 * Max source lines per chunk in the MCP response.
 * 2 lines is the single biggest output-token lever — signature + first body
 * line is enough to identify what a method does without inflating context.
 */
const MAX_SOURCE_LINES = 2;

/**
 * Scores for call-graph neighbours.
 * These are the KG's structural advantage over plain vector search:
 *
 *  EXACT_MATCH  — symbol / filePath lookup hit. Always ranks first.
 *  CALLEE       — outbound CALLS: a method this seed directly invokes.
 *                 High relevance for tracing what a slow method calls.
 *  CALLER       — inbound  CALLS: a method that triggers this seed.
 *                 High relevance for blast-radius / who causes this path.
 *  CALL_BOOST   — additive bonus when a node is BOTH semantically similar
 *                 AND structurally call-connected: it's doubly confirmed.
 *
 * Ordering guarantee:
 *   exact (1.0) > semantic+call (sem+0.10) > semantic-only (0.30–1.0)
 *   > callee (0.25) > caller (0.20) > nothing (skipped)
 */
const EXACT_MATCH_SCORE = 1.0;
const CALLEE_SCORE      = 0.25;
const CALLER_SCORE      = 0.20;
const CALL_BOOST        = 0.10;
const LEXICAL_BASE_SCORE = 0.85;
const LEXICAL_RANK_DECAY = 0.05;

/** Node types that carry actual logic — the only ones returned as results. */
const RESULT_TYPES = new Set<string>(['METHOD', 'FUNCTION']);

function toFullTextQuery(question: string): string {
  const terms = question.match(/[\p{L}\p{N}]+/gu) ?? [];
  return [...new Set(terms.filter(term => term.length > 1))].join(' OR ');
}

// ─────────────────────────────────────────────────────────────────────────────

export class Retriever {
  constructor(private db: Neo4jDb) {}

  /**
   * Retrieve relevant code chunks using:
   *   1. Explicit filters (symbol / filePath / nodeType)  — highest priority
   *   2. Neo4j vector index ANN search                    — semantic seeds
   *   3. Cypher BFS expansion (CONTAINS|DEFINES|CALLS)    — structural context
   *
   * Source code comes directly from Neo4j node properties — no disk I/O.
   */
  async retrieve(
    query:    RetrievalQuery,
    cacheDir: string = DEFAULT_CACHE_DIR,
  ): Promise<ContextChunk[]> {
    const {
      question, symbol, filePath, nodeType,
      maxDepth = 1, limit = 4, repoName,
    } = query;

    const exactSeeds:    CodeNode[] = [];  // symbol / filePath point-lookups
    const semanticSeeds: CodeNode[] = [];  // ANN vector-search hits
    const lexicalSeeds:  CodeNode[] = [];  // exact token / full-text hits
    const semanticScores = new Map<string, number>(); // nodeId → cosine similarity
    const lexicalScores  = new Map<string, number>(); // nodeId → rank-based score
    const exactSeedIds   = new Set<string>();          // for scoring

    // ── 1. Exact lookups (symbol / filePath) ──────────────────────────────────
    // Precise index hits — no embedding needed. nodeType is NOT a seed source
    // (loading all 5 000+ METHOD nodes as seeds then expanding is catastrophic).
    if (symbol   !== undefined && symbol   !== '') {
      exactSeeds.push(...await this.db.findNodesByName(symbol, repoName));
    }
    if (filePath !== undefined && filePath !== '') {
      exactSeeds.push(...await this.db.nodesInFile(filePath, repoName));
    }
    for (const n of exactSeeds) exactSeedIds.add(n.id);

    // ── 2. Semantic vector search ──────────────────────────────────────────────
    // Hybrid retrieval: semantic search understands intent, while full-text
    // search preserves exact error names, keys, and symbols. Both are bounded
    // before graph expansion, so this adds no LLM-token cost.
    // Capped at MAX_SEMANTIC_SEEDS (3) — extra seeds past the result limit are
    // wasted call-graph traversal; 3 high-quality seeds cover any top-4 window.
    if (exactSeeds.length === 0 && question) {
      const fullTextQuery = toFullTextQuery(question);
      const [queryVec, lexicalHits] = await Promise.all([
        embedTexts([question], cacheDir).then(([vec]) => vec),
        this.db.fullTextSearch(fullTextQuery, MAX_LEXICAL_SEEDS, repoName),
      ]);
      if (queryVec) {
        const hits = await this.db.vectorSearch(
          queryVec, SEMANTIC_THRESHOLD, MAX_SEMANTIC_SEEDS, repoName,
        );
        for (const { node, score } of hits) {
          semanticScores.set(node.id, score);
          semanticSeeds.push(node);
        }
      }
      lexicalHits.forEach(({ node }, rank) => {
        lexicalSeeds.push(node);
        lexicalScores.set(node.id, LEXICAL_BASE_SCORE - rank * LEXICAL_RANK_DECAY);
      });
    }

    const seedNodes = [...exactSeeds, ...semanticSeeds, ...lexicalSeeds];
    if (seedNodes.length === 0) return [];

    // ── 3. Call-graph expansion (KG's structural edge over plain vector) ───────
    // Replaces generic BFS (CONTAINS|DEFINES|CALLS) which:
    //   • mixed containment noise with runtime call edges
    //   • was outbound-only — callers were completely invisible
    //   • returned FILE/CLASS nodes that were immediately discarded
    //
    // callsGraph returns METHOD/FUNCTION nodes only, tagged with direction so
    // we can score callees and callers differently.
    const callGraph    = await this.db.callsGraph(seedNodes.map(n => n.id), maxDepth, repoName);
    const callScores   = new Map<string, number>();  // nodeId → call-edge score
    for (const { node, direction, distance } of callGraph) {
      const baseScore = direction === 'callee' ? CALLEE_SCORE : CALLER_SCORE;
      const s = baseScore / Math.max(1, distance);
      // If a node appears as both caller and callee, keep the higher score
      callScores.set(node.id, Math.max(callScores.get(node.id) ?? 0, s));
    }

    // ── 4. Merge seeds + call-graph, score, post-filter ───────────────────────
    // Scoring priority (highest → lowest):
    //   exact match  (1.0)          — symbol / filePath lookup hit
    //   sem + call   (sem + 0.10)   — semantically similar AND call-connected
    //   semantic     (0.30–1.0)     — ANN hit only
    //   callee       (0.25)         — what the seed method calls
    //   caller       (0.20)         — what triggers the seed method
    //
    // nodeType applied here as a post-filter — zero extra DB calls.
    const allNodes = [...seedNodes, ...callGraph.map(c => c.node)];
    const seen     = new Set<string>();
    const chunks:  ContextChunk[] = [];

    for (const node of allNodes) {
      if (seen.has(node.id)) continue;
      seen.add(node.id);

      if (!RESULT_TYPES.has(node.type)) continue;
      if (nodeType !== undefined && node.type !== nodeType) continue;

      // Compute composite score
      let score: number;
      if (exactSeedIds.has(node.id)) {
        score = EXACT_MATCH_SCORE;
      } else {
        const sem  = semanticScores.get(node.id);
        const lexical = lexicalScores.get(node.id);
        const call = callScores.get(node.id);
        const retrieval = Math.max(sem ?? 0, lexical ?? 0);
        if      (retrieval > 0 && call !== undefined) score = retrieval + CALL_BOOST;
        else if (retrieval > 0)                       score = retrieval;
        else if (call !== undefined)                      score = call;
        else continue;  // seed node with no match path — skip
      }

      const sourceLines = (node.sourceCode ?? node.firstLine ?? '')
        .split('\n')
        .slice(0, MAX_SOURCE_LINES)
        .filter(l => l.trim().length > 0);

      if (sourceLines.length === 0 && !node.firstLine) continue;

      chunks.push({ node, sourceLines, relevanceScore: score });
    }

    // ── 5. Sort → deduplicate overloads → top-N ───────────────────────────────
    return this.deduplicateByClass(
      chunks.sort((a, b) => b.relevanceScore - a.relevanceScore),
    ).slice(0, limit);
  }

  // ── Diagnostic context assembly ───────────────────────────────────────────────

  /**
   * Assemble a DiagnosisContext for a reported production issue:
   *
   * 1. Parse the stack trace / question for file+line hints
   * 2. Look up the epicentre node in Neo4j (exact line if available)
   * 3. Fall back to semantic search if no line is found
   * 4. Traverse CALLS edges for callers (what leads here) and callees (what blows up)
   * 5. Find related test methods in the same repo
   *
   * The resulting context is handed to Analyzer.analyze() for LLM diagnosis.
   */
  async diagnoseContext(opts: {
    question:      string;
    errorMessage?: string;
    stackTrace?:   string;
    runtimeEvidence?: string;
    file?:         string;
    line?:         number;
    repoName?:     string;
  }, cacheDir: string = DEFAULT_CACHE_DIR): Promise<DiagnosisContext> {
    const { question, errorMessage, stackTrace, runtimeEvidence, repoName } = opts;
    let epicentre: CodeNode | undefined;
    let evidenceLevel: 'exact' | 'semantic' | 'none' = 'none';

    // ── Step 1: Locate the epicentre ──────────────────────────────────────────
    // Try explicit file+line first, then stack trace, then semantic search.

    let fileHint = opts.file;
    let lineHint = opts.line;

    // Parse the stack trace for richer hints if no explicit line given
    if (!lineHint && stackTrace) {
      const parsed = parseStackTrace(stackTrace);
      if (parsed.epicentre?.filePath) {
        fileHint = fileHint ?? parsed.epicentre.filePath;
        lineHint = lineHint ?? parsed.epicentre.line;
      }
    }

    // Fall back to extracting hints from the question text
    if (!lineHint) {
      const hints = extractLineHints(errorMessage ?? question);
      if (hints.length > 0 && hints[0]) {
        fileHint = fileHint ?? hints[0].fileHint;
        lineHint = lineHint ?? hints[0].line;
      }
    }

    // Attempt line-level lookup in Neo4j
    if (lineHint !== undefined && fileHint) {
      const candidates = await this.db.getNodeAtLine(lineHint, fileHint, repoName);
      if (candidates[0]) {
        epicentre = candidates[0];
        evidenceLevel = 'exact';
      }
    }

    // Fall back to semantic search on the question
    if (!epicentre && question) {
      const [queryVec] = await embedTexts([question], cacheDir);
      if (queryVec) {
        const hits = await this.db.vectorSearch(
          queryVec, SEMANTIC_THRESHOLD, 5, repoName,
        );
        // Take the best hit that is a METHOD or FUNCTION in production code (not tests)
        epicentre = hits.find(h =>
          (h.node.type === 'METHOD' || h.node.type === 'FUNCTION') &&
          !/src[/\\]test/i.test(h.node.filePath),
        )?.node;
        if (epicentre) evidenceLevel = 'semantic';
      }
    }

    // ── Step 2: Call-graph expansion ─────────────────────────────────────────
    const [callers, callees] = epicentre
      ? await Promise.all([
          this.db.getCallers(epicentre.id, 2),
          this.db.getCallees(epicentre.id, 2),
        ])
      : [[], []];

    const [staticFindings, linkedEvidence] = epicentre && evidenceLevel === 'exact'
      ? await Promise.all([
          this.db.getStaticFindings([epicentre.id, ...callees.map(node => node.id)]),
          this.db.getEvidenceForCode(epicentre.id),
        ])
      : [[], []];

    // ── Step 3: Related tests ─────────────────────────────────────────────────
    // Find METHOD/FUNCTION nodes whose file path contains "test" (case-insensitive)
    // and whose name references the epicentre symbol.
    const relatedTests: CodeNode[] = [];
    if (epicentre) {
      const testHits = await this.db.findNodesByName(
        // Common test naming conventions: testFoo, FooTest, shouldFoo
        epicentre.name + 'Test', repoName,
      );
      relatedTests.push(...testHits.filter(n =>
        /test/i.test(n.filePath) && (n.type === 'METHOD' || n.type === 'FUNCTION'),
      ));

      // Also search semantically for tests in test files referencing this symbol
      if (relatedTests.length === 0) {
        const allInFile = epicentre.filePath
          ? await this.db.findNodesByName(epicentre.name, repoName)
          : [];
        relatedTests.push(...allInFile.filter(n =>
          /test/i.test(n.filePath) && (n.type === 'METHOD' || n.type === 'FUNCTION'),
        ).slice(0, 3));
      }
    }

    return {
      question,
      errorMessage,
      stackTrace,
      runtimeEvidence,
      evidenceLevel,
      epicentre,
      staticFindings: staticFindings.slice(0, 5),
      linkedEvidence: linkedEvidence.slice(0, 3),
      // Keep counts low — the prompt builder trims further, but feeding fewer
      // nodes here avoids Neo4j over-fetching in the first place.
      callers:      callers.slice(0, 3),
      callees:      callees.slice(0, 3),
      relatedTests: relatedTests.slice(0, 2),
    };
  }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  /**
   * If the same method name appears multiple times in the same file
   * (overloads that the regex parser sees as separate lines), keep only the
   * highest-scored one.
   */
  private deduplicateByClass(chunks: ContextChunk[]): ContextChunk[] {
    const seen   = new Set<string>();
    const result: ContextChunk[] = [];
    for (const chunk of chunks) {
      const key = `${chunk.node.filePath}::${chunk.node.name}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push(chunk);
      }
    }
    return result;
  }
}
