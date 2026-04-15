# Tool groups

Each library can mix-and-match three kinds of sources. The tool groups are enabled per library based on the `kind` of its sources.

When multiple libraries are configured, every tool (except `list_libraries`) takes a required `library` parameter.

## Markdown docs — `kind: "docs"`

For Markdown files (`*.md`). Supports regex search, TOC extraction, and chapter-by-chapter reads so the agent doesn't have to load huge files.

| Tool | Description |
|---|---|
| `get_doc_index` | Top-level index of all markdown files |
| `get_sub_index` | Index of a subfolder |
| `read_doc_file` | Read a full markdown file |
| `get_file_toc` | Headings (TOC) of a file |
| `get_chapters` | Extract specific chapters by heading |
| `search_docs` | Regex search across docs, with optional glob path filter |

## API reference — `kind: "api"`

Parses **C# XML documentation comments** (`*.xml`) and **TypeDoc JSON** (`*.json`) into a unified namespace / type / member model.

| Tool | Description |
|---|---|
| `get_api_index` | All namespaces and types with summaries |
| `get_api_type` | Full docs for a type including all members |
| `get_api_member` | Detailed docs for one member (parameters, returns, exceptions, examples) |
| `search_api` | Regex search across type names, member names, signatures, and summaries |

## JSON Schema / OpenAPI — `kind: "schema"`

Indexes **JSON Schema** (draft 6+), **OpenAPI 3.x**, and **Swagger 2.0** files. For OpenAPI specs, path operations are exposed as definitions named like `GET /pets`.

> TypeDoc JSON files should use `kind: "api"`, not `kind: "schema"` — the API pipeline has a richer model for types and members.

| Tool | Description |
|---|---|
| `list_schemas` | All indexed schema files with format and definition counts |
| `list_definitions` | Definition names in a schema (including OpenAPI path operations) |
| `get_definition` | Full JSON for a definition or path operation |
| `search_definitions` | Glob/pipe keyword search within a schema |
| `search_all_schemas` | Same, across all schemas in the library |

Search expressions support:
- `|` as OR separator (`"user|order"`)
- `*` and `?` as glob wildcards (`"GET*"`)
- Plain substring match (case-insensitive)

## Multi-library meta

| Tool | Description |
|---|---|
| `list_libraries` | Only exposed when ≥ 2 libraries are configured. Returns each library's name, description, and which tool groups (docs / api / schema) it exposes. |

## The `library` parameter

When multiple libraries are configured, every tool gains a required `library` parameter. The agent calls `list_libraries` first to discover what's available, then passes the library name on subsequent tool calls.

When only one library is configured, the parameter is omitted — tools behave exactly as a single-library server would.
