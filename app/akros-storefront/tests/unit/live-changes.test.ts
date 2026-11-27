// @vitest-environment node
import { createServer } from "node:http";
import type { IncomingHttpHeaders } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  applyLiveFrame,
  followLiveChanges,
  isCurrent,
  liveConnected,
  MERCHANDISE_OWNERS,
  resetLiveChanges,
} from "@/ontos/live-changes";

/** Any second owner group of the stream (the main Catalog, Pricing and Inventory). */
const ERP_OWNERS = ["catalog", "pricing", "inventory"] as const;

beforeEach(() => resetLiveChanges());
afterEach(() => vi.unstubAllEnvs());

it("holds an answer read after the stream opened until one of its owners changes", () => {
  expect(isCurrent(1_000, MERCHANDISE_OWNERS)).toBe(false);
  applyLiveFrame("retry: 3254\nid: e.45\n: connected", 1_000);
  expect(liveConnected()).toBe(true);
  // Read before the stream opened: nothing tells what changed before it.
  expect(isCurrent(999, MERCHANDISE_OWNERS)).toBe(false);
  expect(isCurrent(1_001, MERCHANDISE_OWNERS)).toBe(true);
  applyLiveFrame("id: e.46\nevent: change\ndata: inventory,shell", 2_000);
  expect(isCurrent(1_001, MERCHANDISE_OWNERS)).toBe(true);
  expect(isCurrent(1_001, ERP_OWNERS)).toBe(false);
  expect(isCurrent(2_001, ERP_OWNERS)).toBe(true);
  // Pings change nothing; a reset changes every owner.
  applyLiveFrame("id: e.46\n: ping", 3_000);
  expect(isCurrent(1_001, MERCHANDISE_OWNERS)).toBe(true);
  applyLiveFrame("id: e.47\nevent: reset\ndata: all", 4_000);
  expect(isCurrent(2_001, MERCHANDISE_OWNERS)).toBe(false);
  expect(isCurrent(4_001, ERP_OWNERS)).toBe(true);
});

it("follows the Shell's stream with the storefront key, company and owners, and is not current once it ends", async () => {
  let seen: IncomingHttpHeaders = {};
  const server = createServer((request, response) => {
    seen = request.headers;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write("retry: 3000\nid: e.1\n: connected\n\n");
    setTimeout(() => response.write("id: e.2\nevent: change\ndata: catalog\n\n"), 30);
    setTimeout(() => response.end(), 60);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing HTTP address");
  vi.stubEnv("ONTOS_SHELL_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "live-test-key");
  vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", "71000000-0000-4000-8000-000000000024");
  try {
    const opened = Date.now();
    const following = followLiveChanges([...MERCHANDISE_OWNERS, ...ERP_OWNERS]);
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(liveConnected()).toBe(true);
    await following;
    expect(seen).toMatchObject({
      "x-api-key": "live-test-key",
      "x-ontos-legal-entity-id": "71000000-0000-4000-8000-000000000024",
      "x-ontos-live-audiences": "merchandise,catalog,pricing,inventory",
    });
    // The catalog change arrived after the stream opened; merchandise did not change.
    expect(isCurrent(opened + 20, ERP_OWNERS)).toBe(false);
    expect(liveConnected()).toBe(false);
    expect(isCurrent(Date.now(), MERCHANDISE_OWNERS)).toBe(false);
  } finally {
    server.close();
  }
});

it("refuses a stream the Shell does not open", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(401);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing HTTP address");
  vi.stubEnv("ONTOS_SHELL_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "live-test-key");
  try {
    await expect(followLiveChanges(MERCHANDISE_OWNERS)).rejects.toThrow("HTTP 401");
    expect(liveConnected()).toBe(false);
  } finally {
    server.close();
  }
});
