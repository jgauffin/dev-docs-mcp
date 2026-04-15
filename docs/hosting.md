# Hosting

By default the server uses stdio, which is what MCP clients like Claude Code and Claude Desktop expect. To expose the server over HTTP instead (e.g. behind a reverse proxy or for multi-user access), add `--port`:

```bash
markdown-mcp --config dev-docs.json --port 3000
```

The server listens on `http://0.0.0.0:<port>/mcp` using the MCP [Streamable HTTP](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http) transport. Clients connect by pointing their MCP HTTP configuration at that URL.

## Hosting with IIS (httpPlatformHandler)

IIS can manage the Node process directly using `httpPlatformHandler` — no separate reverse proxy modules needed. IIS starts the process, assigns it a port via `HTTP_PLATFORM_PORT`, and forwards all matching requests to it. The server reads this variable automatically.

**Prerequisites:** The HttpPlatformHandler module ships with IIS 10+. On older versions, install it from the [IIS downloads page](https://www.iis.net/downloads/microsoft/httpplatformhandler).

### 1. Create an IIS application

In IIS Manager, create a new Application (or virtual directory) under your site — for example with alias `mcp-docs` pointing to the folder that contains `web.config` below.

### 2. Add a `web.config`

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <handlers>
      <add name="httpPlatformHandler"
           path="*" verb="*"
           modules="httpPlatformHandler"
           resourceType="Unspecified" />
    </handlers>
    <httpPlatform processPath="node"
                  arguments="d:\path\to\markdown-mcp\dist\index.js --config d:\path\to\dev-docs.json"
                  startupTimeLimit="60"
                  stdoutLogEnabled="true"
                  stdoutLogFile=".\logs\node.log">
      <environmentVariables>
        <environmentVariable name="NODE_ENV" value="production" />
      </environmentVariables>
    </httpPlatform>
  </system.webServer>
</configuration>
```

IIS sets `HTTP_PLATFORM_PORT` automatically — the server picks it up without needing `port` in the config file. Adjust the `processPath` if `node` is not on the system PATH (use the full path, e.g. `C:\Program Files\nodejs\node.exe`).

### 3. Claude Code configuration

```bash
claude mcp add --scope user --transport http dev-docs https://yourserver.com/mcp-docs/mcp
```
