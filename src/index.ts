import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import {
  handleGetDocIndex,
  handleGetSubIndex,
  handleReadDocFile,
  handleGetFileToc,
  handleGetChapters,
  handleSearchDocs,
} from "./markdown/handlers.js";
import { MARKDOWN_TOOLS } from "./markdown/tools.js";
import {
  ApiDocIndex,
  handleGetApiIndex,
  handleGetApiType,
  handleGetApiMember,
  handleSearchApi,
  textResult,
} from "./api/handlers.js";
import { API_TOOLS } from "./api/tools.js";
import { XmlDocParser } from "./api/parsers/xmldoc-parser.js";
import { TypeDocParser } from "./api/parsers/typedoc-parser.js";
import type { ApiDocParser } from "./api/types.js";
import { createSource } from "./source.js";

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  let docsFolder: string | undefined;
  let apiFolder: string | undefined;
  let name: string | undefined;
  let description: string | undefined;
  let cacheDir: string | undefined;
  let updateInterval: number | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--name" && i + 1 < args.length) {
      name = args[++i];
    } else if (arg === "--description" && i + 1 < args.length) {
      description = args[++i];
    } else if (arg === "--cache-dir" && i + 1 < args.length) {
      cacheDir = args[++i];
    } else if (arg === "--update-interval" && i + 1 < args.length) {
      updateInterval = parseInt(args[++i]!, 10);
    } else if (arg === "--api" && i + 1 < args.length) {
      apiFolder = args[++i];
    } else if (!arg.startsWith("--")) {
      docsFolder = arg;
    }
  }

  return { docsFolder, apiFolder, name, description, cacheDir, updateInterval };
}

const { docsFolder, apiFolder, name, description, cacheDir, updateInterval } = parseArgs(process.argv);
if (!docsFolder && !apiFolder) {
  console.error(
    "Usage: markdown-mcp [<docs-folder>] [--api <api-folder>] [--name <name>] [--description <text>] [--cache-dir <path>] [--update-interval <minutes>]"
  );
  process.exit(1);
}

const updateIntervalMs = updateInterval ? updateInterval * 60_000 : undefined;
const SERVER_NAME = name ?? "markdown-mcp";

// ─────────────────────────────────────────────────────────────────────────────
// Source setup
// ─────────────────────────────────────────────────────────────────────────────

const mdSource = docsFolder ? createSource(docsFolder, cacheDir, updateIntervalMs) : null;
const apiSource = apiFolder ? createSource(apiFolder, cacheDir, updateIntervalMs) : null;

// Auto-detect API doc format and create index
let apiIndex: ApiDocIndex | null = null;
if (apiSource) {
  const parsers: ApiDocParser[] = [new XmlDocParser(), new TypeDocParser()];
  apiIndex = new ApiDocIndex(apiSource, parsers);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Definitions
// ─────────────────────────────────────────────────────────────────────────────

const TOOLS: Tool[] = [];
if (mdSource) TOOLS.push(...MARKDOWN_TOOLS);
if (apiIndex) TOOLS.push(...API_TOOLS);

// ─────────────────────────────────────────────────────────────────────────────
// Server Setup
// ─────────────────────────────────────────────────────────────────────────────

const mcpServer = new McpServer(
  { name: SERVER_NAME, version: "1.0.0", description },
  { capabilities: { tools: {} } }
);

mcpServer.server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS,
}));

mcpServer.server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  // Markdown tools
  if (mdSource) {
    switch (name) {
      case "get_doc_index":
        return handleGetDocIndex(mdSource);
      case "get_sub_index":
        return handleGetSubIndex(args as { path: string }, mdSource);
      case "read_doc_file":
        return handleReadDocFile(args as { file_path: string }, mdSource);
      case "get_file_toc":
        return handleGetFileToc(
          args as { file_path: string; include_abstracts?: boolean },
          mdSource
        );
      case "get_chapters":
        return handleGetChapters(
          args as { file_path: string; headings: string[] },
          mdSource
        );
      case "search_docs":
        return handleSearchDocs(
          args as { query: string; path_pattern?: string },
          mdSource
        );
    }
  }

  // API tools
  if (apiIndex) {
    switch (name) {
      case "get_api_index":
        return handleGetApiIndex(apiIndex);
      case "get_api_type":
        return handleGetApiType(args as { type_name: string }, apiIndex);
      case "get_api_member":
        return handleGetApiMember(
          args as { type_name: string; member_name: string },
          apiIndex
        );
      case "search_api":
        return handleSearchApi(args as { query: string }, apiIndex);
    }
  }

  return textResult(`Unknown tool: ${name}`, true);
});

const transport = new StdioServerTransport();
await mcpServer.connect(transport);
console.error(`${SERVER_NAME} MCP Server running on stdio`);
