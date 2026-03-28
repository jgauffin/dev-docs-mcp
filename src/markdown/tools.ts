import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const MARKDOWN_TOOLS: Tool[] = [
  {
    name: "get_doc_index",
    description:
      "Returns the top-level documentation index: root files and folder summaries with document counts. Use get_sub_index to drill into a specific folder.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_sub_index",
    description:
      "Returns the documentation index for a specific folder/section. Lists files with titles and abstracts within that folder.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Folder path to list (e.g., 'opcodes', 'tutorials', 'headers')",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "read_doc_file",
    description: "Reads the full content of a documentation file.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description:
            "Relative path to the doc file (e.g., 'components/button.md')",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "get_file_toc",
    description:
      "Returns the Table of Contents (headings) of a file. Use this for large docs to find specific sections before reading them with get_chapters.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file",
        },
        include_abstracts: {
          type: "boolean",
          description:
            "Include the first paragraph after each heading as an abstract (default: false)",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "get_chapters",
    description:
      "Returns the content of specific chapters (sections) from a doc file. Use after get_file_toc to read selected sections.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: {
          type: "string",
          description: "Path to the file",
        },
        headings: {
          type: "array",
          items: { type: "string" },
          description:
            "List of heading names to extract (e.g., ['Authentication', 'Error Handling'])",
        },
      },
      required: ["file_path", "headings"],
    },
  },
  {
    name: "search_docs",
    description:
      "Search documentation using regex (case insensitive). Can be scoped using glob patterns.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Regex pattern to search for (case insensitive). Use '|' to search multiple terms (e.g. 'router.*link|anchor|r-a') — results are grouped per term. All results are returned in YAML format.",
        },
        path_pattern: {
          type: "string",
          description:
            "Glob pattern to filter files (e.g., 'api/**', 'components/*.md'). Use '|' for OR (e.g., 'api/|components/'). Defaults to '**/*.md'",
        },
      },
      required: ["query"],
    },
  },
];
