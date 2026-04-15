import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const SCHEMA_TOOLS: Tool[] = [
  {
    name: "list_schemas",
    description:
      "List all indexed JSON Schema / OpenAPI files with their format, titles, and definition counts.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "list_definitions",
    description:
      "List all definition names in a schema. For OpenAPI specs this includes both component schemas and path operations (e.g. \"GET /pets\").",
    inputSchema: {
      type: "object",
      properties: {
        schema: {
          type: "string",
          description: "Schema name (filename without .json)",
        },
      },
      required: ["schema"],
    },
  },
  {
    name: "get_definition",
    description:
      "Get the full JSON schema of a specific definition or OpenAPI operation.",
    inputSchema: {
      type: "object",
      properties: {
        schema: { type: "string", description: "Schema name (filename without .json)" },
        definition: { type: "string", description: "Definition name" },
      },
      required: ["schema", "definition"],
    },
  },
  {
    name: "search_definitions",
    description:
      "Search definitions by keyword within a specific schema. Supports glob patterns (* and ?) and pipe (|) as OR separator, e.g. \"GET*|POST*\" or \"user|account\".",
    inputSchema: {
      type: "object",
      properties: {
        schema: { type: "string", description: "Schema name (filename without .json)" },
        keyword: {
          type: "string",
          description: "Search expression: plain keyword, glob pattern (* ?), or pipe-separated alternatives",
        },
      },
      required: ["schema", "keyword"],
    },
  },
  {
    name: "search_all_schemas",
    description:
      "Search definitions by keyword across all schemas. Supports glob patterns (* and ?) and pipe (|) as OR separator.",
    inputSchema: {
      type: "object",
      properties: {
        keyword: {
          type: "string",
          description: "Search expression: plain keyword, glob pattern (* ?), or pipe-separated alternatives",
        },
      },
      required: ["keyword"],
    },
  },
];
