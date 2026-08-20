import { Neo4jDb } from './src/neo4j-database.js';

const db = new Neo4jDb();

const session = (db as any).session();
try {
  // Fetch a few nodes that have embeddings, show all their context
  const res = await session.run(`
    MATCH (n:CodeNode {repoName: 'permissions'})
    WHERE n.embedding IS NOT NULL AND n.type = 'METHOD'
    RETURN n
    LIMIT 3
  `);

  for (const record of res.records) {
    const n = record.get('n').properties;
    const emb: number[] = n.embedding;

    console.log('─'.repeat(70));
    console.log(`Name      : ${n.name}`);
    console.log(`Type      : ${n.type}`);
    console.log(`File      : ${n.filePath}`);
    console.log(`Lines     : ${n.startLine} → ${n.endLine}`);
    console.log(`Repo      : ${n.repoName}`);
    console.log(`Signature : ${n.firstLine}`);
    console.log(`\nSource Code (first 5 lines):`);
    const lines = (n.sourceCode as string).split('\n').slice(0, 5);
    for (const l of lines) console.log(`  ${l}`);

    console.log(`\nEmbedding:`);
    console.log(`  Dimensions : ${emb.length}`);
    console.log(`  First 10   : [${emb.slice(0, 10).map(v => v.toFixed(4)).join(', ')}]`);
    console.log(`  Last 10    : [${emb.slice(-10).map(v => v.toFixed(4)).join(', ')}]`);
    console.log(`  Min value  : ${Math.min(...emb).toFixed(4)}`);
    console.log(`  Max value  : ${Math.max(...emb).toFixed(4)}`);
    const mag = Math.sqrt(emb.reduce((s, v) => s + v * v, 0));
    console.log(`  Magnitude  : ${mag.toFixed(6)}  (should be ≈1.0 — L2-normalised)`);
    console.log(`\nWhat was embedded (input text to model):`);
    console.log(`  "${n.type} ${n.name}: ${n.firstLine?.trim().slice(0, 120)}"`);
    console.log('');
  }
} finally {
  await session.close();
  await db.close();
}
