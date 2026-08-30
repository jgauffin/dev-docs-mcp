---
title: "Live API specs for coding agents"
published: false
tags: mcp, ai, openapi, webdev
cover_image: ""
---

# Live API specs for coding agents

An agent writing frontend code has to know the backend's API. It has three options. It can read the backend source and work out from scratch what the service already publishes. It can ask you, which promotes you to API documentation. Or it can swallow the entire OpenAPI document in order to use one route out of it.

Then it does the same thing again tomorrow, against a `swagger.json` you exported last Tuesday.

`docs-mcpserver` takes the spec straight from the running service, caches it, and serves it one operation at a time.

## The config

```json
{
  "cacheDir": "./cache",
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

```bash
npm install -g docs-mcpserver
claude mcp add docs -- docs-mcpserver --config /path/to/dev-docs.json
```

That is the whole setup.

## One operation, not the whole spec

The agent lists the definitions in `orders`, picks the one it needs, and fetches that. For an OpenAPI document the path operations are exposed as definitions named `GET /orders/{id}`, so it can also search by keyword.

A few hundred tokens for the operation it is writing against, instead of the entire document. That keeps working as the service grows, which a pasted spec does not.

## The backend does not have to be running

Every call is answered from the cached spec, never from the network. The fetch happens on startup and then in the background while you work, so an endpoint you added 20 seconds ago is already visible.

Start the backend once, shut it down, and keep building the frontend. The agent still has real routes and real payload shapes. If the service is down, or answers with something that is not a spec, the last known-good copy keeps being served.

## Worth knowing

- The spec must be **JSON**. YAML is not supported.
- `cacheDir` is required for `url` sources.
- A service on `localhost` over HTTPS works as-is. Development certificates are accepted there by default, and only there.

Code and issues: [github.com/jgauffin/dev-docs-mcp](https://github.com/jgauffin/dev-docs-mcp). On npm as `docs-mcpserver`.
