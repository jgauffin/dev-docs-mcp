import type { DocsSource } from "./source.js";

// ─────────────────────────────────────────────────────────────────────────────
// Utilities
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Extracts markdown headers as a table of contents.
 * When includeAbstracts is true, the first non-empty, non-heading line after each heading is appended.
 */
function parseHeading(lines: string[], i: number): { title: string; level: number } | null {
  // ATX-style: ## Heading
  const atx = lines[i]!.match(/^(#{1,6})\s+(.*)/);
  if (atx?.[1] && atx[2] !== undefined) {
    return { title: atx[2], level: atx[1].length };
  }
  // Setext-style: underline with === (h1) or --- (h2)
  const next = lines[i + 1];
  if (next !== undefined && lines[i]!.trim() !== "") {
    if (/^=+\s*$/.test(next)) return { title: lines[i]!.trim(), level: 1 };
    if (/^-+\s*$/.test(next)) return { title: lines[i]!.trim(), level: 2 };
  }
  return null;
}

export function extractToc(content: string, includeAbstracts = false): string[] {
  const toc: string[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const heading = parseHeading(lines, i);
    if (!heading) continue;

    const isSetext = lines[i + 1] !== undefined && /^[=\-]+\s*$/.test(lines[i + 1]!);
    const indent = "  ".repeat(heading.level - 1);
    let abstract = "";
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

    const entry = abstract
      ? `${indent}- [Line ${i + 1}] ${heading.title} — ${abstract}`
      : `${indent}- [Line ${i + 1}] ${heading.title}`;
    toc.push(entry);
    if (isSetext) i++; // skip underline
  }

  return toc;
}

/**
 * Extracts the content of specific chapters (sections) by heading name.
 * Each chapter includes everything from the heading to the next heading of the same or higher level.
 */
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

/** Max number of entries before we switch to hierarchical (folder-summary) mode. */
const INDEX_THRESHOLD = 80;

async function buildFileEntry(file: string, source: DocsSource): Promise<string> {
  const content = await source.readFile(file);
  const lines = content.split("\n");

  const heading = parseHeading(lines, 0);
  const title = heading?.title ?? lines[0]?.trim() ?? "(No title)";
  const isSetext = heading !== null && lines[1] !== undefined && /^[=\-]+\s*$/.test(lines[1]);
  const abstractStart = isSetext ? 2 : 1;

  let abstract = "";
  for (let i = abstractStart; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === "") continue;
    if (parseHeading(lines, i)) break;
    abstract = line;
    break;
  }

  return abstract ? `- ${file}: ${title} — ${abstract}` : `- ${file}: ${title}`;
}

export async function handleGetDocIndex(source: DocsSource): Promise<ToolResult> {
  const files = await source.listFiles("**/*.md");
  if (files.length === 0) {
    return textResult("No documentation files found.", true);
  }

  // Small doc set: return flat index as before
  if (files.length <= INDEX_THRESHOLD) {
    const entries: string[] = [];
    for (const file of files) {
      entries.push(await buildFileEntry(file, source));
    }
    return textResult(`## Documentation Index\n\n${entries.join("\n")}`);
  }

  // Large doc set: return root-level files + folder summaries
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

  const entries: string[] = [];

  // Root files with full details
  for (const file of rootFiles) {
    entries.push(await buildFileEntry(file, source));
  }

  // Folder summaries
  for (const [folder, count] of [...folders.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    entries.push(`- ${folder}/ (${count} files) — use get_sub_index("${folder}") to explore`);
  }

  return textResult(
    `## Documentation Index (${files.length} files total)\n\n${entries.join("\n")}`
  );
}

export async function handleGetSubIndex(args: { path?: string }, source: DocsSource): Promise<ToolResult> {
  if (!args.path) {
    return textResult("Invalid arguments: path is required.", true);
  }

  const folder = args.path.replace(/\/+$/, "");
  const files = await source.listFiles(`${folder}/**/*.md`);

  if (files.length === 0) {
    return textResult(`No documentation files found in "${folder}".`, true);
  }

  // Check if there are deep sub-folders worth summarizing
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

  const entries: string[] = [];

  // If manageable, list all files flat
  if (files.length <= INDEX_THRESHOLD) {
    for (const file of files) {
      entries.push(await buildFileEntry(file, source));
    }
    return textResult(`## Index: ${folder}/ (${files.length} files)\n\n${entries.join("\n")}`);
  }

  // Otherwise, show direct files + sub-folder summaries
  for (const file of directFiles) {
    entries.push(await buildFileEntry(file, source));
  }

  for (const [sub, count] of [...subFolders.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    entries.push(`- ${sub}/ (${count} files) — use get_sub_index("${sub}") to explore`);
  }

  return textResult(
    `## Index: ${folder}/ (${files.length} files total)\n\n${entries.join("\n")}`
  );
}

export async function handleReadDocFile(args: { file_path?: string }, source: DocsSource): Promise<ToolResult> {
  if (!args.file_path) {
    return textResult("Invalid arguments: file_path is required.", true);
  }

  const resolved = source.resolvePath(args.file_path);
  if (!resolved) {
    return textResult("Invalid path or security violation.", true);
  }

  try {
    const content = await source.readFile(resolved);
    return textResult(content);
  } catch {
    return textResult(`File not found: ${args.file_path}`, true);
  }
}

export async function handleGetFileToc(args: { file_path: string; include_abstracts?: boolean }, source: DocsSource): Promise<ToolResult> {
  const resolved = source.resolvePath(args.file_path);
  if (!resolved) {
    return textResult("Invalid path.", true);
  }

  try {
    const content = await source.readFile(resolved);
    const toc = extractToc(content, args.include_abstracts ?? false);
    return textResult(
      `## Table of Contents for ${args.file_path}\n\n${toc.join("\n")}`
    );
  } catch {
    return textResult("File not found.", true);
  }
}

export async function handleGetChapters(args: { file_path: string; headings: string[] }, source: DocsSource): Promise<ToolResult> {
  const resolved = source.resolvePath(args.file_path);
  if (!resolved) {
    return textResult("Invalid path or security violation.", true);
  }

  try {
    const content = await source.readFile(resolved);
    const chapters = extractChapters(content, args.headings);

    if (chapters.size === 0) {
      const notFound = args.headings.join(", ");
      return textResult(`No matching chapters found for: ${notFound}`);
    }

    const sections: string[] = [];
    for (const [, body] of chapters) {
      sections.push(body);
    }

    return textResult(sections.join("\n\n---\n\n"));
  } catch {
    return textResult("File not found.", true);
  }
}

export async function handleSearchDocs(args: { query: string; path_pattern?: string }, source: DocsSource): Promise<ToolResult> {
  const { query, path_pattern } = args;

  // Split on "|" to support multiple search terms (e.g. "r-a|router.*link|anchor")
  const terms = query.split("|").map(t => t.trim()).filter(Boolean);
  const regexes: { term: string; regex: RegExp }[] = [];
  for (const term of terms) {
    try {
      regexes.push({ term, regex: new RegExp(term, "i") });
    } catch {
      return textResult(`Invalid regex pattern: ${term}`, true);
    }
  }

  if (regexes.length === 0) {
    return textResult("No search terms provided.", true);
  }

  let globPattern = "**/*.md";
  if (path_pattern) {
    if (path_pattern.endsWith(".md")) {
      globPattern = path_pattern;
    } else if (path_pattern.endsWith("/")) {
      globPattern = `${path_pattern}**/*.md`;
    } else if (path_pattern.includes("*")) {
      globPattern = path_pattern;
    } else {
      globPattern = `${path_pattern}/**/*.md`;
    }
  }

  const files = await source.listFiles(globPattern);
  const MAX_RESULTS = 50;
  let totalMatches = 0;

  // Single term: flat results (original behavior)
  if (regexes.length === 1) {
    const { regex } = regexes[0]!;
    const results: string[] = [];

    for (const file of files) {
      const content = await source.readFile(file);
      content.split("\n").forEach((line, i) => {
        if (regex.test(line)) {
          results.push(`[${file}:${i + 1}] ${line.trim()}`);
        }
      });
    }

    if (results.length === 0) {
      return textResult("No matches found.");
    }

    const limited = results.slice(0, MAX_RESULTS);
    const overflow = results.length > MAX_RESULTS
      ? `\n... (${results.length - MAX_RESULTS} more matches hidden)`
      : "";

    return textResult(`## Search Results for "${query}"\n\n${limited.join("\n")}${overflow}`);
  }

  // Multiple terms: group results by term
  const perTerm = MAX_RESULTS / regexes.length | 0;
  const sections: string[] = [];

  for (const { term, regex } of regexes) {
    const matches: string[] = [];

    for (const file of files) {
      const content = await source.readFile(file);
      content.split("\n").forEach((line, i) => {
        if (regex.test(line)) {
          matches.push(`[${file}:${i + 1}] ${line.trim()}`);
        }
      });
    }

    totalMatches += matches.length;
    const limited = matches.slice(0, perTerm);
    const overflow = matches.length > perTerm
      ? `\n... (${matches.length - perTerm} more matches for "${term}")`
      : "";

    sections.push(`### "${term}" (${matches.length} matches)\n\n${limited.join("\n")}${overflow}`);
  }

  if (totalMatches === 0) {
    return textResult("No matches found.");
  }

  return textResult(`## Search Results for "${query}"\n\n${sections.join("\n\n")}`);
}
