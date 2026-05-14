# Configuration

A single server instance can host multiple libraries/frameworks side-by-side. The AI picks which library to query via a `library` parameter on every tool call.

## Config file

```json
{
  "name": "dev-docs",
  "description": "Docs for multiple libraries",
  "cacheDir": "./cache",
  "updateInterval": 30,
  "libraries": [
    {
      "name": "relaxjs",
      "description": "Lightweight JavaScript framework",
      "sources": [
        { "type": "github", "origin": "https://github.com/user/relaxjs", "kind": "docs", "folder": "docs" },
        { "type": "github", "origin": "https://github.com/user/relaxjs", "kind": "api",  "folder": "api" }
      ]
    },
    {
      "name": "petstore",
      "description": "Petstore OpenAPI spec",
      "sources": [
        { "type": "disk", "origin": "./schemas/petstore", "kind": "schema" }
      ]
    }
  ]
}
```

See [`sample-config.json`](../sample-config.json) for a complete example with all three source kinds.

## Top-level fields

| Field | Description |
|---|---|
| `name` | Server name shown to the MCP client |
| `description` | Server description shown to the MCP client. The list of libraries is auto-appended so the agent knows what's available. |
| `cacheDir` | Directory for cached git clones (used when `type: "github"` is configured) |
| `updateInterval` | Minutes between `git pull` refreshes for cloned sources |
| `port` | Run as HTTP server on this port — see [hosting.md](hosting.md) |
| `libraries` | Array of library configs |

## Library config

| Field | Description |
|---|---|
| `name` | Library identifier used as the `library` tool argument. Must be alphanumeric (plus `_ - .`). Must be unique. |
| `description` | Human-readable description — included in the server description and `list_libraries` output |
| `sources` | Array of sources feeding this library |

## Source config

Each library's `sources` array contains one or more source entries:

| Field | Description |
|---|---|
| `type` | `"disk"` or `"github"` |
| `origin` | Local path or GitHub URL |
| `kind` | `"docs"`, `"api"`, or `"schema"` — see [tools.md](tools.md) for what each enables |
| `folder` | *(optional)* Subfolder within the origin |

The `folder` field is useful when a single GitHub repo hosts multiple kinds — the repo is only cloned once:

```json
{
  "libraries": [
    {
      "name": "my-project",
      "sources": [
        { "type": "github", "origin": "https://github.com/user/my-project", "kind": "docs",   "folder": "docs" },
        { "type": "github", "origin": "https://github.com/user/my-project", "kind": "api",    "folder": "api" },
        { "type": "github", "origin": "https://github.com/user/my-project", "kind": "schema", "folder": "schemas" }
      ]
    }
  ]
}
```

## Supported GitHub URL formats

| URL | Resolved as |
|---|---|
| `https://github.com/owner/repo` | Root of `main` branch |
| `https://github.com/owner/repo/tree/branch` | Root of specified branch |
| `https://github.com/owner/repo/tree/branch/path/to/docs` | Subfolder of specified branch |

For private repositories, set the `GITHUB_TOKEN` environment variable.

## Legacy config (single library)

The old single-library shape still works — it's promoted internally to one implicit library:

```bash
docs-mcpserver ./docs --api ./api-docs --name "MyLib"
```

```json
{
  "name": "MyLib",
  "sources": [
    { "type": "disk", "origin": "./docs",     "kind": "docs" },
    { "type": "disk", "origin": "./api-docs", "kind": "api"  }
  ]
}
```

When only one library is configured, the `library` tool parameter is omitted — tools behave exactly as before.
