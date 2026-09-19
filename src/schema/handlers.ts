import type { DocsSource } from "../source.js";
import { indexSchemas, searchInSchema, SCHEMA_FILE_PATTERN } from "./lib.js";
import type { IndexedSchema, SearchHit } from "./types.js";
import { textResult, type ToolResult } from "../api/handlers.js";

// ─────────────────────────────────────────────────────────────────────────────
// SchemaIndex — lazy cached index backed by a DocsSource
// ─────────────────────────────────────────────────────────────────────────────

export class SchemaIndex {
  private cache: Map<string, IndexedSchema> | null = null;
  private stamp: string | null = null;

  constructor(private readonly source: DocsSource) {}

  async get(): Promise<Map<string, IndexedSchema>> {
    const stamp = await this.source.getChangeStamp(SCHEMA_FILE_PATTERN);
    if (this.cache && stamp === this.stamp) return this.cache;

    console.error(
      this.cache
        ? `[schema-index] Schemas changed, rebuilding index...`
        : `[schema-index] Building schema index...`,
    );
    this.cache = await indexSchemas(this.source);
    this.stamp = stamp;
    console.error(`[schema-index] Indexed ${this.cache.size} schemas`);
    return this.cache;
  }

  /**
   * A warning for the agent when the schemas it is reading may not match
   * their origin, null when they are current or come straight from disk.
   */
  async staleness(): Promise<string | null> {
    if (!this.source.freshness) return null;
    const { origin, fetchedAt, problem } = await this.source.freshness();
    if (!problem) return null;

    if (!fetchedAt) {
      return `warning: no spec has been fetched from ${origin} yet: ${problem}. Nothing can be answered until the service is reachable.`;
    }
    return (
      `warning: these schemas are a cached copy of ${origin} fetched ${fetchedAt.toISOString()}. ` +
      `The service has not answered since: ${problem}. The origin may have changed.`
    );
  }
}

/**
 * The answer as JSON, followed by a warning when the schemas may be stale.
 * The warning is a separate block so the JSON stays parseable on its own.
 */
async function ok(data: unknown, index: SchemaIndex): Promise<ToolResult> {
  const content: ToolResult["content"] = [{ type: "text", text: JSON.stringify(data, null, 2) }];
  const staleness = await index.staleness();
  if (staleness) content.push({ type: "text", text: staleness });
  return { content, isError: false };
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
  return ok(items, index);
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
  return ok(defs, index);
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
  return ok(def, index);
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
  return ok(searchInSchema(s, args.schema, args.keyword), index);
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
  return ok(hits, index);
}
