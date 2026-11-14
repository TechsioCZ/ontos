import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import { fetch as fetchNativeHttp, request as requestNativeHttp } from '@effect/platform-node/Undici';
import { build } from 'esbuild';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

import {
  moduleReleaseServiceBinding,
  moduleReleaseWorkerName,
} from '../../packages/core-runtime/src/http/module-release-identity.ts';

const unitServiceFetchModule = fileURLToPath(
  new URL('../../packages/core-runtime/src/http/unit-service-fetch.workerd.ts', import.meta.url),
);

const releaseIdentityModule = fileURLToPath(
  new URL('../../packages/core-runtime/src/http/module-release-identity.ts', import.meta.url),
);

const bindingProbeWorker = `
import { Effect } from 'effect';
import { moduleReleaseFetch } from ${JSON.stringify(unitServiceFetchModule)};
import { moduleReleaseWorkerName } from ${JSON.stringify(releaseIdentityModule)};

const releaseModule = async (appId) => {
  const deployment = { appId, buildMarker: 'bound-worker-release' };
  const workerName = await Effect.runPromise(moduleReleaseWorkerName(appId, deployment.buildMarker));
  return {
    backend: {
      baseUrl: 'https://' + workerName + '.fixture.workers.dev/',
      transport: 'cloudflare-worker',
      versionId: '123e4567-e89b-42d3-a456-426614174000',
      workerName,
    },
    deployment,
  };
};
const forward = async (module, path) => {
  const response = await Effect.runPromise(moduleReleaseFetch(
    new Request('https://shell.invalid' + path, {
      body: 'owner-body',
      headers: { authorization: 'Bearer signed-owner-proof' },
      method: 'POST',
    }),
    module,
  ));
  return response.status + ' ' + (await response.text());
};

export default {
  async fetch() {
    return Response.json({
      bound: await forward(await releaseModule('catalog'), '/catalog-api/items?page=2'),
      unbound: await forward(await releaseModule('pricing'), '/pricing-api/prices'),
    });
  },
};
`;

const echoTransport = (transport: string) => async (request: Request) => {
  const url = new URL(request.url);
  return new Response(
    `${transport} ${request.method} ${url.host}${url.pathname}${url.search} ${request.headers.get('authorization')} ${await request.text()}`,
    { status: 201 },
  );
};

const BindingProbeResultSchema = Schema.Struct({ bound: Schema.String, unbound: Schema.String });

it.live('reaches a Worker release through the binding declared for that exact release, else its HTTPS origin', () =>
  Effect.gen(function* reachesBoundRelease() {
    const bundle = yield* Effect.promise(() =>
      build({
        bundle: true,
        conditions: ['workerd', 'worker', 'import'],
        external: ['cloudflare:*'],
        format: 'esm',
        platform: 'neutral',
        stdin: { contents: bindingProbeWorker, loader: 'js', resolveDir: import.meta.dirname },
        write: false,
      }),
    );
    const catalogRelease = yield* moduleReleaseWorkerName('catalog', 'bound-worker-release');
    const pricingRelease = yield* moduleReleaseWorkerName('pricing', 'bound-worker-release');
    const worker = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new Miniflare(
            convertV4MiniflareOptions({
              compatibilityDate: '2026-06-02',
              compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
              modules: true,
              outboundService: echoTransport('https'),
              script: bundle.outputFiles[0]?.text ?? '',
              serviceBindings: { [moduleReleaseServiceBinding(catalogRelease)]: echoTransport('binding') },
            }),
          ),
      ),
      (miniflare) => Effect.promise(() => miniflare.dispose()),
    );
    const response = yield* Effect.promise(() => worker.dispatchFetch('https://probe.invalid/'));
    const result = Schema.decodeUnknownSync(BindingProbeResultSchema)(yield* Effect.promise(() => response.json()));
    expect(moduleReleaseServiceBinding(catalogRelease)).toBe(`ONTOS_RELEASE_${catalogRelease.slice('ontos-'.length)}`);
    expect(result).toEqual({
      bound: `201 binding POST ${catalogRelease}.fixture.workers.dev/catalog-api/items?page=2 Bearer signed-owner-proof owner-body`,
      unbound: `201 https POST ${pricingRelease}.fixture.workers.dev/pricing-api/prices Bearer signed-owner-proof owner-body`,
    });
  }).pipe(Effect.scoped),
);

