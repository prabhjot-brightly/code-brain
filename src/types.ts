export type NodeType = 'FILE' | 'CLASS' | 'FUNCTION' | 'METHOD' | 'INTERFACE';

/**
 * Controls how much detail is extracted and stored during indexing.
 *
 * - `low`  – FILE nodes only, no parsing, no embeddings. Fast file inventory.
 * - `med`  – Adds CLASS and INTERFACE nodes, structural edges, class-level embeddings.
 * - `high` – Full detail: all node types, CALLS resolution, method-level embeddings.
 */
export type IndexLevel = 'low' | 'med' | 'high';
export type EdgeType =
  | 'CONTAINS'
  | 'DEFINES'
  | 'IMPORTS'
  | 'CALLS'
  | 'REFERENCES'
  | 'EXTENDS'
  | 'IMPLEMENTS'
  // class → class/interface it receives via CDI / Spring / Quarkus @Inject
  | 'INJECTS'
  // method → configuration constant it reads (e.g. AdapterConstants.BC_APP_CONNECTOR_FLAG)
  | 'READS_CONFIG'
  // method → field/property it reads from a model/config object (e.g. appConfig.getEnabled())
  | 'READS_FIELD';

/** Describes how safely an edge was recovered from source. */
export type EdgeResolution = 'structural' | 'ast' | 'heuristic';

export interface CodeNode {
  id:         string;
  type:       NodeType;
  name:       string;
  filePath:   string;
  startLine:  number;
  endLine:    number;
  hash:       string;
  /** Normalized identity such as `com.example.Service#process`. */
  qualifiedName?: string;
  /** Parser language identifier, for example `java` or `typescript`. */
  language?: string;
  /** Indexing depth used when this node was last written. */
  indexLevel?: IndexLevel;
  // ── Rich context stored in Neo4j ──────────────────────────────────────────
  repoName?:   string;    // e.g. "ei-erp-connect"
  repoPath?:   string;    // absolute path on disk
  sourceCode?:    string;    // full body text of this node (up to SOURCE_CODE_MAX_LINES)
  firstLine?:     string;    // first / signature line (trimmed, capped at 500 chars)
  documentation?: string;    // JSDoc / leading comment block above the node
}

export interface CodeEdge {
  source:      string;
  target:      string;
  type:        EdgeType;
  /** 0..1 confidence in the resolved relationship. */
  confidence?: number;
  resolution?: EdgeResolution;
  /** 1-based source line of the reference, when available. */
  sourceLine?: number;
}

export interface GraphData {
  nodes: CodeNode[];
  edges: CodeEdge[];
}

export interface RetrievalQuery {
  question?:  string;
  symbol?:    string;
  filePath?:  string;
  nodeType?:  NodeType;
  maxDepth?:  number;
  limit?:     number;
  repoName?:  string;   // undefined = search all repos
}

export interface ContextChunk {
  node:           CodeNode;
  sourceLines:    string[];
  relevanceScore: number;
}

export interface StaticFinding {
  id:          string;
  repoName?:   string;
  ruleId:      string;
  severity:    'high' | 'medium' | 'low';
  message:     string;
  nodeId:      string;
  filePath:    string;
  line:        number;
}

export interface IncidentEvidence {
  id:             string;
  repoName?:      string;
  source?:        string;
  observedAt?:    string;
  service?:       string;
  environment?:   string;
  route?:         string;
  traceId?:       string;
  deploymentId?:  string;
  version?:       string;
  dependency?:    string;
  summary:        string;
  linkedCodeIds?: string[];
}

export interface EvaluationRecord {
  id:                     string;
  repoName?:              string;
  incidentId?:            string;
  madeCausalClaim:        boolean;
  resolvedCorrectly:      boolean;
  expectedCauseIdentified:boolean;
  supportedByEvidence:    boolean;
  latencyMs:              number;
  estimatedCostUsd:       number;
}

export interface EvaluationMetrics {
  total:                  number;
  precision:               number;
  recall:                  number;
  unsupportedClaimRate:    number;
  averageLatencyMs:        number;
  averageCostUsd:          number;
}

export interface ScanOptions {
  extensions?: string[];
  ignore?:     string[];
}

export interface IndexOptions {
  repoPath:  string;
  repoName?: string;
  scan?:     ScanOptions;
  /** Indexing depth. Defaults to `'high'` (full detail). */
  level?:    IndexLevel;
}

/** Full context assembled for one diagnosis request — input to the Analyzer. */
export interface DiagnosisContext {
  question:      string;
  errorMessage?: string;
  stackTrace?:   string;
  /** Provider-neutral incident observations supplied by the caller, not repository graph evidence. */
  runtimeEvidence?: string;
  staticFindings: StaticFinding[];
  linkedEvidence: IncidentEvidence[];
  /** How the epicentre was resolved: exact incident anchor, semantic candidate, or unavailable. */
  evidenceLevel: 'exact' | 'semantic' | 'none';
  /** The node at the reported failure point (epicentre of the problem). */
  epicentre?:    CodeNode;
  /** Functions that call the epicentre — show what paths lead here. */
  callers:       CodeNode[];
  /** Functions called by the epicentre — show what could be null/missing. */
  callees:       CodeNode[];
  /** Test methods in the same repo whose file paths contain "test". */
  relatedTests:  CodeNode[];
}

export interface IndexResult {
  filesScanned: number;
  nodesFound:   number;
  edgesFound:   number;
  findingsFound: number;
  durationMs:   number;
}

