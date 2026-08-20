---
title: "Giving AI agents knowledge they were never trained on"
published: false
tags: mcp, ai, typescript, llm
cover_image: ""
---

# Giving AI agents knowledge they were never trained on

I love coding my own stuff, and my clients typically have lots of internal specifications and libraries that should be used.

But since LLMs haven't been trained on that, it's hard to get them to code accurately using those specs, libraries or frameworks.

You can of course let them parse everything, but that wastes tokens and your patience :)


Same goes for well known libraries, but you are stuck on a specific version that you must follow. You don't want it to guess the API.

`docs-mcpserver` exists to deal with both.

## What it is

It is an MCP server that gives an agent accurate knowledge of a framework. Documentation is just the medium that carries that
knowledge — so it reads three kinds of it:

- **Markdown docs** — your `*.md` files.
- **API reference** — C# XML documentation, or TypeDoc JSON.
- **Schema** — JSON Schema, OpenAPI 3.x, Swagger 2.0.

What the agent gets out of it is the same in every case: the real names, the real
signatures, the real shapes. Sources can come from a
local folder or straight from a GitHub URL. A single
server instance can host several libraries side by side. For instance your in-house
framework, a client's framework, and a specific version of some public library. 

The agent picks which one to query.

## Why not just give the agent the files

You could point the agent at the folders and let it read. The MCP server does a
few things that raw file access does not:

- **It is sandboxed.** Each source is scoped, with path-traversal protection. The
  agent reads what you exposed, nothing else on the disk.
- **It reads in pieces.** Instead of loading a 4000-line reference file, the agent
  asks for the table of contents, then pulls the one chapter it needs.
- **It searches properly.** Dedicated search tools with regex and glob support,
  instead of the agent improvising its own grep.
- **It is self-describing.** With several libraries configured, the agent calls
  one tool to discover what is available. You do not have to spell out every path.
- **GitHub works without cloning.** Give it a repo URL and it handles the rest.

The multi-library part is the point. Instead of running several MCP servers for
documentation, you get one with a small toolset. No token waste.

## Setting it up

Install and build:

```bash
npm install
npm run build
```

The quick way, a single folder:

```bash
docs-mcpserver ./docs --name "My Docs"
```

For the real use case — several libraries — use a config file. Here is an
in-house framework served from disk, next to a pinned version of a public
library pulled from GitHub:

```json
{
  "name": "dev-docs",
  "description": "Frameworks the model has not been trained on",
  "cacheDir": "./cache",
  "libraries": [
    {
      "name": "acme-core",
      "description": "Our internal application framework",
      "sources": [
        { "type": "disk", "origin": "./frameworks/acme-core/docs", "kind": "docs" },
        { "type": "disk", "origin": "./frameworks/acme-core/api",  "kind": "api"  }
      ]
    },
    {
      "name": "somelib-3.2",
      "description": "SomeLib, pinned to v3.2.0",
      "sources": [
        {
          "type": "github",
          "origin": "https://github.com/someorg/somelib/tree/v3.2.0/docs",
          "kind": "docs"
        }
      ]
    }
  ]
}
```

Start it with the config:

```bash
docs-mcpserver --config dev-docs.json
```

And register it with Claude Code:

```bash
claude mcp add mydocs -- node /path/to/markdown-docs-mcp/dist/index.js --config /path/to/dev-docs.json
```

For private GitHub repos, set `GITHUB_TOKEN` in the environment.

## What the agent actually sees

Each library exposes tools based on the `kind` of its sources:

- **docs** — `get_doc_index`, `get_sub_index`, `read_doc_file`, `get_file_toc`,
  `get_chapters`, `search_docs`.
- **api** — `get_api_index`, `get_api_type`, `get_api_member`, `search_api`.
- **schema** — `list_schemas`, `list_definitions`, `get_definition`,
  `search_definitions`, `search_all_schemas`.

A typical run looks like this. The agent calls `list_libraries` and sees
`acme-core` and `somelib-3.2`. It needs to know how `acme-core` handles
configuration, so it calls `search_docs` with `library: "acme-core"`, finds the
right file, asks for its table of contents with `get_file_toc`, then pulls the
one relevant section with `get_chapters`. It answers the question without ever
loading the whole file.

When multiple libraries are configured, every tool takes a `library` parameter.
When there is only one, the parameter disappears and the tools behave like a
plain single-library server.

The same applies to schema sources. For an OpenAPI spec, path operations show up
as definitions named like `GET /pets`, so the agent can ask for one endpoint
without reading the whole document. Useful when you want the agent to call your
API correctly rather than guess at the shape of it.

## Generating the API input

One thing worth knowing up front: the `api` pipeline does not read source code.
It consumes a generated documentation file.

- **TypeScript / JavaScript** — use TypeDoc's JSON serializer:
  `typedoc --json api.json src/index.ts`. Point the source at that `.json` file.
  The markdown output from `typedoc-plugin-markdown` is not supported — it has to
  be the JSON serializer output.
- **C#** — enable `<GenerateDocumentationFile>true</GenerateDocumentationFile>`
  and point the source at the generated `*.xml` file, or the build output folder
  that contains it.

## What it does not do

It does not read source code. If you want API reference, you generate the doc
file first, as above.

## Try it

The code is on GitHub:
[github.com/jgauffin/markdown-docs-mcp](https://github.com/jgauffin/markdown-docs-mcp), or on npm as `docs-mcpserver`.

Feel free to leave feedback, or check my other MCP servers on [GitHub](https://github.com/jgauffin).
