import type { DocsSource } from "../source.js";
import { textResult, type ToolResult } from "../api/handlers.js";
import { DataError } from "./errors.js";
import { detectFormat, scanTokens, selectItems } from "./loader.js";
import type { DataFile, Selected } from "./loader.js";
import { MAX_DIFF_ITEMS, diffItems } from "./diff.js";
import {
  ExpressionError,
  MISSING,
  applyStages,
  parseExpression,
  parsePath,
  resolvePath,
} from "./expr.js";
import type { Expression } from "./expr.js";
import { JsonSyntaxError, formatPath } from "./scanner.js";
import { ShapeBuilder } from "./shape.js";
import {
  MAX_RESPONSE_BYTES,
  byteLength,
  clipStrings,
  describeTruncation,
  fitRows,
} from "./output.js";
import { GroupedAccumulator, Accumulator, MAX_GROUPS, groupKeyOf } from "./stats.js";

export const DATA_FILE_PATTERN = "**/*.{json,jsonl,ndjson}";

/** Room left for the fields that wrap the rows. */
const ENVELOPE_BYTES = 2048;

// ─────────────────────────────────────────────────────────────────────────────
// DataRoot — the directory the data tools may read, and nothing outside it
// ─────────────────────────────────────────────────────────────────────────────

export class DataRoot {
  constructor(
    private readonly source: DocsSource,
    readonly origin: string,
  ) {
    if (!source.openStream) {
      throw new Error(
        `Data source "${origin}" cannot be streamed. Use a local directory (type "disk"), ` +
          `or configure --cache-dir so a GitHub source is cloned locally.`,
      );
    }
  }

  async list(): Promise<Array<{ file: string; format: string; bytes: number | null }>> {
    const files = await this.source.listFiles(DATA_FILE_PATTERN);
    const listed = await Promise.all(
      files.sort().map(async (file) => ({
        file,
        format: detectFormat(file),
        bytes: await this.sizeOf(file),
      })),
    );
    return listed;
  }

  /** Validate a caller-supplied path and bind it to a reader. */
  async openFile(inputPath: string | undefined): Promise<DataFile> {
    if (!inputPath || inputPath.trim() === "") {
      throw new DataError("(no file)", "a file path is required");
    }

    const relativePath = this.source.resolvePath(inputPath, false);
    if (!relativePath) {
      throw new DataError(inputPath, `path is outside the data root (${this.origin})`);
    }

    const size = await this.sizeOf(relativePath);
    if (size === null) {
      throw new DataError(inputPath, `file not found under the data root (${this.origin})`);
    }

    return {
      relativePath,
      format: detectFormat(relativePath),
      open: () => this.source.openStream!(relativePath),
    };
  }

  async sizeOf(relativePath: string): Promise<number | null> {
    if (!this.source.statFile) return null;
    try {
      return (await this.source.statFile(relativePath)).size;
    } catch {
      return null;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared plumbing
// ─────────────────────────────────────────────────────────────────────────────

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], isError: false };
}

