import type { DocsSource } from "../source.js";
import { indexSchemas, searchInSchema } from "./lib.js";
import type { IndexedSchema, SearchHit } from "./types.js";
import { textResult, type ToolResult } from "../api/handlers.js";

// ─────────────────────────────────────────────────────────────────────────────
// SchemaIndex — lazy cached index backed by a DocsSource
// ─────────────────────────────────────────────────────────────────────────────

export class SchemaIndex {
  private cache: Map<string, IndexedSchema> | null = null;

  constructor(private readonly source: DocsSource) {}

  async get(): Promise<Map<string, IndexedSchema>> {
    if (this.cache) return this.cache;
    console.error(`[schema-index] Building schema index...`);
    this.cache = await indexSchemas(this.source);
    console.error(`[schema-index] Indexed ${this.cache.size} schemas`);
    return this.cache;
  }
}

function ok(data: unknown): ToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    isError: false,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

export async function handleListSchemas(index: SchemaIndex): Promise<ToolResult> {
  const schemas = await index.get();
  const items = [...schemas.entries()].map(([name, s]) => ({
    name,
    filename: s.filename,
    format: s.format,
    title: s.title ?? null,
    description: s.description ?? null,
    definitionCount: s.definitions.size,
  }));
  return ok(items);
}

export async function handleListDefinitions(
  args: { schema?: string },
  index: SchemaIndex,
): Promise<ToolResult> {
  if (!args.schema) return textResult("error: schema is required.", true);
  const schemas = await index.get();
  const s = schemas.get(args.schema);
  if (!s) return textResult(`error: Schema "${args.schema}" not found`, true);
  const defs = [...s.definitions.entries()].map(([name, def]) => ({
    name,
    title: (def.title as string) ?? null,
    description: (def.description as string) ?? null,
  }));
  return ok(defs);
}

export async function handleGetDefinition(
  args: { schema?: string; definition?: string },
  index: SchemaIndex,
): Promise<ToolResult> {
  if (!args.schema) return textResult("error: schema is required.", true);
  if (!args.definition) return textResult("error: definition is required.", true);
  const schemas = await index.get();
  const s = schemas.get(args.schema);
  if (!s) return textResult(`error: Schema "${args.schema}" not found`, true);
  const def = s.definitions.get(args.definition);
  if (!def) return textResult(`error: Definition "${args.definition}" not found in "${args.schema}"`, true);
  return ok(def);
}

export async function handleSearchDefinitions(
  args: { schema?: string; keyword?: string },
  index: SchemaIndex,
): Promise<ToolResult> {
  if (!args.schema) return textResult("error: schema is required.", true);
  if (!args.keyword) return textResult("error: keyword is required.", true);
  const schemas = await index.get();
  const s = schemas.get(args.schema);
  if (!s) return textResult(`error: Schema "${args.schema}" not found`, true);
  return ok(searchInSchema(s, args.schema, args.keyword));
}

export async function handleSearchAllSchemas(
  args: { keyword?: string },
  index: SchemaIndex,
): Promise<ToolResult> {
  if (!args.keyword) return textResult("error: keyword is required.", true);
  const schemas = await index.get();
  const hits: SearchHit[] = [];
  for (const [name, s] of schemas) {
    hits.push(...searchInSchema(s, name, args.keyword));
  }
  return ok(hits);
}
