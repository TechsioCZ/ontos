import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const unitServiceFetchModule = fileURLToPath(
  new URL('../../packages/core-runtime/src/http/unit-service-fetch.workerd.ts', import.meta.url),
);

const probeWorker = `
import { unitRoutedFetch, unitServiceFetch } from ${JSON.stringify(unitServiceFetchModule)};

const commerceFetch = unitRoutedFetch([
  { baseUrl: new URL('https://price-group-catalog.invalid/price-group-catalog-api'), serviceBinding: 'VERTICAL_PRICE_GROUP_CATALOG_WORKER' },
]);
const text = async (response) => (await response).text();

export default {
  async fetch() {
    let missingBinding;
    try {
      await unitServiceFetch('VERTICAL_ABSENT_WORKER')('https://absent.invalid/');
    } catch (error) {
      missingBinding = error._tag;
    }
    return Response.json({
      missingBinding,
      otherHost: await text(commerceFetch('https://catalog.invalid/price-group-catalog-api/items')),
      pathSibling: await text(commerceFetch('https://price-group-catalog.invalid/price-group-catalog-apis')),
      underBaseUrl: await text(
        commerceFetch(new Request('https://price-group-catalog.invalid/price-group-catalog-api/compatibility', { method: 'POST' })),
      ),
    });
  },
};
`;

const ProbeResultSchema = Schema.Struct({
  missingBinding: Schema.String,
  otherHost: Schema.String,
  pathSibling: Schema.String,
  underBaseUrl: Schema.String,
});

it.live('routes a Worker unit call under its base URL through the unit service binding and nothing else', () =>
  Effect.gen(function* routesUnitCallsInWorkerd() {
    const bundle = yield* Effect.promise(() =>
      build({
        bundle: true,
        conditions: ['workerd', 'worker', 'import'],
        external: ['cloudflare:*'],
        format: 'esm',
        platform: 'neutral',
        stdin: { contents: probeWorker, loader: 'js', resolveDir: import.meta.dirname },
        write: false,
      }),
    );
    const worker = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Miniflare(
            convertV4MiniflareOptions({
              compatibilityDate: '2026-06-02',
              compatibilityFlags: ['nodejs_compat'],
              modules: true,
              outboundService: (request: Request) => new Response(`global ${new URL(request.url).host}`),
              script: bundle.outputFiles[0]?.text ?? '',
              serviceBindings: {
                VERTICAL_PRICE_GROUP_CATALOG_WORKER: (request: Request) =>
                  new Response(`binding ${request.method} ${new URL(request.url).pathname}`),
              },
            }),
          ),
      ),
      (miniflare) => Effect.promise(() => miniflare.dispose()),
    );
    const response = yield* Effect.promise(() => worker.dispatchFetch('https://probe.invalid/'));
    const result = Schema.decodeUnknownSync(ProbeResultSchema)(yield* Effect.promise(() => response.json()));
    expect(result).toEqual({
      missingBinding: 'UnitServiceBindingMissingError',
      otherHost: 'global catalog.invalid',
      pathSibling: 'global price-group-catalog.invalid',
      underBaseUrl: 'binding POST /price-group-catalog-api/compatibility',
    });
  }).pipe(Effect.scoped),
);
