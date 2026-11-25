import { Effect } from "effect";
// @vitest-environment node
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createOperation,
  ERROR_BYTES,
  REQUEST_LIMIT,
  OWNER_WORK_LIMIT,
} from "@ontos/storefront-runtime";
import { callAction, ownerRequest, readRecords } from "@/ontos/gateway";

let server: ReturnType<typeof createServer>;
let respond: (request: IncomingMessage, response: ServerResponse) => void;
let credentials: number;
let writes: number;
const context = {
  apiBaseUrl: "/shell-super-app-api/module-api/owner",
  compositionRevision: "a".repeat(64),
  token: "once",
  expiresAt: 99,
};
const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};
beforeEach(async () => {
  credentials = 0;
  writes = 0;
  respond = (request, response) => {
    if (request.url?.endsWith("gateway-context")) {
      credentials++;
      json(response, 200, context);
    } else if (request.url?.endsWith("gateway-read")) {
      credentials++;
      response.setHeader("x-ontos-gateway-context", JSON.stringify(context));
      json(response, 200, { ok: true });
    } else {
      writes++;
      json(response, 503, {
        type: "https://ontos.dev/problems/gateway-unavailable",
        retryable: true,
      });
    }
  };
  server = createServer((request, response) => {
    request.resume();
    respond(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing HTTP address");
  vi.stubEnv("ONTOS_SHELL_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", "test-key");
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.unstubAllEnvs();
});

it("saturation admits no extra credential work, then recovers permits after body abort", async () => {
  const started = Promise.withResolvers<void>();
  respond = (_, response) => {
    credentials++;
    response.writeHead(200, {
      "content-type": "application/json",
      "x-ontos-gateway-context": JSON.stringify(context),
    });
    response.write('{"ok":');
    if (credentials === REQUEST_LIMIT) started.resolve();
  };
  const controllers = Array.from({ length: REQUEST_LIMIT }, () => new AbortController());
  const pending = controllers.map((caller) =>
    readRecords("merchandise", "records", {}, { signal: caller.signal }).catch(
      (error: unknown) => error,
    ),
  );
  await started.promise;
  const before = credentials;
  await expect(readRecords("merchandise", "records", {})).rejects.toMatchObject({
    kind: "overloaded",
  });
  expect(credentials - before).toBe(0);
  controllers.forEach((caller) => caller.abort());
  for (const error of await Promise.all(pending))
    expect(error).toMatchObject({ kind: "cancelled" });
  respond = (_, response) => {
    response.setHeader("x-ontos-gateway-context", JSON.stringify(context));
    json(response, 200, { recovered: true });
  };
  await expect(readRecords("merchandise", "records", {})).resolves.toEqual({ recovered: true });
});

it("keeps the total deadline after headers and counts streamed error bodies", async () => {
  respond = (_, response) => {
    response.writeHead(200);
    response.write("{");
  };
  const operation = Effect.runSync(createOperation({ timeoutMs: 150 }));
  try {
    await expect(readRecords("merchandise", "records", {}, { operation })).rejects.toMatchObject({
      kind: "deadline",
    });
  } finally {
    operation.dispose();
  }
  respond = (_, response) => {
    response.writeHead(503);
    response.write("x".repeat(ERROR_BYTES));
    response.end("ž");
  };
  await expect(readRecords("merchandise", "records", {})).rejects.toMatchObject({
    kind: "body_oversize",
  });
});

it("never replays a mutation or one-time verification GET", async () => {
  await expect(
    callAction("merchandise", "place-storefront-order", {}, "stable-key"),
  ).rejects.toMatchObject({ status: 503 });
  expect(credentials).toBe(1);
  expect(writes).toBe(1);
  const response = await ownerRequest(
    "commerce-customer-context",
    "/api/portal-auth/verify-email?token=once",
    { method: "GET" },
  );
  expect(response.status).toBe(503);
  expect(credentials).toBe(2);
  expect(writes).toBe(2);
});

it("does not replay arbitrary 400/401 responses", async () => {
  for (const status of [400, 401]) {
    let attempts = 0;
    respond = (_, response) => {
      attempts++;
      json(response, status, { code: "terminal" });
    };
    await expect(readRecords("merchandise", "records", {})).rejects.toMatchObject({ status });
    expect(attempts).toBe(1);
  }
});

it("propagates search cancellation through catalog market admission, rather than starting a new owner lifetime", async () => {
  const { POST } = await import("@/app/api/ontos/search/route");
  const { nextRequest } = await import("../support/next-request");
  const started = Promise.withResolvers<void>();
  respond = (_, response) => {
    credentials++;
    response.writeHead(200, {
      "content-type": "application/json",
      "x-ontos-gateway-context": JSON.stringify(context),
    });
    response.write("{");
    started.resolve();
  };
  const caller = new AbortController();
  const next = nextRequest("http://shop.test/api/ontos/search", {
    headers: { "x-akros-market-locale": "cs" },
  });
  try {
    const pending = next.run(() =>
      POST(
        new Request("http://shop.test/api/ontos/search", {
          method: "POST",
          body: JSON.stringify({ q: "matice" }),
          headers: { "content-type": "application/json", "x-akros-market-locale": "cs" },
          signal: caller.signal,
        }),
      ),
    );
    await started.promise;
    caller.abort();
    const response = await pending;
    expect(response.status).toBe(499);
    expect(await response.json()).toMatchObject({ code: "cancelled" });
    expect(writes).toBe(0);
  } finally {
    await next.close();
  }
});

it("charges one request for concurrent derived reads and queues excess fanout without overload", async () => {
  const request = Effect.runSync(createOperation());
  let active = 0;
  let peak = 0;
  const full = Promise.withResolvers<void>();
  const releaseBodies = Promise.withResolvers<void>();
  respond = (_, response) => {
    credentials++;
    active++;
    peak = Math.max(peak, active);
    response.writeHead(200, {
      "content-type": "application/json",
      "x-ontos-gateway-context": JSON.stringify(context),
    });
    response.write('{"ok":');
    if (active === OWNER_WORK_LIMIT) full.resolve();
    void releaseBodies.promise.then(() => {
      active--;
      response.end("true}");
    });
  };
  const reads = Array.from({ length: REQUEST_LIMIT + 1 }, () =>
    readRecords(
      "merchandise",
      "records",
      {},
      { operation: request, signal: new AbortController().signal },
    ),
  );
  try {
    await full.promise;
    expect(credentials).toBe(OWNER_WORK_LIMIT);
    releaseBodies.resolve();
    expect(await Promise.all(reads)).toEqual(
      Array.from({ length: REQUEST_LIMIT + 1 }, () => ({ ok: true })),
    );
    expect(peak).toBe(OWNER_WORK_LIMIT);
  } finally {
    releaseBodies.resolve();
    request.dispose();
    await Promise.allSettled(reads);
  }
});
