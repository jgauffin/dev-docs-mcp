# Tool groups

Each library can mix-and-match four kinds of sources. The tool groups are enabled per library based on the `kind` of its sources.

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

### Generating API input

The `api` pipeline does not read source code — it consumes a generated documentation file:

- **TypeScript / JavaScript** — use TypeDoc's built-in JSON serializer: `typedoc --json api.json src/index.ts`. Point the source at the resulting `.json` file. The markdown output from `typedoc-plugin-markdown` is **not** supported — it must be the JSON serializer output (a TypeDoc project document).
- **C#** — enable XML documentation output in the project (`<GenerateDocumentationFile>true</GenerateDocumentationFile>`) and point the source at the generated `*.xml` file (or the build output folder containing it).

## JSON Schema / OpenAPI — `kind: "schema"`

Indexes **JSON Schema** (draft 6+), **OpenAPI 3.x**, and **Swagger 2.0** files. For OpenAPI specs, path operations are exposed as definitions named like `GET /pets`.

Specs can come from a folder (`type: "disk"` / `"github"`) or straight from a running service that publishes them over HTTP (`type: "url"`) — see [configuration.md](configuration.md#specs-from-a-running-service--type-url). Fetched specs are cached, so a service that is not currently running still serves its last known spec.

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

## JSON data — `kind: "data"`

For **JSON and JSONL data files** — exports, dumps, API captures — as opposed to schemas that describe them. These tools answer questions about a file far larger than any answer could contain, so nothing here ever returns the file itself.

Every operation is capped, and a capped response says so: the true match count sits next to the number of rows returned, arrays report their real length, and a clipped string carries the length it was clipped from. A partial answer can never be mistaken for a complete one.

| Tool | Description |
|---|---|
| `list_data_files` | Files available to the group, with format and size |
| `json_schema` | Structure only — key names, types, array lengths, nesting. The call to make first against an unfamiliar file. |
| `json_query` | The values an expression selects, capped by row count and by response size |
| `json_stat` | count / sum / min / max / mean / median over a selection, optionally grouped. The rows never come back. |
| `json_diff` | Compare the same selection in two files: added, removed, and the specific fields that changed |

### Expression syntax

```
$.orders[*] | select(.total > 100 and .status == "open") | {id, total, name: .customer.name}
```

| Part | Meaning |
|---|---|
| `$.orders[*]` | The leading path. Matched while the file streams, so only the selected subtrees are ever built. `[*]` is any element, `[3]` one element, `["key with spaces"]` a quoted key. |
| `select(...)` | Keeps matching items. Operators: `==` `!=` `>` `>=` `<` `<=` `contains` `startswith` `endswith` `exists` `missing`, joined with `and` / `or` / `not` and grouped with parentheses. |
| `{a, b: .c.d}` | Projection. A bare name keeps its written path as the output key; `alias: .path` renames it. |
| `keys` / `values` / `length` | The keys, the values, or the size of the item |

A missing key and a stored `null` are different: use `.note missing` for the first and `.note == null` for the second. Ordering comparisons across different types are always false, so `.status > 5` on a string does not match.

A JSONL file behaves exactly like a top-level array, so `$[*]` is its records and the same expressions work against both formats.

### Streaming and limits

Files are read a chunk at a time, so memory is bounded by the largest single value being built rather than by the file size — a query against a file of hundreds of megabytes runs in the same memory as one against a small file. Two consequences worth knowing:

- A `data` source must be readable from a local directory. Use `type: "disk"`, or configure `cacheDir` so a GitHub source is cloned locally first.
- An expression selecting one enormous value (`$` on a large file) is refused with a message telling you to narrow it. Select the elements, not the array: `$.orders[*]`, not `$.orders`.

## Multi-library meta

| Tool | Description |
|---|---|
| `list_libraries` | Only exposed when ≥ 2 libraries are configured. Returns each library's name, description, and which tool groups (docs / api / schema / data) it exposes. |

## The `library` parameter

When multiple libraries are configured, every tool gains a required `library` parameter. The agent calls `list_libraries` first to discover what's available, then passes the library name on subsequent tool calls.

When only one library is configured, the parameter is omitted — tools behave exactly as a single-library server would.
