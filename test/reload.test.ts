import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { FileSystemSource } from "../src/source.js";
import { ApiDocIndex } from "../src/api/handlers.js";
import { SchemaIndex } from "../src/schema/handlers.js";
import { TypeDocParser } from "../src/api/parsers/typedoc-parser.js";

// ─────────────────────────────────────────────────────────────────────────────
// These tests prove the business rule: documentation served by the MCP server
// must reflect what is on disk right now. A writer who edits a document and
// asks the server again must see the edit, not the version cached at startup.
// ─────────────────────────────────────────────────────────────────────────────

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "markdown-mcp-reload-"));
});

afterEach(async () => {
  await fs.rm(tempDir, { recursive: true, force: true });
});

/**
 * File modification times have coarse resolution on some file systems, so
 * writes made microseconds apart can share a timestamp. Push the stamp
 * forward explicitly so the test proves change detection, not clock luck.
 */
async function writeFileWithNewerTimestamp(file: string, content: string): Promise<void> {
  await fs.writeFile(file, content, "utf-8");
  const future = new Date(Date.now() + 2000);
  await fs.utimes(file, future, future);
}

function typeDocProject(typeName: string, summary: string): string {
  return JSON.stringify({
    schemaVersion: "2.0",
    variant: "project",
    name: "sample",
    kind: 1,
    children: [
      {
        id: 1,
        name: typeName,
        variant: "declaration",
        kind: 128,
        comment: { summary: [{ kind: "text", text: summary }] },
        children: [],
      },
    ],
  });
}

function jsonSchema(definitionName: string): string {
  return JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Orders",
    definitions: {
      [definitionName]: { type: "object", description: "A booked order." },
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// API documentation
// ─────────────────────────────────────────────────────────────────────────────

describe("API documentation reload", () => {
  it("serves a type that was added after the index was first built", async () => {
    const file = path.join(tempDir, "api.json");
    await fs.writeFile(file, typeDocProject("Booking", "The original booking."), "utf-8");

    const index = new ApiDocIndex(new FileSystemSource(tempDir), [new TypeDocParser()]);
    await index.getNamespaces();
    expect(index.findType("Invoice")).toBeNull();

    await writeFileWithNewerTimestamp(file, typeDocProject("Invoice", "A new invoice."));

    await index.getNamespaces();
    expect(index.findType("Invoice")).not.toBeNull();
  });

  it("stops serving a type after its documentation file is deleted", async () => {
    const file = path.join(tempDir, "api.json");
    await fs.writeFile(file, typeDocProject("Booking", "The original booking."), "utf-8");

    const index = new ApiDocIndex(new FileSystemSource(tempDir), [new TypeDocParser()]);
    await index.getNamespaces();
    expect(index.findType("Booking")).not.toBeNull();

    await fs.rm(file);

    await index.getNamespaces();
    expect(index.findType("Booking")).toBeNull();
  });

  it("reuses the built index while no documentation file has changed", async () => {
    const file = path.join(tempDir, "api.json");
    await fs.writeFile(file, typeDocProject("Booking", "The original booking."), "utf-8");

    const index = new ApiDocIndex(new FileSystemSource(tempDir), [new TypeDocParser()]);
    const first = await index.getNamespaces();
    const second = await index.getNamespaces();

    expect(second).toBe(first);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Schema documentation
// ─────────────────────────────────────────────────────────────────────────────

describe("Schema documentation reload", () => {
  it("serves a definition that was added after the index was first built", async () => {
    const file = path.join(tempDir, "orders.json");
    await fs.writeFile(file, jsonSchema("Order"), "utf-8");

    const index = new SchemaIndex(new FileSystemSource(tempDir));
    const before = await index.get();
    expect([...before.values()][0]!.definitions.has("Shipment")).toBe(false);

    await writeFileWithNewerTimestamp(file, jsonSchema("Shipment"));

    const after = await index.get();
    expect([...after.values()][0]!.definitions.has("Shipment")).toBe(true);
  });

  it("serves a schema file that was added after the index was first built", async () => {
    await fs.writeFile(path.join(tempDir, "orders.json"), jsonSchema("Order"), "utf-8");

    const index = new SchemaIndex(new FileSystemSource(tempDir));
    expect((await index.get()).size).toBe(1);

    await fs.writeFile(path.join(tempDir, "invoices.json"), jsonSchema("Invoice"), "utf-8");

    expect((await index.get()).size).toBe(2);
  });

  it("reuses the built index while no schema file has changed", async () => {
    await fs.writeFile(path.join(tempDir, "orders.json"), jsonSchema("Order"), "utf-8");

    const index = new SchemaIndex(new FileSystemSource(tempDir));
    const first = await index.get();
    const second = await index.get();

    expect(second).toBe(first);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Change detection
// ─────────────────────────────────────────────────────────────────────────────

describe("Change detection", () => {
  it("reports a new stamp when a document is edited", async () => {
    const file = path.join(tempDir, "guide.md");
    await fs.writeFile(file, "# Guide", "utf-8");

    const source = new FileSystemSource(tempDir);
    const before = await source.getChangeStamp("**/*.md");

    await writeFileWithNewerTimestamp(file, "# Guide\n\nNow with content.");

    expect(await source.getChangeStamp("**/*.md")).not.toBe(before);
  });

  it("reports the same stamp when nothing has changed", async () => {
    await fs.writeFile(path.join(tempDir, "guide.md"), "# Guide", "utf-8");

    const source = new FileSystemSource(tempDir);

    expect(await source.getChangeStamp("**/*.md")).toBe(
      await source.getChangeStamp("**/*.md"),
    );
  });

  it("reports a new stamp when a document is deleted", async () => {
    const file = path.join(tempDir, "guide.md");
    await fs.writeFile(file, "# Guide", "utf-8");

    const source = new FileSystemSource(tempDir);
    const before = await source.getChangeStamp("**/*.md");

    await fs.rm(file);

    expect(await source.getChangeStamp("**/*.md")).not.toBe(before);
  });
});