/** Report the failing path and what went wrong, never a bare exception name. */
async function guard(work: () => Promise<ToolResult>): Promise<ToolResult> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof DataError || err instanceof ExpressionError || err instanceof JsonSyntaxError) {
      return textResult(`error: ${err.message}`, true);
    }
    return textResult(`error: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}

function clamp(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

// ─────────────────────────────────────────────────────────────────────────────
// json_schema
// ─────────────────────────────────────────────────────────────────────────────

export async function handleJsonSchema(
  args: { file?: string; depth?: number; sample?: number } | undefined,
  root: DataRoot,
): Promise<ToolResult> {
  return guard(async () => {
    const file = await root.openFile(args?.file);
    const depth = clamp(args?.depth, 3, 1, 12);
    const sample = clamp(args?.sample, 1, 0, 1);

    const builder = new ShapeBuilder(depth);
    await scanTokens(file, (token) => builder.handle(token));

    // Shallower rather than cut off mid-tree: a whole level is easier to reason
    // about than an arbitrary boundary, and the reduction is reported.
    let renderedDepth = depth;
    let shape = builder.render(renderedDepth, sample >= 1);
    while (renderedDepth > 1 && byteLength(shape) > MAX_RESPONSE_BYTES - ENVELOPE_BYTES) {
      renderedDepth--;
      shape = builder.render(renderedDepth, sample >= 1);
    }

    return ok({
      file: file.relativePath,
      format: file.format,
      bytes: await root.sizeOf(file.relativePath),
      depth: renderedDepth,
      shape,
      truncated:
        renderedDepth < depth
          ? { reason: "response_bytes", depth_requested: depth, depth_returned: renderedDepth }
          : null,
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// json_query
// ─────────────────────────────────────────────────────────────────────────────

export async function handleJsonQuery(
  args: { file?: string; expr?: string; limit?: number; max_string?: number } | undefined,
  root: DataRoot,
): Promise<ToolResult> {
  return guard(async () => {
    const file = await root.openFile(args?.file);
    const expression = parseExpression(args?.expr ?? "$");
    const limit = clamp(args?.limit, 50, 1, 500);
    const maxString = clamp(args?.max_string, 200, 20, 4000);

    const rows: Array<{ path: string; value: unknown }> = [];
    let matched = 0;

    await selectItems(file, expression.path, (item) => {
      const result = applyStages(item.value, expression.stages);
      if (!result.kept) return;
      matched++;
      if (rows.length < limit) {
        rows.push({ path: formatPath(item.path), value: clipStrings(result.value, maxString) });
      }
    });

    const fitted = fitRows(rows, MAX_RESPONSE_BYTES - ENVELOPE_BYTES);

    return ok({
      file: file.relativePath,
      expr: args?.expr ?? "$",
      matched,
      returned: fitted.kept.length,
      rows: fitted.kept,
      truncated: describeTruncation(matched - rows.length, fitted.omitted),
    });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// json_stat
// ─────────────────────────────────────────────────────────────────────────────

export async function handleJsonStat(
  args: { file?: string; expr?: string; value?: string; group_by?: string } | undefined,
  root: DataRoot,
): Promise<ToolResult> {
  return guard(async () => {
    const file = await root.openFile(args?.file);
    const expression = parseExpression(args?.expr ?? "$");
    const valuePath = args?.value ? parsePath(args.value, "value") : null;
    const groupPath = args?.group_by ? parsePath(args.group_by, "group_by") : null;

    const single = new Accumulator();
    const grouped = new GroupedAccumulator();
    let selected = 0;

    await selectItems(file, expression.path, (item) => {
      const result = applyStages(item.value, expression.stages);
      if (!result.kept) return;
      selected++;

      const value = valuePath ? unwrap(resolvePath(result.value, valuePath)) : result.value;
      if (!groupPath) {
        single.add(value);
        return;
      }
      grouped.add(groupKeyOf(unwrap(resolvePath(result.value, groupPath))), value);
    });

    const base = {
      file: file.relativePath,
      expr: args?.expr ?? "$",
      value: args?.value ?? null,
      group_by: args?.group_by ?? null,
      selected,
    };

    if (!groupPath) {
      return ok({ ...base, stats: single.summary(), truncated: null });
    }

    const ranked = grouped.ranked();
    const kept = ranked.slice(0, MAX_GROUPS);
    return ok({
      ...base,
      groups: kept.length,
      stats: Object.fromEntries(kept.map((entry) => [entry.key, entry.summary])),
      truncated:
        ranked.length > kept.length
          ? { reason: "limit", groups_omitted: ranked.length - kept.length }
          : null,
    });
  });
}

function unwrap(value: unknown): unknown {
  return value === MISSING ? null : value;
}

// ─────────────────────────────────────────────────────────────────────────────
// json_diff
// ─────────────────────────────────────────────────────────────────────────────

export async function handleJsonDiff(
  args: { file_a?: string; file_b?: string; expr?: string; key?: string; limit?: number } | undefined,
  root: DataRoot,
): Promise<ToolResult> {
  return guard(async () => {
    const fileA = await root.openFile(args?.file_a);
    const fileB = await root.openFile(args?.file_b);
    const expression = parseExpression(args?.expr ?? "$");
    const keyPath = args?.key ? parsePath(args.key, "key") : null;
    const limit = clamp(args?.limit, 50, 1, 200);

    const itemsA = await collectForDiff(fileA, expression);
    const itemsB = await collectForDiff(fileB, expression);
    const outcome = diffItems(itemsA, itemsB, keyPath);

    const budget = Math.floor((MAX_RESPONSE_BYTES - ENVELOPE_BYTES) / 3);
    const onlyA = fitRows(outcome.only_in_a.slice(0, limit).map(clipEntry), budget);
    const onlyB = fitRows(outcome.only_in_b.slice(0, limit).map(clipEntry), budget);
    const changed = fitRows(outcome.changed.slice(0, limit), budget);

    const omitted = {
      only_in_a: outcome.only_in_a.length - onlyA.kept.length,
      only_in_b: outcome.only_in_b.length - onlyB.kept.length,
      changed: outcome.changed.length - changed.kept.length,
    };

    return ok({
      file_a: fileA.relativePath,
      file_b: fileB.relativePath,
      expr: args?.expr ?? "$",
      key: args?.key ?? null,
      aligned_by: keyPath ? "key" : "position",
      compared: { a: itemsA.length, b: itemsB.length },
      summary: {
        only_in_a: outcome.only_in_a.length,
        only_in_b: outcome.only_in_b.length,
        changed: outcome.changed.length,
        unchanged: outcome.unchanged,
        duplicate_keys: outcome.duplicate_keys,
      },
      only_in_a: onlyA.kept,
      only_in_b: onlyB.kept,
      changed: changed.kept,
      truncated:
        omitted.only_in_a + omitted.only_in_b + omitted.changed > 0
          ? { reason: "limit", rows_omitted: omitted }
          : null,
    });
  });
}

function clipEntry(entry: { key: string; value: unknown }): { key: string; value: unknown } {
  return { key: entry.key, value: clipStrings(entry.value, 200) };
}

async function collectForDiff(file: DataFile, expression: Expression): Promise<unknown[]> {
  const items: unknown[] = [];

  await selectItems(file, expression.path, (item: Selected) => {
    const result = applyStages(item.value, expression.stages);
    if (!result.kept) return;
    if (items.length >= MAX_DIFF_ITEMS) {
      throw new DataError(
        file.relativePath,
        `the expression selects more than ${MAX_DIFF_ITEMS} items, which is more than a diff can align. Narrow it with select(...).`,
      );
    }
    items.push(result.value);
  });

  return items;
}

// ─────────────────────────────────────────────────────────────────────────────
// list_data_files
// ─────────────────────────────────────────────────────────────────────────────

export async function handleListDataFiles(root: DataRoot): Promise<ToolResult> {
  return guard(async () => ok(await root.list()));
}
