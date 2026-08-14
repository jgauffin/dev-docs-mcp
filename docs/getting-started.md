# Getting started

## Installation

```bash
npm install
npm run build
```

## Quick start

Single library, local folder:

```bash
docs-mcpserver ./docs --name "My Docs"
```

GitHub repository:

```bash
docs-mcpserver https://github.com/user/my-project/tree/main/docs --name "My Project"
```

Multi-library via config file:

```bash
docs-mcpserver --config dev-docs.json
```

See [configuration.md](configuration.md) for the full config schema, or [`sample-config.json`](../sample-config.json) for a complete example.

## CLI reference

```bash
docs-mcpserver <docs-folder-or-github-url> [options]
```

| Option | Description |
|---|---|
| `<docs-folder-or-github-url>` | Positional — local path or GitHub URL (legacy single-library mode) |
| `--config <file>` | Load settings from a JSON config file. CLI flags override config file values. |
| `--name <name>` | Server name |
| `--description <text>` | Server description |
| `--cache-dir <path>` | Directory for cached git clones |
| `--update-interval <minutes>` | Refresh interval for cached clones |
| `--port <port>` | Run as HTTP server on this port (see [hosting.md](hosting.md)) |
| `--api <folder>` | (legacy) API docs folder for implicit single library |

For private GitHub repos, set the `GITHUB_TOKEN` environment variable.

## Claude Code integration

Project-scoped:

```bash
claude mcp add mydocs -- node /path/to/markdown-mcp/dist/index.js --config /path/to/dev-docs.json
```

Global:

```bash
claude mcp add --scope user mydocs -- node /path/to/markdown-mcp/dist/index.js --config /path/to/dev-docs.json
```

For private GitHub repos, pass `GITHUB_TOKEN` via the shell environment when launching, or use `claude mcp add --env GITHUB_TOKEN=...`.

## Development

```bash
npm run dev        # Watch mode for TypeScript
npm test           # Run tests
npm run test:watch # Watch mode for tests
```
