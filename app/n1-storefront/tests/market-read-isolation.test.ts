import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { Effect, Schema } from "effect";
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { TestClock } from "effect/testing";
import { describe, expect, it } from "effect-rstest";
import { getCartScope } from "../src/ontos/cart-quote-server";
import { storefrontRuntime } from "../src/ontos/runtime";
import { readConfiguration } from "../src/ontos/config";
import { createMarketCatalogRead } from "../src/ontos/market-catalog-read";
import { createOperation, REQUEST_LIMIT } from "@ontos/storefront-runtime";
import { storefrontHttpClientLayer, withOwnerOperation } from "../src/ontos/owner-operation";
import { ownerServer } from "./support/owner-server";

const tenantId = "70000000-0000-4000-8000-000000000099";
const legalEntityId = "71000000-0000-4000-8000-000000000099";
const marketId = "72000000-0000-4000-8000-000000000099";
const environment = {
  ONTOS_N1_STOREFRONT_API_KEY: "market-isolation-service-key",
  ONTOS_STOREFRONT_LEGAL_ENTITY_ID: legalEntityId,
  ONTOS_STOREFRONT_TENANT_ID: tenantId,
};
const market = { configured: true, currency: "CZK", marketId };
const marketCatalog = {
  associations: [
    {
      channel: "B2C",
      effectivePeriod: { startsAt: "2020-01-01T00:00:00Z" },
      marketRef: { resourceId: marketId },
      sellingLegalEntityRef: { resourceId: legalEntityId },
      storefrontRef: { appId: "n1-storefront", tenantId },
    },
  ],
  markets: [
    {
      effectivePeriod: { startsAt: "2020-01-01T00:00:00Z" },
      lifecycle: "ACTIVE",
      marketCode: "N1",
      marketRef: { resourceId: marketId },
      sellingLegalEntityRef: { resourceId: legalEntityId },
      supportedLocales: ["cs-CZ"],
    },
  ],
};
const Read = Schema.Struct({
  audience: Schema.String,
  query: Schema.Struct({
    view: Schema.optionalKey(
      Schema.Struct({
        storefrontCatalog: Schema.Struct({
          includeCategories: Schema.Boolean,
          mode: Schema.optionalKey(Schema.String),
        }),
      }),
    ),
  }),
  readName: Schema.String,
});
const fixture = () => {
  const requests: (typeof Read.Type)[] = [];
  let unavailable = false;
  const application = HttpRouter.add(
    "POST",
    "/shell-super-app-api/auth/api-key/gateway-read",
    Effect.gen(function* answerOwnerRead() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const read = yield* Schema.decodeUnknownEffect(Read)(yield* request.json);
      requests.push(read);
      const headers = {
        "x-ontos-gateway-context": JSON.stringify({
          apiBaseUrl: "/shell-super-app-api/gateway/merchandise",
          compositionRevision: "a".repeat(64),
          expiresAt: 9_999_999_999,
          token: "market-isolation-read",
        }),
      };
      if (read.readName === "current-market-catalog") {
        return HttpServerResponse.jsonUnsafe(
          unavailable ? { code: "read_handler_unavailable" } : marketCatalog,
          {
            headers,
            status: unavailable ? 503 : 200,
          },
        );
      }
      return HttpServerResponse.jsonUnsafe(
        {
          market,
          products: [{ id: "current-owner-product", name: "Aktuální produkt", slug: "aktualni" }],
          revision: 7,
        },
        { headers },
      );
    }).pipe(Effect.orDie),
  );
  return {
    fail: () => {
      unavailable = true;
    },
    layer: ownerServer(application, environment),
    recover: () => {
      unavailable = false;
    },
    requests,
  };
};

const RenderMessage = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("checkpoint") }),
  Schema.Struct({ kind: Schema.Literal("result"), results: Schema.Unknown }),
]);

