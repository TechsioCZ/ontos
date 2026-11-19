import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  manufacturerRelationRevisions,
  manufacturerRelations,
  productVariants,
  products,
} from '../../src/database/schema.ts';
import { manufacturerCurrentReadsForScope } from '../../src/persistence/manufacturer-current-reads.ts';
import { ManufacturerPersistenceUnavailable } from '../../src/persistence/manufacturer-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '33333333-3333-4333-8333-333333333333';
const variantId = '44444444-4444-4444-8444-444444444444';
const relationId = '55555555-5555-4555-8555-555555555555';
const legalEntityId = '66666666-6666-4666-8666-666666666666';
const at = '2026-09-17T00:00:00.000Z';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: variantId,
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:manufacturer-read-test:run:1',
    authMethod: 'system',
    principalId: '22222222-2222-4222-8222-222222222222',
    tenantId,
  }),
  correlationId: 'manufacturer-current-test',
};
const head = {
  currentRevision: 1,
  disposition: 'CONFIRMED',
  effectiveFrom: null,
  effectiveTo: null,
  evidenceRefs: ['record:maker'],
  productId,
  reason: 'Verified manufacturer',
  relationId,
  targetId: legalEntityId,
  targetKind: 'LEGAL_ENTITY',
  tenantId,
  variantId: null,
};
const revision = {
  ...head,
  actingPrincipalId: scope.principalId,
  actionInvocationId: '77777777-7777-4777-8777-777777777777',
  recordedAt: new Date(at),
  revision: 1,
};
type Table =
  | typeof products
  | typeof productVariants
  | typeof manufacturerRelations
  | typeof manufacturerRelationRevisions;
const mock = (rows: Map<Table, object[]>) => ({
  select: () => ({
    from: (table: Table) => {
      const result = () => Effect.succeed(rows.get(table) ?? []);
      return { where: () => ({ limit: result, pipe: result }) };
    },
  }),
});
const rows = () =>
  new Map<Table, object[]>([
    [products, [{ productId, tenantId }]],
    [productVariants, [{ productId, tenantId, variantId }]],
    [manufacturerRelations, [head]],
    [manufacturerRelationRevisions, [revision]],
  ]);
describe('Manufacturer Current reads', () => {
  it.effect('returns the original Product provenance and its exact current revision, with no owner call', () =>
    Effect.gen(function* current() {
      // @ts-expect-error Mock implements only exercised query chains.
      const read = manufacturerCurrentReadsForScope(mock(rows()), scope);
      const result = yield* read.current(productRef, at);
      expect(result).toMatchObject({
        claim: {
          actingPrincipalId: scope.principalId,
          actionInvocationId: revision.actionInvocationId,
          evidenceRefs: ['record:maker'],
          reason: 'Verified manufacturer',
          recordedAt: new Date(at),
          relationId,
          revision: 1,
          subject: productRef,
          target: {
            kind: 'LEGAL_ENTITY',
            legalEntityRef: {
              moduleId: 'core.identity',
              resourceId: legalEntityId,
              resourceType: 'core.identity.legal-entity',
              tenantId,
            },
          },
        },
        kind: 'CURRENT',
      });
      expect(result.kind === 'CURRENT' && [result.claim.effectiveFrom, result.claim.effectiveTo]).toEqual([
        undefined,
        undefined,
      ]);
    }),
  );

  it.effect('uses Product-wide relation for a Variant, but does not invent a missing manufacturer', () =>
    Effect.gen(function* variant() {
      const data = rows();
      // @ts-expect-error Mock implements only exercised query chains.
      const read = manufacturerCurrentReadsForScope(mock(data), scope);
      expect((yield* read.current(variantRef, at)).kind).toBe('CURRENT');
      data.set(manufacturerRelations, []);
      expect(yield* read.current(variantRef, at)).toEqual({ kind: 'ABSENT' });
    }),
  );

  it.effect('rejects conflicts, foreign scope, and contradictory revision', () =>
    Effect.gen(function* invalid() {
      const data = rows();
      // @ts-expect-error Mock implements only exercised query chains.
      const read = manufacturerCurrentReadsForScope(mock(data), scope);
      data.set(manufacturerRelations, [
        head,
        { ...head, productId: null, relationId: '88888888-8888-4888-8888-888888888888', variantId },
      ]);
      expect(Schema.is(ManufacturerPersistenceUnavailable)(yield* Effect.flip(read.current(variantRef, at)))).toBe(
        true,
      );
      data.set(manufacturerRelations, [head]);
      data.set(manufacturerRelationRevisions, [{ ...revision, targetId: 'wrong' }]);
      expect(Schema.is(ManufacturerPersistenceUnavailable)(yield* Effect.flip(read.current(productRef, at)))).toBe(
        true,
      );
      expect(
        Schema.is(ManufacturerPersistenceUnavailable)(
          yield* Effect.flip(read.current({ ...productRef, tenantId: '99999999-9999-4999-8999-999999999999' }, at)),
        ),
      ).toBe(true);
    }),
  );
});
