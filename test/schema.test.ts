import { describe, it, expect } from "vitest";
import path from "path";
import {
  detectFormat,
  indexSchemas,
  searchInSchema,
  buildMatcher,
  matchesKeyword,
} from "../src/schema/lib.js";
import {
  SchemaIndex,
  handleListSchemas,
  handleListDefinitions,
  handleGetDefinition,
  handleSearchDefinitions,
  handleSearchAllSchemas,
} from "../src/schema/handlers.js";
import { FileSystemSource } from "../src/source.js";

const FIXTURES = path.resolve(import.meta.dirname, "fixtures-schema");
const source = new FileSystemSource(FIXTURES);

// ─────────────────────────────────────────────────────────────────────────────
// detectFormat
// ─────────────────────────────────────────────────────────────────────────────

describe("detectFormat", () => {
  it("detects OpenAPI 3.x", () => {
    expect(detectFormat({ openapi: "3.0.3" })).toBe("openapi-3");
    expect(detectFormat({ openapi: "3.1.0" })).toBe("openapi-3");
  });

  it("detects Swagger 2.0", () => {
    expect(detectFormat({ swagger: "2.0" })).toBe("swagger-2");
  });

  it("detects JSON Schema via $defs", () => {
    expect(detectFormat({ $defs: {} })).toBe("json-schema");
  });

  it("detects JSON Schema via definitions", () => {
    expect(detectFormat({ definitions: {} })).toBe("json-schema");
  });

  it("detects JSON Schema via type/properties", () => {
    expect(detectFormat({ type: "object" })).toBe("json-schema");
  });

  it("returns null for TypeDoc (handled by API pipeline)", () => {
    expect(detectFormat({ schemaVersion: "2.0", variant: "project" })).toBeNull();
  });

  it("returns null for unrecognized objects", () => {
    expect(detectFormat({ foo: "bar" })).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// buildMatcher / matchesKeyword
// ─────────────────────────────────────────────────────────────────────────────

describe("buildMatcher", () => {
  it("plain keyword does substring match (case-insensitive)", () => {
    const m = buildMatcher("hello");
    expect(m("Hello World")).toBe(true);
    expect(m("goodbye")).toBe(false);
  });

  it("glob * matches any characters", () => {
    const m = buildMatcher("GET*");
    expect(m("GET /pets")).toBe(true);
    expect(m("POST /pets")).toBe(false);
  });

  it("glob ? matches single character", () => {
    const m = buildMatcher("Us?r");
    expect(m("User")).toBe(true);
    expect(m("Users")).toBe(false);
  });

  it("pipe separates alternatives", () => {
    const m = buildMatcher("user|order");
    expect(m("user")).toBe(true);
    expect(m("order")).toBe(true);
    expect(m("product")).toBe(false);
  });

  it("pipe + globs", () => {
    const m = buildMatcher("GET*|POST*");
    expect(m("GET /pets")).toBe(true);
    expect(m("POST /pets")).toBe(true);
    expect(m("DELETE /pets")).toBe(false);
  });
});

describe("matchesKeyword", () => {
  it("searches nested objects", () => {
    expect(matchesKeyword({ a: { b: "needle" } }, "needle")).toBe(true);
    expect(matchesKeyword({ a: { b: "hay" } }, "needle")).toBe(false);
  });

  it("searches arrays", () => {
    expect(matchesKeyword(["one", "two"], "two")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Indexing (JSON Schema fixtures)
// ─────────────────────────────────────────────────────────────────────────────

describe("indexSchemas — JSON Schema", () => {
  it("indexes both $defs and definitions", async () => {
    const schemas = await indexSchemas(source);
    expect(schemas.has("order")).toBe(true);
    expect(schemas.has("user")).toBe(true);
  });

  it("extracts $defs from order schema", async () => {
    const schemas = await indexSchemas(source);
    const order = schemas.get("order")!;
    expect(order.definitions.size).toBe(3);
    expect(order.definitions.has("Address")).toBe(true);
    expect(order.definitions.has("LineItem")).toBe(true);
    expect(order.definitions.has("Order")).toBe(true);
  });

  it("captures title and description", async () => {
    const schemas = await indexSchemas(source);
    const order = schemas.get("order")!;
    expect(order.title).toBe("Order Schema");
    expect(order.description).toBe("Schema for e-commerce orders");
  });

  it("sets format = json-schema", async () => {
    const schemas = await indexSchemas(source);
    expect(schemas.get("order")!.format).toBe("json-schema");
    expect(schemas.get("user")!.format).toBe("json-schema");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Indexing (OpenAPI fixtures)
// ─────────────────────────────────────────────────────────────────────────────

describe("indexSchemas — OpenAPI", () => {
  it("detects petstore as openapi-3", async () => {
    const schemas = await indexSchemas(source);
    expect(schemas.get("petstore")!.format).toBe("openapi-3");
  });

  it("extracts title and description from info", async () => {
    const schemas = await indexSchemas(source);
    const p = schemas.get("petstore")!;
    expect(p.title).toBe("Petstore API");
    expect(p.description).toBe("A sample pet store API");
  });

  it("extracts component schemas and path operations", async () => {
    const schemas = await indexSchemas(source);
    const p = schemas.get("petstore")!;
    expect(p.definitions.has("Pet")).toBe(true);
    expect(p.definitions.has("Error")).toBe(true);
    expect(p.definitions.has("GET /pets")).toBe(true);
    expect(p.definitions.has("POST /pets")).toBe(true);
    expect(p.definitions.has("GET /pets/{petId}")).toBe(true);
    expect(p.definitions.size).toBe(5);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────────────

describe("searchInSchema", () => {
  it("finds definitions by name", async () => {
    const schemas = await indexSchemas(source);
    const hits = searchInSchema(schemas.get("order")!, "order", "address");
    const names = hits.map((h) => h.definition);
    expect(names).toContain("Address");
    expect(names).toContain("Order");
  });

  it("finds with glob on operation names", async () => {
    const schemas = await indexSchemas(source);
    const hits = searchInSchema(schemas.get("petstore")!, "petstore", "GET*");
    const names = hits.map((h) => h.definition);
    expect(names).toContain("GET /pets");
    expect(names).toContain("GET /pets/{petId}");
    expect(names).not.toContain("POST /pets");
  });

  it("pipe-separated alternatives", async () => {
    const schemas = await indexSchemas(source);
    const hits = searchInSchema(schemas.get("order")!, "order", "Address|LineItem");
    const names = hits.map((h) => h.definition);
    expect(names).toContain("Address");
    expect(names).toContain("LineItem");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Handlers
// ─────────────────────────────────────────────────────────────────────────────

describe("schema handlers", () => {
  const index = new SchemaIndex(source);

  it("handleListSchemas returns all schemas", async () => {
    const r = await handleListSchemas(index);
    expect(r.isError).toBeFalsy();
    const items = JSON.parse(r.content[0]!.text) as Array<{ name: string; format: string }>;
    const names = items.map((s) => s.name).sort();
    expect(names).toEqual(["order", "petstore", "user"]);
  });

  it("handleListDefinitions returns names/titles", async () => {
    const r = await handleListDefinitions({ schema: "order" }, index);
    expect(r.isError).toBeFalsy();
    const defs = JSON.parse(r.content[0]!.text) as Array<{ name: string }>;
    expect(defs.map((d) => d.name).sort()).toEqual(["Address", "LineItem", "Order"]);
  });

  it("handleGetDefinition returns full schema", async () => {
    const r = await handleGetDefinition({ schema: "order", definition: "LineItem" }, index);
    expect(r.isError).toBeFalsy();
    const def = JSON.parse(r.content[0]!.text) as Record<string, unknown>;
    expect(def.type).toBe("object");
  });

  it("handleGetDefinition errors on missing definition", async () => {
    const r = await handleGetDefinition({ schema: "order", definition: "Nope" }, index);
    expect(r.isError).toBe(true);
  });

  it("handleSearchDefinitions finds within a schema", async () => {
    const r = await handleSearchDefinitions({ schema: "user", keyword: "email" }, index);
    const hits = JSON.parse(r.content[0]!.text) as Array<{ definition: string }>;
    expect(hits.map((h) => h.definition)).toContain("User");
  });

  it("handleSearchAllSchemas finds across all schemas", async () => {
    const r = await handleSearchAllSchemas({ keyword: "address" }, index);
    const hits = JSON.parse(r.content[0]!.text) as Array<{ schema: string }>;
    const schemas = [...new Set(hits.map((h) => h.schema))].sort();
    expect(schemas).toContain("order");
    expect(schemas).toContain("user");
  });

  it("errors on unknown schema", async () => {
    const r = await handleListDefinitions({ schema: "nope" }, index);
    expect(r.isError).toBe(true);
  });
});
