# Changelog

Notable changes per release. Details are in [docs/](docs/) and in `git log`.

## Unreleased

### Changed

- The JSON data tools now work with no configuration, rooted at the directory the server was started in. A library with `kind: "data"` still overrides that root. `list_data_files` skips `node_modules`, `dist` and similar, and caps its listing.
- Starting with no libraries configured no longer exits with a usage error. The server runs and serves the JSON data tools.

## 1.0.0 - 2026-08-20

First tagged release. Markdown docs, API reference, JSON Schema / OpenAPI and JSON data, from local folders or GitHub, hosted as one or many libraries.

### Added

- Source kind `data` for JSON and JSONL data files, with tools `list_data_files`, `json_schema`, `json_query`, `json_stat` and `json_diff`. Files are read as streams and every response is capped, so a file far too large to return can still be summarised, filtered and aggregated. See [docs/tools.md](docs/tools.md).
- `openStream` and `statFile` on disk-backed sources, which read past the size limit `readFile` enforces.
