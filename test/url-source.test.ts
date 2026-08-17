import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { UrlSource, createSourceFromConfig } from "../src/source.js";
import { SchemaIndex } from "../src/schema/handlers.js";

// ─────────────────────────────────────────────────────────────────────────────
// These tests prove the business rules for services that publish their OpenAPI
// spec over HTTP but are not running all the time:
//
//   * The spec is fetched and cached, so no one has to copy files by hand.
//   * A service being down never breaks the server — the last known spec is
//     still served.
//   * A spec being edited right now shows up within seconds, without the
//     server hammering the service on every single request.
// ─────────────────────────────────────────────────────────────────────────────

const SPEC_URL = "https://localhost:5001/openapi/v1.json";
const REFRESH_INTERVAL_MS = 10_000;

let cacheDir: string;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  cacheDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-url-cache-"));
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(cacheDir, { recursive: true, force: true, maxRetries: 3 });
});

/** An OpenAPI document exposing a single named schema. */
function openApiSpec(schemaName: string): string {
  return JSON.stringify({
    openapi: "3.0.1",
    info: { title: "Orders API", description: "Handles customer orders." },
    paths: {},
    components: {
      schemas: {
        [schemaName]: { type: "object", description: "A booked order." },
      },
    },
  });
}

/**
 * A service that answers with the given body. A fresh Response is built per
 * call because a Response body can only be read once.
 */
function respondWith(body: string): () => Promise<Response> {
  return async () =>
    new Response(body, { status: 200, headers: { "content-type": "application/json" } });
}

/** A service that is not running. */
function connectionRefused(): Promise<never> {
  return Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5001"));
}

function createSource(refreshIntervalMs = REFRESH_INTERVAL_MS): UrlSource {
  return new UrlSource(SPEC_URL, cacheDir, "orders", refreshIntervalMs);
}

/**
 * Make the cached spec look older than the refresh interval, so the next
 * request is expected to re-fetch. Modification times are the staleness
 * signal, exactly as they are for documentation on disk.
 */
