import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { StringDecoder } from "string_decoder";
import { FileSystemSource } from "../src/source.js";
import { JsonTokenizer, JsonSyntaxError, LongString, formatPath } from "../src/data/scanner.js";
import { ValueBuilder, detectFormat, selectItems } from "../src/data/loader.js";
import type { DataFile } from "../src/data/loader.js";
import { ExpressionError, applyStages, parseExpression, parsePath } from "../src/data/expr.js";
import { ShapeBuilder } from "../src/data/shape.js";
import { MAX_RESPONSE_BYTES, clipStrings, fitRows } from "../src/data/output.js";
import {
  DataRoot,
  handleJsonDiff,
  handleJsonQuery,
  handleJsonSchema,
  handleJsonStat,
  handleListDataFiles,
} from "../src/data/handlers.js";
import type { ToolResult } from "../src/api/handlers.js";

const FIXTURES = path.resolve(import.meta.dirname, "fixtures-data");
const root = new DataRoot(new FileSystemSource(FIXTURES), FIXTURES);

function fixtureText(name: string): string {
  return readFileSync(path.join(FIXTURES, name), "utf-8");
}

function payload(result: ToolResult): any {
  expect(result.isError, result.content[0]?.text).toBe(false);
  return JSON.parse(result.content[0]!.text);
}

function errorText(result: ToolResult): string {
  expect(result.isError).toBe(true);
  return result.content[0]!.text;
}

