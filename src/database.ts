import BetterSqlite3 from 'better-sqlite3';
import path from 'node:path';
import type { CodeNode, CodeEdge, GraphData } from './types.js';
// GraphData, RetrievalQuery, ContextChunk are re-exported from types.ts

const SCHEMA = /* sql */ `
  CREATE TABLE IF NOT EXISTS nodes (
    id         TEXT PRIMARY KEY,
    type       TEXT NOT NULL,
    name       TEXT NOT NULL,
    file_path  TEXT NOT NULL,
    start_line INTEGER NOT NULL,
    end_line   INTEGER NOT NULL,
    hash       TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_nodes_name      ON nodes(name);
  CREATE INDEX IF NOT EXISTS idx_nodes_file      ON nodes(file_path);
  CREATE INDEX IF NOT EXISTS idx_nodes_type      ON nodes(type);

  CREATE TABLE IF NOT EXISTS edges (
    source  TEXT NOT NULL,
    target  TEXT NOT NULL,
    type    TEXT NOT NULL,
    PRIMARY KEY (source, target, type)
  );

  CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source);
  CREATE INDEX IF NOT EXISTS idx_edges_target ON edges(target);

  -- Vector embeddings stored as raw Float32Array bytes (384 dims × 4 bytes = 1 536 bytes each)
  CREATE TABLE IF NOT EXISTS embeddings (
    node_id TEXT PRIMARY KEY,
    vector  BLOB NOT NULL
  );
`;

export class Db {
  private db: BetterSqlite3.Database;

  constructor(dataDir: string, dbName = 'graph.db') {
    this.db = new BetterSqlite3(path.join(dataDir, dbName));
    this.db.pragma('journal_mode = WAL');
    this.db.exec(SCHEMA);
  }

  // ─── Nodes ───────────────────────────────────────────────────────────────

  upsertNode(node: CodeNode): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO nodes (id, type, name, file_path, start_line, end_line, hash)
         VALUES (@id, @type, @name, @filePath, @startLine, @endLine, @hash)`,
      )
      .run({
        id: node.id,
        type: node.type,
        name: node.name,
        filePath: node.filePath,
        startLine: node.startLine,
        endLine: node.endLine,
        hash: node.hash,
      });
  }

  findNodesByName(name: string): CodeNode[] {
    return this.db
      .prepare(
        `SELECT id, type, name, file_path as filePath, start_line as startLine,
                end_line as endLine, hash FROM nodes WHERE name = ?`,
      )
      .all(name) as CodeNode[];
  }

  nodesInFile(filePath: string): CodeNode[] {
    return this.db
      .prepare(
        `SELECT id, type, name, file_path as filePath, start_line as startLine,
                end_line as endLine, hash FROM nodes WHERE file_path = ?`,
      )
      .all(filePath) as CodeNode[];
  }

  nodesByType(type: string): CodeNode[] {
    return this.db
      .prepare(
        `SELECT id, type, name, file_path as filePath, start_line as startLine,
                end_line as endLine, hash FROM nodes WHERE type = ?`,
      )
      .all(type) as CodeNode[];
  }

  // ─── Edges ───────────────────────────────────────────────────────────────

  upsertEdge(edge: CodeEdge): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO edges (source, target, type)
         VALUES (@source, @target, @type)`,
      )
      .run(edge);
  }

  outgoingEdges(source: string): CodeEdge[] {
    return this.db
      .prepare('SELECT source, target, type FROM edges WHERE source = ?')
      .all(source) as CodeEdge[];
  }

  incomingEdges(target: string): CodeEdge[] {
    return this.db
      .prepare('SELECT source, target, type FROM edges WHERE target = ?')
      .all(target) as CodeEdge[];
  }

  // ─── Embeddings ──────────────────────────────────────────────────────────────

  upsertEmbedding(nodeId: string, vec: Float32Array): void {
    this.db
      .prepare('INSERT OR REPLACE INTO embeddings (node_id, vector) VALUES (?, ?)')
      .run(nodeId, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
  }

  /** Batch upsert — ~10× faster than individual inserts for large sets. */
  upsertEmbeddingsBatch(pairs: Array<{ nodeId: string; vec: Float32Array }>): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO embeddings (node_id, vector) VALUES (?, ?)',
    );
    const runAll = this.db.transaction(
      (items: Array<{ nodeId: string; vec: Float32Array }>) => {
        for (const { nodeId, vec } of items) {
          stmt.run(nodeId, Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength));
        }
      },
    );
    runAll(pairs);
  }

  /**
   * Load all stored embeddings into a Map keyed by node ID.
   * Returns an empty Map when no embeddings have been generated yet.
   * Memory cost: ~1 536 bytes × N nodes (≈10.5 MB for 7 K nodes).
   */
  loadAllEmbeddings(): Map<string, Float32Array> {
    const rows = this.db
      .prepare('SELECT node_id, vector FROM embeddings')
      .all() as Array<{ node_id: string; vector: Buffer }>;

    const map = new Map<string, Float32Array>();
    for (const row of rows) {
      map.set(
        row.node_id,
        new Float32Array(row.vector.buffer, row.vector.byteOffset, row.vector.byteLength / 4),
      );
    }
    return map;
  }

  /** True if at least one embedding row exists. */
  hasEmbeddings(): boolean {
    const row = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM embeddings LIMIT 1')
      .get() as { cnt: number };
    return row.cnt > 0;
  }

  embeddingCount(): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS cnt FROM embeddings')
      .get() as { cnt: number };
    return row.cnt;
  }

  // ─── Bulk ────────────────────────────────────────────────────────────────

  clear(): void {
    this.db.exec('DELETE FROM nodes; DELETE FROM edges; DELETE FROM embeddings;');
  }

  loadAll(): GraphData {
    const nodes = this.db
      .prepare(
        `SELECT id, type, name, file_path as filePath, start_line as startLine,
                end_line as endLine, hash FROM nodes`,
      )
      .all() as CodeNode[];

    const edges = this.db
      .prepare('SELECT source, target, type FROM edges')
      .all() as CodeEdge[];

    return { nodes, edges };
  }

  close(): void {
    this.db.close();
  }
}
