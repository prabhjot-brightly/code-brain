# Use cases

This document walks through real scenarios and maps each one to the right combination of index level and MCP tools.

---

## Decision map — index level vs MCP tool

```
Goal                          → Index level    → MCP tool(s)
──────────────────────────────────────────────────────────────
"What files are in module X?" → low            → query_codebase (filePath filter)
"What classes exist here?"    → med            → query_codebase (nodeType=CLASS)
"How does class X relate?"    → med            → query_codebase + get_node_context
"What does method X do?"      → high           → get_node_context
"Who calls method X?"         → high           → query_codebase (symbol=X, depth=2)
"Root-cause this stack trace" → high           → diagnose_issue
"Store an incident signal"    → high           → ingest_incident_evidence
"Index a remote repo"         → (any)          → index_github
```

The MCP server is used **at query time** (inside Claude or another agent). The index scripts (`npm run index:*`) are run **once up front** to populate the graph. You only re-index when the source changes.

---

## Scenario 1 — Bug reported in a repo

You receive a bug report: *"NullPointerException in OrderService.processOrder at line 87"*.

**Step 1 — Index if not already done**
```bash
npm run index:high -- /path/to/order-service
```
You need `high` because you want CALLS edges and method source to trace the failure path.

**Step 2 — Use `diagnose_issue` in Claude Code**

In Claude Code (with the MCP server running):
> "Diagnose this incident: NullPointerException in OrderService.processOrder at line 87. Stack trace: …"

`diagnose_issue` will:
- Locate `processOrder` as the epicentre node
- Pull its source code from the graph
- Fetch callers (what triggered it) and callees (what it delegates to)
- Pass all of that to Claude for root-cause analysis

**Step 3 — Drill in if needed**

If the diagnosis points to a dependency:
> `query_codebase` with `symbol="InventoryClient"` to see the class shape.
> `get_node_context` at the specific file+line to read the exact implementation.

**What to use for what:**
| Step | Tool / script |
|---|---|
| Initial index | `npm run index:high` |
| Automated root-cause from stack trace | `diagnose_issue` |
| Find a specific class or method | `query_codebase(symbol=...)` |
| Read full implementation of one method | `get_node_context` |
| Read multiple methods at once | `get_nodes_context` |
| Store a log/metric observation linked to code | `ingest_incident_evidence` |

---

## Scenario 2 — Agent scout (recommend agents from the knowledge graph)

You have a library of agents (like `.claude/agents/`) and want to build an agent that, given a task description, recommends which agent to invoke.

**Setup — index your agents repo at `med`**
```bash
npm run index:med -- /path/to/agents-repo
```
`med` is enough: agent files are mostly class/function descriptions + configuration, no need for deep call chains.

**Scout agent query pattern**

The scout agent calls `query_codebase` with the task description as the question and uses the results to match agent capabilities:

```
query_codebase(
  question: "fix a failing database migration",
  repo:     "agents-repo",
  nodeType: "FILE",
  limit:    5
)
```

Returns the most semantically relevant agent files based on their embedded descriptions. The scout then reads the top matches with `get_node_context` to extract agent metadata (tools available, description, use case) and presents ranked recommendations.

**Why this works:** each agent's file node is embedded at index time. Querying with a natural language task description finds the closest semantic match via vector ANN — no keyword brittle matching.

**Refinement — add structured metadata**

If your agent files have a consistent frontmatter (like the `project-context.md` in `.claude/agents/`), index them at `high` and the scout can also use `query_codebase(nodeType=FUNCTION)` to match against specific capabilities described in the code.

---

## Scenario 3 — PR review / understanding an unfamiliar module

You're reviewing a PR that touches `PaymentGateway`. You've never seen this module.

**Quick orientation (no deep index needed)**
```bash
npm run index:med -- /path/to/repo
```

Then in Claude Code:
> "What classes are in the payment module and what do they extend?"

```
query_codebase(question: "payment gateway classes", nodeType: "CLASS", repo: "my-service")
```

Returns class shapes, EXTENDS/IMPLEMENTS relationships, and file locations — enough to understand the architecture before reading the diff.

---

## Scenario 4 — Finding all usages of a deprecated method

You're removing `LegacyAuthService.validate()` and need every caller.

**Requires `high` index** (CALLS edges only exist at high level):
```bash
npm run index:high -- /path/to/repo
```

In Claude Code:
> "What calls LegacyAuthService.validate?"

```
query_codebase(symbol: "validate", nodeType: "METHOD", depth: 2, repo: "auth-service")
```

Returns all methods that call `validate`, with caller counts. Each result shows `← N callers · M callees` so you can prioritise which callers to update first.

---

## Scenario 5 — Semantic search across multiple repos

You manage several microservices. You want to find all places that read a specific config key `BC_APP_CONNECTOR_FLAG`.

```
query_codebase(question: "BC_APP_CONNECTOR_FLAG config read")
```

No `repo` filter — searches across all indexed repos. Returns matches from every service that reads that flag. Works because READS_CONFIG edges and config constant names are stored at `high` level.

---

## When NOT to use the knowledge graph

| Situation | Better approach |
|---|---|
| The repo hasn't changed and you just re-indexed | Cache the result — `query_codebase` is already cheap |
| You want to read one file you already know the path of | `Read` tool directly — no graph overhead |
| The repo is tiny (< 20 files) | Just read the files — indexing overhead isn't worth it |
| You need to search for a string literal / regex pattern | `grep` / `Grep` tool — graph stores structure, not text search |
| You need to check if a file exists | File system tools — faster than a graph query |
