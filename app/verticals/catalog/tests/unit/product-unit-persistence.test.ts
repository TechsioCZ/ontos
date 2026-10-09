import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CreateProductUnitPayloadSchema } from '../../shared/actions/create-product-unit.ts';
import { ReviseProductUnitPayloadSchema } from '../../shared/actions/revise-product-unit.ts';
import { RetireProductUnitPayloadSchema } from '../../shared/actions/retire-product-unit.ts';
import { SetProductUnitTargetDivisibilityPayloadSchema } from '../../shared/actions/set-product-unit-target-divisibility.ts';
import { productUnitRuleRevisions, productUnits, productVariants, products } from '../../src/database/schema.ts';
import { productUnitPersistenceServiceFactory } from '../../src/actions/product-unit-action-support.ts';
import {
  productUnitPersistenceForScope,
  ProductUnitPersistenceUnavailable,
} from '../../src/persistence/product-unit-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const principalId = '22222222-2222-4222-8222-222222222222';
const unitId = '33333333-3333-4333-8333-333333333333';
const variantId = '44444444-4444-4444-8444-444444444444';
const productId = '77777777-7777-4777-8777-777777777777';
const expectedSources = {
  product: {
    resourceRef: {
      moduleId: 'commerce.catalog',
      resourceId: productId,
      resourceType: 'commerce.catalog.product',
      tenantId,
    },
    revision: 2,
  },
  variant: {
    resourceRef: {
      moduleId: 'commerce.catalog',
      resourceId: variantId,
      resourceType: 'commerce.catalog.variant',
      tenantId,
    },
    revision: 3,
  },
};
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:product-unit-persistence-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'product-unit-persistence-test',
};
const unitRef = {
  moduleId: 'commerce.catalog',
  resourceId: unitId,
  resourceType: 'commerce.catalog.product-unit',
  tenantId,
};
const evidence = { actionInvocationId: '55555555-5555-4555-8555-555555555555', principalId };
const createPayload = Schema.decodeUnknownSync(CreateProductUnitPayloadSchema)({
  code: 'M',
  evidenceRefs: ['catalog-record:unit'],
  label: 'Metre',
  reason: 'Catalog unit approved',
  rule: { rounding: 'UP', step: '0.01' },
  unitRef,
});

type UnitReadTable = typeof productUnits | typeof productUnitRuleRevisions;
type ProductReadTable = UnitReadTable | typeof productVariants | typeof products;
const activeUnit = { currentRuleRevision: 1, lifecycleState: 'ACTIVE', tenantId, unitId };
const currentRule = { revision: 1, rounding: 'UP', step: '0.01', tenantId, unitId };
const readRows = (rows: readonly object[]) => () => Effect.succeed(rows);
const unitWhere = (rows: readonly object[]) => ({ for: () => ({ limit: readRows(rows) }) });

const selectUnit = (unitRows: readonly object[]) => () => ({
  from: () => ({ where: () => unitWhere(unitRows) }),
});

const selectUnitAndRule =
  (unitRows: readonly object[], ruleRows: readonly object[] = [currentRule]) =>
  () => ({
    from: (table: UnitReadTable) => ({
      where: () => (table === productUnits ? unitWhere(unitRows) : { limit: readRows(ruleRows) }),
    }),
  });

const recordRuleWrite = (writes: unknown[]) => (table: typeof productUnitRuleRevisions) => ({
  values: (value: typeof productUnitRuleRevisions.$inferInsert) => {
    writes.push([table, value]);
    return Effect.succeed([]);
  },
});

const readLocked = (locked: ProductReadTable[], table: ProductReadTable) => () => {
  locked.push(table);
  if (table === productUnits) {
    return Effect.succeed([activeUnit]);
  }
  if (table === productVariants) {
    return Effect.succeed([{ currentRevision: 3, lifecycleState: 'ACTIVE', productId, variantId }]);
  }
  if (table === products) {
    return Effect.succeed([{ currentRevision: 4, lifecycleState: 'ACTIVE', productId }]);
  }
  throw new Error('unexpected locked table');
};

const productWhere = (locked: ProductReadTable[], table: ProductReadTable) => ({
  for: () => ({ limit: readLocked(locked, table) }),
  limit: readRows([currentRule]),
});
const selectProductCurrent = (locked: ProductReadTable[]) => () => ({
  from: (table: ProductReadTable) => ({ where: () => productWhere(locked, table) }),
});

