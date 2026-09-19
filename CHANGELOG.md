# Changelog

Notable changes per release. Details are in [docs/](docs/) and in `git log`.

## 1.2.0 - 2026-09-19

### Added

- The agent is told when a spec fetched from a service may be stale. While the service does not answer, every schema tool appends a warning after its JSON answer naming the origin, when the served copy was fetched and why the last fetch failed. `list_libraries` now lists each library's sources with their origin, and `fetchedAt` / `problem` for a `url` source.
- `freshness()` on `DocsSource`, implemented by sources that serve a fetched copy.

## 1.1.0 - 2026-08-30

### Changed

- The JSON data tools now work with no configuration, rooted at the directory the server was started in. A library with `kind: "data"` still overrides that root. `list_data_files` skips `node_modules`, `dist` and similar, and caps its listing.
- Starting with no libraries configured no longer exits with a usage error. The server runs and serves the JSON data tools.

## 1.0.0 - 2026-08-20

First tagged release. Markdown docs, API reference, JSON Schema / OpenAPI and JSON data, from local folders or GitHub, hosted as one or many libraries.

### Added

- Source kind `data` for JSON and JSONL data files, with tools `list_data_files`, `json_schema`, `json_query`, `json_stat` and `json_diff`. Files are read as streams and every response is capped, so a file far too large to return can still be summarised, filtered and aggregated. See [docs/tools.md](docs/tools.md).
- `openStream` and `statFile` on disk-backed sources, which read past the size limit `readFile` enforces.
