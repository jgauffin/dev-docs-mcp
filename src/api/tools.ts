import type { Tool } from "@modelcontextprotocol/sdk/types.js";

export const API_TOOLS: Tool[] = [
  {
    name: "get_api_index",
    description:
      "Returns the API documentation index: all namespaces and types with summaries and member counts. Use get_api_type to drill into a specific type.",
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
    },
  },
  {
    name: "get_api_type",
    description:
      "Returns full documentation for an API type (class, interface, enum, etc.) including all members with their signatures and summaries. Supports partial name matching.",
    inputSchema: {
      type: "object",
      properties: {
        type_name: {
          type: "string",
          description:
            "Type name to look up. Can be short name (e.g., 'User'), full name (e.g., 'MyLib.Models.User'), or partial match.",
        },
      },
      required: ["type_name"],
    },
  },
  {
    name: "get_api_member",
    description:
      "Returns detailed documentation for a specific member of a type, including parameters, return type, exceptions, and examples.",
    inputSchema: {
      type: "object",
      properties: {
        type_name: {
          type: "string",
          description: "The type that contains the member.",
        },
        member_name: {
          type: "string",
          description:
            "The member name to look up (e.g., 'GetById', 'Name', 'constructor').",
        },
      },
      required: ["type_name", "member_name"],
    },
  },
  {
    name: "search_api",
    description:
      "Search API documentation using regex (case insensitive). Searches across type names, member names, signatures, and summaries.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Regex pattern to search for (case insensitive).",
        },
      },
      required: ["query"],
    },
  },
];
