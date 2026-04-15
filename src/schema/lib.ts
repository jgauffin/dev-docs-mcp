import type { DocsSource } from "../source.js";
import type { IndexedSchema, SchemaFormat, SearchHit } from "./types.js";

// ─────────────────────────────────────────────────────────────────────────────
// Format detection
// ─────────────────────────────────────────────────────────────────────────────

export function detectFormat(parsed: Record<string, unknown>): SchemaFormat | null {
  if (typeof parsed.openapi === "string" && parsed.openapi.startsWith("3."))
    return "openapi-3";
  if (typeof parsed.swagger === "string" && parsed.swagger.startsWith("2."))
    return "swagger-2";
  // TypeDoc projects are handled by the API pipeline, not here.
  if (typeof parsed.schemaVersion === "string" && parsed.variant === "project")
    return null;
  // Heuristic: must look like a schema (has $schema, $defs, definitions, or type)
  if (
    parsed.$schema ||
    parsed.$defs ||
    parsed.definitions ||
    parsed.type ||
    parsed.properties
  ) {
    return "json-schema";
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Definition extraction
// ─────────────────────────────────────────────────────────────────────────────

function extractDefs(
  parsed: Record<string, unknown>,
  format: SchemaFormat,
): Map<string, Record<string, unknown>> {
  const defs = new Map<string, Record<string, unknown>>();

  let rawDefs: Record<string, Record<string, unknown>> | undefined;
  if (format === "openapi-3") {
    const components = parsed.components as Record<string, unknown> | undefined;
    rawDefs = components?.schemas as
      | Record<string, Record<string, unknown>>
      | undefined;
  } else {
    rawDefs =
      (parsed.$defs as Record<string, Record<string, unknown>> | undefined) ??
      (parsed.definitions as
        | Record<string, Record<string, unknown>>
        | undefined);
  }

  if (rawDefs && typeof rawDefs === "object") {
    for (const [name, def] of Object.entries(rawDefs)) {
      defs.set(name, def);
    }
  }

  const paths = parsed.paths as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (
    paths &&
    typeof paths === "object" &&
    (format === "openapi-3" || format === "swagger-2")
  ) {
    const httpMethods = [
      "get", "put", "post", "delete", "options", "head", "patch", "trace",
    ];
    for (const [path, pathItem] of Object.entries(paths)) {
      if (!pathItem || typeof pathItem !== "object") continue;
      for (const method of httpMethods) {
        const op = pathItem[method] as Record<string, unknown> | undefined;
        if (op && typeof op === "object") {
          defs.set(`${method.toUpperCase()} ${path}`, op);
        }
      }
    }
  }

  return defs;
}

function getMetadata(
  parsed: Record<string, unknown>,
  format: SchemaFormat,
): { title: string | undefined; description: string | undefined } {
  if (format === "openapi-3" || format === "swagger-2") {
    const info = parsed.info as Record<string, unknown> | undefined;
    return {
      title: info?.title as string | undefined,
      description: info?.description as string | undefined,
    };
  }
  return {
    title: parsed.title as string | undefined,
    description: parsed.description as string | undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Indexing
// ─────────────────────────────────────────────────────────────────────────────

function basename(filePath: string): string {
  const slash = filePath.lastIndexOf("/");
  const name = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  return name.endsWith(".json") ? name.slice(0, -5) : name;
}

/** Index all .json files from a DocsSource that match a JSON Schema / OpenAPI format. */
export async function indexSchemas(
  source: DocsSource,
): Promise<Map<string, IndexedSchema>> {
  const index = new Map<string, IndexedSchema>();
  const files = await source.listFiles("**/*.json");

  for (const file of files) {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(await source.readFile(file));
    } catch {
      console.error(`[schema] Skipping invalid JSON: ${file}`);
      continue;
    }

    const format = detectFormat(parsed);
    if (!format) continue;

    const { title, description } = getMetadata(parsed, format);
    const definitions = extractDefs(parsed, format);
    const name = basename(file);
    index.set(name, { filename: file, format, title, description, definitions });
  }

  return index;
}

// ─────────────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a matcher from a search expression.
 *  - `|` separates OR alternatives
 *  - `*` and `?` are glob wildcards (anchored)
 *  - Otherwise plain substring match (case-insensitive)
 */
export function buildMatcher(expr: string): (text: string) => boolean {
  const terms = expr.split("|").map((t) => t.trim()).filter(Boolean);

  const matchers = terms.map((term) => {
    if (term.includes("*") || term.includes("?")) {
      const escaped = term.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      const pattern = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
      const re = new RegExp(`^${pattern}$`, "i");
      return (text: string) => re.test(text);
    }
    const lk = term.toLowerCase();
    return (text: string) => text.toLowerCase().includes(lk);
  });

  return (text: string) => matchers.some((m) => m(text));
}

export function matchesKeyword(obj: unknown, keyword: string): boolean;
export function matchesKeyword(obj: unknown, matcher: (t: string) => boolean): boolean;
export function matchesKeyword(
  obj: unknown,
  keywordOrMatcher: string | ((t: string) => boolean),
): boolean {
  const match =
    typeof keywordOrMatcher === "function"
      ? keywordOrMatcher
      : buildMatcher(keywordOrMatcher);
  return matchesDeep(obj, match);
}

function matchesDeep(obj: unknown, match: (t: string) => boolean): boolean {
  if (typeof obj === "string") return match(obj);
  if (Array.isArray(obj)) return obj.some((v) => matchesDeep(v, match));
  if (obj && typeof obj === "object") {
    return Object.entries(obj).some(
      ([k, v]) => match(k) || matchesDeep(v, match),
    );
  }
  return false;
}

export function searchInSchema(
  schema: IndexedSchema,
  schemaName: string,
  keyword: string,
): SearchHit[] {
  const match = buildMatcher(keyword);
  const hits: SearchHit[] = [];
  for (const [defName, defSchema] of schema.definitions) {
    if (match(defName) || matchesDeep(defSchema, match)) {
      hits.push({ schema: schemaName, definition: defName });
    }
  }
  return hits;
}
