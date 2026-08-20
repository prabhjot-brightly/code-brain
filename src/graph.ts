import type { CodeNode, CodeEdge, EdgeType, NodeType, GraphData } from './types.js';

export class Graph {
  private nodes = new Map<string, CodeNode>();
  private edges: CodeEdge[] = [];

  // ─── Mutations ───────────────────────────────────────────────────────────

  addNode(node: CodeNode): void {
    this.nodes.set(node.id, node);
  }

  addEdge(edge: CodeEdge): void {
    this.edges.push(edge);
  }

  // ─── Lookups ─────────────────────────────────────────────────────────────

  getNode(id: string): CodeNode | undefined {
    return this.nodes.get(id);
  }

  /** All nodes of a given type. */
  byType(type: NodeType): CodeNode[] {
    return [...this.nodes.values()].filter((n) => n.type === type);
  }

  /** All nodes in a given file. */
  inFile(filePath: string): CodeNode[] {
    return [...this.nodes.values()].filter((n) => n.filePath === filePath);
  }

  /** Exact name match across all node types. */
  findByName(name: string): CodeNode[] {
    return [...this.nodes.values()].filter((n) => n.name === name);
  }

  // ─── Edge traversal ──────────────────────────────────────────────────────

  outgoing(sourceId: string, type?: EdgeType): CodeEdge[] {
    return this.edges.filter(
      (e) => e.source === sourceId && (type == null || e.type === type),
    );
  }

  incoming(targetId: string, type?: EdgeType): CodeEdge[] {
    return this.edges.filter(
      (e) => e.target === targetId && (type == null || e.type === type),
    );
  }

  /**
   * BFS from `startId`, up to `maxDepth` hops.
   * Returns reachable node IDs (excluding the start node).
   */
  reachable(startId: string, maxDepth = 2): Set<string> {
    const visited = new Set<string>();
    const queue: Array<{ id: string; depth: number }> = [{ id: startId, depth: 0 }];

    while (queue.length > 0) {
      const item = queue.shift()!;
      if (item.depth >= maxDepth) continue;

      for (const edge of this.outgoing(item.id)) {
        if (!visited.has(edge.target)) {
          visited.add(edge.target);
          queue.push({ id: edge.target, depth: item.depth + 1 });
        }
      }
    }

    return visited;
  }

  // ─── Snapshot ────────────────────────────────────────────────────────────

  toData(): GraphData {
    return {
      nodes: [...this.nodes.values()],
      edges: [...this.edges],
    };
  }

  static fromData(data: GraphData): Graph {
    const g = new Graph();
    for (const n of data.nodes) g.addNode(n);
    for (const e of data.edges) g.addEdge(e);
    return g;
  }
}