/** Run text through the tokenizer in the given chunks and rebuild the value. */
function tokenizeToValue(chunks: string[]): unknown {
  const builder = new ValueBuilder("inline");
  const tokenizer = new JsonTokenizer({ onToken: (token) => builder.add(token) });
  for (const chunk of chunks) tokenizer.write(chunk);
  tokenizer.end();
  return builder.value;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tokenizer
// ─────────────────────────────────────────────────────────────────────────────

describe("scanner", () => {
  it("produces the same value regardless of where the input is split", () => {
    for (const fixture of ["orders.json", "tricky.json", "many.json"]) {
      const text = fixtureText(fixture);
      const expected = JSON.parse(text);

      for (let split = 0; split <= text.length; split++) {
        const value = tokenizeToValue([text.slice(0, split), text.slice(split)]);
        expect(value, `${fixture} split at ${split}`).toEqual(expected);
      }
    }
  });

  it("survives a multi-byte character split across stream chunks", () => {
    const bytes = readFileSync(path.join(FIXTURES, "tricky.json"));
    const expected = JSON.parse(bytes.toString("utf-8"));

    for (let split = 0; split <= bytes.length; split++) {
      const decoder = new StringDecoder("utf8");
      const first = decoder.write(bytes.subarray(0, split));
      const second = decoder.write(bytes.subarray(split)) + decoder.end();
      expect(tokenizeToValue([first, second]), `byte split at ${split}`).toEqual(expected);
    }
  });

  it("reads a value that arrives one character at a time", () => {
    const text = fixtureText("orders.json");
    expect(tokenizeToValue([...text])).toEqual(JSON.parse(text));
  });

  it("clips a huge string but reports its true length", () => {
    const text = `{"s":"${"x".repeat(70_000)}"}`;
    const value = tokenizeToValue([text]) as { s: LongString };

    expect(value.s).toBeInstanceOf(LongString);
    expect(value.s.totalLength).toBe(70_000);
    expect(value.s.text.length).toBe(64 * 1024);
  });

  it("names the character and the path when the document is malformed", () => {
    expect(() => tokenizeToValue([`{"orders":[{"id":1,}]}`])).toThrowError(JsonSyntaxError);

    try {
      tokenizeToValue([`{"a":{"b":tru}}`]);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect((err as JsonSyntaxError).jsonPath).toBe("$.a.b");
      expect((err as JsonSyntaxError).message).toContain("character");
    }
  });

  it("rejects an unfinished document rather than returning half of it", () => {
    expect(() => tokenizeToValue([`{"a":[1,2`])).toThrowError(/unexpected end of input/);
    expect(() => tokenizeToValue([""])).toThrowError(/empty/);
  });

  it("rejects trailing content after the document", () => {
    expect(() => tokenizeToValue([`{} {}`])).toThrowError(JsonSyntaxError);
  });

  it("formats paths the way a caller would write them", () => {
    expect(formatPath(["orders", 3, "customer", "name"])).toBe("$.orders[3].customer.name");
    expect(formatPath(["key with spaces"])).toBe('$["key with spaces"]');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Expressions
// ─────────────────────────────────────────────────────────────────────────────

describe("expressions", () => {
  it("splits a path into streamable steps", () => {
    expect(parseExpression("$.orders[*].lines[0]").path).toEqual([
      { kind: "key", name: "orders" },
      { kind: "wildcard" },
      { kind: "key", name: "lines" },
      { kind: "index", index: 0 },
    ]);
  });

  it("points at the character that broke the expression", () => {
    try {
      parseExpression("$.orders[*] | select(.total > )");
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ExpressionError);
      expect((err as ExpressionError).offset).toBe("$.orders[*] | select(.total > ".length);
      expect((err as ExpressionError).message).toContain("expected a value");
    }
  });

  it("rejects an unknown stage by name", () => {
    expect(() => parseExpression("$.a | sum")).toThrowError(/unknown stage "sum"/);
  });

  it("rejects a wildcard where nothing could stream it", () => {
    expect(() => parseExpression("$.a | select(.b[*] == 1)")).toThrowError(/only allowed in the leading path/);
  });

  const item = {
    id: "o-1",
    status: "open",
    total: 120.5,
    customer: { name: "Ada", city: "Stockholm" },
    tags: ["rush", "paid"],
  };

  function keep(expr: string, value: unknown = item): boolean {
    const parsed = parseExpression(expr);
    return applyStages(value, parsed.stages).kept;
  }

  it("compares numbers, strings and booleans", () => {
    expect(keep("$ | select(.total > 100)")).toBe(true);
    expect(keep("$ | select(.total > 900)")).toBe(false);
    expect(keep('$ | select(.status == "open")')).toBe(true);
    expect(keep('$ | select(.status != "open")')).toBe(false);
  });

  it("combines conditions with and, or and not", () => {
    expect(keep('$ | select(.total > 100 and .status == "open")')).toBe(true);
    expect(keep('$ | select(.total > 900 or .status == "open")')).toBe(true);
    expect(keep('$ | select(not .status == "open")')).toBe(false);
    expect(keep('$ | select((.total < 10 or .total > 100) and .customer.city == "Stockholm")')).toBe(true);
  });

  it("matches substrings and array membership", () => {
    expect(keep('$ | select(.customer.city contains "holm")')).toBe(true);
    expect(keep('$ | select(.id startswith "o-")')).toBe(true);
    expect(keep('$ | select(.id endswith "-9")')).toBe(false);
    expect(keep('$ | select(.tags contains "paid")')).toBe(true);
    expect(keep('$ | select(.tags contains "late")')).toBe(false);
  });

  it("separates a missing key from a stored null", () => {
    expect(keep("$ | select(.note missing)")).toBe(true);
    expect(keep("$ | select(.note exists)")).toBe(false);
    expect(keep("$ | select(.note == null)", { note: null })).toBe(true);
    expect(keep("$ | select(.note exists)", { note: null })).toBe(true);
  });

  it("does not order values across types", () => {
    expect(keep("$ | select(.status > 5)")).toBe(false);
    expect(keep("$ | select(.missing > 5)")).toBe(false);
  });

  it("projects named and nested fields", () => {
    const parsed = parseExpression("$ | {id, customer.name, city: .customer.city}");
    expect(applyStages(item, parsed.stages).value).toEqual({
      id: "o-1",
      "customer.name": "Ada",
      city: "Stockholm",
    });
  });

  it("reports a projected field that is absent as null", () => {
    const parsed = parseExpression("$ | {id, missing: .nope.deeper}");
    expect(applyStages(item, parsed.stages).value).toEqual({ id: "o-1", missing: null });
  });

  it("returns keys, values and length", () => {
    expect(applyStages(item, parseExpression("$ | keys").stages).value).toEqual([
      "id",
      "status",
      "total",
      "customer",
      "tags",
    ]);
    expect(applyStages(item.tags, parseExpression("$ | length").stages).value).toBe(2);
    expect(applyStages(item.id, parseExpression("$ | length").stages).value).toBe(3);
    expect(applyStages(item, parseExpression("$ | length").stages).value).toBe(5);
    expect(applyStages(item.customer, parseExpression("$ | values").stages).value).toEqual([
      "Ada",
      "Stockholm",
    ]);
  });

  it("reads a standalone path in either notation", () => {
    expect(parsePath(".customer.name", "value")).toEqual(parsePath("customer.name", "value"));
    expect(parsePath("$.customer.name", "value")).toEqual(parsePath(".customer.name", "value"));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Selection over a stream
// ─────────────────────────────────────────────────────────────────────────────

describe("selection", () => {
  function fileFor(name: string): DataFile {
    return {
      relativePath: name,
      format: detectFormat(name),
      open: () => new FileSystemSource(FIXTURES).openStream(name),
    };
  }

  async function select(name: string, expr: string): Promise<Array<{ path: string; value: unknown }>> {
    const parsed = parseExpression(expr);
    const found: Array<{ path: string; value: unknown }> = [];
    await selectItems(fileFor(name), parsed.path, (item) => {
      found.push({ path: formatPath(item.path), value: item.value });
    });
    return found;
  }

  it("selects every element of an array", async () => {
    const found = await select("orders.json", "$.orders[*]");
    expect(found).toHaveLength(5);
    expect(found[0]!.path).toBe("$.orders[0]");
    expect((found[0]!.value as { id: string }).id).toBe("o-1");
  });

  it("selects a leaf under a wildcard", async () => {
    const found = await select("orders.json", "$.orders[*].customer.name");
    expect(found.map((f) => f.value)).toEqual(["Ada", "Grace", "Linus", "Tove", "Nils"]);
  });

  it("selects a single element by index", async () => {
    const found = await select("orders.json", "$.orders[1].id");
    expect(found.map((f) => f.value)).toEqual(["o-2"]);
  });

  it("treats a JSONL file as a top-level array", async () => {
    const found = await select("events.jsonl", "$[*].level");
    expect(found.map((f) => f.value)).toEqual(["info", "error", "info", "error"]);
    expect(found[0]!.path).toBe("$[0].level");
  });

  it("names the line when a JSONL record is malformed", async () => {
    await expect(select("broken.jsonl", "$[*]")).rejects.toThrow(/broken\.jsonl: line 2 is not valid JSON/);
  });

  it("returns nothing when the path matches nothing", async () => {
    expect(await select("orders.json", "$.invoices[*]")).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Output caps
// ─────────────────────────────────────────────────────────────────────────────

describe("output caps", () => {
  it("clips a long string and states how long it really is", () => {
    expect(clipStrings({ s: "abcdefghij" }, 4)).toEqual({ s: "abcd...[len=10]" });
    expect(clipStrings(new LongString("abcd", 9000), 4)).toBe("abcd...[len=9000]");
  });

  it("keeps short strings untouched", () => {
    expect(clipStrings({ s: "abc", n: 1, b: null }, 200)).toEqual({ s: "abc", n: 1, b: null });
  });

  it("stops adding rows at the byte budget and counts the rest", () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ i, pad: "x".repeat(50) }));
    const fitted = fitRows(rows, 500);

    expect(fitted.kept.length).toBeLessThan(100);
    expect(fitted.kept.length + fitted.omitted).toBe(100);
  });

  it("keeps one row even when that row alone exceeds the budget", () => {
    const fitted = fitRows([{ pad: "x".repeat(5000) }, { pad: "y" }], 100);
    expect(fitted.kept).toHaveLength(1);
    expect(fitted.omitted).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// json_schema
// ─────────────────────────────────────────────────────────────────────────────

describe("json_schema", () => {
  it("describes structure without returning the data", async () => {
    const result = payload(await handleJsonSchema({ file: "orders.json", depth: 3 }, root));

    expect(result.shape.type).toBe("object");
    expect(result.shape.keys.orders.type).toBe("array");
    expect(result.shape.keys.orders.length).toBe(5);
    expect(result.shape.keys.orders.items.keys.id.type).toBe("string");
    expect(result.truncated).toBeNull();
  });

  it("reports a key missing from some records as optional", async () => {
    const result = payload(await handleJsonSchema({ file: "orders.json", depth: 3 }, root));
    const keys = result.shape.keys.orders.items.keys;

    expect(keys.note.optional).toBe(true);
    expect(keys.id.optional).toBeUndefined();
  });

  it("shows the union of types seen at one position", async () => {
    const result = payload(await handleJsonSchema({ file: "orders.json", depth: 3 }, root));
    expect(result.shape.keys.orders.items.keys.total.type).toBe("number|null");

    const many = payload(await handleJsonSchema({ file: "many.json", depth: 3 }, root));
    expect(many.shape.keys.mixed.items.type).toBe("number|string|null|boolean");
  });

  it("counts every array element while only sampling their shape", async () => {
    const result = payload(await handleJsonSchema({ file: "many.json", depth: 3 }, root));
    expect(result.shape.keys.values.length).toBe(30);
    expect(result.shape.keys.values.items_sampled).toBe(20);
  });

  it("counts a huge array without holding it", () => {
    const builder = new ShapeBuilder(3);
    const tokenizer = new JsonTokenizer({ onToken: (token) => builder.handle(token) });
    tokenizer.write("[");
    for (let i = 0; i < 50_000; i++) tokenizer.write(i === 0 ? "1" : ",1");
    tokenizer.write("]");
    tokenizer.end();

    const shape = builder.render(3, true) as { type: string; length: number };
    expect(shape.type).toBe("array");
    expect(shape.length).toBe(50_000);
  });

  it("marks where the depth limit cut the tree off", async () => {
    const result = payload(await handleJsonSchema({ file: "tricky.json", depth: 2 }, root));

    expect(result.shape.keys.deep.keys.a.truncated).toBe("depth");
    expect(result.shape.keys.deep.keys.a.keys).toBeUndefined();
    expect(result.shape.keys.unicode.truncated).toBeUndefined();
  });

  it("goes deeper when asked", async () => {
    const result = payload(await handleJsonSchema({ file: "tricky.json", depth: 6 }, root));

    expect(result.shape.keys.deep.keys.a.keys.b.keys.c.keys.d.keys.e.type).toBe("string");
    expect(result.shape.keys.deep.keys.a.truncated).toBeUndefined();
  });

  it("returns no example values when sample is 0", async () => {
    const withSamples = payload(await handleJsonSchema({ file: "orders.json", sample: 1 }, root));
    const without = payload(await handleJsonSchema({ file: "orders.json", sample: 0 }, root));

    expect(withSamples.shape.keys.generated.sample).toBe("2026-08-01T09:00:00Z");
    expect(without.shape.keys.generated.sample).toBeUndefined();
  });

  it("summarises a JSONL file as the array of records it behaves like", async () => {
    const result = payload(await handleJsonSchema({ file: "events.jsonl" }, root));
    expect(result.format).toBe("jsonl");
    expect(result.shape.type).toBe("array");
    expect(result.shape.length).toBe(4);
    expect(result.shape.items.keys.level.type).toBe("string");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// json_query
// ─────────────────────────────────────────────────────────────────────────────

describe("json_query", () => {
  it("returns the selected rows with their paths", async () => {
    const result = payload(
      await handleJsonQuery({ file: "orders.json", expr: '$.orders[*] | select(.status == "open") | {id, total}' }, root),
    );

    expect(result.matched).toBe(3);
    expect(result.returned).toBe(3);
    expect(result.rows.map((r: any) => r.value.id)).toEqual(["o-1", "o-3", "o-4"]);
    expect(result.rows[0].path).toBe("$.orders[0]");
    expect(result.truncated).toBeNull();
  });

  it("reports the true match count when the limit cuts the rows short", async () => {
    const result = payload(await handleJsonQuery({ file: "orders.json", expr: "$.orders[*]", limit: 2 }, root));

    expect(result.matched).toBe(5);
    expect(result.returned).toBe(2);
    expect(result.truncated).toEqual({ reason: "limit", rows_omitted: 3 });
  });

  it("clips long strings and reports their real length", async () => {
    const result = payload(
      await handleJsonQuery({ file: "orders.json", expr: "$.source", max_string: 20 }, root),
    );
    expect(result.rows[0].value).toBe('warehouse export "ni...[len=26]');
  });

  it("filters JSONL records", async () => {
    const result = payload(
      await handleJsonQuery({ file: "events.jsonl", expr: '$[*] | select(.level == "error") | {id, ms}' }, root),
    );
    expect(result.matched).toBe(2);
    expect(result.rows.map((r: any) => r.value.id)).toEqual([2, 4]);
  });

  it("says the expression is broken and where", async () => {
    const text = errorText(await handleJsonQuery({ file: "orders.json", expr: "$.orders[*] | select(.a" }, root));
    expect(text).toContain("error:");
    expect(text).toContain("character");
  });

  it("refuses a path outside the data root", async () => {
    const text = errorText(await handleJsonQuery({ file: "../../package.json", expr: "$" }, root));
    expect(text).toContain("../../package.json");
    expect(text).toContain("outside the data root");
  });

  it("names a file that is not there", async () => {
    const text = errorText(await handleJsonQuery({ file: "nope.json", expr: "$" }, root));
    expect(text).toContain("nope.json");
    expect(text).toContain("not found");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// json_stat
// ─────────────────────────────────────────────────────────────────────────────

describe("json_stat", () => {
  it("aggregates the selected values themselves", async () => {
    const result = payload(await handleJsonStat({ file: "many.json", expr: "$.values[*]" }, root));

    expect(result.stats.count).toBe(30);
    expect(result.stats.sum).toBe(465);
    expect(result.stats.min).toBe(1);
    expect(result.stats.max).toBe(30);
    expect(result.stats.mean).toBe(15.5);
    expect(result.stats.median).toBe(15.5);
    expect(result.stats.median_exact).toBe(true);
  });

  it("aggregates a field of each selected item", async () => {
    const result = payload(
      await handleJsonStat({ file: "orders.json", expr: "$.orders[*]", value: ".total" }, root),
    );

    expect(result.selected).toBe(5);
    expect(result.stats.count).toBe(4);
    expect(result.stats.sum).toBe(1120.5);
    expect(result.stats.nulls).toBe(1);
  });

  it("groups without ever returning the rows", async () => {
    const result = payload(
      await handleJsonStat(
        { file: "orders.json", expr: "$.orders[*]", value: ".total", group_by: ".status" },
        root,
      ),
    );

    expect(result.stats.open.count).toBe(2);
    expect(result.stats.open.sum).toBe(1020.5);
    expect(result.stats.open.nulls).toBe(1);
    expect(result.stats.closed.count).toBe(2);
    expect(result.stats.closed.sum).toBe(100);
    expect(result.stats.closed.mean).toBe(50);
  });

  it("counts values it cannot add rather than skewing the mean", async () => {
    const result = payload(await handleJsonStat({ file: "many.json", expr: "$.mixed[*]" }, root));

    expect(result.stats.count).toBe(1);
    expect(result.stats.sum).toBe(1);
    expect(result.stats.nulls).toBe(1);
    expect(result.stats.non_numeric).toBe(2);
    expect(result.stats.mean).toBe(1);
  });

  it("orders groups the same way on every call", async () => {
    const first = payload(
      await handleJsonStat({ file: "events.jsonl", expr: "$[*]", value: ".ms", group_by: ".level" }, root),
    );
    const second = payload(
      await handleJsonStat({ file: "events.jsonl", expr: "$[*]", value: ".ms", group_by: ".level" }, root),
    );

    expect(Object.keys(first.stats)).toEqual(Object.keys(second.stats));
    expect(Object.keys(first.stats)).toEqual(["error", "info"]);
  });

  it("aggregates only what the filter kept", async () => {
    const result = payload(
      await handleJsonStat(
        { file: "orders.json", expr: '$.orders[*] | select(.status == "closed")', value: ".total" },
        root,
      ),
    );
    expect(result.selected).toBe(2);
    expect(result.stats.sum).toBe(100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// json_diff
// ─────────────────────────────────────────────────────────────────────────────

describe("json_diff", () => {
  it("aligns by key and reports only the fields that changed", async () => {
    const result = payload(
      await handleJsonDiff(
        { file_a: "orders.json", file_b: "orders-b.json", expr: "$.orders[*]", key: ".id" },
        root,
      ),
    );

    expect(result.aligned_by).toBe("key");
    expect(result.summary).toMatchObject({ only_in_a: 1, only_in_b: 1, changed: 2, unchanged: 2 });
    expect(result.only_in_a[0].key).toBe("o-5");
    expect(result.only_in_b[0].key).toBe("o-6");

    const changed = Object.fromEntries(result.changed.map((c: any) => [c.key, c.differences]));
    expect(changed["o-1"]).toEqual([{ field: "$.customer.city", a: "Stockholm", b: "Uppsala" }]);
    expect(changed["o-2"]).toEqual([{ field: "$.total", a: 40, b: 45 }]);
  });

  it("aligns by position when no key is given", async () => {
    const result = payload(
      await handleJsonDiff({ file_a: "orders.json", file_b: "orders-b.json", expr: "$.orders[*]" }, root),
    );

    expect(result.aligned_by).toBe("position");
    expect(result.summary.only_in_a).toBe(0);
    expect(result.summary.only_in_b).toBe(0);
    expect(result.changed.map((c: any) => c.key)).toEqual(["[0]", "[1]", "[4]"]);
  });

  it("compares a projection rather than whole items", async () => {
    const result = payload(
      await handleJsonDiff(
        {
          file_a: "orders.json",
          file_b: "orders-b.json",
          expr: "$.orders[*] | {id, total}",
          key: ".id",
        },
        root,
      ),
    );

    expect(result.summary.changed).toBe(1);
    expect(result.changed[0].differences).toEqual([{ field: "$.total", a: 40, b: 45 }]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Files too big to return
// ─────────────────────────────────────────────────────────────────────────────

describe("oversized files", () => {
  let bigRoot: DataRoot;
  let directory: string;

  beforeAll(() => {
    directory = mkdtempSync(path.join(tmpdir(), "docs-mcp-data-"));

    const rows = Array.from({ length: 200 }, (_, i) => ({ id: i, blurb: "z".repeat(400) }));
    writeFileSync(path.join(directory, "wide.json"), JSON.stringify({ rows }), "utf-8");

    const numbers = Array.from({ length: 250_000 }, (_, i) => i).join(",");
    writeFileSync(path.join(directory, "huge-array.json"), `[${numbers}]`, "utf-8");

    bigRoot = new DataRoot(new FileSystemSource(directory), directory);
  });

  afterAll(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("stops at the response byte cap and reports the rows left out", async () => {
    const result = payload(await handleJsonQuery({ file: "wide.json", expr: "$.rows[*]", limit: 200 }, bigRoot));

    expect(result.matched).toBe(200);
    expect(result.returned).toBeLessThan(200);
    expect(result.truncated.reason).toBe("response_bytes");
    expect(result.returned + result.truncated.rows_omitted).toBe(200);
    expect(Buffer.byteLength(JSON.stringify(result), "utf-8")).toBeLessThan(MAX_RESPONSE_BYTES);
  });

  it("summarises a file whose rows could never be returned", async () => {
    const result = payload(await handleJsonSchema({ file: "huge-array.json" }, bigRoot));

    expect(result.shape.type).toBe("array");
    expect(result.shape.length).toBe(250_000);
    expect(result.shape.items.type).toBe("number");
  });

  it("refuses to build one value larger than it can hold, and says how to narrow it", async () => {
    const text = errorText(await handleJsonQuery({ file: "huge-array.json", expr: "$" }, bigRoot));

    expect(text).toContain("huge-array.json");
    expect(text).toContain("Narrow the expression");
  });

  it("aggregates a quarter of a million values without returning any", async () => {
    const result = payload(await handleJsonStat({ file: "huge-array.json", expr: "$[*]" }, bigRoot));

    expect(result.stats.count).toBe(250_000);
    expect(result.stats.max).toBe(249_999);
    expect(result.stats.median_exact).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// list_data_files
// ─────────────────────────────────────────────────────────────────────────────

describe("list_data_files", () => {
  it("lists the data files with their format and size", async () => {
    const files = payload(await handleListDataFiles(root));
    const orders = files.find((f: any) => f.file === "orders.json");

    expect(orders.format).toBe("json");
    expect(orders.bytes).toBeGreaterThan(0);
    expect(files.find((f: any) => f.file === "events.jsonl").format).toBe("jsonl");
  });
});
