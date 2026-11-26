// @vitest-environment node
import { Effect, Logger, Predicate } from "effect";
import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createOperation, OperationError } from "@ontos/storefront-runtime";
import type { Operation } from "@ontos/storefront-runtime";
import { callAction, ownerRequest, readRecords } from "@/ontos/gateway";
import * as transport from "@/ontos/shell-fetch";

const secret = "private-token-apiKey-body-url";
const context = {
  apiBaseUrl: "/shell-super-app-api/module-api/owner",
  compositionRevision: "a".repeat(64),
  token: secret,
  expiresAt: 99,
};
type Entry = ReturnType<typeof Logger.formatStructured.log>;
let entries: Entry[];
let operation: Operation;
let server: ReturnType<typeof createServer>;
let paths: string[];
let failAt: string;
let responseStatus: number;
let hold: boolean;
let started: ReturnType<typeof Promise.withResolvers<void>>;

beforeEach(async () => {
  entries = [];
  paths = [];
  failAt = "";
  responseStatus = 200;
  hold = false;
  started = Promise.withResolvers<void>();
  const base = Effect.runSync(createOperation());
  const logs = Logger.layer([
    Logger.make((options) => entries.push(Logger.formatStructured.log(options))),
  ]);
  operation = {
    ...base,
    run: (work) => base.run(work.pipe(Effect.provide(logs))),
  };
  server = createServer((request, response) => {
    request.resume();
    const path = request.url ?? "";
    paths.push(path);
    if (path.endsWith(failAt)) {
      started.resolve();
      if (!hold) request.socket.destroy();
      return;
    }
    response.writeHead(responseStatus, {
      "content-type": "application/json",
      "x-ontos-gateway-context": JSON.stringify(context),
    });
    response.end(JSON.stringify(path.endsWith("gateway-context") ? context : { ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing HTTP address");
  vi.stubEnv("ONTOS_SHELL_URL", `http://127.0.0.1:${address.port}`);
  vi.stubEnv("ONTOS_AKROS_STOREFRONT_API_KEY", secret);
});

afterEach(async () => {
  operation.dispose();
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const expectDiagnostic = (gatewayPhase: string, nativeCauseCode: string) => {
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({
    level: "WARN",
    message: "AKROS gateway fetch failed",
    cause: undefined,
    annotations: {
      gatewayPhase,
      signalAborted: false,
      abortKind: "unavailable",
      nativeCauseCode,
    },
  });
  expect(Object.keys(entries[0]?.annotations ?? {}).sort()).toEqual([
    "abortKind",
    "gatewayPhase",
    "nativeCauseCode",
    "signalAborted",
  ]);
  expect(JSON.stringify(entries)).not.toContain(secret);
  expect(JSON.stringify(entries)).not.toContain("http://");
  expect(JSON.stringify(entries)).not.toContain("/shell-super-app-api");
};

it.each(["gateway-context", "gateway-read", "action", "owner-request"])(
  "records native socket failure for %s without replay or changing the API error",
  async (phase) => {
    failAt =
      phase === "action"
        ? "/merchandise/actions/order"
        : phase === "owner-request"
          ? "/api/portal-auth/verify-email"
          : phase;
    const pending =
      phase === "gateway-read"
        ? readRecords("merchandise", "records", { secret }, { operation })
        : phase === "owner-request"
          ? ownerRequest(
              "commerce-customer-context",
              "/api/portal-auth/verify-email",
              { method: "GET" },
              { operation },
            )
          : callAction("merchandise", "order", { secret }, secret, { operation });
    await expect(pending).rejects.toMatchObject({
      name: "OntosError",
      message: "OntOS is unreachable",
      status: 503,
      code: "backend_unreachable",
      detail: undefined,
      body: undefined,
    });
    expect(paths).toHaveLength(phase === "gateway-read" || phase === "gateway-context" ? 1 : 2);
    expectDiagnostic(
      phase === "gateway-read" || phase === "gateway-context" ? phase : "owner-request",
      "UND_ERR_SOCKET",
    );
  },
);

it("records a native connection refusal, not an upstream HTTP 503", async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await expect(readRecords("merchandise", "records", {}, { operation })).rejects.toMatchObject({
    status: 503,
    code: "backend_unreachable",
  });
  expectDiagnostic("gateway-read", "ECONNREFUSED");
});

it.each([
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
  "ABORT_ERR",
  secret,
])("allowlists a rejected fetch's native cause code: %s", async (code) => {
  const fetch = vi
    .spyOn(transport, "shellFetch")
    .mockRejectedValue(
      new TypeError(secret, { cause: Object.assign(new Error(secret), { code }) }),
    );
  await expect(
    readRecords("merchandise", "records", { secret }, { operation }),
  ).rejects.toMatchObject({
    status: 503,
    code: "backend_unreachable",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expectDiagnostic("gateway-read", code === secret ? "unavailable" : code);
});

it("does not let malformed error properties replace the original API error", async () => {
  const error = Object.defineProperty(new Error(secret), "cause", {
    get() {
      throw new Error(secret);
    },
  });
  const fetch = vi.spyOn(transport, "shellFetch").mockRejectedValue(error);
  await expect(readRecords("merchandise", "records", {}, { operation })).rejects.toMatchObject({
    status: 503,
    code: "backend_unreachable",
  });
  expect(fetch).toHaveBeenCalledTimes(1);
  expectDiagnostic("gateway-read", "unavailable");
});

it.each(["cancelled", "deadline"] satisfies Parameters<Operation["abort"]>[0][])(
  "keeps %s precedence and never replays an in-flight native fetch",
  async (kind) => {
    failAt = "gateway-read";
    hold = true;
    const pending = readRecords("merchandise", "records", { secret }, { operation });
    const rejected = pending.catch((error: unknown) => error);
    await started.promise;
    operation.abort(kind);
    const failure = await rejected;
    expect(Predicate.isTagged(failure, "OperationError")).toBe(true);
    expect(failure).toMatchObject({ kind });
    expect(paths).toHaveLength(1);
    expect(JSON.stringify(entries)).not.toContain(secret);
  },
);

it("keeps an already-cancelled caller's arbitrary abort reason private and dispatches nothing", async () => {
  const caller = new AbortController();
  caller.abort(new Error(secret, { cause: { code: secret } }));
  await expect(
    readRecords("merchandise", "records", {}, { operation, signal: caller.signal }),
  ).rejects.toBeInstanceOf(OperationError);
  expect(paths).toHaveLength(0);
  expect(entries).toHaveLength(0);
});

it("does not diagnose HTTP responses as native fetch failures", async () => {
  failAt = "never";
  responseStatus = 503;
  await expect(readRecords("merchandise", "records", {}, { operation })).rejects.toMatchObject({
    status: 503,
    code: undefined,
  });
  expect(paths).toHaveLength(1);
  expect(entries).toHaveLength(0);
});