const retireUpdate = (current: typeof activeUnit) => () => ({
  set: () => ({
    where: () => ({ returning: readRows([{ ...current, currentRuleRevision: 2, lifecycleState: 'RETIRED' }]) }),
  }),
});

describe('Product Unit persistence', () => {
  it.effect('creates one stable Unit and appends its first rule revision', () =>
    Effect.gen(function* createsUnit() {
      const writes: unknown[] = [];
      const transaction = {
        insert: (table: typeof productUnits | typeof productUnitRuleRevisions) => ({
          values: (value: typeof productUnits.$inferInsert | typeof productUnitRuleRevisions.$inferInsert) => {
            writes.push([table, value]);
            return table === productUnits ? { returning: () => Effect.succeed([value]) } : Effect.succeed([]);
          },
        }),
        select: selectUnit([]),
      };
      // @ts-expect-error Mock implements only the exercised Drizzle chains.
      const service = productUnitPersistenceForScope(transaction, scope);
      const result = yield* service.create({ ...evidence, payload: createPayload });
      expect(
        Match.value(result).pipe(
          Match.tag('created', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(writes).toEqual([
        [productUnits, expect.objectContaining({ currentRuleRevision: 1, lifecycleState: 'ACTIVE', tenantId, unitId })],
        [
          productUnitRuleRevisions,
          expect.objectContaining({
            changeKind: 'CREATED',
            evidenceRefs: ['catalog-record:unit'],
            revision: 1,
            rounding: 'UP',
            step: '0.01',
            unitId,
          }),
        ],
      ]);
    }),
  );

  it.effect('rejects cross-tenant identity before database access', () =>
    Effect.gen(function* rejectsCrossTenant() {
      const transaction = {
        select: () => {
          throw new Error('must not read');
        },
      };
      // @ts-expect-error No query should occur.
      const service = productUnitPersistenceForScope(transaction, scope);
      const result = yield* service.create({
        ...evidence,
        payload: {
          ...createPayload,
          unitRef: { ...createPayload.unitRef, tenantId: '66666666-6666-4666-8666-666666666666' },
        },
      });
      expect(
        Match.value(result).pipe(
          Match.tag('invalid', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );

  it.effect('rejects stale rule revision without writes', () =>
    Effect.gen(function* rejectsStaleRevision() {
      const transaction = {
        select: selectUnit([{ currentRuleRevision: 3, lifecycleState: 'ACTIVE', tenantId, unitId }]),
        update: () => {
          throw new Error('stale update');
        },
      };
      const payload = Schema.decodeUnknownSync(ReviseProductUnitPayloadSchema)({
        evidenceRefs: ['record:2'],
        expectedCurrent: { revision: 2, unit: unitRef },
        reason: 'Revised precision',
        rule: { rounding: 'DOWN', step: '0.1' },
      });
      // @ts-expect-error Mock implements only the exercised Drizzle chains.
      const service = productUnitPersistenceForScope(transaction, scope);
      const result = yield* service.revise({ ...evidence, payload });
      expect(
        Match.value(result).pipe(
          Match.tag('stale', ({ actualRevision }) => actualRevision),
          Match.orElse(() => -1),
        ),
      ).toBe(3);
    }),
  );

  it.effect('retires without changing the prior exact step and rounding', () =>
    Effect.gen(function* retiresWithoutRuleChange() {
      const writes: unknown[] = [];
      const current = { currentRuleRevision: 1, lifecycleState: 'ACTIVE', tenantId, unitId };
      const transaction = {
        insert: recordRuleWrite(writes),
        select: selectUnitAndRule([current]),
        update: retireUpdate(current),
      };
      const payload = Schema.decodeUnknownSync(RetireProductUnitPayloadSchema)({
        evidenceRefs: ['record:4'],
        expectedCurrent: { revision: 1, unit: unitRef },
        reason: 'No longer sold',
      });
      // @ts-expect-error Mock implements only the exercised Drizzle chains.
      const service = productUnitPersistenceForScope(transaction, scope);
      const result = yield* service.retire({ ...evidence, payload });
      expect(
        Match.value(result).pipe(
          Match.tag('retired', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(writes).toEqual([
        [
          productUnitRuleRevisions,
          expect.objectContaining({
            changeKind: 'RETIRED',
            lifecycleState: 'RETIRED',
            revision: 2,
            rounding: 'UP',
            step: '0.01',
          }),
        ],
      ]);
    }),
  );

  it.effect('fails closed when Current target basis is absent', () =>
    Effect.gen(function* rejectsAbsentBasis() {
      const transaction = {
        insert: () => {
          throw new Error('must not write');
        },
        select: selectUnitAndRule([activeUnit]),
        update: () => {
          throw new Error('must not write');
        },
      };
      const payload = Schema.decodeUnknownSync(SetProductUnitTargetDivisibilityPayloadSchema)({
        divisible: true,
        evidenceRefs: ['record:3'],
        expectedSources,
        reason: 'Verified variant divisibility',
        target: { targetId: variantId, targetType: 'commerce.catalog.variant', tenantId, unit: unitRef },
      });
      // @ts-expect-error Mock implements only the exercised Drizzle chains.
      const service = productUnitPersistenceForScope(transaction, scope);
      const error = yield* service.setTargetDivisibility({ ...evidence, payload }).pipe(Effect.flip);
      expect(Schema.is(ProductUnitPersistenceUnavailable)(error)).toBe(true);
    }),
  );

  it.effect('classifies a definitely invalid target basis without writing', () =>
    Effect.gen(function* rejectsInvalidBasis() {
      const transaction = {
        insert: () => {
          throw new Error('must not write');
        },
        select: selectUnitAndRule([activeUnit]),
        update: () => {
          throw new Error('must not write');
        },
      };
      const payload = Schema.decodeUnknownSync(SetProductUnitTargetDivisibilityPayloadSchema)({
        divisible: true,
        evidenceRefs: ['record:3'],
        expectedSources,
        reason: 'Verified variant divisibility',
        target: { targetId: variantId, targetType: 'commerce.catalog.variant', tenantId, unit: unitRef },
      });
      // @ts-expect-error Mock implements only the exercised Drizzle chains.
      const service = productUnitPersistenceForScope(transaction, scope, { verify: () => Effect.succeed('invalid') });
      const result = yield* service.setTargetDivisibility({ ...evidence, payload });
      expect(
        Match.value(result).pipe(
          Match.tag('invalid', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );

  it.effect('classifies stale source Current without writing', () =>
    Effect.gen(function* rejectsStaleBasis() {
      const transaction = {
        insert: () => {
          throw new Error('must not write');
        },
        select: selectUnitAndRule([activeUnit]),
        update: () => {
          throw new Error('must not write');
        },
      };
      const payload = Schema.decodeUnknownSync(SetProductUnitTargetDivisibilityPayloadSchema)({
        divisible: true,
        evidenceRefs: ['record:3'],
        expectedSources,
        reason: 'Verified variant divisibility',
        target: { targetId: variantId, targetType: 'commerce.catalog.variant', tenantId, unit: unitRef },
      });
      // @ts-expect-error Mock implements only the exercised Drizzle chains.
      const service = productUnitPersistenceForScope(transaction, scope, { verify: () => Effect.succeed('stale') });
      const result = yield* service.setTargetDivisibility({ ...evidence, payload });
      expect(
        Match.value(result).pipe(
          Match.tag('stale', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );

  it.effect('compares locked Product Current with caller expectation', () =>
    Effect.gen(function* comparesProductCurrent() {
      const locked: ProductReadTable[] = [];
      const transaction = {
        insert: () => {
          throw new Error('must not write');
        },
        select: selectProductCurrent(locked),
        update: () => {
          throw new Error('must not write');
        },
      };
      const payload = Schema.decodeUnknownSync(SetProductUnitTargetDivisibilityPayloadSchema)({
        divisible: true,
        evidenceRefs: ['record:3'],
        expectedSources,
        reason: 'Verified variant divisibility',
        target: { targetId: variantId, targetType: 'commerce.catalog.variant', tenantId, unit: unitRef },
      });
      // @ts-expect-error Mock implements only the exercised Drizzle chains.
      const service = yield* productUnitPersistenceServiceFactory(transaction, scope);
      const result = yield* service.setTargetDivisibility({ ...evidence, payload });
      expect(
        Match.value(result).pipe(
          Match.tag('stale', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(locked).toEqual([productUnits, productVariants, products]);
    }),
  );
});
