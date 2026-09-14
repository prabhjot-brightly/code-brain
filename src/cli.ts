#!/usr/bin/env node
import process from 'node:process';
import path from 'node:path';
import { Command } from 'commander';
import { Neo4jDb } from './neo4j-database.js';
import { Indexer } from './indexer.js';
import { Retriever } from './retriever.js';

const program = new Command();

program
  .name('rkg')
  .description('Repo Knowledge Graph — index any codebase, then query it via MCP + Neo4j')
  .version('2.0.0');

// ─── Shared ───────────────────────────────────────────────────────────────────

function parseExtensions(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  return raw.split(',').map((e) => {
    const ext = e.trim();
    return ext.startsWith('.') ? ext : `.${ext}`;
  });
}

// ─── index ────────────────────────────────────────────────────────────────────

program
  .command('index <repo-path>')
  .description('Scan and index a local repository into Neo4j')
  .option('--ext <extensions>', 'Comma-separated extensions to index, e.g. ".py,.rb"')
  .option('--ignore <dirs>',    'Extra directory names to skip, comma-separated')
  .action(async (repoPath: string, opts: { ext?: string; ignore?: string }) => {
    const absRepo  = path.resolve(repoPath);
    const repoName = path.basename(absRepo);
    const db       = new Neo4jDb();
    const indexer  = new Indexer(db);

    try {
      await db.init();
      console.log(`Indexing ${absRepo} …`);

      const result = await indexer.index({
        repoPath: absRepo,
        repoName,
        scan: {
          extensions: parseExtensions(opts.ext),
          ignore: opts.ignore?.split(',').map((s) => s.trim()),
        },
      });
      console.log(
        `✓  ${result.filesScanned} files · ${result.nodesFound} nodes · ${result.edgesFound} edges (${result.durationMs}ms)`,
      );

      console.log('Generating embeddings …');
      const count = await indexer.embedNodes(absRepo, repoName);
      console.log(`✓  ${count} embeddings stored in Neo4j`);
    } finally {
      await db.close();
    }
  });

// ─── stats ────────────────────────────────────────────────────────────────────

program
  .command('stats')
  .description('Show all indexed repos and node/edge counts from Neo4j')
  .action(async () => {
    const db = new Neo4jDb();
    try {
      const stats = await db.getStats();
      console.log(`Neo4j Knowledge Graph (db: ${db.database})`);
      console.log(`Total nodes: ${stats.totalNodes}   Total edges: ${stats.totalEdges}\n`);

      if (stats.repos.length === 0) {
        console.log('No repos indexed yet.');
      } else {
        for (const r of stats.repos) {
          console.log(`  ${r.name}  (${r.path})`);
          console.log(`    Nodes: ${r.nodeCount}`);
          for (const [type, count] of Object.entries(r.byType)) {
            console.log(`      ${type.padEnd(12)} ${count}`);
          }
        }
      }
    } finally {
      await db.close();
    }
  });

// ─── query ────────────────────────────────────────────────────────────────────

program
  .command('query')
  .description('Query the knowledge graph with a natural language question')
  .requiredOption('--question <question>', 'Natural language question to ask')
  .option('--repo <repoName>', 'Filter to a specific repo')
  .option('--limit <number>', 'Max results to return', '10')
  .option('--depth <number>', 'BFS hop depth', '2')
  .action(async (opts: { question: string; repo?: string; limit: string; depth: string }) => {
    const db       = new Neo4jDb();
    const retriever = new Retriever(db);
    try {
      const chunks = await retriever.retrieve({
        question: opts.question,
        repoName: opts.repo,
        limit:    parseInt(opts.limit),
        maxDepth: parseInt(opts.depth),
      });

      if (chunks.length === 0) {
        console.log('No results found.');
        return;
      }

      for (const chunk of chunks) {
        console.log('\n─────────────────────────────────────────');
        console.log(`${chunk.node.type}  ${chunk.node.name}  (score: ${chunk.relevanceScore.toFixed(3)})`);
        console.log(`File: ${chunk.node.filePath}  L${chunk.node.startLine}`);
        console.log(chunk.sourceLines.join('\n'));
      }
    } finally {
      await db.close();
    }
  });

// ─── reset-index ──────────────────────────────────────────────────────────────

program
  .command('reset-index')
  .description('Drop and recreate the vector index (needed when switching embedding models)')
  .action(async () => {
    const db = new Neo4jDb();
    try {
      console.log('Dropping old vector index…');
      await db.dropVectorIndex();
      console.log('Recreating vector index with current EMBEDDING_DIMS…');
      await db.init();
      console.log(`✓ Done. Now re-run: npx tsx src/cli.ts index <repo-path>`);
    } finally {
      await db.close();
    }
  });

// ─── run ──────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
