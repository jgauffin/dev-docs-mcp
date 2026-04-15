# Docs MCP Server

An MCP (Model Context Protocol) server that exposes **Markdown documentation**, **API reference** (C# XML-doc / TypeDoc), and **JSON Schema / OpenAPI** specs to AI agents — from local folders or GitHub repositories.

A single server instance can host **multiple libraries/frameworks** side-by-side, each with its own sources. The AI picks which library to query via a `library` parameter, discoverable through the `list_libraries` tool.

## Why use this instead of direct file access?

|  | Direct file access | Docs MCP |
|---|---|---|
| **Security** | Agent can read/write anywhere on the filesystem | Sandboxed per source with traversal protection |
| **Discovery** | Agent scans directories and reads files one-by-one | Index tools give instant overviews of every source |
| **Search** | Agent greps files manually, burning context | Dedicated search tools with regex or glob support |
| **Large files** | Entire file loaded into context | TOC + chapter extraction reads only needed sections |
| **Multi-library** | Agent must know every path/repo | One server, many libraries, self-describing |
| **Source** | Local files only | Local directories or GitHub URLs — no cloning required |

## Quick start

```bash
npm install
npm run build

# Single library
markdown-mcp ./docs --name "My Docs"

# Multi-library
markdown-mcp --config dev-docs.json
```

See [`sample-config.json`](sample-config.json) for a complete multi-library example.

## Documentation

- [Getting started](docs/getting-started.md) — install, CLI, Claude Code / Claude Desktop integration
- [Configuration](docs/configuration.md) — config file format, libraries, sources
- [Tools](docs/tools.md) — the tool groups the agent sees (docs / api / schema)
- [Hosting](docs/hosting.md) — HTTP mode and IIS (httpPlatformHandler) setup

## License

Apache-2.0
