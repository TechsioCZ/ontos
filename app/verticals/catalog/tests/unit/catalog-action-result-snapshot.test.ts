import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { catalogResultSnapshots } from '../../src/database/schema.ts';
import {
  captureCatalogActionResult,
  catalogActionResultSnapshotForScope,
} from '../../src/persistence/catalog-action-result-snapshot.ts';
import { CatalogPersistenceConflict, CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';

/* oxlint-disable anti-slop/no-object-parameters, sonarjs/no-nested-functions -- Typed JSONB test codec and narrowly mocked Drizzle query builders require these shapes. owner: Catalog #478; remove with a shared transaction fixture. expires: 2027-03-31. */

const tenantId = '00000000-0000-4000-8000-000000000001';
const principalId = '00000000-0000-4000-8000-000000000002';
const identity = {
  actionInvocationId: '00000000-0000-4000-8000-000000000003',
  actionKey: 'commerce.catalog.create-product',
  schemaVersion: 1,
};
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:snapshot-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'snapshot-test',
};
const codec = {
  decode: (value: object) =>
    Schema.decodeUnknownEffect(Schema.Struct({ productId: Schema.String.pipe(Schema.brand('ProductId')) }))(value),
  encode: (value: { readonly productId: string }) => Effect.succeed(value),
};
const productId = Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand('ProductId')))('product-1');
const otherProductId = Schema.decodeUnknownSync(Schema.String.pipe(Schema.brand('ProductId')))('product-2');

const transaction = (
  options: {
    existing?: typeof catalogResultSnapshots.$inferInsert;
    inserted?: boolean;
    readUnavailable?: boolean;
  } = {},
) => {
  const rows: (typeof catalogResultSnapshots.$inferInsert)[] = [];
  return {
    insert: (table: typeof catalogResultSnapshots) => {
      expect(table).toBe(catalogResultSnapshots);
      return {
        values: (row: typeof catalogResultSnapshots.$inferInsert) => ({
          onConflictDoNothing: () => ({
            returning: () => {
              rows.push(row);
              return Effect.succeed(options.inserted === false ? [] : [row]);
            },
          }),
        }),
      };
    },
    rows,
    select: () => ({
      from: (table: typeof catalogResultSnapshots) => {
        expect(table).toBe(catalogResultSnapshots);
        return {
          where: () => ({
            limit: () =>
              options.readUnavailable === true
                ? Effect.fail(new Error('database unavailable'))
                : Effect.succeed(options.existing ? [options.existing] : []),
          }),
        };
      },
    }),
  };
};

describe('Catalog Action result snapshot', () => {
  it.effect('captures a different Action result through the same transaction-bound port', () =>
    Effect.gen(function* capturesGenericResult() {
      const tx = transaction();
      const otherIdentity = { ...identity, actionKey: 'commerce.catalog.assign-sku', schemaVersion: 2 };
      const otherCodec = {
        decode: Schema.decodeUnknownEffect(Schema.Struct({ sku: Schema.String })),
        encode: Schema.encodeEffect(Schema.Struct({ sku: Schema.String })),
      };
      // @ts-expect-error Focused mock implements only the snapshot query chains.
      yield* captureCatalogActionResult(tx, scope, otherIdentity, otherCodec, { sku: 'SKU-1' });
      expect(tx.rows).toEqual([
        expect.objectContaining({
          actionKey: otherIdentity.actionKey,
          encodedResult: { sku: 'SKU-1' },
          schemaVersion: 2,
        }),
      ]);
    }),
  );
  it.effect('writes the typed result in the supplied scoped transaction', () =>
    Effect.gen(function* writesSnapshot() {
      const tx = transaction();
      // @ts-expect-error Focused mock implements only the snapshot query chains.
      const service = catalogActionResultSnapshotForScope(tx, scope, codec);
      const value = { productId };
      expect(yield* service.insert(identity, value)).toEqual(value);
      expect(tx.rows).toEqual([
        expect.objectContaining({
          actingPrincipalId: principalId,
          actionInvocationId: identity.actionInvocationId,
          actionKey: identity.actionKey,
          encodedResult: value,
          schemaVersion: 1,
          tenantId,
        }),
      ]);
    }),
  );

  it.effect('returns a typed same-invocation replay without replacing the stored row', () =>
    Effect.gen(function* replaysSnapshot() {
      const existing = {
        ...identity,
        actingPrincipalId: principalId,
        encodedResult: { productId: 'product-1' },
        tenantId,
      };
      const tx = transaction({ existing, inserted: false });
      // @ts-expect-error Focused mock implements only the snapshot query chains.
      const service = catalogActionResultSnapshotForScope(tx, scope, codec);
      expect(yield* service.insert(identity, { productId })).toEqual({ productId });
    }),
  );

  it.effect('rejects divergent replay and principal mismatch', () =>
    Effect.gen(function* rejectsDivergence() {
      const existing = {
        ...identity,
        actingPrincipalId: principalId,
        encodedResult: { productId: 'product-1' },
        tenantId,
      };
      const tx = transaction({ existing, inserted: false });
      // @ts-expect-error Focused mock implements only the snapshot query chains.
      const service = catalogActionResultSnapshotForScope(tx, scope, codec);
      const divergent = yield* Effect.flip(service.insert(identity, { productId: otherProductId }));
      expect(Schema.is(CatalogPersistenceConflict)(divergent)).toBe(true);
      const wrongPrincipal = catalogActionResultSnapshotForScope(
        // @ts-expect-error Focused mock implements only the snapshot query chains.
        tx,
        { ...scope, principalId: '00000000-0000-4000-8000-000000000099' },
        codec,
      );
      const denied = yield* Effect.flip(wrongPrincipal.read(identity));
      expect(Schema.is(CatalogPersistenceUnavailable)(denied)).toBe(true);
    }),
  );

  it.effect('fails closed for a missing or undecodable result', () =>
    Effect.gen(function* failsClosed() {
      const missing = transaction();
      // @ts-expect-error Focused mock implements only the snapshot query chains.
      const missingService = catalogActionResultSnapshotForScope(missing, scope, codec);
      expect(Schema.is(CatalogPersistenceUnavailable)(yield* Effect.flip(missingService.read(identity)))).toBe(true);
      const malformed = transaction({
        existing: { ...identity, actingPrincipalId: principalId, encodedResult: { wrong: true }, tenantId },
      });
      // @ts-expect-error Focused mock implements only the snapshot query chains.
      const malformedService = catalogActionResultSnapshotForScope(malformed, scope, codec);
      expect(Schema.is(CatalogPersistenceUnavailable)(yield* Effect.flip(malformedService.read(identity)))).toBe(true);
    }),
  );

  it.effect('does not turn a failed snapshot read into an absent or committed result', () =>
    Effect.gen(function* unavailableRead() {
      const tx = transaction({ readUnavailable: true });
      // @ts-expect-error Focused mock implements only the snapshot query chains.
      const service = catalogActionResultSnapshotForScope(tx, scope, codec);
      expect(Schema.is(CatalogPersistenceUnavailable)(yield* Effect.flip(service.read(identity)))).toBe(true);
    }),
  );
});
