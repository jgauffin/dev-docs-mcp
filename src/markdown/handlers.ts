import path from "path";
import type { DocsSource } from "../source.js";

// ─────────────────────────────────────────────────────────────────────────────
// Security Helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Reject regex patterns likely to cause catastrophic backtracking (ReDoS). */
function isSafeRegex(pattern: string): boolean {
  if (pattern.length > 200) return false;
  // Nested quantifiers: (x+)+, (x*)+, (x+)*, (x+){n}, etc.
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(pattern)) return false;
  return true;
}

/**
 * Sanitize a user-provided path for safe interpolation into glob patterns.
 * Rejects traversal and glob metacharacters (only literal folder names allowed).
 */
function sanitizePathForGlob(input: string): string | null {
  const normalized = path.posix.normalize(input.replace(/\\/g, "/"));
  if (
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    normalized.includes("\0")
  ) {
    return null;
  }
  if (/[*?{}[\]!@#]/.test(normalized)) return null;
  return normalized;
}

/**
 * Sanitize a user-provided glob pattern.
 * Allows * and ? wildcards but rejects traversal and dangerous metacharacters.
 */
function sanitizeGlobPattern(pattern: string): string | null {
  const normalized = pattern.replace(/\\/g, "/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("..") ||
    normalized.includes("\0")
  ) {
    return null;
  }
  // Only allow alphanumeric, /, -, _, ., *, ?
  if (/[^a-zA-Z0-9/\-_.*?]/.test(normalized)) return null;
  return normalized;
}

/** Max files to scan in a single search to prevent abuse. */
const MAX_FILES_TO_SEARCH = 500;

/** Max time a search may run before being truncated. */
const SEARCH_TIMEOUT_MS = 5000;

// ─────────────────────────────────────────────────────────────────────────────
// YAML Helpers (1-space indentation)
// ─────────────────────────────────────────────────────────────────────────────

function yStr(s: string): string {
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function yBlock(content: string, indent: number): string {
  const pad = ' '.repeat(indent);
  return '|\n' + content.split('\n').map(l => l ? pad + l : '').join('\n');
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

function parseHeading(lines: string[], i: number): { title: string; level: number } | null {
  const atx = lines[i]!.match(/^(#{1,6})\s+(.*)/);
  if (atx?.[1] && atx[2] !== undefined) {
    return { title: atx[2], level: atx[1].length };
  }
  const next = lines[i + 1];
  if (next !== undefined && lines[i]!.trim() !== "") {
    if (/^=+\s*$/.test(next)) return { title: lines[i]!.trim(), level: 1 };
    if (/^-+\s*$/.test(next)) return { title: lines[i]!.trim(), level: 2 };
  }
  return null;
}

export interface TocEntry {
  line: number;
  title: string;
  level: number;
  abstract?: string;
}

export function extractToc(content: string, includeAbstracts = false): TocEntry[] {
  const toc: TocEntry[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const heading = parseHeading(lines, i);
    if (!heading) continue;

    const isSetext = lines[i + 1] !== undefined && /^[=\-]+\s*$/.test(lines[i + 1]!);
    let abstract: string | undefined;

    if (includeAbstracts) {
      const start = isSetext ? i + 2 : i + 1;
      for (let j = start; j < lines.length; j++) {
        const next = lines[j]!.trim();
        if (next === "") continue;
        if (parseHeading(lines, j)) break;
        abstract = next;
        break;
      }
    }

    const entry: TocEntry = { line: i + 1, title: heading.title, level: heading.level };
    if (abstract) entry.abstract = abstract;
    toc.push(entry);
    if (isSetext) i++;
  }

  return toc;
}

export function extractChapters(content: string, headings: string[]): Map<string, string> {
  const lines = content.split("\n");
  const result = new Map<string, string>();
  const lowerHeadings = headings.map(h => h.toLowerCase());

  for (let i = 0; i < lines.length; i++) {
    const heading = parseHeading(lines, i);
    if (!heading) continue;
    if (!lowerHeadings.includes(heading.title.toLowerCase())) continue;

    const isSetext = lines[i + 1] !== undefined && /^[=\-]+\s*$/.test(lines[i + 1]!);
    const contentStart = isSetext ? i + 2 : i + 1;

    let end = lines.length;
    for (let j = contentStart; j < lines.length; j++) {
      const next = parseHeading(lines, j);
      if (next && next.level <= heading.level) {
        end = j;
        break;
      }
    }

    result.set(heading.title, lines.slice(i, end).join("\n").trimEnd());
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Handlers
// ─────────────────────────────────────────────────────────────────────────────

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: "text", text }], isError };
}

const INDEX_THRESHOLD = 80;

interface FileEntry {
  path: string;
  title: string;
  abstract?: string;
}

async function buildFileEntry(file: string, source: DocsSource): Promise<FileEntry> {
  const content = await source.readFile(file);
  const lines = content.split("\n");

  const heading = parseHeading(lines, 0);
  const title = heading?.title ?? lines[0]?.trim() ?? "(No title)";
  const isSetext = heading !== null && lines[1] !== undefined && /^[=\-]+\s*$/.test(lines[1]);
  const abstractStart = isSetext ? 2 : 1;

  let abstract: string | undefined;
  for (let i = abstractStart; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    if (parseHeading(lines, i)) break;
    abstract = line;
    break;
  }

  const entry: FileEntry = { path: file, title };
  if (abstract) entry.abstract = abstract;
  return entry;
}

function formatEntryYaml(entry: FileEntry, indent: number): string {
  const pad = ' '.repeat(indent);
  let yaml = `${pad}- path: ${yStr(entry.path)}\n`;
  yaml += `${pad}  title: ${yStr(entry.title)}`;
  if (entry.abstract) {
    yaml += `\n${pad}  abstract: ${yStr(entry.abstract)}`;
  }
  return yaml;
}

function formatFolderYaml(folder: string, count: number, indent: number): string {
  const pad = ' '.repeat(indent);
  return `${pad}- folder: ${yStr(folder + '/')}\n${pad}  count: ${count}`;
}

export async function handleGetDocIndex(source: DocsSource): Promise<ToolResult> {
  const files = await source.listFiles("**/*.md");
  if (files.length === 0) {
    return textResult("error: No documentation files found.", true);
  }

  if (files.length <= INDEX_THRESHOLD) {
    const entries: FileEntry[] = [];
    for (const file of files) {
      entries.push(await buildFileEntry(file, source));
    }
    let yaml = 'doc_index:\n';
    yaml += ` total: ${entries.length}\n`;
    yaml += ' entries:\n';
    yaml += entries.map(e => formatEntryYaml(e, 2)).join('\n');
    return textResult(yaml);
  }

  const rootFiles: string[] = [];
  const folders = new Map<string, number>();
  for (const file of files) {
    const slashIndex = file.indexOf("/");
    if (slashIndex === -1) {
      rootFiles.push(file);
    } else {
      const folder = file.substring(0, slashIndex);
      folders.set(folder, (folders.get(folder) ?? 0) + 1);
    }
  }

  const entries: FileEntry[] = [];
  for (const file of rootFiles) {
    entries.push(await buildFileEntry(file, source));
  }

  let yaml = 'doc_index:\n';
  yaml += ` total: ${files.length}\n`;
  yaml += ' entries:\n';
  yaml += entries.map(e => formatEntryYaml(e, 2)).join('\n');

  if (folders.size > 0) {
    yaml += '\n folders:\n';
    const sorted = [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    yaml += sorted.map(([f, c]) => formatFolderYaml(f, c, 2)).join('\n');
  }

  return textResult(yaml);
}

export async function handleGetSubIndex(args: { path?: string }, source: DocsSource): Promise<ToolResult> {
  if (!args.path) {
    return textResult("error: path is required.", true);
  }

  const folder = sanitizePathForGlob(args.path.replace(/\/+$/, ""));
  if (!folder) {
    return textResult("error: Invalid path.", true);
  }
  const files = await source.listFiles(`${folder}/**/*.md`);

  if (files.length === 0) {
    return textResult(`error: No documentation files found in "${folder}".`, true);
  }

  const directFiles: string[] = [];
  const subFolders = new Map<string, number>();

  for (const file of files) {
    const relative = file.substring(folder.length + 1);
    const slashIndex = relative.indexOf("/");
    if (slashIndex === -1) {
      directFiles.push(file);
    } else {
      const sub = folder + "/" + relative.substring(0, slashIndex);
      subFolders.set(sub, (subFolders.get(sub) ?? 0) + 1);
    }
  }

  if (files.length <= INDEX_THRESHOLD) {
    const entries: FileEntry[] = [];
    for (const file of files) {
      entries.push(await buildFileEntry(file, source));
    }
    let yaml = 'sub_index:\n';
    yaml += ` path: ${yStr(folder + '/')}\n`;
    yaml += ` total: ${files.length}\n`;
    yaml += ' entries:\n';
    yaml += entries.map(e => formatEntryYaml(e, 2)).join('\n');
    return textResult(yaml);
  }

  const entries: FileEntry[] = [];
  for (const file of directFiles) {
    entries.push(await buildFileEntry(file, source));
  }

  let yaml = 'sub_index:\n';
  yaml += ` path: ${yStr(folder + '/')}\n`;
  yaml += ` total: ${files.length}\n`;
  yaml += ' entries:\n';
  yaml += entries.map(e => formatEntryYaml(e, 2)).join('\n');

  if (subFolders.size > 0) {
    yaml += '\n folders:\n';
    const sorted = [...subFolders.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    yaml += sorted.map(([f, c]) => formatFolderYaml(f, c, 2)).join('\n');
  }

  return textResult(yaml);
}

export async function handleReadDocFile(args: { file_path?: string }, source: DocsSource): Promise<ToolResult> {
  if (!args.file_path) {
    return textResult("error: file_path is required.", true);
  }

  const resolved = source.resolvePath(args.file_path);
  if (!resolved) {
    return textResult("error: Invalid path or security violation.", true);
  }

  try {
    const content = await source.readFile(resolved);
    return textResult(content);
  } catch {
    return textResult(`error: File not found: ${args.file_path}`, true);
  }
}

export async function handleGetFileToc(args: { file_path: string; include_abstracts?: boolean }, source: DocsSource): Promise<ToolResult> {
  const resolved = source.resolvePath(args.file_path);
  if (!resolved) {
    return textResult("error: Invalid path.", true);
  }

  try {
    const content = await source.readFile(resolved);
    const toc = extractToc(content, args.include_abstracts ?? false);

    let yaml = 'toc:\n';
    yaml += ` file: ${yStr(args.file_path)}\n`;
    yaml += ' headings:\n';
    for (const entry of toc) {
      yaml += `  - line: ${entry.line}\n`;
      yaml += `    title: ${yStr(entry.title)}\n`;
      yaml += `    level: ${entry.level}`;
      if (entry.abstract) {
        yaml += `\n    abstract: ${yStr(entry.abstract)}`;
      }
      yaml += '\n';
    }
    return textResult(yaml.trimEnd());
  } catch {
    return textResult("error: File not found.", true);
  }
}

export async function handleGetChapters(args: { file_path: string; headings: string[] }, source: DocsSource): Promise<ToolResult> {
  const resolved = source.resolvePath(args.file_path);
  if (!resolved) {
    return textResult("error: Invalid path or security violation.", true);
  }

  try {
    const content = await source.readFile(resolved);
    const chapters = extractChapters(content, args.headings);

    if (chapters.size === 0) {
      const notFound = args.headings.join(", ");
      return textResult(`error: No matching chapters found for: ${notFound}`);
    }

    let yaml = 'chapters:\n';
    yaml += ` file: ${yStr(args.file_path)}\n`;
    yaml += ' sections:\n';
    for (const [heading, body] of chapters) {
      yaml += `  - heading: ${yStr(heading)}\n`;
      yaml += `    content: ${yBlock(body, 5)}\n`;
    }
    return textResult(yaml.trimEnd());
  } catch {
    return textResult("error: File not found.", true);
  }
}

/** Resolve glob patterns, splitting on | for OR support. */
function resolveGlobPatterns(pathPattern?: string): string | string[] | null {
  if (!pathPattern) return "**/*.md";

  const parts = pathPattern.split("|").map(p => p.trim()).filter(Boolean);

  function expandPattern(p: string): string | null {
    const safe = sanitizeGlobPattern(p);
    if (!safe) return null;
    if (safe.endsWith(".md")) return safe;
    if (safe.endsWith("/")) return `${safe}**/*.md`;
    if (safe.includes("*")) return safe;
    return `${safe}/**/*.md`;
  }

  const expanded: string[] = [];
  for (const p of parts) {
    const result = expandPattern(p);
    if (!result) return null;
    expanded.push(result);
  }
  return expanded.length === 1 ? expanded[0]! : expanded;
}

export async function handleSearchDocs(args: { query: string; path_pattern?: string }, source: DocsSource): Promise<ToolResult> {
  const { query, path_pattern } = args;

  const terms = query.split("|").map(t => t.trim()).filter(Boolean);
  const regexes: { term: string; regex: RegExp }[] = [];
  for (const term of terms) {
    if (!isSafeRegex(term)) {
      return textResult(`error: Potentially unsafe regex pattern rejected: ${term}`, true);
    }
    try {
      regexes.push({ term, regex: new RegExp(term, "i") });
    } catch {
      return textResult(`error: Invalid regex pattern: ${term}`, true);
    }
  }

  if (regexes.length === 0) {
    return textResult("error: No search terms provided.", true);
  }

  const globPattern = resolveGlobPatterns(path_pattern);
  if (!globPattern) {
    return textResult("error: Invalid path_pattern.", true);
  }

  const allFiles = await source.listFiles(globPattern);
  const files = allFiles.slice(0, MAX_FILES_TO_SEARCH);
  const MAX_RESULTS = 50;
  const searchStart = Date.now();

  if (regexes.length === 1) {
    const { regex } = regexes[0]!;
    const results: { file: string; line: number; text: string }[] = [];
    let timedOut = false;

    for (const file of files) {
      if (Date.now() - searchStart > SEARCH_TIMEOUT_MS) { timedOut = true; break; }
      const content = await source.readFile(file);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) {
          results.push({ file, line: i + 1, text: lines[i]!.trim() });
          if (results.length >= MAX_RESULTS) break;
        }
      }
      if (results.length >= MAX_RESULTS) break;
    }

    if (results.length === 0) {
      return textResult("No matches found.");
    }

    let yaml = 'search:\n';
    yaml += ` query: ${yStr(query)}\n`;
    yaml += ` total: ${results.length}${timedOut ? "+" : ""}\n`;
    yaml += ' results:\n';
    for (const r of results) {
      yaml += `  - file: ${yStr(r.file)}\n`;
      yaml += `    line: ${r.line}\n`;
      yaml += `    text: ${yStr(r.text)}\n`;
    }
    if (timedOut) {
      yaml += ` truncated: true`;
    }
    return textResult(yaml.trimEnd());
  }

  // Multiple terms: group by term
  const perTerm = MAX_RESULTS / regexes.length | 0;
  let totalMatches = 0;
  const termResults: { term: string; count: number; results: { file: string; line: number; text: string }[] }[] = [];

  for (const { term, regex } of regexes) {
    const matches: { file: string; line: number; text: string }[] = [];

    for (const file of files) {
      if (Date.now() - searchStart > SEARCH_TIMEOUT_MS) break;
      const content = await source.readFile(file);
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        if (regex.test(lines[i]!)) {
          matches.push({ file, line: i + 1, text: lines[i]!.trim() });
          if (matches.length >= perTerm) break;
        }
      }
      if (matches.length >= perTerm) break;
    }

    totalMatches += matches.length;
    termResults.push({ term, count: matches.length, results: matches });
  }

  if (totalMatches === 0) {
    return textResult("No matches found.");
  }

  let yaml = 'search:\n';
  yaml += ` query: ${yStr(query)}\n`;
  yaml += ' terms:\n';
  for (const t of termResults) {
    yaml += `  - term: ${yStr(t.term)}\n`;
    yaml += `    count: ${t.count}\n`;
    yaml += '    results:\n';
    for (const r of t.results) {
      yaml += `     - file: ${yStr(r.file)}\n`;
      yaml += `       line: ${r.line}\n`;
      yaml += `       text: ${yStr(r.text)}\n`;
    }
  }
  return textResult(yaml.trimEnd());
}
