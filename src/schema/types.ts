// ─────────────────────────────────────────────────────────────────────────────
// JSON Schema / OpenAPI index model
// TypeDoc is intentionally not handled here — route TypeDoc files through the
// API pipeline (kind: "api") which has a richer namespace/type/member model.
// ─────────────────────────────────────────────────────────────────────────────

export type SchemaFormat = "json-schema" | "openapi-3" | "swagger-2";

export interface IndexedSchema {
  filename: string;
  format: SchemaFormat;
  title: string | undefined;
  description: string | undefined;
  definitions: Map<string, Record<string, unknown>>;
}

export interface SearchHit {
  schema: string;
  definition: string;
}
