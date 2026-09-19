import fs from "fs/promises";
import { createReadStream } from "fs";
import type { Readable } from "stream";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import https from "https";
import glob from "fast-glob";
import micromatch from "micromatch";
import { detectFormat } from "./schema/lib.js";

const execFileAsync = promisify(execFile);

/** Maximum file size that can be read into memory (10 MB). */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

// ─────────────────────────────────────────────────────────────────────────────
// DocsSource Interface
// ─────────────────────────────────────────────────────────────────────────────

export interface DocsSource {
  /** List files matching a glob pattern (relative paths). Accepts | separated patterns for OR. */
  listFiles(pattern: string | string[]): Promise<string[]>;

  /** Read file content by relative path. Throws if not found. */
  readFile(relativePath: string): Promise<string>;

  /**
   * A value that changes whenever any file matching the pattern is added,
   * edited, or removed. Callers that cache derived data compare stamps to
   * decide whether the cache still reflects the published documentation.
   */
  getChangeStamp(pattern: string | string[]): Promise<string>;

  /**
   * Validate that a relative path is safe (no traversal). Returns normalized path or null.
   * @param appendExtension Extension to append if missing (default ".md"), or false to skip.
   */
  resolvePath(inputPath: string, appendExtension?: string | false): string | null;

  /**
   * Open a file as a stream, without the size limit `readFile` enforces. Data
   * tools answer questions about files far too large to return, so they read
   * them a chunk at a time instead of refusing them. Only sources backed by a
   * local directory can do this.
   */
  openStream?(relativePath: string): Promise<Readable>;

  /** Size of a file in bytes. Available wherever `openStream` is. */
  statFile?(relativePath: string): Promise<{ size: number }>;

  /**
   * How current the served content is. Only sources that serve a copy of
   * content living elsewhere have this; a directory on disk is the content.
   */
  freshness?(): Promise<SourceFreshness>;
}

/**
 * Where a source's content comes from and whether the copy being served is
 * known to match it. Reported to the agent so a stale copy is never mistaken
 * for the current state of the origin.
 */
export interface SourceFreshness {
  /** The place the content is fetched from. */
  origin: string;
  /** When the served copy was taken. Null when nothing has been fetched yet. */
  fetchedAt: Date | null;
  /** Why the copy may be behind the origin. Null when the last fetch succeeded. */
  problem: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalize and validate a relative path.
 * Returns the posix-normalized path or null if it escapes the root.
 */
export function safeRelativePath(inputPath: string, appendExtension: string | false = ".md"): string | null {
  const normalized = path.posix.normalize(inputPath.replace(/\\/g, "/"));

  if (
    normalized.startsWith("/") ||
    normalized.startsWith("../") ||
    normalized === ".." ||
    normalized === "." ||
    normalized.includes("\0")
  ) {
    return null;
  }

  let result = normalized;
  if (appendExtension && !result.endsWith(appendExtension)) result += appendExtension;

  return result;
}

/**
 * Resolve a relative path to a real path inside the root, following symlinks.
 * Throws when the result would leave the root.
 */
async function realPathWithinRoot(
  root: string,
  realRoot: string,
  relativePath: string
): Promise<string> {
  const realPath = await fs.realpath(path.join(root, relativePath));
  if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
    throw new Error("Path escapes document root");
  }
  return realPath;
}

/**
 * Build a change stamp from the name, size, and modification time of every
 * matching file. Any add, edit, or delete changes the resulting string.
 */
async function stampFromDisk(root: string, pattern: string | string[]): Promise<string> {
  const files = (await glob(pattern, { cwd: root })).sort();

  const parts: string[] = [];
  for (const file of files) {
    try {
      const stat = await fs.stat(path.join(root, file));
      parts.push(`${file}:${stat.size}:${stat.mtimeMs}`);
    } catch {
      // Removed between listing and stat — the next stamp picks it up.
    }
  }

  return parts.join("|");
}