// A native server-condition process lets the installed React RSC renderer own cache lifetime.
// This runs the two public read chains used by LocaleLayout, not a substituted cache implementation.
const renderReads = async (
  renders: number,
  checkpoint: () => void = () => {},
  apiRoute = false,
) => {
  const require = createRequire(import.meta.url);
  const bundle = await build({
    alias: { "server-only": require.resolve("next/dist/compiled/server-only/empty.js") },
    bundle: true,
    external: ["react", "react/*", "react-dom", "react-dom/*", "next/*", "effect", "effect/*"],
    format: "cjs",
    logLevel: "silent",
    platform: "node",
    stdin: {
      contents: `
        import { createElement } from 'react';
        import { renderToReadableStream } from 'next/dist/compiled/react-server-dom-webpack/server.node';
        import { getCatalog } from './src/ontos/catalog';
        import { getCartScope } from './src/ontos/cart-quote-server';
        import { storefrontRuntime } from './src/ontos/runtime';
        import { Effect } from 'effect';
        import { createOperation, REQUEST_LIMIT } from '@ontos/storefront-runtime';
        import { withOwnerOperation } from './src/ontos/owner-operation';
        import { readCurrentMarketCatalog } from './src/ontos/market-catalog-read';
        import { readConfiguration } from './src/ontos/config';
        import { NextRequest } from 'next/server';
        import { createRequestStoreForAPI } from 'next/dist/server/async-storage/request-store';
        import { renderOperation } from './src/ontos/render-operation';
        import { workAsyncStorage } from 'next/dist/server/app-render/work-async-storage.external';
        import { createWorkStore } from 'next/dist/server/async-storage/work-store';
        import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external';
        const scope = () => storefrontRuntime.runPromise(getCartScope('cs').pipe(Effect.match({
          onFailure: error => ({ state: error.state, diagnostic: error.diagnostic }),
          onSuccess: value => ({ state: 'ready', scope: value }),
        })));
        async function renderOne() {
          let result;
          let operation;
          async function ReadLocale() {
            operation = await renderOperation();
            const [catalog, cart] = await Promise.all([
              getCatalog('cs', JSON.stringify({ featured: true })), scope(),
            ]);
            result = catalog.state === 'unavailable'
              ? { catalog, cart, laterCart: await scope() }
              : { catalog, cart };
            return 'locale reads complete';
          }
          const request = new NextRequest('http://n1.test/cs');
          const store = createRequestStoreForAPI(request, new URL(request.url),
            { tags: [], expirationsByCacheKind: new Map() }, undefined, undefined, undefined);
          const errors = [];
          const closes = [];
          const waits = [];
          const workStore = createWorkStore({
            page: '/cs/page', buildId: 'test', deploymentId: 'test', previouslyRevalidatedTags: [],
            renderOpts: {
              cacheLifeProfiles: {}, staticPageGenerationTimeout: 30, cacheComponents: false,
              validationLevel: 'none', experimental: { useCacheTimeout: 30, durableUseCacheEntries: false },
              isBuildTimePrerendering: false, isDraftMode: false,
              onClose: callback => closes.push(callback), waitUntil: promise => waits.push(promise),
              onAfterTaskError: error => errors.push(String(error)),
            },
          });
          return workAsyncStorage.run(workStore, () => workUnitAsyncStorage.run(store, async () => {
          if (${apiRoute}) {
            const roots = await storefrontRuntime.runPromise(Effect.forEach(Array.from({length: REQUEST_LIMIT}), () => createOperation()));
            const ready = Promise.withResolvers();
            let admitted = 0;
            const held = roots.slice(1).map(operation => storefrontRuntime.runPromise(
              withOwnerOperation(Effect.sync(() => {
                if (++admitted === REQUEST_LIMIT - 1) ready.resolve();
              }).pipe(Effect.andThen(Effect.never)), {operation})
            ).catch(() => undefined));
            try {
              await ready.promise;
              result = await storefrontRuntime.runPromise(withOwnerOperation(Effect.gen(function*() {
                const config = yield* readConfiguration(process.env);
                const first = yield* readCurrentMarketCatalog(config);
                const second = yield* readCurrentMarketCatalog(config);
                return {same: first === second, markets: first.markets};
              }), {operation: roots[0]}));
              return result;
            } finally {
              roots.forEach(operation => operation.dispose());
              await Promise.all(held);
              for (const close of closes) close();
              await Promise.all(waits);
            }
          }
          const stream = await renderToReadableStream(createElement(ReadLocale), {}, { onError: error => errors.push(String(error)) });
          await new Response(stream).text();
          for (const close of closes) close();
          await Promise.all(waits);
          if (!operation?.signal.aborted) throw new Error('Native after hook did not dispose render operation');
          if (errors.length) throw new Error(errors.join('\\n'));
          return result;
          }));
        }
        (async () => {
          const results = [];
          for (let i = 0; i < ${renders}; i++) {
            results.push(await renderOne());
            if (i + 1 < ${renders}) {
              await new Promise(resolve => { process.once('message', resolve); process.send({ kind: 'checkpoint' }); });
            }
          }
          process.send({ kind: 'result', results });
          await storefrontRuntime.dispose();
          process.disconnect();
        })().catch(error => { console.error(error); process.exitCode = 1; process.disconnect(); });
      `,
      loader: "ts",
      resolveDir: process.cwd(),
    },
    tsconfig: "tsconfig.json",
    write: false,
  });
  const [output] = bundle.outputFiles;
  if (output === undefined) {
    throw new Error("Missing server render entry");
  }
  const { promise, reject, resolve } = Promise.withResolvers<unknown>();
  {
    const child = spawn(
      process.execPath,
      [
        "--conditions=react-server",
        "--require",
        require.resolve("next/dist/server/node-environment-baseline"),
        "--input-type=commonjs",
      ],
      {
        cwd: process.cwd(),
        env: process.env,
        signal: AbortSignal.timeout(15_000),
        stdio: ["pipe", "ignore", "pipe", "ipc"],
      },
    );
    let stderr = "";
    let result: unknown;
    if (child.stdin === null || child.stderr === null) {
      child.kill();
      throw new Error("Missing child standard streams");
    }
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    child.on("error", reject);
    child.on("message", (message) => {
      try {
        const received = Schema.decodeUnknownSync(RenderMessage)(message);
        if (received.kind === "checkpoint") {
          checkpoint();
          child.send("continue");
        } else {
          result = received.results;
        }
      } catch (error) {
        child.kill();
        reject(new Error("Server-render checkpoint failed", { cause: error }));
      }
    });
    child.on("close", (code) => {
      if (code === 0 && result !== undefined) {
        resolve(result);
      } else {
        reject(new Error(`Server render exited ${code}: ${stderr}`));
      }
    });
    child.stdin.end(output.text);
  }
  return await promise;
};
const readyCatalog = expect.objectContaining({
  catalog: expect.objectContaining({
    products: [expect.objectContaining({ id: "current-owner-product" })],
  }),
  state: "ready",
});
const readyCart = { scope: { currency: "CZK", legalEntityId, marketId, tenantId }, state: "ready" };
const readNames = (requests: (typeof Read.Type)[]) => requests.map((read) => read.readName);
/** The company's catalogue revision head (no market, no products): one fresh read per process, repeated while visited. */
const isRevisionRead = (read: typeof Read.Type) =>
  read.readName === "records" && read.query.view?.storefrontCatalog.mode === "categories";
