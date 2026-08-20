import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const EXPRESSION_HELP = `Expression syntax:
  Path:       $.orders[*]            leading path, matched while the file streams. [*] is any element.
  select:     | select(.total > 100 and .status == "open")
              operators: == != > >= < <= contains startswith endswith exists missing, joined by and / or / not.
  projection: | {id, total, name: .customer.name}
  other:      | keys   | values   | length
A JSONL file behaves exactly like a top-level array, so $[*] is its records.`;

export const DATA_TOOLS: Tool[] = [
  {
    name: "list_data_files",
    description:
      "List the JSON and JSONL files available to the data tools, with their format and size in bytes. Start here when you do not know what the data root holds.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "json_schema",
    description:
      "Summarise the structure of a JSON or JSONL file: key names, value types, array lengths and nesting. Returns no data values unless sample is 1, and never returns the file itself, so it is safe against files far too large to read. This is the call to make first against an unfamiliar file.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to a .json, .jsonl or .ndjson file, relative to the data root" },
        depth: {
          type: "number",
          description: "Levels of nesting to describe, 1-12 (default 3). Deeper levels are marked as truncated.",
        },
        sample: {
          type: "number",
          description: "1 (default) includes one short example value per leaf; 0 returns structure only.",
        },
      },
      required: ["file"],
    },
  },
  {
    name: "json_query",
    description:
      `Return the values a query expression selects, with an explicit cap on how many. The response always reports the true number of matches next to the number returned, and clipped strings carry their real length, so a partial answer can never be mistaken for a complete one.\n\n${EXPRESSION_HELP}`,
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to a .json, .jsonl or .ndjson file, relative to the data root" },
        expr: {
          type: "string",
          description: 'Query expression, e.g. \'$.orders[*] | select(.total > 100) | {id, total}\'',
        },
        limit: { type: "number", description: "Maximum rows to return, 1-500 (default 50)" },
        max_string: {
          type: "number",
          description: "Characters of each string to return, 20-4000 (default 200). Longer strings report their true length.",
        },
      },
      required: ["file", "expr"],
    },
  },
  {
    name: "json_stat",
    description:
      `Aggregate over a selection without returning any of the rows: count, sum, min, max, mean and median, optionally grouped. Use this whenever the answer is a number rather than the data behind it.\n\n${EXPRESSION_HELP}`,
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to a .json, .jsonl or .ndjson file, relative to the data root" },
        expr: { type: "string", description: 'Expression selecting the items to aggregate, e.g. \'$.orders[*]\'' },
        value: {
          type: "string",
          description:
            'Path within each selected item holding the number to aggregate, e.g. ".total". Omit to aggregate the selected values themselves.',
        },
        group_by: {
          type: "string",
          description: 'Path within each selected item to group by, e.g. ".status". Omit for a single summary.',
        },
      },
      required: ["file", "expr"],
    },
  },
  {
    name: "json_diff",
    description:
      `Compare the same selection in two files and report only what differs: items only in the first, items only in the second, and the specific fields that changed. Give a key path to align items by identity rather than by position.\n\n${EXPRESSION_HELP}`,
    inputSchema: {
      type: "object",
      properties: {
        file_a: { type: "string", description: "Baseline file, relative to the data root" },
        file_b: { type: "string", description: "Candidate file, relative to the data root" },
        expr: { type: "string", description: 'Expression selecting the items to compare, e.g. \'$.orders[*]\'' },
        key: {
          type: "string",
          description: 'Path identifying each item, e.g. ".id". Omit to align by position.',
        },
        limit: { type: "number", description: "Maximum items to list per section, 1-200 (default 50)" },
      },
      required: ["file_a", "file_b", "expr"],
    },
  },
];
