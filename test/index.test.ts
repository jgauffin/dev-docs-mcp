import { describe, it, expect } from "vitest";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  resolveDocPath,
  extractToc,
  extractChapters,
  textResult,
  handleGetDocIndex,
  handleReadDocFile,
  handleGetFileToc,
  handleGetChapters,
  handleSearchDocs,
} from "../src/handlers.js";

const execFileAsync = promisify(execFile);
const FIXTURES_PATH = path.resolve(import.meta.dirname, "fixtures");

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
      expect(error.stderr).toContain("Usage: markdown-mcp <docs-folder>");
    }
  });

  it("uses the provided docs folder argument", async () => {
    // Start the server with the fixtures path - it will connect to stdio
    // and print the startup message to stderr, proving it accepted the arg.
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
// resolveDocPath tests
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveDocPath", () => {
  const testDocsRoot = "D:/test/docs";
  const normalizedRoot = path.normalize(testDocsRoot);

  describe("path normalization", () => {
    it("adds .md extension if missing", () => {
      const result = resolveDocPath("readme", testDocsRoot);
      expect(result).toBe(path.join(normalizedRoot, "readme.md"));
    });

    it("does not double-add .md extension", () => {
      const result = resolveDocPath("readme.md", testDocsRoot);
      expect(result).toBe(path.join(normalizedRoot, "readme.md"));
    });

    it("resolves nested paths", () => {
      const result = resolveDocPath("api/endpoints.md", testDocsRoot);
      expect(result).toBe(path.join(normalizedRoot, "api", "endpoints.md"));
    });
  });

  describe("security (directory traversal prevention)", () => {
    it("blocks paths trying to escape with ..", () => {
      const result = resolveDocPath("../../../etc/passwd", testDocsRoot);
      expect(result).toBeNull();
    });

    it("blocks absolute paths outside docs root", () => {
      const result = resolveDocPath("/etc/passwd", testDocsRoot);
      expect(result).toBeNull();
    });

    it("allows valid nested paths", () => {
      const result = resolveDocPath("api/endpoints/users.md", testDocsRoot);
      expect(result).not.toBeNull();
      expect(result).toContain(normalizedRoot);
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
    expect(toc[0]).toContain("Main Title");
    expect(toc[0]).toContain("[Line 1]");
  });

  it("extracts multiple header levels with correct indentation", () => {
    const content = `# Title
## Section 1
### Subsection
## Section 2`;
    const toc = extractToc(content);
    expect(toc).toHaveLength(4);
    expect(toc[0]).toBe("- [Line 1] Title");
    expect(toc[1]).toBe("  - [Line 2] Section 1");
    expect(toc[2]).toBe("    - [Line 3] Subsection");
    expect(toc[3]).toBe("  - [Line 4] Section 2");
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
    expect(toc[5]).toBe("          - [Line 6] H6");
  });

  it("ignores non-header lines", () => {
    const content = `Regular text
# Header
More text
Not a #header`;
    const toc = extractToc(content);
    expect(toc).toHaveLength(1);
    expect(toc[0]).toBe("- [Line 2] Header");
  });

  it("returns empty array for content without headers", () => {
    const content = "Just some plain text\nwith multiple lines";
    const toc = extractToc(content);
    expect(toc).toHaveLength(0);
  });

  it("preserves header text exactly", () => {
    const content = "# Header with `code` and **bold**";
    const toc = extractToc(content);
    expect(toc[0]).toContain("Header with `code` and **bold**");
  });

  it("does not include abstracts by default", () => {
    const content = `# Title

Welcome to the docs.`;
    const toc = extractToc(content);
    expect(toc[0]).toBe("- [Line 1] Title");
  });

  it("includes abstracts when enabled", () => {
    const content = `# Title

Welcome to the docs.

## Usage

Here is how to use it.

## API`;
    const toc = extractToc(content, true);
    expect(toc[0]).toBe("- [Line 1] Title — Welcome to the docs.");
    expect(toc[1]).toBe("  - [Line 5] Usage — Here is how to use it.");
    expect(toc[2]).toBe("  - [Line 9] API");
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
// Handler tests (using fixtures)
// ─────────────────────────────────────────────────────────────────────────────

describe("handleGetDocIndex", () => {
  it("returns list of all markdown files with their titles", async () => {
    const result = await handleGetDocIndex(FIXTURES_PATH);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("## Documentation Index");
    expect(result.content[0].text).toContain("index.md: Framework Documentation");
    expect(result.content[0].text).toContain("api/endpoints.md: API Endpoints");
    expect(result.content[0].text).toContain("components/button.md: Button Component");
  });

  it("includes abstract from first paragraph after heading", async () => {
    const result = await handleGetDocIndex(FIXTURES_PATH);
    const text = result.content[0].text;
    expect(text).toContain("Button Component — A reusable button component.");
    expect(text).toContain("Framework Documentation — Welcome to the framework documentation.");
  });

  it("omits abstract when no paragraph follows the heading", async () => {
    const result = await handleGetDocIndex(FIXTURES_PATH);
    const text = result.content[0].text;
    // API Endpoints has no paragraph after the heading (next line is ## Authentication)
    expect(text).toMatch(/api\/endpoints\.md: API Endpoints$/m);
  });

  it("returns error when docs root does not exist", async () => {
    const result = await handleGetDocIndex("/nonexistent/path");
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No documentation files found");
  });
});

describe("handleReadDocFile", () => {
  it("reads a documentation file", async () => {
    const result = await handleReadDocFile({ file_path: "index.md" }, FIXTURES_PATH);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("# Framework Documentation");
  });

  it("returns error for invalid arguments", async () => {
    const result = await handleReadDocFile({} as { file_path: string }, FIXTURES_PATH);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid arguments");
  });

  it("returns error for non-existent file", async () => {
    const result = await handleReadDocFile({ file_path: "nonexistent.md" }, FIXTURES_PATH);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("File not found");
  });

  it("blocks directory traversal attempts", async () => {
    const result = await handleReadDocFile({ file_path: "../../../etc/passwd" }, FIXTURES_PATH);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid path");
  });
});

describe("handleGetFileToc", () => {
  it("extracts table of contents from a file", async () => {
    const result = await handleGetFileToc({ file_path: "api/endpoints.md" }, FIXTURES_PATH);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Table of Contents");
    expect(result.content[0].text).toContain("API Endpoints");
    expect(result.content[0].text).toContain("Authentication");
  });

  it("excludes abstracts by default", async () => {
    const result = await handleGetFileToc({ file_path: "components/button.md" }, FIXTURES_PATH);
    expect(result.content[0].text).not.toContain("—");
  });

  it("includes abstracts when requested", async () => {
    const result = await handleGetFileToc({ file_path: "components/button.md", include_abstracts: true }, FIXTURES_PATH);
    expect(result.content[0].text).toContain("Button Component — A reusable button component.");
  });

  it("returns error for non-existent file", async () => {
    const result = await handleGetFileToc({ file_path: "nonexistent.md" }, FIXTURES_PATH);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("File not found");
  });
});

describe("handleGetChapters", () => {
  it("returns content of requested chapters", async () => {
    const result = await handleGetChapters(
      { file_path: "api/endpoints.md", headings: ["Authentication"] },
      FIXTURES_PATH
    );
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("## Authentication");
    expect(result.content[0].text).toContain("POST /auth/login");
  });

  it("returns multiple chapters separated by dividers", async () => {
    const result = await handleGetChapters(
      { file_path: "api/endpoints.md", headings: ["Authentication", "Error Handling"] },
      FIXTURES_PATH
    );
    expect(result.content[0].text).toContain("## Authentication");
    expect(result.content[0].text).toContain("## Error Handling");
    expect(result.content[0].text).toContain("---");
  });

  it("returns message when no chapters match", async () => {
    const result = await handleGetChapters(
      { file_path: "api/endpoints.md", headings: ["Nonexistent"] },
      FIXTURES_PATH
    );
    expect(result.content[0].text).toContain("No matching chapters found");
  });

  it("returns error for non-existent file", async () => {
    const result = await handleGetChapters(
      { file_path: "nonexistent.md", headings: ["Test"] },
      FIXTURES_PATH
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("File not found");
  });
});

describe("handleSearchDocs", () => {
  it("finds matches across documentation files", async () => {
    const result = await handleSearchDocs({ query: "Button" }, FIXTURES_PATH);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("Search Results");
    expect(result.content[0].text).toContain("button.md");
  });

  it("filters by glob pattern", async () => {
    const result = await handleSearchDocs({ query: "#", path_pattern: "api/" }, FIXTURES_PATH);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("endpoints.md");
    expect(result.content[0].text).not.toContain("button.md");
  });

  it("supports glob wildcards in path pattern", async () => {
    const result = await handleSearchDocs({ query: "Component", path_pattern: "components/*.md" }, FIXTURES_PATH);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("button.md");
    expect(result.content[0].text).not.toContain("endpoints.md");
  });

  it("returns no matches message when nothing found", async () => {
    const result = await handleSearchDocs({ query: "xyznonexistent123" }, FIXTURES_PATH);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toBe("No matches found.");
  });

  it("returns error for invalid regex", async () => {
    const result = await handleSearchDocs({ query: "[invalid" }, FIXTURES_PATH);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Invalid regex pattern");
  });
});
