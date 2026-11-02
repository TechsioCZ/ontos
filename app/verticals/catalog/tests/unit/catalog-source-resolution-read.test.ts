import { ReadHandlerNotFound, ReadHandlerUnavailable } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CatalogSourceResolutionRequestSchema } from '../../shared/apis/catalog-source-resolution.ts';
import { readCatalogSourceResolution } from '../../src/api/catalog-source-resolution.read.ts';
import type { CatalogSourceFactValue } from '../../shared/actions/catalog-source-resolution.ts';
import type { CatalogLocalOverride } from '../../src/domain/catalog-source-resolution.ts';
import { CatalogSourceResolutionUnavailable } from '../../src/persistence/catalog-source-resolution-ports.ts';
import type { catalogSourceResolutionReadStoreForScope } from '../../src/persistence/catalog-source-resolution-read-store.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const input = Schema.decodeUnknownSync(CatalogSourceResolutionRequestSchema)({
  scope: {
    factKey: 'catalog.name',
    targetId: '22222222-2222-4222-8222-222222222222',
    targetKind: 'PRODUCT',
    tenantId,
  },
});
const retainedOverride: CatalogLocalOverride<CatalogSourceFactValue> = {
  actorPrincipalId: 'principal-1',
  evidenceRef: 'retained-evidence',
  lifecycle: 'ACTIVE',
  reason: 'Retained decision',
  revision: 1n,
  scope: input.scope,
  value: 'Retained name',
};
const makeServices = (exists: boolean, unavailable = false) => {
  let sourceReads = 0;
  let ownerReads = 0;
  const services: ReturnType<typeof catalogSourceResolutionReadStoreForScope> = {
    productExists: () => {
      ownerReads += 1;
      return unavailable
        ? Effect.fail(
            new CatalogSourceResolutionUnavailable({
              code: 'catalog_source_resolution_unavailable',
              reason: 'Owner unavailable',
            }),
          )
        : Effect.succeed(exists);
    },
    readAcceptedBases: () =>
      Effect.sync(() => {
        sourceReads += 1;
        return [];
      }),
    readOverrides: () =>
      Effect.sync(() => {
        sourceReads += 1;
        return [retainedOverride];
      }),
  };
  return { counts: () => ({ ownerReads, sourceReads }), services };
};

describe('Catalog source resolution Product identity', () => {
  it.effect('does not publish retained phantom override evidence as Current', () =>
    Effect.gen(function* testMissing() {
      const fixture = makeServices(false);
      const error = yield* readCatalogSourceResolution(input, tenantId, fixture.services).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerNotFound)(error)).toBe(true);
      expect(fixture.counts()).toEqual({ ownerReads: 1, sourceReads: 0 });
    }),
  );
  it.effect('keeps existing Product empty-base override Current with exact immutable evidence', () =>
    Effect.gen(function* testExisting() {
      const fixture = makeServices(true);
      const result = yield* readCatalogSourceResolution(input, tenantId, fixture.services);
      expect(result).toEqual({
        source: { evidenceRef: 'retained-evidence', kind: 'LOCAL_OVERRIDE', revision: 1n },
        status: 'CURRENT',
        value: 'Retained name',
      });
      expect(fixture.counts()).toEqual({ ownerReads: 1, sourceReads: 2 });
    }),
  );
  it.effect('returns typed unavailable when owner lookup cannot establish identity', () =>
    Effect.gen(function* testUnavailable() {
      const fixture = makeServices(false, true);
      const error = yield* readCatalogSourceResolution(input, tenantId, fixture.services).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerUnavailable)(error)).toBe(true);
      expect(fixture.counts()).toEqual({ ownerReads: 1, sourceReads: 0 });
    }),
  );
  it.effect('rejects foreign Tenant before any owner or source read', () =>
    Effect.gen(function* testForeign() {
      const fixture = makeServices(true);
      const error = yield* readCatalogSourceResolution(
        input,
        '33333333-3333-4333-8333-333333333333',
        fixture.services,
      ).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerNotFound)(error)).toBe(true);
      expect(fixture.counts()).toEqual({ ownerReads: 0, sourceReads: 0 });
    }),
  );
});
