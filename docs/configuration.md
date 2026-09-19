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

See [`sample-config.json`](../sample-config.json) for a complete example with all four source kinds.

The JSON data tools need no configuration: they are rooted at the directory the server was started in unless a library declares a `data` source. Configure one only to point them at a fixed directory instead, which also puts them behind the `library` parameter:

```json
{
  "name": "exports",
  "description": "Nightly warehouse exports",
  "sources": [
    { "type": "disk", "origin": "./exports", "kind": "data" }
  ]
}
```

Data files are read as streams, which a raw GitHub source cannot do. Use `type: "disk"`, or set `cacheDir` so a `github` source is cloned to disk first.

## Top-level fields

| Field | Description |
|---|---|
| `name` | Server name shown to the MCP client |
| `description` | Server description shown to the MCP client. The list of libraries is auto-appended so the agent knows what's available. |
| `cacheDir` | Directory for cached content — git clones (`type: "github"`) and fetched specs (`type: "url"`). **Required** when any `url` source is configured. |
| `updateInterval` | **Minutes** between `git pull` refreshes for cloned GitHub sources (default `30`) |
| `refreshInterval` | **Seconds** before a `url` source re-fetches its spec (default `10`) |

The two refresh settings are deliberately separate. GitHub repositories are external resources and
are polled slowly (30 minutes); specs published by your own locally running services are cheap to
ask and are polled in seconds, so a spec you are editing right now shows up almost immediately.
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
| `type` | `"disk"`, `"github"`, or `"url"` |
| `origin` | Local path, GitHub URL, or spec URL |
| `kind` | `"docs"`, `"api"`, `"schema"`, or `"data"` — see [tools.md](tools.md) for what each enables |
| `folder` | *(optional)* Subfolder within the origin — `disk` and `github` only |
| `name` | *(optional, `url` only)* Schema name the agent uses. Defaults to the last URL path segment. |
| `refreshInterval` | *(optional, `url` only)* Seconds before this spec is re-fetched, overriding the top-level value |
| `allowSelfSignedCertificate` | *(optional, `url` only)* Accept an untrusted TLS certificate. Defaults to `true` for `localhost`/`127.0.0.1`, `false` everywhere else. |

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

## Specs from a running service — `type: "url"`

A service that exposes its OpenAPI spec over HTTP can be configured by URL instead of copying the
spec file into a folder by hand:

```json
{
  "cacheDir": "./cache",
  "refreshInterval": 10,
  "libraries": [
    {
      "name": "orders-api",
      "description": "Order handling service",
      "sources": [
        {
          "type": "url",
          "origin": "https://localhost:5001/openapi/v1.json",
          "kind": "schema",
          "name": "orders"
        }
      ]
    }
  ]
}
```

The agent then queries it exactly like any other schema — `list_schemas` reports it under `orders`
(the `name` field, or the last URL path segment when `name` is omitted).

### Caching and refresh

The fetched spec is written to `<cacheDir>/url/<host>/<name>.json`, which makes these sources
suitable for services that are only running while you work on them:

- **On startup** the server fetches every configured spec in the background.
- **On each tool call** a refresh starts in the background if the cached spec is older than
  `refreshInterval` (default 10 seconds). The call itself is answered from the cache and never
  waits for the service — so editing a spec in a running service shows up within seconds, without
  the server issuing a request per tool call.
- **A cold start with nothing cached** is the one case that waits for the fetch (5 second timeout),
  so the first call returns a spec rather than an empty library.

### When the service is unavailable

Fetch failures are never fatal. The last cached spec keeps being served; if nothing was ever cached
the library simply reports no schemas. This applies to a service that is down, an error status, a
timeout, and a response that is not a recognised schema — a known-good cached spec is never
replaced by a bad response.

The agent is told, not left to guess. Until the service answers again, every schema tool appends a
warning after its JSON answer naming the origin, when the served copy was fetched and why the last
fetch failed, and `list_libraries` reports the same as `fetchedAt` and `problem` on the source. The
reason is also logged to stderr.

### HTTPS and development certificates

A service running locally over HTTPS — an ASP.NET project on `https://localhost:7276`, for
instance — presents a development certificate that no trust store accepts. Node's `fetch` rejects
it with `DEPTH_ZERO_SELF_SIGNED_CERT` and reports nothing more than "fetch failed".

Sources on `localhost` and `127.0.0.1` therefore accept an untrusted certificate by default, so a
local service works without extra configuration. Any other host is verified normally; to fetch a
spec from a remote service with an untrusted certificate, opt in explicitly:

```json
{
  "type": "url",
  "origin": "https://staging.internal/openapi/v1.json",
  "kind": "schema",
  "allowSelfSignedCertificate": true
}
```

Verification is waived per request — the process-wide TLS trust settings are never modified, so
every other source keeps full certificate checking.

### Limitations

- The response must be **JSON**. YAML specs are not supported; the fetch is skipped and logged.
- `cacheDir` must be configured — the server fails at startup with an explanatory error otherwise.
- Only `kind: "schema"` is meaningful. A `url` source with another `kind` is ignored with a warning.
- `folder` does not apply — a `url` source is a single document.

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
