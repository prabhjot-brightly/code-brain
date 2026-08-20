import { Neo4jDb } from './src/neo4j-database.js';

const db    = new Neo4jDb();
const stats = await db.getStats();

console.log(`\n✓ Connected to Neo4j (database: ${db.database})\n`);
console.log(`Total nodes : ${stats.totalNodes}`);
console.log(`Total edges : ${stats.totalEdges}\n`);

if (stats.repos.length === 0) {
  console.log('No repos indexed yet.');
} else {
  for (const r of stats.repos) {
    console.log(`Repo: ${r.name}`);
    console.log(`  Path  : ${r.path}`);
    console.log(`  Nodes : ${r.nodeCount}`);
    for (const [type, count] of Object.entries(r.byType).sort((a,b) => b[1]-a[1])) {
      console.log(`    ${type.padEnd(12)} ${count}`);
    }
    console.log('');
  }
}

await db.close();
