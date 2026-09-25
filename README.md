# code-brain

> Index any codebase into a Neo4j knowledge graph, then query it with natural language or diagnose production incidents — exposed as an MCP server for Claude Code and Claude Desktop.

---

## What it does

**code-brain** parses Java and TypeScript source with tree-sitter, stores every file, class, method, and function as a graph node in Neo4j, and draws edges for `CALLS`, `IMPORTS`, `EXTENDS`, `IMPLEMENTS`, and more. Each node gets a vector embedding so you can search by meaning, not just by name. The MCP server hands all of this to Claude so it can answer questions like "where is X defined?", trace call chains, or root-cause a production alert from a stack trace.

---

## Requirements

- Node.js >= 20
- Docker (for Neo4j)
- OpenAI API key -- or set `EMBEDDER=local` to run fully offline
- Anthropic API key -- optional, enables AI root-cause in `diagnose_issue`

---

## Quick start

### 1. Install

```bash
npm install --ignore-scripts
```

### 2. Start Neo4j

```bash
docker compose up -d
```

Browser UI at `http://localhost:7474`, Bolt at `bolt://localhost:7687`.

### 3. Create `.env`

Copy the block below into a `.env` file at the project root.

```env
# ── Neo4j ────────────────────────────────────────────────────────────────────
# URI must match the port in docker-compose.yml (default 7687)
NEO4J_URI=bolt://127.0.0.1:7687

# Credentials — must match NEO4J_AUTH in docker-compose.yml (format: user/password)
NEO4J_USER=neo4j
NEO4J_PASSWORD=neo4j

# Database name — must match NEO4J_initial_dbms_default__database in docker-compose.yml
NEO4J_DATABASE=codebrain

# ── Embedder ─────────────────────────────────────────────────────────────────
# "openai"  → uses text-embedding-3-small (1536 dims), requires OPENAI_API_KEY
# "local"   → uses bge-large-en-v1.5 offline (1024 dims), no API key needed
EMBEDDER=openai
OPENAI_API_KEY=sk-...

# ── AI root-cause analysis (optional) ────────────────────────────────────────
# Required only for the diagnose_issue MCP tool
# Get one at https://console.anthropic.com/
ANTHROPIC_API_KEY=sk-ant-...
```

> **Note:** If you change `NEO4J_PASSWORD` here, update `NEO4J_AUTH` in `docker-compose.yml` to match (format: `neo4j/<password>`).
>
> **Note:** If you switch `EMBEDDER` after indexing, run `npx tsx src/cli.ts reset-index` then re-index — the two backends use different vector dimensions.

### 4. Index a repo

```bash
npm run index -- /path/to/your/repo

# Optional filters
npm run index -- /path/to/your/repo --ext .java,.ts --ignore dist,build
```

---

## CLI

| Command | Description |
|---|---|
| `npm run index -- <path>` | Scan, parse, and embed a local repo (high detail, default) |
| `npm run index:low -- <path>` | Fast file-inventory index (no parsing, no embeddings) |
| `npm run index:med -- <path>` | Class-level index (classes, interfaces, structural edges, embeddings) |
| `npm run index:high -- <path>` | Full index — same as `npm run index` |
| `npm run stats` | Show all indexed repos and node counts |
| `npm run query -- --question "..."` | Natural-language search |
| `npm run mcp` | Start the MCP server |
| `npx tsx src/cli.ts reset-index` | Drop and recreate vector index (needed when switching embedders) |

---

## MCP tools

| Tool | What it does |
|---|---|
| `index_repo` | Index a local path |
| `index_github` | Clone and index a GitHub repo (`owner/repo` or full URL) |
| `query_codebase` | Semantic + structural search |
| `get_node_context` | Source and docs for one method/function |
| `get_nodes_context` | Source for multiple nodes in one call |
| `diagnose_issue` | Root-cause a production incident from a stack trace |
| `ingest_incident_evidence` | Store runtime observations linked to code |
| `get_stats` | List indexed repos |
| `record_evaluation` / `get_evaluation_metrics` | Track diagnosis accuracy |

---

## Connect to Claude Code

Add to `.claude/mcp.json` (project) or your global MCP config:

```json
{
  "mcpServers": {
    "repo-knowledge-graph": {
      "command": "npx",
      "args": ["tsx", "src/mcp.ts"],
      "cwd": "/absolute/path/to/code-brain"
    }
  }
}
```

---

## Indexing levels

Three levels control the trade-off between speed, storage, and query power. All three can coexist — each repo in the graph records the level it was indexed at, and you can upgrade a repo by re-running at a higher level (no `reset-index` required — that is only needed when switching embedding backends).

### Level comparison

| | `low` | `med` | `high` |
|---|---|---|---|
| **Speed** | Fastest (no parsing) | Fast | Slower (full parse + CALLS resolution) |
| **Node types** | FILE | FILE, CLASS, INTERFACE | FILE, CLASS, INTERFACE, METHOD, FUNCTION |
| **Edge types** | — | CONTAINS, DEFINES, IMPORTS, EXTENDS, IMPLEMENTS | All of med + CALLS, INJECTS, READS_CONFIG, READS_FIELD |
| **Embeddings** | None | CLASS + INTERFACE | All code-bearing nodes |
| **Source code stored** | None | Class body (up to 100 lines) | All bodies (up to 100 lines each) |
| **Use case** | Quick file inventory, dependency map | Architecture exploration, class hierarchy, PR review | Deep call-chain tracing, incident diagnosis, semantic search |