async function backdateCachedSpec(source: UrlSource, ageMs: number): Promise<void> {
  const past = new Date(Date.now() - ageMs);
  await fs.utimes(source.cacheFilePath, past, past);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetching and caching
// ─────────────────────────────────────────────────────────────────────────────

describe("Fetching a spec from a service", () => {
  it("fetches_and_serves_a_spec_the_first_time_a_service_is_queried", async () => {
    fetchMock.mockImplementation(respondWith(openApiSpec("Order")));

    const source = createSource();
    const files = await source.listFiles("**/*.json");

    expect(files).toEqual(["orders.json"]);
    expect(JSON.parse(await source.readFile("orders.json")).components.schemas).toHaveProperty(
      "Order",
    );
  });

  it("stores_the_fetched_spec_under_the_cache_directory_so_it_survives_a_restart", async () => {
    fetchMock.mockImplementation(respondWith(openApiSpec("Order")));

    const source = createSource();
    await source.listFiles("**/*.json");

    const cached = await fs.readFile(source.cacheFilePath, "utf-8");
    expect(JSON.parse(cached).info.title).toBe("Orders API");
    expect(source.cacheFilePath.startsWith(cacheDir)).toBe(true);
  });

  it("exposes_the_spec_through_the_schema_tools_using_the_configured_name", async () => {
    fetchMock.mockImplementation(respondWith(openApiSpec("Order")));

    const schemas = await new SchemaIndex(createSource()).get();

    expect([...schemas.keys()]).toEqual(["orders"]);
    expect(schemas.get("orders")!.definitions.has("Order")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Surviving an unreachable service
// ─────────────────────────────────────────────────────────────────────────────

describe("Serving a spec while its service is down", () => {
  it("keeps_serving_the_last_cached_spec_when_the_service_is_unreachable", async () => {
    fetchMock.mockImplementation(respondWith(openApiSpec("Order")));
    const warm = createSource();
    await warm.listFiles("**/*.json");

    fetchMock.mockImplementation(connectionRefused);
    const cold = createSource();
    await backdateCachedSpec(cold, REFRESH_INTERVAL_MS * 2);

    expect(await cold.listFiles("**/*.json")).toEqual(["orders.json"]);
    expect(JSON.parse(await cold.readFile("orders.json")).components.schemas).toHaveProperty(
      "Order",
    );
  });

  it("reports_no_schemas_instead_of_failing_when_the_service_was_never_reachable", async () => {
    fetchMock.mockImplementation(connectionRefused);

    const schemas = await new SchemaIndex(createSource()).get();

    expect(schemas.size).toBe(0);
  });

  it("reports_no_schemas_instead_of_failing_when_the_service_returns_an_error_status", async () => {
    fetchMock.mockResolvedValue(new Response("Service Unavailable", { status: 503 }));

    const schemas = await new SchemaIndex(createSource()).get();

    expect(schemas.size).toBe(0);
  });

  it("rejects_a_response_that_is_not_a_recognised_schema", async () => {
    fetchMock.mockImplementation(respondWith(openApiSpec("Order")));
    const source = createSource();
    await source.listFiles("**/*.json");

    // The service is replaced by something that is not a spec at all — a login
    // page, for instance. The known-good spec must not be overwritten.
    fetchMock.mockImplementation(respondWith("<html>Sign in</html>"));
    await backdateCachedSpec(source, REFRESH_INTERVAL_MS * 2);
    await source.refresh();

    expect(JSON.parse(await source.readFile("orders.json")).components.schemas).toHaveProperty(
      "Order",
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Picking up published changes
// ─────────────────────────────────────────────────────────────────────────────

describe("Picking up a spec change", () => {
  it("serves_the_updated_spec_after_the_service_publishes_a_change", async () => {
    fetchMock.mockImplementation(respondWith(openApiSpec("Order")));
    const source = createSource();
    const index = new SchemaIndex(source);

    expect((await index.get()).get("orders")!.definitions.has("Shipment")).toBe(false);

    fetchMock.mockImplementation(respondWith(openApiSpec("Shipment")));
    await backdateCachedSpec(source, REFRESH_INTERVAL_MS * 2);
    await source.refresh();

    expect((await index.get()).get("orders")!.definitions.has("Shipment")).toBe(true);
  });

  it("does_not_refetch_while_the_cached_spec_is_still_fresh", async () => {
    fetchMock.mockImplementation(respondWith(openApiSpec("Order")));
    const source = createSource();

    await source.listFiles("**/*.json");
    await source.refresh();
    await source.refresh();

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refetches_once_the_refresh_interval_has_elapsed", async () => {
    fetchMock.mockImplementation(respondWith(openApiSpec("Order")));
    const source = createSource();
    await source.listFiles("**/*.json");

    await backdateCachedSpec(source, REFRESH_INTERVAL_MS * 2);
    await source.refresh();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("asks_the_service_only_once_when_several_requests_arrive_together", async () => {
    fetchMock.mockImplementation(respondWith(openApiSpec("Order")));
    const source = createSource();

    await Promise.all([
      source.listFiles("**/*.json"),
      source.listFiles("**/*.json"),
      source.getChangeStamp("**/*.json"),
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Cache isolation
// ─────────────────────────────────────────────────────────────────────────────

describe("Cache isolation", () => {
  it("keeps_the_cached_file_within_the_cache_directory_for_a_hostile_url", () => {
    const source = new UrlSource(
      "https://../../evil/openapi.json",
      cacheDir,
      "../../../etc/passwd",
      REFRESH_INTERVAL_MS,
    );

    expect(path.resolve(source.cacheFilePath).startsWith(path.resolve(cacheDir))).toBe(true);
  });

  it("gives_two_services_separate_cache_files", async () => {
    fetchMock.mockImplementation(respondWith(openApiSpec("Order")));

    const orders = new UrlSource(SPEC_URL, cacheDir, "orders", REFRESH_INTERVAL_MS);
    const billing = new UrlSource(
      "https://localhost:5002/openapi/v1.json",
      cacheDir,
      "billing",
      REFRESH_INTERVAL_MS,
    );
    await Promise.all([orders.listFiles("**/*.json"), billing.listFiles("**/*.json")]);

    expect(orders.cacheFilePath).not.toBe(billing.cacheFilePath);
    expect(await orders.listFiles("**/*.json")).toEqual(["orders.json"]);
    expect(await billing.listFiles("**/*.json")).toEqual(["billing.json"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// Locally running services over HTTPS
// ─────────────────────────────────────────────────────────────────────────────

describe("Reaching a service that uses a development certificate", () => {
  /** How Node reports an untrusted certificate. */
  function untrustedCertificate(): Promise<never> {
    return Promise.reject(
      Object.assign(new TypeError("fetch failed"), {
        cause: { code: "DEPTH_ZERO_SELF_SIGNED_CERT" },
      }),
    );
  }

  it("accepts_the_development_certificate_of_a_service_on_localhost_by_default", async () => {
    // A localhost source bypasses fetch entirely, so a rejecting fetch proves
    // the request did not go through the verifying path.
    fetchMock.mockImplementation(untrustedCertificate);

    const source = createSourceFromConfig(
      { type: "url", origin: SPEC_URL, kind: "schema", name: "orders" },
      cacheDir,
      undefined,
      REFRESH_INTERVAL_MS,
    );
    await source.listFiles("**/*.json").catch(() => {});

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("verifies_the_certificate_of_a_service_that_is_not_on_this_machine", async () => {
    fetchMock.mockImplementation(respondWith(openApiSpec("Order")));

    const source = createSourceFromConfig(
      { type: "url", origin: "https://api.example.com/openapi/v1.json", kind: "schema", name: "orders" },
      cacheDir,
      undefined,
      REFRESH_INTERVAL_MS,
    );
    await source.listFiles("**/*.json");

    // A remote service must go through fetch, which verifies certificates.
    expect(fetchMock).toHaveBeenCalled();
  });

  it("explains_how_to_trust_the_certificate_when_verification_fails", async () => {
    const warnings: string[] = [];
    const consoleSpy = vi
      .spyOn(console, "error")
      .mockImplementation((...args) => void warnings.push(args.join(" ")));
    fetchMock.mockImplementation(untrustedCertificate);

    const source = createSourceFromConfig(
      { type: "url", origin: "https://api.example.com/openapi/v1.json", kind: "schema" },
      cacheDir,
      undefined,
      REFRESH_INTERVAL_MS,
    );
    await source.listFiles("**/*.json").catch(() => {});
    consoleSpy.mockRestore();

    expect(warnings.join("\n")).toContain("allowSelfSignedCertificate");
  });
});

describe("Configuring a url source", () => {
  it("names_the_schema_after_the_url_when_no_name_is_configured", async () => {
    fetchMock.mockImplementation(respondWith(openApiSpec("Order")));

    const source = createSourceFromConfig(
      { type: "url", origin: "https://api.example.com/openapi/v1.json", kind: "schema" },
      cacheDir,
      undefined,
      REFRESH_INTERVAL_MS,
    );

    expect(await source.listFiles("**/*.json")).toEqual(["v1.json"]);
  });

  it("explains_that_a_cache_directory_is_required_for_url_sources", () => {
    expect(() =>
      createSourceFromConfig({ type: "url", origin: SPEC_URL, kind: "schema" }),
    ).toThrow(/cacheDir/);
  });
});
