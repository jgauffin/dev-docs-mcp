/**
 * Aggregation is the case where the rows must never come back at all, so these
 * accumulators fold values as they stream past and keep nothing but the running
 * totals. Values are retained only for the median, and only up to a cap.
 */

import { LongString } from "./scanner.js";

/** Values kept per group so an exact median can be computed. */
export const MEDIAN_RETENTION_CAP = 100_000;

/** Groups reported before the rest are summarised as omitted. */
export const MAX_GROUPS = 50;

export interface StatSummary {
  count: number;
  sum: number;
  min: number | null;
  max: number | null;
  mean: number | null;
  median: number | null;
  median_exact: boolean;
  nulls: number;
  non_numeric: number;
}

export class Accumulator {
  private count = 0;
  private sum = 0;
  private min: number | null = null;
  private max: number | null = null;
  private nulls = 0;
  private nonNumeric = 0;
  private readonly retained: number[] = [];
  private retentionCapped = false;

  /** Every observed value is counted somewhere, including the ones it cannot use. */
  add(value: unknown): void {
    if (value === null || value === undefined) {
      this.nulls++;
      return;
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.nonNumeric++;
      return;
    }

    this.count++;
    this.sum += value;
    this.min = this.min === null ? value : Math.min(this.min, value);
    this.max = this.max === null ? value : Math.max(this.max, value);

    if (this.retained.length < MEDIAN_RETENTION_CAP) this.retained.push(value);
    else this.retentionCapped = true;
  }

  /** Total observations, including nulls and non-numerics. */
  get observed(): number {
    return this.count + this.nulls + this.nonNumeric;
  }

  summary(): StatSummary {
    return {
      count: this.count,
      sum: this.sum,
      min: this.min,
      max: this.max,
      mean: this.count > 0 ? this.sum / this.count : null,
      median: this.median(),
      median_exact: !this.retentionCapped,
      nulls: this.nulls,
      non_numeric: this.nonNumeric,
    };
  }

  private median(): number | null {
    if (this.retained.length === 0) return null;
    const sorted = [...this.retained].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
  }
}

export class GroupedAccumulator {
  private readonly groups = new Map<string, Accumulator>();

  add(groupKey: string, value: unknown): void {
    let accumulator = this.groups.get(groupKey);
    if (!accumulator) {
      accumulator = new Accumulator();
      this.groups.set(groupKey, accumulator);
    }
    accumulator.add(value);
  }

  get size(): number {
    return this.groups.size;
  }

  /** Largest groups first, ties broken by name so two calls are comparable. */
  ranked(): Array<{ key: string; summary: StatSummary }> {
    return [...this.groups.entries()]
      .map(([key, accumulator]) => ({ key, summary: accumulator.summary(), observed: accumulator.observed }))
      .sort((a, b) => b.observed - a.observed || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      .map(({ key, summary }) => ({ key, summary }));
  }
}

/** How a group key is written in the result. */
export function groupKeyOf(value: unknown): string {
  if (value === null || value === undefined) return "(none)";
  if (value instanceof LongString) return value.text;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