### What each level stores

#### `low` — file inventory
Stores one `FILE` node per scanned file. No AST parsing, no edges, no embeddings. Completes in seconds even for large repos.

```
(:CodeNode { type:"FILE", name:"OrderService.java", filePath:"src/.../OrderService.java", indexLevel:"low" })
```

#### `med` — structural graph
Parses every file and stores:
- **Nodes:** FILE, CLASS, INTERFACE
- **Edges:** CONTAINS (file→class), DEFINES (class→method signature not stored), IMPORTS (file→file), EXTENDS, IMPLEMENTS
- **Embeddings:** CLASS and INTERFACE nodes (enables semantic search on class descriptions)

Class method bodies are **not** stored at `med` — you see class shapes but not inner logic.

#### `high` — full knowledge graph
Everything in `med`, plus:
- **Nodes:** METHOD, FUNCTION (with full source body)
- **Edges:** CALLS (resolved by name across the repo), INJECTS (CDI/Spring @Inject), READS_CONFIG, READS_FIELD
- **Embeddings:** all code-bearing nodes (METHOD, FUNCTION, CLASS, INTERFACE)

This is the level required by `diagnose_issue`, `get_node_context`, and deep semantic queries.

---

### Example queries per level

#### `low` — find all files in a module
```cypher
MATCH (f:CodeNode {type:"FILE", repoName:"my-service"})
WHERE f.filePath CONTAINS "payment"
RETURN f.filePath
```

#### `med` — explore class hierarchy
```cypher
MATCH (c:CodeNode {type:"CLASS", repoName:"my-service"})-[:EXTENDS|IMPLEMENTS*1..3]->(p)
RETURN c.name, p.name, p.type
LIMIT 30
```

Find all classes in a package:
```cypher
MATCH (f:CodeNode {type:"FILE"})-[:CONTAINS]->(c:CodeNode {type:"CLASS", repoName:"my-service"})
WHERE f.filePath CONTAINS "service"
RETURN f.filePath, c.name
```

#### `high` — trace call chain to a method
```cypher
MATCH path = (caller:CodeNode)-[:CALLS*1..4]->
             (target:CodeNode {name:"processPayment", repoName:"my-service"})
RETURN [n in nodes(path) | n.name + " (" + n.filePath + ")"] AS chain
```

Find everything a method touches:
```cypher
MATCH (m:CodeNode {name:"placeOrder", repoName:"my-service", type:"METHOD"})
OPTIONAL MATCH (m)-[:CALLS]->(called)
OPTIONAL MATCH (m)-[:READS_CONFIG]->(cfg)
RETURN m.sourceCode, collect(called.name) AS calls, collect(cfg) AS configs
```

---

### Which level should each agent use?

| Agent / use case | Recommended level | Reason |
|---|---|---|
| **Quick orientation on an unfamiliar repo** | `low` | Just want file structure, no parse overhead |
| **PR review / architecture question** | `med` | Class/interface shapes are enough; method detail not needed |
| **Finding where a class is defined or what it extends** | `med` | Structural edges cover it |
| **Semantic "find code related to X"** | `med` or `high` | `med` covers class-level; `high` needed for method-level results |
| **Incident diagnosis / root-cause from stack trace** | `high` | `diagnose_issue` tool requires METHOD nodes + CALLS edges |
| **"What calls this method?"** | `high` | CALLS edges only exist at high |
| **Finding a method's full implementation** | `high` | Source code only stored at high |
| **Generating a full call graph** | `high` | CALLS resolution only at high |

> **Tip:** For a new repo, run `index:low` first to get a file map instantly, then `index:high` when you need deep analysis. You don't need to reset between upgrades — re-running at a higher level replaces the existing graph for that repo.

---

## Use cases

Bug triage, agent scouts, PR review, cross-repo search — see **[docs/USE_CASES.md](docs/USE_CASES.md)** for detailed scenarios with example queries and tool guidance.

---

## Embedders

| `EMBEDDER` | Model | Notes |
|---|---|---|
| `openai` (default) | `text-embedding-3-small` -- 1536 dims | Requires `OPENAI_API_KEY` |
| `local` | `bge-large-en-v1.5` -- fully offline | Model cached in `~/.cache/repo-knowledge-graph/models` |

The difference is only in vector search quality — the graph structure (nodes, edges, CALLS, EXTENDS, etc.) is identical regardless of embedder.

| | `local` (bge-large-en-v1.5) | `openai` (text-embedding-3-small) |
|---|---|---|
| Dims | 1024 | 1536 |
| Quality | Good, especially for code | Slightly better semantic understanding |
| Speed | Slow first run (model download), fast after | Fast (API call) |
| Cost | Free | ~$0.02 / million tokens |

**Practical impact:** when you run `query_codebase` with a natural language question, the semantic similarity ranking may differ slightly — OpenAI tends to handle paraphrasing and domain vocabulary better. Exact symbol lookups and structural traversal (CALLS chains, EXTENDS, etc.) are unaffected since those don't use embeddings at all.

> **Note:** You cannot mix embedders. Switching changes vector dimensions — run `npm run reset-index` then re-index all repos.

---

## Tests

```bash
npm test
```
