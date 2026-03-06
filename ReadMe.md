# Markdown MCP Server

An MCP (Model Context Protocol) server for browsing and searching Markdown documentation.

## Why use this instead of direct file access?

When an AI agent has direct file system access to documentation, several issues arise:

- **Security risk** - The agent can potentially read/write anywhere on the filesystem
- **Inefficient** - The agent must scan directories and read files one-by-one to find information
- **Context bloat** - Large files consume valuable context window tokens
- **No structure** - The agent has no overview of what documentation exists

This MCP server solves these problems:

- **Sandboxed** - Access is restricted to a single docs directory with directory traversal protection
- **Indexed** - `get_framework_index` provides instant overview of all available docs
- **Searchable** - `search_docs` finds relevant content across all files with regex support
- **Structured** - `get_file_toc` extracts headers so the agent can navigate large files efficiently

## Installation

```bash
npm install
npm run build
```

## Usage

```bash
markdown-mcp <docs-folder> [--name <name>] [--description <text>]
```

| Option | Description |
|---|---|
| `<docs-folder>` | Path to the documentation directory (required) |
| `--name <name>` | Documentation title (e.g. "RelaxJS documentation"). Used as the MCP server name and injected into tool descriptions so the AI knows which docs it's browsing. |
| `--description <text>` | Describes what the documentation covers. Sent as the MCP server description. |

### Examples

Minimal (no title/description):

```bash
node dist/index.js ./docs
```

With title only:

```bash
node dist/index.js ./docs --name "RelaxJS documentation"
```

With title and description:

```bash
node dist/index.js ./docs --name "RelaxJS documentation" --description "Usage and API docs for a lightweight JavaScript framework for building streamlined UIs"
```

### Claude Code

Add as a project-scoped server:

```bash
claude mcp add relaxjs-docs -- node /path/to/markdown-mcp/dist/index.js /path/to/relaxjs/docs --name "RelaxJS documentation" --description "Usage and API docs for a lightweight JavaScript framework for building streamlined UIs"
```

Or add globally (available in all projects):

```bash
claude mcp add --scope user relaxjs-docs -- node /path/to/markdown-mcp/dist/index.js /path/to/relaxjs/docs --name "RelaxJS documentation" --description "Usage and API docs for a lightweight JavaScript framework for building streamlined UIs"
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "relaxjs-docs": {
      "command": "node",
      "args": [
        "/path/to/markdown-mcp/dist/index.js",
        "/path/to/relaxjs/docs",
        "--name", "RelaxJS",
        "--description", "Usage and API docs for a lightweight JavaScript framework for building streamlined UIs"
      ]
    }
  }
}
```

## Development

```bash
npm run dev        # Watch mode for TypeScript
npm test           # Run tests
npm run test:watch # Watch mode for tests
```

## License

Apache-2.0
