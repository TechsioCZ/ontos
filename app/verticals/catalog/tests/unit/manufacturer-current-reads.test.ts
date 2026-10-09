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
import { ManufacturerTargetAbsent } from '../../src/persistence/manufacturer-target-absent.ts';
import { ManufacturerTargetForbidden } from '../../src/persistence/manufacturer-target-forbidden.ts';
import { makeManufacturerTargetResolver } from '../../src/persistence/manufacturer-target-resolver.ts';
import { ManufacturerTargetUnavailable } from '../../src/persistence/manufacturer-target-unavailable.ts';

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
const resolver = (status: 'active' | 'suspended' | 'archived' = 'active') =>
  makeManufacturerTargetResolver({
    readManagedLegalEntity: ({ legalEntityRef }) => Effect.succeed({ legalEntityRef, status }),
    readPartyDetail: () => Effect.fail({ _tag: 'PartyDetailUnavailableProblem' }),
  });

describe('Manufacturer Current reads', () => {
  it.effect('returns the original Product provenance and owner-verified managed Legal Entity', () =>
    Effect.gen(function* current() {
      // @ts-expect-error Mock implements only exercised query chains.
      const read = manufacturerCurrentReadsForScope(mock(rows()), scope, { targetResolver: resolver() });
      const result = yield* read.effective(productRef, at);
      expect(result).toMatchObject({
        claim: {
          evidenceRefs: ['record:maker'],
          owner: { kind: 'LEGAL_ENTITY', state: 'CURRENT' },
          relationId,
          revision: 1,
          subject: productRef,
          target: { kind: 'LEGAL_ENTITY', legalEntityRef: { resourceId: legalEntityId } },
        },
        kind: 'CURRENT',
      });
    }),
  );

  it.effect('uses Product-wide relation for a Variant, but does not invent a missing manufacturer', () =>
    Effect.gen(function* variant() {
      const data = rows();
      // @ts-expect-error Mock implements only exercised query chains.
      const read = manufacturerCurrentReadsForScope(mock(data), scope, { targetResolver: resolver() });
      expect((yield* read.effective(variantRef, at)).kind).toBe('CURRENT');
      data.set(manufacturerRelations, []);
      expect(yield* read.effective(variantRef, at)).toEqual({ kind: 'ABSENT' });
    }),
  );

  it.effect('preserves archived status and fails closed without the managed-owner port', () =>
    Effect.gen(function* archived() {
      // @ts-expect-error Mock implements only exercised query chains.
      const archivedRead = manufacturerCurrentReadsForScope(mock(rows()), scope, {
        targetResolver: resolver('archived'),
      });
      expect(yield* archivedRead.effective(productRef, at)).toMatchObject({
        claim: { owner: { state: 'ARCHIVED' } },
        kind: 'CURRENT',
      });
      // @ts-expect-error Mock implements only exercised query chains.
      const noOwnerRead = manufacturerCurrentReadsForScope(mock(rows()), scope);
      expect(Schema.is(ManufacturerTargetUnavailable)(yield* Effect.flip(noOwnerRead.effective(productRef, at)))).toBe(
        true,
      );
    }),
  );

  it.effect('keeps owner absence, denial, and unavailability distinct', () =>
    Effect.gen(function* failures() {
      for (const [tag, expected] of [
        ['ReadHandlerNotFound', ManufacturerTargetAbsent],
        ['ReadPermissionDenied', ManufacturerTargetForbidden],
        ['ReadUnavailable', ManufacturerTargetUnavailable],
      ] as const) {
        const targetResolver = makeManufacturerTargetResolver({
          readManagedLegalEntity: () => Effect.fail({ _tag: tag }),
          readPartyDetail: () => Effect.fail({ _tag: 'PartyDetailUnavailableProblem' }),
        });
        // @ts-expect-error Mock implements only exercised query chains.
        const read = manufacturerCurrentReadsForScope(mock(rows()), scope, { targetResolver });
        expect(Schema.is(expected)(yield* Effect.flip(read.effective(productRef, at)))).toBe(true);
      }
    }),
  );

  it.effect('rejects conflicts, foreign scope, and contradictory revision before owner resolution', () =>
    Effect.gen(function* invalid() {
      const data = rows();
      let called = false;
      const targetResolver = makeManufacturerTargetResolver({
        readManagedLegalEntity: ({ legalEntityRef }) => {
          called = true;
          return Effect.succeed({ legalEntityRef, status: 'active' });
        },
        readPartyDetail: () => Effect.fail({ _tag: 'PartyDetailUnavailableProblem' }),
      });
      // @ts-expect-error Mock implements only exercised query chains.
      const read = manufacturerCurrentReadsForScope(mock(data), scope, { targetResolver });
      data.set(manufacturerRelations, [
        head,
        { ...head, productId: null, relationId: '88888888-8888-4888-8888-888888888888', variantId },
      ]);
      expect(Schema.is(ManufacturerPersistenceUnavailable)(yield* Effect.flip(read.effective(variantRef, at)))).toBe(
        true,
      );
      data.set(manufacturerRelations, [head]);
      data.set(manufacturerRelationRevisions, [{ ...revision, targetId: 'wrong' }]);
      expect(Schema.is(ManufacturerPersistenceUnavailable)(yield* Effect.flip(read.effective(productRef, at)))).toBe(
        true,
      );
      expect(
        Schema.is(ManufacturerPersistenceUnavailable)(
          yield* Effect.flip(read.effective({ ...productRef, tenantId: '99999999-9999-4999-8999-999999999999' }, at)),
        ),
      ).toBe(true);
      expect(called).toBe(false);
    }),
  );
});