/** Market and catalogue reads, without the revision head read (its count depends on the background repeat). */
const ownerReadNames = (requests: (typeof Read.Type)[]) =>
  readNames(requests.filter((read) => !isRevisionRead(read))).toSorted();

describe("market read lifetime at the real server renderer", () => {
  it.live("reuses the HTTP operation inside native App Route stores at full admission", () => {
    const owner = fixture();
    return Effect.gen(function* appRouteAdmission() {
      const result = yield* Effect.promise(() => renderReads(1, () => {}, true));
      expect(result).toEqual([{ markets: marketCatalog, same: true }]);
      expect(readNames(owner.requests)).toEqual(["current-market-catalog"]);
    }).pipe(Effect.provide(owner.layer));
  });
  it.live(
    "runs the shared catalogue read in its own operation beside the render's cart scope read",
    () => {
      const owner = fixture();
      return Effect.gen(function* sharedLocaleRead() {
        const result = yield* Effect.promise(() => renderReads(1));
        expect(result).toEqual([{ cart: readyCart, catalog: readyCatalog }]);
        // Awaiting the child close drains every HTTP chain before the exact-count assertions. The catalogue answer is
        // shared across requests, so it reads its market under its own operation, after the catalogue revision head.
        expect(owner.requests.filter(isRevisionRead)).toHaveLength(1);
        expect(ownerReadNames(owner.requests)).toEqual([
          "current-market-catalog",
          "current-market-catalog",
          "records",
          "records",
        ]);
        expect(
          owner.requests
            .filter((read) => read.readName === "records" && !isRevisionRead(read))
            .map((read) => read.query.view?.storefrontCatalog.includeCategories)
            .toSorted((left, right) => Number(left) - Number(right)),
        ).toEqual([false, true]);
      }).pipe(Effect.provide(owner.layer));
    },
  );

  it.live(
    "starts fresh cart scope reads per render and shares the catalogue answer of one revision",
    () => {
      const owner = fixture();
      return Effect.gen(function* independentRenders() {
        const result = yield* Effect.promise(() => renderReads(2));
        expect(result).toEqual(
          Array.from({ length: 2 }, () => ({ cart: readyCart, catalog: readyCatalog })),
        );
        // First render: the catalogue's market and records, the cart's market and records (beside the revision head).
        // Second render: the revision and the catalogue answer are still shared; only the cart scope reads again.
        expect(ownerReadNames(owner.requests)).toEqual([
          "current-market-catalog",
          "current-market-catalog",
          "current-market-catalog",
          "records",
          "records",
          "records",
        ]);
      }).pipe(Effect.provide(owner.layer));
    },
  );

  it.live("retries a failed market read once per chain, then recovers on the next render", () => {
    const owner = fixture();
    owner.fail();
    return Effect.gen(function* failedThenFreshRender() {
      const result = yield* Effect.promise(() =>
        renderReads(2, () => {
          // The catalogue's own operation and the render's cart scope (shared by its later read) each retry once.
          expect(ownerReadNames(owner.requests)).toEqual(
            Array.from({ length: 6 }, () => "current-market-catalog"),
          );
          owner.recover();
        }),
      );
      const failedCart = { diagnostic: "context-read-unavailable", state: "unavailable" };
      expect(result).toEqual([
        {
          cart: failedCart,
          catalog: { reason: "StorefrontReadUnavailable", state: "unavailable" },
          laterCart: failedCart,
        },
        { cart: readyCart, catalog: readyCatalog },
      ]);
      // An unavailable catalogue answer is never kept: the next render reads the catalogue and the cart scope again.
      expect(ownerReadNames(owner.requests)).toEqual([
        ...Array.from({ length: 8 }, () => "current-market-catalog"),
        "records",
        "records",
      ]);
    }).pipe(Effect.provide(owner.layer));
  });

  it.live("does not share market or merchandise responses between calls outside a render", () => {
    const owner = fixture();
    return Effect.gen(function* separateScopeCalls() {
      const first = yield* Effect.promise(() => storefrontRuntime.runPromise(getCartScope("cs")));
      const second = yield* Effect.promise(() => storefrontRuntime.runPromise(getCartScope("cs")));
      expect(first).toEqual(readyCart.scope);
      expect(second).toEqual(readyCart.scope);
      expect(readNames(owner.requests)).toEqual([
        "current-market-catalog",
        "records",
        "current-market-catalog",
        "records",
      ]);
    }).pipe(Effect.provide(owner.layer));
  });
});

