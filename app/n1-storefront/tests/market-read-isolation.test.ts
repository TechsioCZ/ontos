import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { Effect, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { describe, expect, it } from "effect-rstest";
import { getCartScope } from "../src/ontos/cart-quote-server";
import { storefrontRuntime } from "../src/ontos/runtime";
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
        storefrontCatalog: Schema.Struct({ includeCategories: Schema.Boolean }),
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
        return HttpServerResponse.jsonUnsafe(marketCatalog, {
          headers,
          status: unavailable ? 503 : 200,
        });
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
const renderReads = async (renders: number, checkpoint: () => void = () => {}) => {
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
        import { NextRequest } from 'next/server';
        import { createRequestStoreForAPI } from 'next/dist/server/async-storage/request-store';
        import { workUnitAsyncStorage } from 'next/dist/server/app-render/work-unit-async-storage.external';
        const scope = () => storefrontRuntime.runPromise(getCartScope('cs').pipe(Effect.match({
          onFailure: error => ({ state: error.state, diagnostic: error.diagnostic }),
          onSuccess: value => ({ state: 'ready', scope: value }),
        })));
        async function renderOne() {
          let result;
          async function ReadLocale() {
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
          return workUnitAsyncStorage.run(store, async () => {
          const errors = [];
          const stream = await renderToReadableStream(createElement(ReadLocale), {}, { onError: error => errors.push(String(error)) });
          await new Response(stream).text();
          if (errors.length) throw new Error(errors.join('\\n'));
          return result;
          });
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

describe("market read lifetime at the real server renderer", () => {
  it.live(
    "shares one market across concurrent locale chains but retains both merchandise reads",
    () => {
      const owner = fixture();
      return Effect.gen(function* sharedLocaleRead() {
        const result = yield* Effect.promise(() => renderReads(1));
        expect(result).toEqual([{ cart: readyCart, catalog: readyCatalog }]);
        // Awaiting the child close drains both HTTP chains before the exact-count assertions.
        expect(readNames(owner.requests)).toEqual(["current-market-catalog", "records", "records"]);
        expect(
          owner.requests
            .filter((read) => read.readName === "records")
            .map((read) => read.query.view?.storefrontCatalog.includeCategories)
            .toSorted((left, right) => Number(left) - Number(right)),
        ).toEqual([false, true]);
      }).pipe(Effect.provide(owner.layer));
    },
  );

  it.live("starts fresh market and merchandise reads for independent render requests", () => {
    const owner = fixture();
    return Effect.gen(function* independentRenders() {
      const result = yield* Effect.promise(() => renderReads(2));
      expect(result).toEqual(
        Array.from({ length: 2 }, () => ({ cart: readyCart, catalog: readyCatalog })),
      );
      expect(readNames(owner.requests)).toEqual([
        "current-market-catalog",
        "records",
        "records",
        "current-market-catalog",
        "records",
        "records",
      ]);
    }).pipe(Effect.provide(owner.layer));
  });

  it.live("shares a single failed retry sequence, then recovers on the next render", () => {
    const owner = fixture();
    owner.fail();
    return Effect.gen(function* failedThenFreshRender() {
      const result = yield* Effect.promise(() =>
        renderReads(2, () => {
          expect(readNames(owner.requests)).toEqual(
            Array.from({ length: 3 }, () => "current-market-catalog"),
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
      expect(readNames(owner.requests)).toEqual([
        "current-market-catalog",
        "current-market-catalog",
        "current-market-catalog",
        "current-market-catalog",
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
