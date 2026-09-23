import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { productVariantRevisions, productVariants, products } from '../../src/database/schema.ts';
import type { manufacturerRelations } from '../../src/database/schema.ts';
import {
  variantPersistenceForScope,
  VariantCurrentBasisUnavailable,
} from '../../src/persistence/variant-persistence.ts';
import { VariantUseChangeConflict } from '../../shared/domain/variant-use-change.ts';

const tenantId = '00000000-0000-4000-8000-000000000001';
const productId = '00000000-0000-4000-8000-000000000002';
const variantId = '00000000-0000-4000-8000-000000000003';
const principalId = '00000000-0000-4000-8000-000000000004';
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:variant-test:run:1',
    authMethod: 'system',
    principalId,
    tenantId,
  }),
  correlationId: 'variant-test',
};
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
const evidence = {
  actionInvocationId: '00000000-0000-4000-8000-000000000005',
  evidenceRefs: ['catalog-record:1'],
  principalId,
  reason: 'Verified catalog record',
};
const row = {
  combinationAxisRevision: null,
  combinationKey: null,
  currentRevision: 1,
  lifecycleState: 'WORK_IN_PROGRESS',
  productId,
  tenantId,
  variantId,
};
const lockedRow = <T>(value: T) => ({ where: () => ({ for: () => ({ limit: () => Effect.succeed([value]) }) }) });
const returnedRow = <T>(value: T) => ({ where: () => ({ returning: () => Effect.succeed([value]) }) });
const rejectedCombinationRow = () => ({
  where: () => ({
    returning: () => Effect.fail({ code: '23505', constraint: 'catalog_product_variants_active_combination_uk' }),
  }),
});
const noManufacturerRelations = () => ({ where: () => ({ for: () => ({ pipe: () => Effect.succeed([]) }) }) });
const confirmedManufacturerRelations = () => ({
  where: () => ({
    for: () => ({
      pipe: () =>
        Effect.succeed([{ disposition: 'CONFIRMED', effectiveTo: null, productId, tenantId, variantId: null }]),
    }),
  }),
});

