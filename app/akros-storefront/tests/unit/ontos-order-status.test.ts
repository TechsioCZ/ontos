// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/ontos/order-status/route";
import { serveHttp } from "../support/http";
import { nextRequest } from "../support/next-request";

const orderId = "e12a77c6-c624-46bf-88fe-13d8c386e099";
const clientRequestId = "sf-12345678-1234-4234-8234-123456789abc";
const legalEntityId = "71000000-0000-4000-8000-000000000024";
const gatewayReadPath = "/shell-super-app-api/auth/api-key/gateway-read";
let network: Awaited<ReturnType<typeof serveHttp>>;
let ownerAnswer: unknown;

const gatewayRequests = () =>
  network.requests.filter((request) => new URL(request.url).pathname === gatewayReadPath);

const ask = async (body: unknown, origin = network.origin) => {
  const response = await fetch(`${network.origin}/api/ontos/order-status`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // The BFF response has arrived before checking that no owner read occurred, or counting reads.
  await network.idle();
  return response;
};

beforeEach(async () => {
  ownerAnswer = {
    orderStatus: {
      id: orderId,
      number: "OBJ-2026-0031",
      status: "PACKING",
      updatedAt: "2026-10-20T21:40:00.000Z",
    },
  };
  network = await serveHttp(async (request) => {
    const path = new URL(request.url).pathname;
    if (path === gatewayReadPath) {
      return Response.json(ownerAnswer, {
        headers: {
          "x-ontos-gateway-context": JSON.stringify({
            apiBaseUrl: "/shell-super-app-api/merchandise",
            compositionRevision: "a".repeat(64),
            token: "order-status-test-assertion",
            expiresAt: Date.now() + 60_000,
          }),
        },
      });
    }
    if (path === "/api/ontos/order-status") {
      const context = nextRequest(request.url, {
        method: request.method,
        headers: request.headers,
        body: await request.text(),
      });
      try {
        return await context.run(() => POST(context.request));
      } finally {
        await context.close();
      }
    }
    return new Response("Unexpected endpoint", { status: 404 });
  });
  vi.stubEnv("ONTOS_SHELL_URL", network.origin);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "order-status-test-api-key");
  vi.stubEnv("ONTOS_STOREFRONT_LEGAL_ENTITY_ID", legalEntityId);
});

afterEach(async () => {
  try {
    await network.idle();
    await network.close();
  } finally {
    vi.unstubAllEnvs();
  }
});

describe("live order status BFF", () => {
  it("reads only the owner storefrontOrderStatus view and returns a Czech label", async () => {
    const response = await ask({ orderId, clientRequestId });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      id: orderId,
      number: "OBJ-2026-0031",
      status: "PACKING",
      statusLabel: "Připravená k předání",
      updatedAt: "2026-10-20T21:40:00.000Z",
      final: false,
    });
    expect(network.requests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/ontos/order-status",
      gatewayReadPath,
    ]);
    const reads = gatewayRequests();
    expect(reads).toHaveLength(1);
    for (const request of reads) {
      expect(request.method).toBe("POST");
      expect(request.headers.get("x-api-key")).toBe("order-status-test-api-key");
      expect(await request.json()).toEqual({
        audience: "merchandise",
        legalEntityId,
        readName: "records",
        query: {
          view: { storefront: true, storefrontOrderStatus: { orderId, clientRequestId } },
        },
      });
    }
  });
  it("marks delivered and cancelled orders as final", async () => {
    for (const [status, statusLabel] of [
      ["CANCELLED", "Stornovaná"],
      ["DELIVERED", "Dokončená"],
    ]) {
      ownerAnswer = {
        orderStatus: {
          id: orderId,
          number: "OBJ-2026-0031",
          status,
          updatedAt: "2026-10-20T21:40:00.000Z",
        },
      };
      expect(await (await ask({ orderId, clientRequestId })).json()).toMatchObject({
        statusLabel,
        final: true,
      });
    }
  });
  it.each([
    [{ orderId, clientRequestId: "bad" }],
    [{ orderId: "x", clientRequestId }],
    [{ clientRequestId }],
  ])("rejects invalid input %j without reading OntOS", async (body) => {
    expect((await ask(body)).status).toBe(400);
    expect(gatewayRequests()).toEqual([]);
  });
  it.each([
    { orderStatus: null },
    { orderStatus: { id: "other-order-id", number: "X", status: "NEW", updatedAt: "x" } },
    { orderStatus: { id: orderId, number: "X", status: "LOST", updatedAt: "x" } },
  ])("answers 404 for an unknown or malformed owner answer %j", async (owner) => {
    ownerAnswer = owner;
    expect((await ask({ orderId, clientRequestId })).status).toBe(404);
  });
  it("refuses cross-origin calls", async () => {
    expect((await ask({ orderId, clientRequestId }, "https://evil.example")).status).toBe(403);
    expect(gatewayRequests()).toEqual([]);
  });
});
