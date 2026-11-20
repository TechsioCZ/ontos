import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path, Schema, SchemaAST } from 'effect';
import { expect, it } from 'effect-rstest';

import { ShellAuthenticationApi } from '../../shared/browser-api.ts';

/*
 * The Core Media byte-delivery edge of the Shell (#1443, #1436, design-review M9): one hand-written streaming route
 * that takes only an asset id, no payload and no storage value, and carries no JSON route of the governed download
 * Read. The runtime behavior (a fresh decision per request, abort on corruption, finish-after-revoke) is proven in
 * core-runtime against real PostgreSQL and SpiceDB; here only the contract and the source surface are pinned.
 */

const { coreMediaDownload: group } = ShellAuthenticationApi.groups;
const { downloadAsset: endpoint } = group.endpoints;

const readApp = Effect.fn('CoreMediaDownloadEdge.read')(function* readApp(relative: string) {
  const [fileSystem, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path], { concurrency: 2 });
  return yield* fileSystem.readFileString(yield* path.fromFileUrl(new URL(`../../${relative}`, import.meta.url)));
});

const statusOf = (schema: Schema.Top): number => Number(Schema.resolveAnnotationsKey(schema)?.httpApiStatus);

it('publishes exactly one download endpoint: a GET by asset id with no payload and a streamed byte body', () => {
  expect(Object.keys(group.endpoints)).toEqual(['downloadAsset']);
  expect(endpoint.method).toBe('GET');
  expect(endpoint.path).toBe('/core/media/assets/:mediaAssetId/content');
  // The asset id is the only input: no tenant, no storage key, no URL, no range or version parameter.
  const { params } = endpoint;
  expect(params !== undefined && SchemaAST.isObjects(params.ast)).toBe(true);
  expect(
    params !== undefined && SchemaAST.isObjects(params.ast)
      ? params.ast.propertySignatures.map(({ name }) => name)
      : [],
  ).toEqual(['mediaAssetId']);
  expect(endpoint.payload.size).toBe(0);
  expect(endpoint.query).toBeUndefined();
  expect(Schema.is(endpoint.params ?? Schema.Never)({ mediaAssetId: 'not-a-uuid' })).toBe(false);
  expect(Schema.is(endpoint.params ?? Schema.Never)({ mediaAssetId: '11111111-1111-4111-8111-111111111111' })).toBe(
    true,
  );
  const [success] = [...endpoint.success];
  expect(success?.ast && SchemaAST.isDeclaration(success.ast)).toBe(true);
  expect([...endpoint.success]).toHaveLength(1);
});

it('keeps every failure a distinct, redacted Problem Details status: none of the 301, 302, 206, 304 transports', () => {
  const statuses = [...endpoint.error].map(statusOf).toSorted((left, right) => left - right);
  expect(statuses).toEqual([400, 401, 403, 404, 409, 422, 428, 429, 500, 503]);
  for (const forbidden of [206, 301, 302, 303, 307, 308, 304]) {
    expect(statuses).not.toContain(forbidden);
  }
});

it.layer(NodeServices.layer, { excludeTestServices: true })('the Shell sources of the download', (suite) => {
  suite.effect('have no JSON route, DTO or client of the download Read and no storage value on the route', () =>
    Effect.gen(function* noJsonRoute() {
      const files = ['shared/browser-api.ts', 'shared/api.ts', 'api/index.ts', 'src/api/auth-client.ts'];
      for (const file of files) {
        const text = yield* readApp(file);
        expect(text, file).not.toContain('/core/reads/asset-download');
        expect(text, file).not.toContain('executeAssetDownload');
        expect(text, file).not.toMatch(/core-reads\/asset-download/u);
      }
      const exists = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fileSystem) =>
          Path.Path.pipe(
            Effect.flatMap((path) =>
              path.fromFileUrl(new URL('../../shared/core-reads/asset-download.ts', import.meta.url)),
            ),
            Effect.flatMap((target) => fileSystem.exists(target)),
          ),
        ),
      );
      expect(exists).toBe(false);
    }),
  );

  suite.effect('answer from an allow-listed header set and never re-read a header the client sent', () =>
    Effect.gen(function* handlerBehavior() {
      const index = yield* readApp('api/index.ts');
      const start = index.indexOf("HttpApiBuilder.group(ShellAuthenticationApi, 'coreMediaDownload'");
      const end = index.indexOf('const coreMediaObjectStorageLive');
      expect(start).toBeGreaterThan(0);
      const handler = index.slice(start, end);
      // Authorization is the governed download Read of this very request, before any provider byte.
      expect(handler.indexOf('assetDownloadRead')).toBeGreaterThan(0);
      expect(handler.indexOf('assetDownloadRead')).toBeLessThan(handler.indexOf('streamConfirmedBytes'));
      // The tenant of the ref is the authenticated principal's, never the request's.
      expect(handler).toContain('tenantId: resolved.principal.tenantId');
      // Range and every conditional header are ignored: the handler never reads them, so a retry is a new decision.
      expect(handler).not.toMatch(/range|if-none-match|if-modified-since|if-range|etag/iu);
      expect(handler).not.toMatch(/redirect|presign|signedUrl|x-amz/iu);
      expect(handler).toContain('downloadResponseHeaders(authorization)');
      // A HEAD request is answered after its own decision and never opens the provider.
      expect(handler.indexOf("request.method === 'HEAD'")).toBeGreaterThan(handler.indexOf('assetDownloadRead'));
      expect(handler.indexOf("request.method === 'HEAD'")).toBeLessThan(handler.indexOf('streamConfirmedBytes'));
    }),
  );
});