const pendingMarketOwner = () => {
  const started = Promise.withResolvers<null>();
  const stopped = Promise.withResolvers<null>();
  const release = Promise.withResolvers<null>();
  let requests = 0;
  const application = HttpRouter.add(
    "POST",
    "/shell-super-app-api/auth/api-key/gateway-read",
    Effect.gen(function* pendingMarketRead() {
      requests += 1;
      started.resolve(null);
      yield* Effect.promise(() => release.promise).pipe(
        Effect.onInterrupt(() => Effect.sync(() => stopped.resolve(null))),
      );
      return HttpServerResponse.jsonUnsafe(marketCatalog, {
        headers: {
          "x-ontos-gateway-context": JSON.stringify({
            apiBaseUrl: "/shell-super-app-api/market",
            compositionRevision: "a".repeat(64),
            expiresAt: 9_999_999_999,
            token: "cancelled-market-read",
          }),
        },
      });
    }),
  );
  return {
    layer: ownerServer(application, environment),
    release: () => release.resolve(null),
    requests: () => requests,
    started: started.promise,
    stopped: stopped.promise,
  };
};

describe("shared market operation cancellation", () => {
  it.effect(
    "keeps an unowned holder's original monotonic deadline before its first subscription",
    () => {
      let calls = 0;
      const fetch: typeof globalThis.fetch = async () => {
        calls += 1;
        return Response.json(marketCatalog);
      };
      return Effect.gen(function* unownedSharedDeadline() {
        const shared = yield* createMarketCatalogRead();
        yield* TestClock.adjust("30 seconds");
        const failure = yield* shared({
          apiKey: "market-isolation-service-key",
          appId: "n1-storefront",
          legalEntityId,
          shellUrl: "https://shell.example",
          tenantId,
        }).pipe(Effect.flip);
        expect(failure).toMatchObject({ reason: "deadline" });
        expect(calls).toBe(0);
      }).pipe(
        Effect.provide(storefrontHttpClientLayer),
        Effect.provideService(FetchHttpClient.Fetch, fetch),
      );
    },
  );

  it.live(
    "charges 32 subscribers to their own requests without a 33rd shared-source admission",
    () => {
      const owner = pendingMarketOwner();
      return Effect.gen(function* sharedBurst() {
        const config = yield* readConfiguration(process.env);
        yield* Effect.promise(async () => {
          const shared = await storefrontRuntime.runPromise(createMarketCatalogRead());
          const operations = await storefrontRuntime.runPromise(
            Effect.forEach(Array.from({ length: REQUEST_LIMIT }), () => createOperation()),
          );
          const pending = operations.map((operation) =>
            storefrontRuntime.runPromise(withOwnerOperation(shared(config), { operation })),
          );
          try {
            await owner.started;
            owner.release();
            for (const result of await Promise.all(pending)) {
              expect(result.markets).toEqual(marketCatalog);
            }
            expect(owner.requests()).toBe(1);
          } finally {
            owner.release();
            for (const operation of operations) {
              operation.dispose();
            }
            await Promise.allSettled(pending);
          }
        });
      }).pipe(Effect.provide(owner.layer));
    },
  );

  it.live(
    "does not restart the deadline when an explicitly owned shared read is subscribed lazily",
    () => {
      const owner = pendingMarketOwner();
      return Effect.gen(function* lazyDeadline() {
        const config = yield* readConfiguration(process.env);
        yield* Effect.promise(async () => {
          const operation = await storefrontRuntime.runPromise(createOperation({ timeoutMs: 120 }));
          const shared = await storefrontRuntime.runPromise(createMarketCatalogRead({ operation }));
          const { deadline } = operation;
          try {
            await storefrontRuntime.runPromise(operation.wait(60));
            const pending = storefrontRuntime.runPromise(shared(config).pipe(Effect.flip));
            await owner.started;
            expect(await pending).toMatchObject({ kind: "deadline" });
            expect(operation.deadline).toBe(deadline);
            await owner.stopped;
            expect(owner.requests()).toBe(1);
          } finally {
            operation.dispose();
            owner.release();
          }
        });
      }).pipe(Effect.provide(owner.layer));
    },
  );

  it.live(
    "keeps the shared read alive for a surviving waiter after the first caller cancels",
    () => {
      const owner = pendingMarketOwner();
      return Effect.gen(function* survivingWaiter() {
        const config = yield* readConfiguration(process.env);
        yield* Effect.promise(async () => {
          const shared = await storefrontRuntime.runPromise(createMarketCatalogRead());
          const first = new AbortController();
          const second = new AbortController();
          const firstResult = storefrontRuntime
            .runPromise(withOwnerOperation(shared(config), { signal: first.signal }))
            .then(() => "success")
            .catch(() => "cancelled");
          const secondResult = storefrontRuntime.runPromise(
            withOwnerOperation(shared(config), { signal: second.signal }),
          );
          try {
            await owner.started;
            first.abort();
            expect(await firstResult).toBe("cancelled");
            owner.release();
            const surviving = await secondResult;
            expect(surviving.markets).toEqual(marketCatalog);
            expect(owner.requests()).toBe(1);
          } finally {
            second.abort();
            owner.release();
            await secondResult.catch(() => {});
          }
        });
      }).pipe(Effect.provide(owner.layer));
    },
  );

  it.live(
    "interrupts HTTP when the last waiter cancels and never caches that interrupted read",
    () => {
      const owner = pendingMarketOwner();
      return Effect.gen(function* abandonedRead() {
        const config = yield* readConfiguration(process.env);
        yield* Effect.promise(async () => {
          const shared = await storefrontRuntime.runPromise(createMarketCatalogRead());
          const first = new AbortController();
          const second = new AbortController();
          const firstResult = storefrontRuntime
            .runPromise(shared(config), { signal: first.signal })
            .then(() => "success")
            .catch(() => "cancelled");
          const secondResult = storefrontRuntime
            .runPromise(shared(config), { signal: second.signal })
            .then(() => "success")
            .catch(() => "cancelled");
          try {
            await owner.started;
            first.abort();
            expect(await firstResult).toBe("cancelled");
            second.abort();
            expect(await secondResult).toBe("cancelled");
            await owner.stopped;
            expect(owner.requests()).toBe(1);
            owner.release();
            const restarted = await storefrontRuntime.runPromise(shared(config));
            expect(restarted.markets).toEqual(marketCatalog);
            expect(owner.requests()).toBe(2);
          } finally {
            first.abort();
            second.abort();
            owner.release();
            await Promise.all([firstResult, secondResult]);
          }
        });
      }).pipe(Effect.provide(owner.layer));
    },
  );
});
