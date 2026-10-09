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
| `npm run index -- <path>` | Scan, parse, and embed a local repo |
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