describe('Variant persistence', () => {
  it.effect('keeps the first exact Variant identity when a second form is recorded', () =>
    Effect.gen(function* preserveSimpleVariantIdentity() {
      const secondVariantId = '00000000-0000-4000-8000-000000000006';
      const createdRows: (string | undefined)[] = [];
      const revisionRows: [string | undefined, string | null | undefined][] = [];
      const transaction = {
        insert: (table: typeof productVariants | typeof productVariantRevisions) => ({
          values: (value: typeof productVariants.$inferInsert | typeof productVariantRevisions.$inferInsert) => {
            if (table === productVariants) {
              createdRows.push(value.variantId);
              return { returning: () => Effect.succeed([{ ...row, variantId: value.variantId }]) };
            }
            revisionRows.push([value.variantId, value.combinationKey]);
            return Effect.succeed([]);
          },
        }),
        select: () => ({
          from: (table: typeof products | typeof manufacturerRelations) =>
            table === products ? lockedRow({ ...row, currentRevision: 4 }) : noManufacturerRelations(),
        }),
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = variantPersistenceForScope(transaction, scope);
      const first = yield* service.create({ ...evidence, expectedProductRevision: 4, productRef, variantRef });
      const second = yield* service.create({
        ...evidence,
        actionInvocationId: '00000000-0000-4000-8000-000000000007',
        expectedProductRevision: 4,
        productRef,
        variantRef: { ...variantRef, resourceId: secondVariantId },
      });

      expect(
        Match.value(first).pipe(
          Match.tag('created', ({ variant }) => variant),
          Match.orElse(() => null),
        ),
      ).toMatchObject({ lifecycle: 'WORK_IN_PROGRESS', productRef, variantRef });
      expect(
        Match.value(second).pipe(
          Match.tag('created', ({ variant }) => variant),
          Match.orElse(() => null),
        ),
      ).toMatchObject({ variantRef: { ...variantRef, resourceId: secondVariantId } });
      expect(createdRows).toEqual([variantId, secondVariantId]);
      expect(revisionRows).toEqual([
        [variantId, null],
        [secondVariantId, null],
      ]);
    }),
  );

  it.effect('creates a draft with an immutable initial revision, never an invented Current combination', () =>
    Effect.gen(function* createDraft() {
      const writes: unknown[] = [];
      const transaction = {
        insert: (table: typeof productVariants | typeof productVariantRevisions) => ({
          values: (value: typeof productVariants.$inferInsert | typeof productVariantRevisions.$inferInsert) => {
            writes.push([table, value]);
            return table === productVariants ? { returning: () => Effect.succeed([row]) } : Effect.succeed([]);
          },
        }),
        select: () => ({
          from: (table: typeof products | typeof manufacturerRelations) =>
            table === products ? lockedRow({ ...row, currentRevision: 4 }) : noManufacturerRelations(),
        }),
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = variantPersistenceForScope(transaction, scope);
      const result = yield* service.create({ ...evidence, expectedProductRevision: 4, productRef, variantRef });
      expect(
        Match.value(result).pipe(
          Match.tag('created', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(writes).toEqual([
        [productVariants, expect.objectContaining({ lifecycleState: 'WORK_IN_PROGRESS', variantId })],
        [
          productVariantRevisions,
          expect.objectContaining({
            changeKind: 'CREATED',
            combinationAxisRevision: null,
            combinationKey: null,
            evidenceRefs: evidence.evidenceRefs,
            productId,
            revision: 1,
          }),
        ],
      ]);
    }),
  );

  it.effect('rejects a new exact form under a current Product-wide manufacturer assertion without writing', () =>
    Effect.gen(function* rejectUnverifiedManufacturerScope() {
      const transaction = {
        insert: () => {
          throw new Error('manufacturer scope conflict must not write');
        },
        select: () => ({
          from: (table: typeof products | typeof manufacturerRelations) =>
            table === products ? lockedRow({ ...row, currentRevision: 4 }) : confirmedManufacturerRelations(),
        }),
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = variantPersistenceForScope(transaction, scope);
      const outcome = yield* service.create({ ...evidence, expectedProductRevision: 4, productRef, variantRef });
      expect(
        Match.value(outcome).pipe(
          Match.tag('identity_conflict', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );

  it.effect('records an evidenced correction after the original data error is named', () =>
    Effect.gen(function* recordEvidencedCorrection() {
      const revisions: unknown[] = [];
      let written: Partial<typeof productVariants.$inferInsert> | undefined;
      const transaction = {
        insert: (table: typeof productVariantRevisions) => {
          expect(table).toBe(productVariantRevisions);
          return {
            values: (value: typeof productVariantRevisions.$inferInsert) => {
              revisions.push(value);
              return Effect.succeed([]);
            },
          };
        },
        select: () => ({
          from: (table: typeof productVariants) => {
            expect(table).toBe(productVariants);
            return lockedRow(row);
          },
        }),
        update: (table: typeof productVariants) => {
          expect(table).toBe(productVariants);
          return {
            set: (values: Partial<typeof productVariants.$inferInsert>) => {
              written = values;
              return returnedRow({ ...row, ...values });
            },
          };
        },
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = variantPersistenceForScope(transaction, scope);
      const outcome = yield* service.change({
        ...evidence,
        classification: 'EVIDENCED_CORRECTION',
        currentProductRef: productRef,
        expectedRevision: 1,
        originalDataErrorEvidenceRef: evidence.evidenceRefs[0],
        variantRef,
      });
      expect(
        Match.value(outcome).pipe(
          Match.tag('changed', ({ revision }) => revision),
          Match.orElse(() => 0),
        ),
      ).toBe(2);
      expect(written).toMatchObject({ currentRevision: 2 });
      expect(revisions).toEqual([
        expect.objectContaining({
          changeKind: 'CORRECTED',
          evidenceRefs: evidence.evidenceRefs,
          productId,
          revision: 2,
          variantId,
        }),
      ]);
    }),
  );

  it.effect('rejects a correction whose original-error reference is absent from its evidence', () =>
    Effect.gen(function* rejectUnevidencedCorrection() {
      const transaction = {
        select: () => ({ from: () => lockedRow(row) }),
        update: () => {
          throw new Error('unevidenced correction must not write');
        },
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = variantPersistenceForScope(transaction, scope);
      const outcome = yield* service.change({
        ...evidence,
        classification: 'EVIDENCED_CORRECTION',
        currentProductRef: productRef,
        expectedRevision: 1,
        originalDataErrorEvidenceRef: 'catalog-record:other',
        variantRef,
      });
      expect(
        Match.value(outcome).pipe(
          Match.tag('invalid_change', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );

  it.effect('keeps Product membership correction typed fail-closed without its owner migration proof', () =>
    Effect.gen(function* rejectUnprovenMembershipCorrection() {
      const targetProductRef = { ...productRef, resourceId: '00000000-0000-4000-8000-000000000006' };
      const transaction = {
        select: () => ({ from: () => lockedRow(row) }),
        update: () => {
          throw new Error('unproven membership correction must not write');
        },
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = variantPersistenceForScope(transaction, scope);
      const failure = yield* service
        .change({
          ...evidence,
          classification: 'EVIDENCED_PARENT_CORRECTION',
          currentProductRef: productRef,
          expectedRevision: 1,
          targetProductRef,
          variantRef,
        })
        .pipe(Effect.flip);
      expect(Schema.is(VariantCurrentBasisUnavailable)(failure)).toBe(true);
    }),
  );

  it.effect('refuses reactivation without authoritative effective axes and Current proof', () =>
    Effect.gen(function* rejectUnverifiedReactivate() {
      const transaction = {
        select: () => ({
          from: (table: typeof products | typeof productVariants) =>
            lockedRow(
              table === productVariants ? { ...row, lifecycleState: 'RETIRED' } : { ...row, lifecycleState: 'ACTIVE' },
            ),
        }),
        update: () => {
          throw new Error('reactivation must not write without Current basis');
        },
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = variantPersistenceForScope(transaction, scope);
      const result = yield* service.reactivate({ ...evidence, expectedRevision: 1, variantRef }).pipe(Effect.flip);
      expect(Schema.is(VariantCurrentBasisUnavailable)(result)).toBe(true);
    }),
  );

  const combinationKey = 'a'.repeat(64);
  const reactivationTransaction = (
    overrides: {
      readonly onSet?: (values: Partial<typeof productVariants.$inferInsert>) => void;
      readonly rejectCombination?: boolean;
    } = {},
  ) => {
    const revisions: unknown[] = [];
    const transaction = {
      insert: (table: typeof productVariantRevisions) => {
        expect(table).toBe(productVariantRevisions);
        return {
          values: (value: typeof productVariantRevisions.$inferInsert) => {
            revisions.push(value);
            return Effect.succeed([]);
          },
        };
      },
      select: () => ({
        from: (table: typeof products | typeof productVariants) =>
          lockedRow(
            table === productVariants
              ? { ...row, currentRevision: 2, lifecycleState: 'RETIRED' }
              : { ...row, lifecycleState: 'ACTIVE' },
          ),
      }),
      update: (table: typeof productVariants) => {
        expect(table).toBe(productVariants);
        return {
          set: (values: Partial<typeof productVariants.$inferInsert>) => {
            overrides.onSet?.(values);
            return overrides.rejectCombination === true
              ? rejectedCombinationRow()
              : returnedRow({ ...row, ...values, lifecycleState: 'ACTIVE' });
          },
        };
      },
    };
    return { revisions, transaction };
  };
  const provenAssessment = {
    assessReactivation: () =>
      Effect.succeed({
        combinationAxisRevision: 1,
        combinationKey,
        decision: { changeKind: 'CORRECTED' as const, revalidation: 'NOT_REQUIRED' as const },
      }),
  };

  it.effect('reactivates a documented collision-free Variant once the #441 assessment proves it clear', () =>
    Effect.gen(function* reactivateVariant() {
      const { revisions, transaction } = reactivationTransaction();
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = variantPersistenceForScope(transaction, scope, provenAssessment);
      const outcome = yield* service.reactivate({ ...evidence, expectedRevision: 2, variantRef });
      expect(
        Match.value(outcome).pipe(
          Match.tag('changed', ({ variant }) => variant.lifecycle),
          Match.orElse(() => 'FAILED'),
        ),
      ).toBe('ACTIVE');
      expect(revisions).toEqual([
        expect.objectContaining({
          changeKind: 'LIFECYCLE',
          lifecycleState: 'ACTIVE',
          productId,
          revision: 3,
          variantId,
        }),
      ]);
    }),
  );

  it.effect('writes the proven Current combination identity when reactivating', () =>
    Effect.gen(function* reactivateCombination() {
      let written: Partial<typeof productVariants.$inferInsert> | undefined;
      const { transaction } = reactivationTransaction({
        onSet: (values) => {
          written = values;
        },
      });
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = variantPersistenceForScope(transaction, scope, provenAssessment);
      yield* service.reactivate({ ...evidence, expectedRevision: 2, variantRef });
      expect(written).toMatchObject({ combinationAxisRevision: 1, combinationKey, lifecycleState: 'ACTIVE' });
    }),
  );

  it.effect('maps a partial-unique-index violation during reactivation to identity_conflict', () =>
    Effect.gen(function* reactivateRace() {
      const { transaction } = reactivationTransaction({ rejectCombination: true });
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = variantPersistenceForScope(transaction, scope, provenAssessment);
      const outcome = yield* service.reactivate({ ...evidence, expectedRevision: 2, variantRef });
      expect(
        Match.value(outcome).pipe(
          Match.tag('identity_conflict', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );

  it.effect('maps a reactivation allowed-value violation to invalid_change without writing', () =>
    Effect.gen(function* reactivateInvalidValue() {
      const transaction = {
        insert: () => {
          throw new Error('an out-of-allowance reactivation must not append a revision');
        },
        select: () => ({
          from: (table: typeof products | typeof productVariants) =>
            lockedRow(
              table === productVariants
                ? { ...row, currentRevision: 2, lifecycleState: 'RETIRED' }
                : { ...row, lifecycleState: 'ACTIVE' },
            ),
        }),
        update: () => {
          throw new Error('an out-of-allowance reactivation must not write');
        },
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = variantPersistenceForScope(transaction, scope, {
        assessReactivation: () =>
          Effect.fail(
            new VariantUseChangeConflict({
              code: 'variant_use_change_conflict',
              conflict: 'INVALID_VALUE',
              reason: 'Value retired from the Current allowed set',
            }),
          ),
      });
      const outcome = yield* service.reactivate({ ...evidence, expectedRevision: 2, variantRef });
      expect(
        Match.value(outcome).pipe(
          Match.tag('invalid_change', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );

  it.effect('maps an open-selection revalidation conflict to its own typed outcome', () =>
    Effect.gen(function* reactivateSelection() {
      const transaction = {
        select: () => ({
          from: (table: typeof products | typeof productVariants) =>
            lockedRow(
              table === productVariants
                ? { ...row, currentRevision: 2, lifecycleState: 'RETIRED' }
                : { ...row, lifecycleState: 'ACTIVE' },
            ),
        }),
        update: () => {
          throw new Error('selection revalidation must not write');
        },
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = variantPersistenceForScope(transaction, scope, {
        assessReactivation: () =>
          Effect.fail(
            new VariantUseChangeConflict({
              code: 'variant_use_change_conflict',
              conflict: 'OPEN_SELECTION_REVALIDATION_REQUIRED',
              reason: 'Open selections',
            }),
          ),
      });
      const outcome = yield* service.reactivate({ ...evidence, expectedRevision: 2, variantRef });
      expect(
        Match.value(outcome).pipe(
          Match.tag('selection_revalidation_required', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );

  it.effect('retires the targeted Variant and appends its lifecycle revision', () =>
    Effect.gen(function* retireVariant() {
      const revisions: unknown[] = [];
      const transaction = {
        insert: (table: typeof productVariantRevisions) => {
          expect(table).toBe(productVariantRevisions);
          return {
            values: (value: typeof productVariantRevisions.$inferInsert) => {
              revisions.push(value);
              return Effect.succeed([]);
            },
          };
        },
        select: () => ({
          from: (table: typeof productVariants) => {
            expect(table).toBe(productVariants);
            return lockedRow({
              ...row,
              combinationAxisRevision: 3,
              combinationKey: 'a'.repeat(64),
              lifecycleState: 'ACTIVE',
            });
          },
        }),
        update: (table: typeof productVariants) => {
          expect(table).toBe(productVariants);
          return {
            set: (values: Partial<typeof productVariants.$inferInsert>) => returnedRow({ ...row, ...values }),
          };
        },
      };
      // @ts-expect-error Only the exercised Drizzle query chains are mocked.
      const service = variantPersistenceForScope(transaction, scope);
      const outcome = yield* service.retire({ ...evidence, expectedRevision: 1, variantRef });
      expect(
        Match.value(outcome).pipe(
          Match.tag('retired', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(revisions).toEqual([
        expect.objectContaining({
          changeKind: 'LIFECYCLE',
          combinationAxisRevision: null,
          combinationKey: null,
          lifecycleState: 'RETIRED',
          productId,
          revision: 2,
          variantId,
        }),
      ]);
    }),
  );

  it.effect('rejects cross-tenant draft creation before querying or writing', () =>
    Effect.gen(function* rejectOtherTenant() {
      const transaction = new Proxy(
        {},
        {
          get: () => {
            throw new Error('transaction touched');
          },
        },
      );
      // @ts-expect-error An uncallable transaction proves the tenant guard executes first.
      const service = variantPersistenceForScope(transaction, scope);
      const outcome = yield* service.create({
        ...evidence,
        expectedProductRevision: 1,
        productRef: { ...productRef, tenantId: '00000000-0000-4000-8000-000000000099' },
        variantRef,
      });
      expect(
        Match.value(outcome).pipe(
          Match.tag('invalid_change', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );
});