const moduleReleaseProbeWorker = `
import { Effect, Predicate } from 'effect';
import { moduleReleaseFetch } from ${JSON.stringify(unitServiceFetchModule)};
import { moduleReleaseWorkerName } from ${JSON.stringify(releaseIdentityModule)};

const deployment = { appId: 'catalog', buildMarker: 'ordinary-worker-release' };
const reject = (module) => Effect.runPromise(
  moduleReleaseFetch(new Request('https://shell.invalid/catalog-api/items'), module).pipe(
    Effect.match({
      onFailure: (error) => Predicate.isTagged(error, 'ModuleReleaseTransportError'),
      onSuccess: () => false,
    }),
  ),
);

export default {
  async fetch(incoming) {
    const workerName = await Effect.runPromise(moduleReleaseWorkerName(deployment.appId, deployment.buildMarker));
    const module = {
      backend: {
        baseUrl: 'https://' + workerName + '.fixture.workers.dev/',
        transport: 'cloudflare-worker',
        versionId: '123e4567-e89b-42d3-a456-426614174000',
        workerName,
      },
      deployment,
    };
    if (new URL(incoming.url).pathname === '/gzip') {
      return Effect.runPromise(moduleReleaseFetch(
        new Request('https://shell.invalid/catalog-api/gzip', {
          headers: {
            authorization: 'Bearer signed-owner-proof',
            'x-ontos-composition-revision': 'approved-revision-proof',
          },
        }),
        module,
      ));
    }
    const forwarded = await Effect.runPromise(moduleReleaseFetch(
      new Request('https://shell.invalid/catalog-api/items?filter=one&filter=two&opaque=%2F', {
        body: new Uint8Array([0, 255, 254, 17]),
        headers: {
          authorization: 'Bearer signed-owner-proof',
          'content-type': 'application/octet-stream',
          'x-ontos-composition-revision': 'approved-revision-proof',
        },
        method: 'POST',
      }),
      module,
    ));
    const bytes = Array.from(new Uint8Array(await forwarded.arrayBuffer()));
    const cookies = forwarded.headers.getAll('Set-Cookie');
    const redirect = await Effect.runPromise(moduleReleaseFetch(
      new Request('https://shell.invalid/catalog-api/redirect', {
        headers: { authorization: 'Bearer signed-owner-proof' },
      }),
      module,
    ));
    await Effect.runPromise(moduleReleaseFetch(
      new Request('https://shell.invalid//credentials-sink.invalid/escaped'),
      module,
    ));
    return Response.json({
      bytes,
      contentType: forwarded.headers.get('content-type'),
      cookies,
      invalidOriginRejected: await reject({ ...module, backend: { ...module.backend, baseUrl: 'https://credentials-sink.invalid/' } }),
      insecureOriginRejected: await reject({ ...module, backend: { baseUrl: 'http://127.0.0.1:9999/', transport: 'node-http' } }),
      mismatchedReleaseRejected: await reject({ ...module, deployment: { ...deployment, buildMarker: 'another-owner-release' } }),
      redirectLocation: redirect.headers.get('location'),
      redirectStatus: redirect.status,
      responseStatus: forwarded.status,
      workerName,
    });
  },
};
`;

const ModuleReleaseProbeResultSchema = Schema.Struct({
  bytes: Schema.Array(Schema.Number),
  contentType: Schema.String,
  cookies: Schema.Array(Schema.String),
  insecureOriginRejected: Schema.Boolean,
  invalidOriginRejected: Schema.Boolean,
  mismatchedReleaseRejected: Schema.Boolean,
  redirectLocation: Schema.String,
  redirectStatus: Schema.Number,
  responseStatus: Schema.Number,
  workerName: Schema.String,
});

