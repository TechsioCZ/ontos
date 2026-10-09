import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  brandRevisions,
  brands,
  productBrandAssignmentRevisions,
  productBrandAssignments,
  products,
} from '../../src/database/schema.ts';
import { brandReadsForScope } from '../../src/persistence/brand-reads.ts';
import { CatalogPersistenceUnavailable } from '../../src/persistence/errors.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const brandId = '33333333-3333-4333-8333-333333333333';
const productId = '44444444-4444-4444-8444-444444444444';
const brandRef = {
  moduleId: 'commerce.catalog',
  resourceId: brandId,
  resourceType: 'commerce.catalog.brand',
  tenantId,
} as const;
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: productId,
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:brand-read-test:run:1',
    authMethod: 'system',
    principalId: '22222222-2222-4222-8222-222222222222',
    tenantId,
  }),
  correlationId: 'brand-read-test',
};
const audit = {
  actingPrincipalId: '22222222-2222-4222-8222-222222222222',
  actionInvocationId: '55555555-5555-4555-8555-555555555555',
  reason: 'Verified claim',
  recordedAt: new Date('2026-09-17T00:00:00.000Z'),
};
const revision = (number: number, changeKind: string, lifecycleState: string, name: string) => ({
  ...audit,
  brandId,
  changeKind,
  evidenceRefs: ['record:brand'],
  lifecycleState,
  name,
  revision: number,
  tenantId,
});

type Table =
  | typeof brands
  | typeof brandRevisions
  | typeof products
  | typeof productBrandAssignments
  | typeof productBrandAssignmentRevisions;
const mock = (rows: Map<Table, object[]>) => {
  const from = (table: Table) => {
    const result = () => Effect.succeed(rows.get(table) ?? []);
    return { where: () => ({ limit: result, pipe: result }) };
  };
  return { select: () => ({ from }) };
};

describe('Brand reads', () => {
  it.effect('keeps retired Current identity and returns exact historical names', () =>
    Effect.gen(function* readsRetired() {
      const rows = new Map<Table, object[]>([
        [brands, [{ brandId, currentRevision: 2, lifecycleState: 'RETIRED', name: 'Alfa', tenantId }]],
        [brandRevisions, [revision(1, 'CREATED', 'ACTIVE', 'Alfa Home'), revision(2, 'RETIRED', 'RETIRED', 'Alfa')]],
      ]);
      // @ts-expect-error Mock implements only exercised read chains.
      const reads = brandReadsForScope(mock(rows), scope);
      const current = yield* reads.current(brandRef);
      expect(Option.isSome(current) && current.value.assignable).toBe(false);
      const first = yield* reads.revision(brandRef, 1);
      expect(Option.isSome(first) && first.value.name).toBe('Alfa Home');
      expect(Option.isNone(yield* reads.revision(brandRef, 3))).toBe(true);
    }),
  );

  it.effect('distinguishes missing assignment, explicit unknown, and retained retired Brand', () =>
    Effect.gen(function* readsProduct() {
      const rows = new Map<Table, object[]>([[products, [{ productId, tenantId }]]]);
      // @ts-expect-error Mock implements only exercised read chains.
      const reads = brandReadsForScope(mock(rows), scope);
      const missing = yield* reads.productCurrent(productRef);
      expect(Option.isSome(missing) && missing.value.revision).toBe(0);
      expect(Option.isSome(missing) && missing.value.assignment.kind).toBe('unknown');
      rows.set(productBrandAssignments, [
        { brandId, claimKind: 'BRANDED', currentRevision: 1, evidenceRef: 'record:brand', productId, tenantId },
      ]);
      rows.set(productBrandAssignmentRevisions, [
        { ...audit, brandId, claimKind: 'BRANDED', evidenceRef: 'record:brand', productId, revision: 1, tenantId },
      ]);
      const branded = yield* reads.productCurrent(productRef);
      expect(Option.isSome(branded) && branded.value.assignment.kind).toBe('brand');
      rows.set(productBrandAssignments, [
        { brandId: null, claimKind: 'UNKNOWN', currentRevision: 1, evidenceRef: null, productId, tenantId },
      ]);
      rows.set(productBrandAssignmentRevisions, [
        { ...audit, brandId: null, claimKind: 'UNKNOWN', evidenceRef: null, productId, revision: 1, tenantId },
      ]);
      const explicitUnknown = yield* reads.productCurrent(productRef);
      expect(Option.isSome(explicitUnknown) && explicitUnknown.value.revision).toBe(1);
      expect(Option.isSome(explicitUnknown) && explicitUnknown.value.assignment.kind).toBe('unknown');
      rows.set(productBrandAssignments, [
        {
          brandId: null,
          claimKind: 'CONFIRMED_UNBRANDED',
          currentRevision: 1,
          evidenceRef: 'record:none',
          productId,
          tenantId,
        },
      ]);
      rows.set(productBrandAssignmentRevisions, [
        {
          ...audit,
          brandId: null,
          claimKind: 'CONFIRMED_UNBRANDED',
          evidenceRef: 'record:none',
          productId,
          revision: 1,
          tenantId,
        },
      ]);
      const unbranded = yield* reads.productCurrent(productRef);
      expect(Option.isSome(unbranded) && unbranded.value.assignment.kind).toBe('confirmed_unbranded');
    }),
  );

  it.effect('fails closed on foreign or mismatched Current and historical rows', () =>
    Effect.gen(function* rejectsCorruption() {
      const rows = new Map<Table, object[]>([
        [brands, [{ brandId, currentRevision: 1, lifecycleState: 'ACTIVE', name: 'Wrong', tenantId }]],
        [brandRevisions, [revision(1, 'CREATED', 'ACTIVE', 'Alfa')]],
      ]);
      // @ts-expect-error Mock implements only exercised read chains.
      const reads = brandReadsForScope(mock(rows), scope);
      expect(Schema.is(CatalogPersistenceUnavailable)(yield* Effect.flip(reads.current(brandRef)))).toBe(true);
      rows.set(brandRevisions, [
        { ...revision(1, 'CREATED', 'ACTIVE', 'Alfa'), tenantId: '99999999-9999-4999-8999-999999999999' },
      ]);
      expect(Schema.is(CatalogPersistenceUnavailable)(yield* Effect.flip(reads.history(brandRef)))).toBe(true);
    }),
  );
});
