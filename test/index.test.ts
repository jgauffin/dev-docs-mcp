import { describe, it, expect } from "vitest";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  extractToc,
  extractChapters,
  textResult,
  handleGetDocIndex,
  handleGetSubIndex,
  handleReadDocFile,
  handleGetFileToc,
  handleGetChapters,
  handleSearchDocs,
} from "../src/markdown/handlers.js";
import { FileSystemSource, GitHubSource, parseGitHubUrl } from "../src/source.js";

const execFileAsync = promisify(execFile);
const FIXTURES_PATH = path.resolve(import.meta.dirname, "fixtures");
const fixturesSource = new FileSystemSource(FIXTURES_PATH);

// ─────────────────────────────────────────────────────────────────────────────
// CLI argument tests
// ─────────────────────────────────────────────────────────────────────────────

describe("CLI argument", () => {
  it("exits with error when no docs folder argument is provided", async () => {
    try {
      await execFileAsync("node", ["dist/index.js"]);
      expect.fail("should have exited with non-zero code");
    } catch (err: unknown) {
      const error = err as { code: number; stderr: string };
      expect(error.code).toBe(1);
      expect(error.stderr).toContain("Usage:");
    }
  });

  it("uses the provided docs folder argument", async () => {
    const child = execFile("node", ["dist/index.js", FIXTURES_PATH]);

    const stderr = await new Promise<string>((resolve, reject) => {
      let data = "";
      child.stderr?.on("data", (chunk) => {
        data += chunk;
        if (data.includes("running on stdio")) {
          resolve(data);
        }
      });
      child.on("error", reject);
      setTimeout(() => resolve(data), 3000);
    });

    child.kill();
    expect(stderr).toContain("MCP Server running on stdio");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// resolvePath tests
// ─────────────────────────────────────────────────────────────────────────────

describe("resolvePath", () => {
  const source = new FileSystemSource("D:/test/docs");

  describe("path normalization", () => {
    it("adds .md extension if missing", () => {
      const result = source.resolvePath("readme");
      expect(result).toBe("readme.md");
    });

    it("does not double-add .md extension", () => {
      const result = source.resolvePath("readme.md");
      expect(result).toBe("readme.md");
    });

    it("resolves nested paths", () => {
      const result = source.resolvePath("api/endpoints.md");
      expect(result).toBe("api/endpoints.md");
    });
  });

  describe("security (directory traversal prevention)", () => {
    it("blocks paths trying to escape with ..", () => {
      const result = source.resolvePath("../../../etc/passwd");
      expect(result).toBeNull();
    });

    it("blocks absolute paths outside docs root", () => {
      const result = source.resolvePath("/etc/passwd");
      expect(result).toBeNull();
    });

    it("allows valid nested paths", () => {
      const result = source.resolvePath("api/endpoints/users.md");
      expect(result).not.toBeNull();
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractToc tests
// ─────────────────────────────────────────────────────────────────────────────

describe("extractToc", () => {
  it("extracts h1 headers", () => {
    const content = "# Main Title";
    const toc = extractToc(content);
    expect(toc).toHaveLength(1);
    expect(toc[0]).toEqual({ line: 1, title: "Main Title", level: 1 });
  });

  it("extracts multiple header levels with correct structure", () => {
    const content = `# Title
## Section 1
### Subsection
## Section 2`;
    const toc = extractToc(content);
    expect(toc).toHaveLength(4);
    expect(toc[0]).toEqual({ line: 1, title: "Title", level: 1 });
    expect(toc[1]).toEqual({ line: 2, title: "Section 1", level: 2 });
    expect(toc[2]).toEqual({ line: 3, title: "Subsection", level: 3 });
    expect(toc[3]).toEqual({ line: 4, title: "Section 2", level: 2 });
  });

  it("handles all header levels (h1-h6)", () => {
    const content = `# H1
## H2
### H3
#### H4
##### H5
###### H6`;
    const toc = extractToc(content);
    expect(toc).toHaveLength(6);
    expect(toc[5]).toEqual({ line: 6, title: "H6", level: 6 });
  });

  it("ignores non-header lines", () => {
    const content = `Regular text
# Header
More text
Not a #header`;
    const toc = extractToc(content);
    expect(toc).toHaveLength(1);
    expect(toc[0]).toEqual({ line: 2, title: "Header", level: 1 });
  });

  it("returns empty array for content without headers", () => {
    const content = "Just some plain text\nwith multiple lines";
    const toc = extractToc(content);
    expect(toc).toHaveLength(0);
  });

  it("preserves header text exactly", () => {
    const content = "# Header with `code` and **bold**";
    const toc = extractToc(content);
    expect(toc[0]!.title).toBe("Header with `code` and **bold**");
  });

  it("does not include abstracts by default", () => {
    const content = `# Title

Welcome to the docs.`;
    const toc = extractToc(content);
    expect(toc[0]).toEqual({ line: 1, title: "Title", level: 1 });
    expect(toc[0]!.abstract).toBeUndefined();
  });

  it("includes abstracts when enabled", () => {
    const content = `# Title

Welcome to the docs.

## Usage

Here is how to use it.

## API`;
    const toc = extractToc(content, true);
    expect(toc[0]).toEqual({ line: 1, title: "Title", level: 1, abstract: "Welcome to the docs." });
    expect(toc[1]).toEqual({ line: 5, title: "Usage", level: 2, abstract: "Here is how to use it." });
    expect(toc[2]).toEqual({ line: 9, title: "API", level: 2 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// extractChapters tests
// ─────────────────────────────────────────────────────────────────────────────

describe("extractChapters", () => {
  const content = `# API Endpoints

## Authentication

### POST /auth/login

Authenticates a user.

### POST /auth/logout

Invalidates the session.

## Users

### GET /users

Returns all users.

## Error Handling

All endpoints return errors.`;

  it("extracts a single chapter by heading name", () => {
    const chapters = extractChapters(content, ["Authentication"]);
    expect(chapters.size).toBe(1);
    const auth = chapters.get("Authentication")!;
    expect(auth).toContain("## Authentication");
    expect(auth).toContain("POST /auth/login");
    expect(auth).toContain("POST /auth/logout");
    expect(auth).not.toContain("## Users");
  });

  it("extracts multiple chapters", () => {
    const chapters = extractChapters(content, ["Authentication", "Error Handling"]);
    expect(chapters.size).toBe(2);
    expect(chapters.has("Authentication")).toBe(true);
    expect(chapters.has("Error Handling")).toBe(true);
  });

  it("matches headings case-insensitively", () => {
    const chapters = extractChapters(content, ["authentication"]);
    expect(chapters.size).toBe(1);
    expect(chapters.has("Authentication")).toBe(true);
  });

  it("returns empty map for non-existent headings", () => {
    const chapters = extractChapters(content, ["Nonexistent"]);
    expect(chapters.size).toBe(0);
  });

  it("stops chapter at next heading of same or higher level", () => {
    const chapters = extractChapters(content, ["Users"]);
    const users = chapters.get("Users")!;
    expect(users).toContain("GET /users");
    expect(users).not.toContain("Error Handling");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// textResult tests
// ─────────────────────────────────────────────────────────────────────────────

describe("textResult", () => {
  it("creates a success result by default", () => {
    const result = textResult("Success message");
    expect(result).toEqual({
      content: [{ type: "text", text: "Success message" }],
      isError: false,
    });
  });

  it("creates an error result when isError is true", () => {
    const result = textResult("Error message", true);
    expect(result).toEqual({
      content: [{ type: "text", text: "Error message" }],
      isError: true,
    });
  });

  it("handles empty strings", () => {
    const result = textResult("");
    expect(result.content[0].text).toBe("");
  });

  it("handles multiline text", () => {
    const text = "Line 1\nLine 2\nLine 3";
    const result = textResult(text);
    expect(result.content[0].text).toBe(text);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Handler tests (using fixtures) — all YAML output
// ─────────────────────────────────────────────────────────────────────────────

describe("handleGetDocIndex", () => {
  it("returns YAML index of all markdown files", async () => {
    const result = await handleGetDocIndex(fixturesSource);
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("doc_index:");
    expect(text).toContain("total:");
    expect(text).toContain("entries:");
  });

  it("includes file paths and titles in YAML entries", async () => {
    const result = await handleGetDocIndex(fixturesSource);
    const text = result.content[0].text;
    expect(text).toContain('"index.md"');
    expect(text).toContain('"Framework Documentation"');
    expect(text).toContain('"api/endpoints.md"');
    expect(text).toContain('"API Endpoints"');
    expect(text).toContain('"components/button.md"');
    expect(text).toContain('"Button Component"');
  });

  it("includes abstracts in YAML entries", async () => {
    const result = await handleGetDocIndex(fixturesSource);
    const text = result.content[0].text;
    expect(text).toContain('"A reusable button component."');
    expect(text).toContain('"Welcome to the framework documentation."');
  });

  it("returns error when docs root does not exist", async () => {
    const badSource = new FileSystemSource("/nonexistent/path");
    const result = await handleGetDocIndex(badSource);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No documentation files found");
  });
});

describe("handleReadDocFile", () => {
  it("reads a documentation file and returns raw markdown", async () => {
    const result = await handleReadDocFile({ file_path: "index.md" }, fixturesSource);
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("# Framework Documentation");
  });

  it("returns error for invalid arguments", async () => {
    const result = await handleReadDocFile({} as { file_path: string }, fixturesSource);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("file_path is required");
  });

  it("returns error for non-existent file", async () => {
    const result = await handleReadDocFile({ file_path: "nonexistent.md" }, fixturesSource);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("File not found");
  });

  it("blocks directory traversal attempts", async () => {
    const result = await handleReadDocFile({ file_path: "../../../etc/passwd" }, fixturesSource);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid path");
  });
});

describe("handleGetFileToc", () => {
  it("extracts table of contents as YAML", async () => {
    const result = await handleGetFileToc({ file_path: "api/endpoints.md" }, fixturesSource);
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("toc:");
    expect(text).toContain('file: "api/endpoints.md"');
    expect(text).toContain("headings:");
    expect(text).toContain('"API Endpoints"');
    expect(text).toContain('"Authentication"');
  });

  it("excludes abstracts by default", async () => {
    const result = await handleGetFileToc({ file_path: "components/button.md" }, fixturesSource);
    expect(result.content[0].text).not.toContain("abstract:");
  });

  it("includes abstracts when requested", async () => {
    const result = await handleGetFileToc({ file_path: "components/button.md", include_abstracts: true }, fixturesSource);
    const text = result.content[0].text;
    expect(text).toContain("abstract:");
    expect(text).toContain('"A reusable button component."');
  });

  it("returns error for non-existent file", async () => {
    const result = await handleGetFileToc({ file_path: "nonexistent.md" }, fixturesSource);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("File not found");
  });
});

describe("handleGetChapters", () => {
  it("returns YAML with requested chapter content", async () => {
    const result = await handleGetChapters(
      { file_path: "api/endpoints.md", headings: ["Authentication"] },
      fixturesSource
    );
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("chapters:");
    expect(text).toContain('file: "api/endpoints.md"');
    expect(text).toContain("sections:");
    expect(text).toContain('"Authentication"');
    expect(text).toContain("content: |");
    expect(text).toContain("POST /auth/login");
  });

  it("returns multiple chapters in YAML sections", async () => {
    const result = await handleGetChapters(
      { file_path: "api/endpoints.md", headings: ["Authentication", "Error Handling"] },
      fixturesSource
    );
    const text = result.content[0].text;
    expect(text).toContain('"Authentication"');
    expect(text).toContain('"Error Handling"');
  });

  it("returns error message when no chapters match", async () => {
    const result = await handleGetChapters(
      { file_path: "api/endpoints.md", headings: ["Nonexistent"] },
      fixturesSource
    );
    expect(result.content[0].text).toContain("No matching chapters found");
  });

  it("returns error for non-existent file", async () => {
    const result = await handleGetChapters(
      { file_path: "nonexistent.md", headings: ["Test"] },
      fixturesSource
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("File not found");
  });
});

describe("handleSearchDocs", () => {
  it("finds matches and returns YAML", async () => {
    const result = await handleSearchDocs({ query: "Button" }, fixturesSource);
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("search:");
    expect(text).toContain('query: "Button"');
    expect(text).toContain("total:");
    expect(text).toContain("results:");
    expect(text).toContain("button.md");
  });

  it("filters by glob pattern", async () => {
    const result = await handleSearchDocs({ query: "#", path_pattern: "api/" }, fixturesSource);
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("endpoints.md");
    expect(text).not.toContain("button.md");
  });

  it("supports glob wildcards in path pattern", async () => {
    const result = await handleSearchDocs({ query: "Component", path_pattern: "components/*.md" }, fixturesSource);
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("button.md");
    expect(text).not.toContain("endpoints.md");
  });

  it("supports | delimited glob patterns for OR search", async () => {
    const result = await handleSearchDocs({ query: "#", path_pattern: "api/|components/" }, fixturesSource);
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("endpoints.md");
    expect(text).toContain("button.md");
    // Should not include files from other folders like guides/
    expect(text).not.toContain("getting-started.md");
  });

  it("returns no matches message when nothing found", async () => {
    const result = await handleSearchDocs({ query: "xyznonexistent123" }, fixturesSource);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe("No matches found.");
  });

  it("returns error for invalid regex", async () => {
    const result = await handleSearchDocs({ query: "[invalid" }, fixturesSource);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid regex pattern");
  });

  it("rejects ReDoS patterns with nested quantifiers", async () => {
    const result = await handleSearchDocs({ query: "(a+)+" }, fixturesSource);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unsafe regex");
  });

  it("rejects excessively long regex patterns", async () => {
    const longPattern = "a".repeat(201);
    const result = await handleSearchDocs({ query: longPattern }, fixturesSource);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unsafe regex");
  });

  it("rejects path_pattern with traversal", async () => {
    const result = await handleSearchDocs({ query: "test", path_pattern: "../../etc/" }, fixturesSource);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid path_pattern");
  });

  it("rejects path_pattern with dangerous glob metacharacters", async () => {
    const result = await handleSearchDocs({ query: "test", path_pattern: "foo{bar,baz}" }, fixturesSource);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid path_pattern");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Security tests
// ─────────────────────────────────────────────────────────────────────────────

describe("GitHubSource.resolvePath", () => {
  const ref = parseGitHubUrl("https://github.com/owner/repo")!;
  const ghSource = new GitHubSource(ref);

  it("blocks bare '..'", () => {
    expect(ghSource.resolvePath("..")).toBeNull();
  });

  it("blocks trailing '..' (foo/..)", () => {
    expect(ghSource.resolvePath("foo/..")).toBeNull();
  });

  it("blocks deep traversal (a/b/../../..)", () => {
    expect(ghSource.resolvePath("a/b/../../..")).toBeNull();
  });

  it("blocks null bytes", () => {
    expect(ghSource.resolvePath("foo\0bar")).toBeNull();
  });

  it("blocks absolute paths", () => {
    expect(ghSource.resolvePath("/etc/passwd")).toBeNull();
  });

  it("allows valid relative paths", () => {
    expect(ghSource.resolvePath("docs/readme")).toBe("docs/readme.md");
  });

  it("normalizes backslashes", () => {
    expect(ghSource.resolvePath("docs\\readme")).toBe("docs/readme.md");
  });
});

describe("handleGetSubIndex security", () => {
  it("rejects paths with glob metacharacters", async () => {
    const result = await handleGetSubIndex({ path: "foo{bar}" }, fixturesSource);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid path");
  });

  it("rejects paths with traversal", async () => {
    const result = await handleGetSubIndex({ path: "../../etc" }, fixturesSource);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid path");
  });
});
