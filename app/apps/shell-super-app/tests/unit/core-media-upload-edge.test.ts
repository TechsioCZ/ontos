import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Path, Schema, SchemaAST } from 'effect';
import { expect, it } from 'effect-rstest';

import { ShellAuthenticationApi } from '../../shared/browser-api.ts';

/*
 * The Core Media byte-INGRESS edge of the Shell (#1433, #1430): one hand-written streaming route that takes only an
 * asset id and the raw body, declares no payload schema (so no framework buffering, cap or content-type
 * negotiation), and has no JSON route of the byte-source Read. The runtime behavior (principal binding, replay,
 * conflict, uncertain ends, confirm) is proven in core-runtime against real PostgreSQL, the provider double and the
 * S3-compatible emulator; here only the contract and the source surface are pinned.
 */

const { coreMediaUpload: group } = ShellAuthenticationApi.groups;
const { uploadAssetBytes: endpoint } = group.endpoints;

const readApp = Effect.fn('CoreMediaUploadEdge.read')(function* readApp(relative: string) {
  const [fileSystem, path] = yield* Effect.all([FileSystem.FileSystem, Path.Path], { concurrency: 2 });
  return yield* fileSystem.readFileString(yield* path.fromFileUrl(new URL(`../../${relative}`, import.meta.url)));
});

const statusOf = (schema: Schema.Top): number => Number(Schema.resolveAnnotationsKey(schema)?.httpApiStatus);

it('publishes exactly one upload endpoint: a PUT by asset id with no declared payload', () => {
  expect(Object.keys(group.endpoints)).toEqual(['uploadAssetBytes']);
  expect(endpoint.method).toBe('PUT');
  expect(endpoint.path).toBe('/core/media/assets/:mediaAssetId/bytes');
  const { params } = endpoint;
  expect(params !== undefined && SchemaAST.isObjects(params.ast)).toBe(true);
  expect(
    params !== undefined && SchemaAST.isObjects(params.ast)
      ? params.ast.propertySignatures.map(({ name }) => name)
      : [],
  ).toEqual(['mediaAssetId']);
  // The handler reads the request stream itself: nothing declared here can buffer, cap or negotiate the body.
  expect(endpoint.payload.size).toBe(0);
  expect(endpoint.query).toBeUndefined();
  expect(Schema.is(endpoint.params ?? Schema.Never)({ mediaAssetId: 'not-a-uuid' })).toBe(false);
  expect(Schema.is(endpoint.params ?? Schema.Never)({ mediaAssetId: '11111111-1111-4111-8111-111111111111' })).toBe(
    true,
  );
});

it('answers success only as the ready identity and carries no storage value', () => {
  const [success] = [...endpoint.success];
  expect(success).toBeDefined();
  const decode = Schema.decodeUnknownSync(Schema.toType(Schema.Union([success ?? Schema.Never])));
  const ready = {
    byteSize: 3,
    contentSha256: 'a'.repeat(64),
    mediaAssetRef: {
      moduleId: 'core.media',
      resourceId: '11111111-1111-4111-8111-111111111111',
      resourceType: 'core.media.asset',
      tenantId: '22222222-2222-4222-8222-222222222222',
    },
    processingStatus: 'ready',
  };
  expect(decode(ready)).toEqual(ready);
  for (const status of ['uploaded', 'scanning', 'failed']) {
    expect(() => decode({ ...ready, processingStatus: status })).toThrow();
  }
  expect([...endpoint.success]).toHaveLength(1);
});

it('keeps every failure a distinct, redacted Problem Details status, with 411 for a body of unstated length', () => {
  const statuses = [...endpoint.error].map(statusOf).toSorted((left, right) => left - right);
  expect(statuses).toEqual([400, 401, 403, 404, 409, 411, 422, 428, 429, 500, 503]);
  for (const forbidden of [206, 301, 302, 303, 307, 308, 304, 413]) {
    expect(statuses).not.toContain(forbidden);
  }
});

it.layer(NodeServices.layer, { excludeTestServices: true })('the Shell sources of the upload', (suite) => {
  suite.effect('have no JSON route, DTO or client of the byte-source Read', () =>
    Effect.gen(function* noJsonRoute() {
      for (const file of ['shared/browser-api.ts', 'shared/api.ts', 'api/index.ts', 'src/api/auth-client.ts']) {
        const text = yield* readApp(file);
        expect(text, file).not.toContain('/core/reads/asset-byte-source');
        expect(text, file).not.toContain('executeAssetByteSource');
        expect(text, file).not.toMatch(/core-reads\/asset-byte-source/u);
      }
      const exists = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fileSystem) =>
          Path.Path.pipe(
            Effect.flatMap((path) =>
              path.fromFileUrl(new URL('../../shared/core-reads/asset-byte-source.ts', import.meta.url)),
            ),
            Effect.flatMap((target) => fileSystem.exists(target)),
          ),
        ),
      );
      expect(exists).toBe(false);
    }),
  );

  suite.effect('authenticate first, take the tenant from the principal, and never hash, buffer or cap the body', () =>
    Effect.gen(function* handlerBehavior() {
      const index = yield* readApp('api/index.ts');
      const start = index.indexOf("HttpApiBuilder.group(ShellAuthenticationApi, 'coreMediaUpload'");
      const end = index.indexOf('The Core operations the Shell host serves to modules');
      expect(start).toBeGreaterThan(0);
      const handler = index.slice(start, end);
      expect(handler.indexOf('resolveTenantContext')).toBeGreaterThan(0);
      expect(handler.indexOf('resolveTenantContext')).toBeLessThan(handler.indexOf('assetByteSourceRead'));
      expect(handler.indexOf('assetByteSourceRead')).toBeLessThan(handler.indexOf('ingestMediaBytes'));
      // The tenant of the ref is the authenticated principal's, never the request's.
      expect(handler).toContain('tenantId: principal.tenantId');
      // The body is the request stream itself: no collect, no whole-body read, no hashing and no size cap in the Shell.
      expect(handler).toContain('body: request.stream');
      expect(handler).not.toMatch(/arrayBuffer|\.text\b|runCollect|sha256|noble|maxBytes|payloadTooLarge|413/iu);
      // The caller's own principal runs the confirm Action: the Shell adds no permission of its own.
      expect(handler).toContain('registration: confirmAssetAction');
      expect(handler).not.toMatch(/redirect|presign|signedUrl|x-amz/iu);
      // Every answer, the failures too, is private and no-store, before anything can fail.
      expect(handler.indexOf('privateUploadResponse')).toBeLessThan(handler.indexOf('resolveTenantContext'));
    }),
  );
});
