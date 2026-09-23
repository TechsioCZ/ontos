import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { SetProductUnitTargetDivisibilityPayloadSchema } from '../../shared/actions/set-product-unit-target-divisibility.ts';
import { packageContentRevisions, packageDefinitions, productVariants, products } from '../../src/database/schema.ts';
import { productUnitTargetBasisForScope } from '../../src/persistence/product-unit-target-basis.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const variantId = '33333333-3333-4333-8333-333333333333';
const packageId = '44444444-4444-4444-8444-444444444444';
const unitId = '55555555-5555-4555-8555-555555555555';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:product-unit-target-basis-test:run:1',
    authMethod: 'system',
    principalId: '66666666-6666-4666-8666-666666666666',
    tenantId,
  }),
  correlationId: 'product-unit-target-basis-test',
};
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType: `commerce.catalog.${resourceType}`,
  tenantId,
});
const payload = (packageRevision: number) =>
  Schema.decodeUnknownSync(SetProductUnitTargetDivisibilityPayloadSchema)({
    divisible: false,
    evidenceRefs: ['record:package-divisibility'],
    expectedSources: {
      packageDefinition: { resourceRef: ref('package-definition', packageId), revision: packageRevision },
      product: { resourceRef: ref('product', productId), revision: 4 },
      variant: { resourceRef: ref('variant', variantId), revision: 3 },
    },
    reason: 'Verified package divisibility',
    target: {
      targetId: packageId,
      targetType: 'commerce.catalog.package-definition',
      tenantId,
      unit: ref('product-unit', unitId),
    },
  });

const first = {
  effectiveAt: new Date('1900-01-01T00:00:00.000Z'),
  lifecycleState: 'ACTIVE',
  packageDefinitionId: packageId,
  productId,
  revision: 1,
  tenantId,
  variantId,
};
const future = { ...first, effectiveAt: new Date('2999-01-01T00:00:00.000Z'), revision: 2 };

type ReadTable = typeof packageDefinitions | typeof packageContentRevisions | typeof productVariants | typeof products;
const lockedWhere = (rows: readonly object[]) => ({ for: () => ({ limit: () => Effect.succeed(rows) }) });
const readRows = (table: ReadTable, revisions: readonly object[], definitionRevision: number): readonly object[] => {
  if (table === packageDefinitions) {
    return [
      {
        currentRevision: definitionRevision,
        lifecycleState: 'ACTIVE',
        packageDefinitionId: packageId,
        productId,
        variantId,
      },
    ];
  }
  if (table === packageContentRevisions) {
    return revisions;
  }
  if (table === productVariants) {
    return [{ currentRevision: 3, lifecycleState: 'ACTIVE', productId, variantId }];
  }
  return [{ currentRevision: 4, lifecycleState: 'ACTIVE', productId }];
};

const basis = (revisions: readonly object[], definitionRevision = 2) => {
  const reads: ReadTable[] = [];
  const transaction = {
    select: () => ({
      from: (table: ReadTable) => {
        reads.push(table);
        const rows = readRows(table, revisions, definitionRevision);
        return {
          where: () => (table === packageContentRevisions ? Effect.succeed(rows) : lockedWhere(rows)),
        };
      },
    }),
  };
  // @ts-expect-error Mock implements only the exercised Drizzle chains.
  return { reads, service: productUnitTargetBasisForScope(transaction, scope) };
};

describe('Product Unit Package target basis', () => {
  it.effect('accepts the effective content revision while a successor is pending', () =>
    Effect.gen(function* acceptsEffective() {
      const { reads, service } = basis([future, first]);
      expect(yield* service.verify(payload(1).target, payload(1).expectedSources)).toBe('valid');
      expect(reads).toEqual([packageDefinitions, packageContentRevisions, productVariants, products]);
    }),
  );

  it.effect('marks a pending revision expectation stale instead of using it early', () =>
    Effect.gen(function* rejectsPending() {
      const { reads, service } = basis([first, future]);
      expect(yield* service.verify(payload(2).target, payload(2).expectedSources)).toBe('stale');
      expect(reads).toEqual([packageDefinitions, packageContentRevisions]);
    }),
  );

  it.effect('fails closed for a missing owner revision or retired effective content', () =>
    Effect.gen(function* rejectsBrokenHistory() {
      for (const revisions of [
        [future],
        [first, { ...future, revision: 3 }],
        [{ ...first, lifecycleState: 'RETIRED' }, future],
      ]) {
        const { service } = basis(revisions);
        expect(yield* service.verify(payload(1).target, payload(1).expectedSources)).toBe('invalid');
      }
    }),
  );
});