it.live(
  'fetches the approved ordinary Worker origin without redirecting signed authority or changing native response bytes',
  () =>
    Effect.gen(function* fetchesOrdinaryWorkerRelease() {
      const requests: Request[] = [];
      const contentType = 'application/octet-stream';
      const decodedBytes = new Uint8Array([0, 255, 1, 128, 17]);
      const compressedBytes = new Uint8Array(gzipSync(decodedBytes));
      const bundle = yield* Effect.promise(() =>
        build({
          bundle: true,
          conditions: ['workerd', 'worker', 'import'],
          external: ['cloudflare:*'],
          format: 'esm',
          platform: 'neutral',
          stdin: { contents: moduleReleaseProbeWorker, loader: 'js', resolveDir: import.meta.dirname },
          write: false,
        }),
      );
      const worker = yield* Effect.acquireRelease(
        Effect.sync(
          () =>
            new Miniflare(
              convertV4MiniflareOptions({
                compatibilityDate: '2026-06-02',
                compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'],
                modules: true,
                outboundService: (request: Request) => {
                  requests.push(request);
                  if (new URL(request.url).pathname === '/catalog-api/redirect') {
                    return new Response(null, {
                      headers: { location: 'https://credentials-sink.invalid/stolen' },
                      status: 307,
                    });
                  }
                  if (new URL(request.url).pathname === '/catalog-api/gzip') {
                    return new Response(compressedBytes, {
                      headers: {
                        'content-encoding': 'gzip',
                        'content-length': String(compressedBytes.byteLength),
                        'content-type': contentType,
                      },
                    });
                  }
                  const headers = new Headers({ 'content-type': contentType });
                  headers.append('set-cookie', 'first=one; Path=/; HttpOnly');
                  headers.append('set-cookie', 'second=two; Path=/; Secure');
                  return new Response(new Uint8Array([0, 255, 1, 128, 17]), { headers, status: 201 });
                },
                script: bundle.outputFiles[0]?.text ?? '',
              }),
            ),
        ),
        (miniflare) => Effect.promise(() => miniflare.dispose()),
      );
      const response = yield* Effect.promise(() => worker.dispatchFetch('https://probe.invalid/'));
      const result = Schema.decodeUnknownSync(ModuleReleaseProbeResultSchema)(
        yield* Effect.promise(() => response.json()),
      );
      const observedRequests = yield* Effect.forEach((request: Request) =>
        Effect.promise(() => request.arrayBuffer()).pipe(
          Effect.map((body) => ({
            authorization: request.headers.get('authorization'),
            body: [...new Uint8Array(body)],
            method: request.method,
            revision: request.headers.get('x-ontos-composition-revision'),
            url: request.url,
          })),
        ),
      )(requests);
      const origin = `https://${result.workerName}.fixture.workers.dev`;
      expect(result).toEqual({
        bytes: [0, 255, 1, 128, 17],
        contentType,
        cookies: ['first=one; Path=/; HttpOnly', 'second=two; Path=/; Secure'],
        insecureOriginRejected: true,
        invalidOriginRejected: true,
        mismatchedReleaseRejected: true,
        redirectLocation: 'https://credentials-sink.invalid/stolen',
        redirectStatus: 307,
        responseStatus: 201,
        workerName: result.workerName,
      });
      expect(observedRequests).toEqual([
        {
          authorization: 'Bearer signed-owner-proof',
          body: [0, 255, 254, 17],
          method: 'POST',
          revision: 'approved-revision-proof',
          url: `${origin}/catalog-api/items?filter=one&filter=two&opaque=%2F`,
        },
        {
          authorization: 'Bearer signed-owner-proof',
          body: [],
          method: 'GET',
          revision: null,
          url: `${origin}/catalog-api/redirect`,
        },
        {
          authorization: null,
          body: [],
          method: 'GET',
          revision: null,
          url: `${origin}//credentials-sink.invalid/escaped`,
        },
      ]);
      const listener = yield* Effect.promise(() => worker.ready);
      const wireResponse = yield* Effect.promise(() => requestNativeHttp(new URL('/gzip', listener)));
      const wireBytes = yield* Effect.promise(() => wireResponse.body.arrayBuffer());
      expect(new Uint8Array(wireBytes)).toEqual(compressedBytes);
      expect(wireResponse.headers['content-encoding']).toBe('gzip');
      expect(wireResponse.headers['content-length']).toBe(String(compressedBytes.byteLength));
      const nativeResponse = yield* Effect.promise(() => fetchNativeHttp(new URL('/gzip', listener)));
      const nativeBytes = yield* Effect.promise(() => nativeResponse.arrayBuffer());
      expect(new Uint8Array(nativeBytes)).toEqual(decodedBytes);
      expect(requests).toHaveLength(5);
    }).pipe(Effect.scoped),
);