// ─────────────────────────────────────────────────────────────────────────────
// FileSystemSource
// ─────────────────────────────────────────────────────────────────────────────

export class FileSystemSource implements DocsSource {
  private realRoot: string | null = null;

  constructor(private readonly root: string) {}

  private async getRealRoot(): Promise<string> {
    if (!this.realRoot) {
      this.realRoot = await fs.realpath(this.root);
    }
    return this.realRoot;
  }

  async listFiles(pattern: string | string[]): Promise<string[]> {
    return glob(pattern, { cwd: this.root });
  }

  async readFile(relativePath: string): Promise<string> {
    const absPath = path.join(this.root, relativePath);

    // Resolve symlinks and verify the real path stays within the docs root
    const realPath = await fs.realpath(absPath);
    const realRoot = await this.getRealRoot();
    if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
      throw new Error("Path escapes document root");
    }

    // Enforce file size limit
    const stat = await fs.stat(realPath);
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB, max ${MAX_FILE_SIZE / 1024 / 1024} MB)`
      );
    }

    return fs.readFile(realPath, "utf-8");
  }

  async openStream(relativePath: string): Promise<Readable> {
    const realPath = await realPathWithinRoot(this.root, await this.getRealRoot(), relativePath);
    return createReadStream(realPath);
  }

  async statFile(relativePath: string): Promise<{ size: number }> {
    const realPath = await realPathWithinRoot(this.root, await this.getRealRoot(), relativePath);
    const stat = await fs.stat(realPath);
    return { size: stat.size };
  }

  async getChangeStamp(pattern: string | string[]): Promise<string> {
    return stampFromDisk(this.root, pattern);
  }

  resolvePath(inputPath: string, appendExtension: string | false = ".md"): string | null {
    const rel = safeRelativePath(inputPath, appendExtension);
    if (!rel) return null;

    const normalizedRoot = path.normalize(this.root);
    const abs = path.resolve(normalizedRoot, rel);

    if (!abs.startsWith(normalizedRoot)) return null;
    return rel;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GitHubSource
// ─────────────────────────────────────────────────────────────────────────────

export interface GitHubRef {
  owner: string;
  repo: string;
  branch: string;
  basePath: string;
}

/**
 * Parse a GitHub URL into owner, repo, branch, and sub-path.
 *
 * Supported formats:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/branch
 *   https://github.com/owner/repo/tree/branch/path/to/docs
 */
export function parseGitHubUrl(url: string): GitHubRef | null {
  const m = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/tree\/([^/]+)(\/.*)?)?$/
  );
  if (!m) return null;

  return {
    owner: m[1]!,
    repo: m[2]!,
    branch: m[3] ?? "main",
    basePath: m[4] ? m[4].replace(/^\//, "") : "",
  };
}

/** How long GitHub responses are reused before being re-fetched (5 minutes). */
export const GITHUB_CACHE_TTL_MS = 5 * 60_000;

/**
 * How often a cloned GitHub repository is pulled when no updateInterval is
 * configured (30 minutes). Deliberately slow: these are external resources
 * that should not be polled hard. Specs published by a local service use the
 * much shorter URL_REFRESH_INTERVAL_MS instead.
 */
export const GIT_UPDATE_INTERVAL_MS = 30 * 60_000;

export class GitHubSource implements DocsSource {
  private readonly ref: GitHubRef;
  private readonly ttlMs: number;
  private fileListCache: string[] | null = null;
  private fileListFetchedAt = 0;
  private fileContentCache = new Map<string, { content: string; fetchedAt: number }>();

  constructor(ref: GitHubRef, ttlMs: number = GITHUB_CACHE_TTL_MS) {
    this.ref = ref;
    this.ttlMs = ttlMs;
  }

  /** True when a value fetched at the given time may still be served. */
  private isFresh(fetchedAt: number): boolean {
    return Date.now() - fetchedAt < this.ttlMs;
  }

  private get rawBase(): string {
    const { owner, repo, branch } = this.ref;
    return `https://raw.githubusercontent.com/${owner}/${repo}/${branch}`;
  }

  private get apiBase(): string {
    const { owner, repo } = this.ref;
    return `https://api.github.com/repos/${owner}/${repo}`;
  }

  private fullPath(relativePath: string): string {
    return this.ref.basePath
      ? `${this.ref.basePath}/${relativePath}`
      : relativePath;
  }

  /** Fetch the recursive file tree from GitHub and filter to our basePath. */
  private async fetchFileList(): Promise<string[]> {
    if (this.fileListCache && this.isFresh(this.fileListFetchedAt)) return this.fileListCache;

    const url = `${this.apiBase}/git/trees/${this.ref.branch}?recursive=1`;
    console.error(`[github] Fetching file tree from ${url}`);
    const res = await fetch(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "markdown-mcp",
        ...(process.env.GITHUB_TOKEN
          ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
    });

    if (!res.ok) {
      throw new Error(
        `GitHub API error (${res.status}): ${await res.text()}`
      );
    }

    const data = (await res.json()) as {
      tree: Array<{ path: string; type: string }>;
    };

    const prefix = this.ref.basePath ? this.ref.basePath + "/" : "";
    const files: string[] = [];
    for (const entry of data.tree) {
      if (entry.type !== "blob") continue;
      if (prefix && !entry.path.startsWith(prefix)) continue;
      // Make path relative to basePath
      const rel = prefix ? entry.path.slice(prefix.length) : entry.path;
      files.push(rel);
    }

    console.error(`[github] File tree loaded: ${files.length} files`);
    this.fileListCache = files;
    this.fileListFetchedAt = Date.now();
    return files;
  }

  async listFiles(pattern: string | string[]): Promise<string[]> {
    const allFiles = await this.fetchFileList();
    return micromatch(allFiles, pattern);
  }

  async readFile(relativePath: string): Promise<string> {
    const cached = this.fileContentCache.get(relativePath);
    if (cached && this.isFresh(cached.fetchedAt)) return cached.content;

    const fullPath = this.fullPath(relativePath);
    const url = `${this.rawBase}/${fullPath}`;
    console.error(`[github] Fetching file: ${relativePath}`);
    const res = await fetch(url, {
      headers: {
        "User-Agent": "markdown-mcp",
        ...(process.env.GITHUB_TOKEN
          ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
    });

    if (!res.ok) {
      throw new Error(`Failed to fetch ${relativePath} (${res.status})`);
    }

    // Enforce file size limit
    const contentLength = res.headers.get("content-length");
    if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
      throw new Error("File too large");
    }

    const content = await res.text();
    if (content.length > MAX_FILE_SIZE) {
      throw new Error("File too large");
    }

    this.fileContentCache.set(relativePath, { content, fetchedAt: Date.now() });
    return content;
  }

  /**
   * The branch head commit, which changes whenever documentation is published.
   * Falls back to a time bucket if the commit cannot be read, so a rebuild is
   * still attempted once per TTL rather than never.
   */
  async getChangeStamp(): Promise<string> {
    const url = `${this.apiBase}/commits/${this.ref.branch}`;
    try {
      const res = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": "markdown-mcp",
          ...(process.env.GITHUB_TOKEN
            ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
            : {}),
        },
      });
      if (!res.ok) throw new Error(`GitHub API error (${res.status})`);

      const data = (await res.json()) as { sha?: string };
      if (data.sha) return data.sha;
      throw new Error("commit response had no sha");
    } catch (err) {
      console.error(`[github] Could not read branch head, falling back to time bucket: ${err}`);
      return `time:${Math.floor(Date.now() / this.ttlMs)}`;
    }
  }

  resolvePath(inputPath: string, appendExtension: string | false = ".md"): string | null {
    return safeRelativePath(inputPath, appendExtension);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GitCloneSource
// ─────────────────────────────────────────────────────────────────────────────

const LAST_UPDATED_FILE = ".last-updated";

/** Shared clone promises keyed by cloneDir so multiple sources reuse one clone. */
const pendingClones = new Map<string, Promise<void>>();

export class GitCloneSource implements DocsSource {
  private readonly ref: GitHubRef;
  private readonly cloneDir: string;
  private readonly docsRoot: string;
  private readonly updateIntervalMs: number;
  private ensurePromise: Promise<void> | null = null;
  private lastCheckedAt = 0;
  private realRoot: string | null = null;
  constructor(ref: GitHubRef, cacheDir: string, updateIntervalMs: number) {
    this.ref = ref;
    // e.g. ~/.cache/markdown-mcp/owner/repo/branch
    this.cloneDir = path.join(cacheDir, ref.owner, ref.repo, ref.branch);
    this.docsRoot = ref.basePath
      ? path.join(this.cloneDir, ref.basePath)
      : this.cloneDir;
    this.updateIntervalMs = updateIntervalMs;

    // Start cloning eagerly so the first request does not pay for it. A
    // failure is reported to the request that needs the clone, not here.
    this.ensureClone().catch(() => {});
  }

  private cloneUrl(): string {
    const { owner, repo } = this.ref;
    if (process.env.GITHUB_TOKEN) {
      return `https://x-access-token:${process.env.GITHUB_TOKEN}@github.com/${owner}/${repo}.git`;
    }
    return `https://github.com/${owner}/${repo}.git`;
  }

  private async isCloned(): Promise<boolean> {
    try {
      await fs.access(path.join(this.cloneDir, ".git"));
      return true;
    } catch {
      return false;
    }
  }

  private async isStale(): Promise<boolean> {
    try {
      const tsFile = path.join(this.cloneDir, LAST_UPDATED_FILE);
      const content = await fs.readFile(tsFile, "utf-8");
      const lastUpdated = parseInt(content.trim(), 10);
      return Date.now() - lastUpdated > this.updateIntervalMs;
    } catch {
      return true;
    }
  }

  private async writeTimestamp(): Promise<void> {
    const tsFile = path.join(this.cloneDir, LAST_UPDATED_FILE);
    await fs.writeFile(tsFile, String(Date.now()), "utf-8");
  }

  private ensureClone(): Promise<void> {
    // Release the completed check once the interval has elapsed so the next
    // request re-evaluates staleness and pulls newly published documentation.
    if (this.ensurePromise && Date.now() - this.lastCheckedAt >= this.updateIntervalMs) {
      this.ensurePromise = null;
    }

    if (!this.ensurePromise) {
      // Share the clone promise across instances targeting the same directory
      const existing = pendingClones.get(this.cloneDir);
      if (existing) {
        this.ensurePromise = existing;
      } else {
        this.lastCheckedAt = Date.now();
        const p = this.doEnsureClone()
          .catch((err) => {
            // Do not cache the failure — let the next request retry.
            if (this.ensurePromise === p) this.ensurePromise = null;
            throw err;
          })
          .finally(() => pendingClones.delete(this.cloneDir));
        pendingClones.set(this.cloneDir, p);
        this.ensurePromise = p;
      }
    }
    return this.ensurePromise;
  }

  private async doEnsureClone(): Promise<void> {
    await resolveGitPath();
    console.error(`[git-clone] Checking clone at ${this.cloneDir}`);
    if (await this.isCloned()) {
      if (await this.isStale()) {
        console.error(`[git-clone] Cache stale, pulling updates: ${this.cloneDir}`);
        try {
          await gitExec(["-C", this.cloneDir, "pull", "--ff-only"]);
        } catch (err) {
          console.error(`[git-clone] Pull failed, using existing cache: ${err}`);
        }
        await this.writeTimestamp();
      } else {
        console.error(`[git-clone] Cache is fresh`);
      }
    } else {
      console.error(`[git-clone] Cloning ${this.ref.owner}/${this.ref.repo}@${this.ref.branch} into ${this.cloneDir}`);
      await fs.mkdir(this.cloneDir, { recursive: true });
      await gitExec([
        "clone",
        "--depth", "1",
        "--branch", this.ref.branch,
        "--single-branch",
        this.cloneUrl(),
        this.cloneDir,
      ]);
      await this.writeTimestamp();
    }

    console.error(`[git-clone] Clone ready at ${this.cloneDir}`);
  }

  private async getRealRoot(): Promise<string> {
    if (!this.realRoot) {
      this.realRoot = await fs.realpath(this.docsRoot);
    }
    return this.realRoot;
  }

  async listFiles(pattern: string | string[]): Promise<string[]> {
    await this.ensureClone();
    return glob(pattern, { cwd: this.docsRoot });
  }

  async readFile(relativePath: string): Promise<string> {
    await this.ensureClone();
    const absPath = path.join(this.docsRoot, relativePath);

    // Resolve symlinks and verify the real path stays within the docs root
    const realPath = await fs.realpath(absPath);
    const realRoot = await this.getRealRoot();
    if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
      throw new Error("Path escapes document root");
    }

    // Enforce file size limit
    const stat = await fs.stat(realPath);
    if (stat.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB, max ${MAX_FILE_SIZE / 1024 / 1024} MB)`
      );
    }

    return fs.readFile(realPath, "utf-8");
  }

  async openStream(relativePath: string): Promise<Readable> {
    await this.ensureClone();
    const realPath = await realPathWithinRoot(this.docsRoot, await this.getRealRoot(), relativePath);
    return createReadStream(realPath);
  }

  async statFile(relativePath: string): Promise<{ size: number }> {
    await this.ensureClone();
    const realPath = await realPathWithinRoot(this.docsRoot, await this.getRealRoot(), relativePath);
    const stat = await fs.stat(realPath);
    return { size: stat.size };
  }

  async getChangeStamp(pattern: string | string[]): Promise<string> {
    await this.ensureClone();
    return stampFromDisk(this.docsRoot, pattern);
  }

  resolvePath(inputPath: string, appendExtension: string | false = ".md"): string | null {
    return safeRelativePath(inputPath, appendExtension);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// UrlSource
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long a spec fetched from a service is served before the next request
 * triggers a background re-fetch (10 seconds). Short enough that a spec being
 * edited right now shows up almost immediately, long enough that an agent
 * working through many tool calls does not flood the service.
 */
export const URL_REFRESH_INTERVAL_MS = 10_000;

/** How long a service is given to answer before the fetch is abandoned. */
const URL_FETCH_TIMEOUT_MS = 5_000;

/** Strip everything that could give a file name meaning to the file system. */
function sanitizeForFileName(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^\.+/, "");
  return cleaned || "spec";
}

/**
 * Derive a schema name from a spec URL, used when no name is configured.
 * "https://host:5001/openapi/v1.json" becomes "v1".
 */
export function schemaNameFromUrl(url: string): string {
  const withoutQuery = url.split(/[?#]/)[0]!;
  const lastSegment = withoutQuery.split("/").filter(Boolean).pop() ?? "spec";
  const withoutExtension = lastSegment.replace(/\.(json|ya?ml)$/i, "");
  return sanitizeForFileName(withoutExtension);
}

/**
 * A schema published by a running service over HTTP.
 *
 * The spec is cached on disk so it stays available while the service is down —
 * which is the normal state for a service that is only started when worked on.
 * Requests are always answered from the cache; the fetch that keeps the cache
 * current runs in the background and its failures are logged, never raised.
 */
export class UrlSource implements DocsSource {
  /** Absolute path of the cached spec. Exposed so callers can report it. */
  readonly cacheFilePath: string;

  private readonly cacheFolder: string;
  private readonly relativePath: string;
  private readonly disk: FileSystemSource;
  private refreshPromise: Promise<void> | null = null;
  /** Why the last fetch kept the cached spec, null when it succeeded. */
  private lastProblem: string | null = null;

  constructor(
    private readonly url: string,
    cacheDir: string,
    schemaName: string,
    private readonly refreshIntervalMs: number = URL_REFRESH_INTERVAL_MS,
    private readonly allowSelfSignedCertificate: boolean = false,
  ) {
    // One folder per service so several services can each cache a "v1.json".
    this.cacheFolder = path.join(cacheDir, "url", sanitizeForFileName(hostOf(url)));
    this.relativePath = `${sanitizeForFileName(schemaName)}.json`;
    this.cacheFilePath = path.join(this.cacheFolder, this.relativePath);
    this.disk = new FileSystemSource(this.cacheFolder);

    // Fetch eagerly so the spec is current by the time the first request
    // arrives. A service that is down is reported, not fatal.
    this.refresh().catch(() => {});
  }

  /**
   * Bring the cached spec up to date. Does nothing when a fetch is already in
   * flight or the cache is younger than the refresh interval.
   */
  refresh(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;

    // Claim the slot synchronously. Awaiting the staleness check first would
    // let requests that arrive together each start their own fetch.
    const p = this.refreshIfStale().finally(() => {
      if (this.refreshPromise === p) this.refreshPromise = null;
    });
    this.refreshPromise = p;
    return p;
  }

  private async refreshIfStale(): Promise<void> {
    if (!(await this.isStale())) return;
    this.lastProblem = await this.fetchSpec();
    if (this.lastProblem) {
      console.error(`[url] ${this.lastProblem}. Keeping cached spec.`);
    } else {
      console.error(`[url] Cached spec at ${this.cacheFilePath}`);
    }
  }

  async freshness(): Promise<SourceFreshness> {
    let fetchedAt: Date | null = null;
    try {
      fetchedAt = (await fs.stat(this.cacheFilePath)).mtime;
    } catch {
      // Nothing cached yet.
    }
    return { origin: this.url, fetchedAt, problem: this.lastProblem };
  }

  private async isStale(): Promise<boolean> {
    try {
      const stat = await fs.stat(this.cacheFilePath);
      return Date.now() - stat.mtimeMs >= this.refreshIntervalMs;
    } catch {
      return true; // Never fetched — always worth trying.
    }
  }

  private async isCached(): Promise<boolean> {
    try {
      await fs.access(this.cacheFilePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Fetch, validate, and store the spec. Returns why the cached spec was kept
   * instead, or null when it was replaced. Never throws.
   */
  private async fetchSpec(): Promise<string | null> {
    try {
      console.error(`[url] Fetching spec: ${this.url}`);
      const res = await this.get();

      if (res.status < 200 || res.status >= 300) {
        return `${this.url} answered ${res.status}`;
      }

      const body = res.body;
      if (body.length > MAX_FILE_SIZE) {
        return `${this.url} answered with a spec larger than ${MAX_FILE_SIZE / 1024 / 1024} MB`;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        return `${this.url} did not answer with JSON — YAML specs are not supported`;
      }

      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return `${this.url} did not answer with a schema`;
      }

      if (!detectFormat(parsed as Record<string, unknown>)) {
        return `${this.url} is not a recognised OpenAPI or JSON Schema document`;
      }

      await this.writeSpec(body);
      return null;
    } catch (err) {
      return `${this.url} could not be fetched: ${describeFetchError(err)}`;
    }
  }

  /**
   * Request the spec.
   *
   * A service running locally over HTTPS normally presents a development
   * certificate that no trust store accepts. Such a source is fetched through
   * the https module, which can waive verification for this one request —
   * unlike fetch, whose trust settings are process wide. Everything else goes
   * through fetch with verification fully intact.
   */
  private async get(): Promise<{ status: number; body: string }> {
    if (!this.allowSelfSignedCertificate) {
      const res = await fetch(this.url, {
        headers: { Accept: "application/json", "User-Agent": "markdown-mcp" },
        signal: AbortSignal.timeout(URL_FETCH_TIMEOUT_MS),
      });
      return { status: res.status, body: await res.text() };
    }
    return httpsGetAllowingUntrustedCertificate(this.url);
  }

  /** Write via a temp file so a reader never sees a half-written spec. */
  private async writeSpec(body: string): Promise<void> {
    await fs.mkdir(this.cacheFolder, { recursive: true });
    const tmp = `${this.cacheFilePath}.tmp`;
    await fs.writeFile(tmp, body, "utf-8");
    await fs.rename(tmp, this.cacheFilePath);
  }

  /**
   * Start a refresh without blocking the caller, so a tool call never waits on
   * a service. The exception is a cold start with nothing cached at all: then
   * the caller waits, because an empty answer would be worse than a short wait.
   */
  private async ensureSpec(): Promise<void> {
    if (await this.isCached()) {
      this.refresh().catch(() => {});
      return;
    }
    await this.refresh().catch(() => {});
  }

  async listFiles(pattern: string | string[]): Promise<string[]> {
    await this.ensureSpec();
    if (!(await this.isCached())) return [];
    return this.disk.listFiles(pattern);
  }

  async readFile(relativePath: string): Promise<string> {
    await this.ensureSpec();
    return this.disk.readFile(relativePath);
  }

  async getChangeStamp(pattern: string | string[]): Promise<string> {
    await this.ensureSpec();
    if (!(await this.isCached())) return "";
    return this.disk.getChangeStamp(pattern);
  }

  resolvePath(inputPath: string, appendExtension: string | false = ".md"): string | null {
    return safeRelativePath(inputPath, appendExtension);
  }
}

/**
 * Fetch a URL over HTTPS without verifying the certificate, for a service that
 * presents a development certificate. Scoped to this single request so the
 * trust settings of every other request are unaffected. Enforces the same size
 * limit as the rest of the server by abandoning an oversized response.
 */
function httpsGetAllowingUntrustedCertificate(
  url: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        rejectUnauthorized: false,
        headers: { Accept: "application/json", "User-Agent": "markdown-mcp" },
        timeout: URL_FETCH_TIMEOUT_MS,
      },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (chunk: string) => {
          body += chunk;
          if (body.length > MAX_FILE_SIZE) {
            req.destroy(new Error("spec exceeds the maximum size"));
          }
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );

    req.on("timeout", () => req.destroy(Object.assign(new Error("timed out"), { name: "TimeoutError" })));
    req.on("error", reject);
    req.end();
  });
}

/** Certificate problems a locally running service typically causes. */
const CERTIFICATE_ERROR_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
]);

/**
 * Explain a failed fetch in terms the reader can act on. Node reports every
 * transport problem as "fetch failed", which hides whether the service is down
 * or simply presenting a development certificate.
 */
function describeFetchError(err: unknown): string {
  // fetch buries the transport error in `cause`; the https module raises it directly.
  const error = err as { code?: string; cause?: { code?: string } };
  const code = error?.code ?? error?.cause?.code;

  if (code && CERTIFICATE_ERROR_CODES.has(code)) {
    return (
      `${code} — the service presented a certificate that is not trusted. ` +
      `If this is your own service running locally, add "allowSelfSignedCertificate": true to the source.`
    );
  }
  if (code === "ECONNREFUSED") return "ECONNREFUSED — nothing is listening, the service is not running";
  if ((err as { name?: string })?.name === "TimeoutError") return "the service did not answer in time";
  if (code) return `${code}`;
  return String(err);
}

/**
 * True when a URL points at this machine. Services running locally over HTTPS
 * present a development certificate, so verification is relaxed for them by
 * default. A spec served from anywhere else must present a valid certificate
 * unless the source opts out explicitly.
 */
export function isLocalhost(url: string): boolean {
  try {
    const { hostname } = new URL(url);
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

/** The host of a URL, or a placeholder when it cannot be parsed. */
function hostOf(url: string): string {
  try {
    return new URL(url).host || "unknown-host";
  } catch {
    return "unknown-host";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Source config
// ─────────────────────────────────────────────────────────────────────────────

export interface SourceConfig {
  /**
   * "disk" for local directories, "github" for GitHub repositories,
   * "url" for a spec published over HTTP by a running service.
   */
  type: "disk" | "github" | "url";
  /** Local path, GitHub URL, or spec URL. */
  origin: string;
  /** What the source provides. */
  kind: "docs" | "api" | "schema" | "data";
  /** Subfolder within the origin (especially useful for GitHub repos). */
  folder?: string;
  /** Schema name for a url source. Defaults to the last URL path segment. */
  name?: string;
  /** Seconds before a url source re-fetches its spec. Defaults to 10. */
  refreshInterval?: number;
  /**
   * Accept an untrusted TLS certificate from this url source. Needed for a
   * service running locally over HTTPS with a development certificate.
   */
  allowSelfSignedCertificate?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

export function createSource(
  docsFolder: string,
  cacheDir?: string,
  updateIntervalMs?: number,
): DocsSource {
  const ghRef = parseGitHubUrl(docsFolder);
  if (ghRef) {
    if (cacheDir) {
      return new GitCloneSource(ghRef, cacheDir, updateIntervalMs ?? GIT_UPDATE_INTERVAL_MS);
    }
    return new GitHubSource(ghRef);
  }
  return new FileSystemSource(path.resolve(docsFolder));
}

/** Well-known git paths on Windows, checked when git is not on PATH. */
const GIT_CANDIDATES = [
  "git",
  "C:\\Program Files\\Git\\cmd\\git.exe",
  "C:\\Program Files\\Git\\bin\\git.exe",
  "C:\\Program Files (x86)\\Git\\cmd\\git.exe",
];

let resolvedGitPath: string | null = null;

async function resolveGitPath(): Promise<string> {
  if (resolvedGitPath) return resolvedGitPath;

  for (const candidate of GIT_CANDIDATES) {
    try {
      await execFileAsync(candidate, ["--version"]);
      resolvedGitPath = candidate;
      console.error(`[git-clone] Using git: ${candidate}`);
      return candidate;
    } catch {
      // try next
    }
  }

  throw new Error("git not found (checked PATH and common install locations)");
}

function gitExec(args: string[]): ReturnType<typeof execFileAsync> {
  if (!resolvedGitPath) throw new Error("git path not resolved yet");
  return execFileAsync(resolvedGitPath, args);
}

export function createSourceFromConfig(
  source: SourceConfig,
  cacheDir?: string,
  updateIntervalMs?: number,
  refreshIntervalMs?: number,
): DocsSource {
  if (source.type === "url") {
    if (!cacheDir) {
      throw new Error(
        `Source "${source.origin}" is fetched over HTTP and must be cached on disk. ` +
          `Configure "cacheDir" (or --cache-dir) to enable url sources.`,
      );
    }
    return new UrlSource(
      source.origin,
      cacheDir,
      source.name ?? schemaNameFromUrl(source.origin),
      source.refreshInterval !== undefined
        ? source.refreshInterval * 1_000
        : refreshIntervalMs ?? URL_REFRESH_INTERVAL_MS,
      source.allowSelfSignedCertificate ?? isLocalhost(source.origin),
    );
  }

  if (source.type === "github") {
    const ghRef = parseGitHubUrl(source.origin);
    if (!ghRef) throw new Error(`Invalid GitHub URL: ${source.origin}`);

    // Append folder to the repo's basePath
    if (source.folder) {
      ghRef.basePath = ghRef.basePath
        ? `${ghRef.basePath}/${source.folder}`
        : source.folder;
    }

    if (cacheDir) {
      return new GitCloneSource(ghRef, cacheDir, updateIntervalMs ?? GIT_UPDATE_INTERVAL_MS);
    }
    return new GitHubSource(ghRef);
  }

  // Disk source
  const dir = source.folder
    ? path.resolve(source.origin, source.folder)
    : path.resolve(source.origin);
  return new FileSystemSource(dir);
}
