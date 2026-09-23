import type { ActionHandlerContext } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { ChangeVariantPayload } from '../../shared/actions/change-variant.ts';
import { handleChangeVariant } from '../../src/actions/change-variant.action.ts';
import { handleCreateVariant } from '../../src/actions/create-variant.action.ts';
import { handleRetireVariant } from '../../src/actions/retire-variant.action.ts';
import { handleReactivateVariant } from '../../src/actions/reactivate-variant.action.ts';
import { VariantActionConflict } from '../../src/actions/variant-action-support.ts';
import { CatalogOpenSelectionImpactUnavailable } from '../../src/persistence/catalog-open-selection-impact.ts';
import { VariantCurrentBasisUnavailable } from '../../src/persistence/variant-persistence.ts';
import type { VariantPersistence } from '../../src/persistence/variant-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const productRef = {
  moduleId: 'commerce.catalog',
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'commerce.catalog.product',
  tenantId,
} as const;
const variantRef = {
  moduleId: 'commerce.catalog',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.catalog.variant',
  tenantId,
} as const;
const variant = { lifecycle: 'WORK_IN_PROGRESS', productRef, variantId: variantRef.resourceId, variantRef } as const;
const creationClassification = (reason: string, evidenceRefs: readonly [string]) =>
  ({
    affectsOpenSelection: true,
    evidenceRefs,
    kind: 'NEW_REALIZATION',
    newVariantRef: variantRef,
    productRef,
    reason,
  }) as const;
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:variant-actions:run:1',
    authMethod: 'system',
    principalId: '55555555-5555-4555-8555-555555555555',
    tenantId,
  }),
  correlationId: 'variant-action-test',
};
const unexpected = () => Effect.die('Unexpected persistence call');
type TestVariantServices = VariantPersistence & {
  readonly assessOpenSelectionImpact: (
    ref: NonNullable<ChangeVariantPayload['currentProductRef']>,
  ) => Effect.Effect<void, CatalogOpenSelectionImpactUnavailable>;
};
const context = (overrides: Partial<TestVariantServices>) => {
  const reads: string[] = [];
  const services: TestVariantServices = {
    assessOpenSelectionImpact: () => Effect.void,
    change: unexpected,
    confirm: unexpected,
    create: unexpected,
    reactivate: unexpected,
    recoverCreateVariant: unexpected,
    retire: unexpected,
    ...overrides,
  };
  const value: ActionHandlerContext<Readonly<Record<string, never>>, TestVariantServices> = {
    actionInvocationId: '66666666-6666-4666-8666-666666666666',
    addDomainEvent: () => Effect.succeed(Object.create(null)),
    addOutboxMessage: () => Effect.void,
    recordAuditEvidence: () => Effect.void,
    recordDataAccess: (access) =>
      Effect.sync(() => {
        reads.push(access.targetResourceId ?? '');
      }),
    scope,
    services,
  };
  return { reads, value };
};

describe('Variant Action handlers', () => {
  it.effect('creates only under trusted Tenant and records governed access', () =>
    Effect.gen(function* variantCreateTest() {
      const run = context({
        create: (input) =>
          Effect.sync(() => {
            expect(input.principalId).toBe(scope.principalId);
            expect(input.expectedProductRevision).toBe(1);
            return { _tag: 'created', revision: 1, variant } as const;
          }),
      });
      const result = yield* handleCreateVariant(
        {
          classification: creationClassification('Real form', ['sheet']),
          evidenceRefs: ['sheet'],
          expectedProductRevision: 1,
          productRef,
          reason: 'Real form',
          variantRef,
        },
        run.value,
      );
      expect(result.variant.lifecycle).toBe('WORK_IN_PROGRESS');
      expect(result.classification).toMatchObject({ kind: 'NEW_REALIZATION', newVariantRef: variantRef });
      expect(run.reads).toEqual([variantRef.resourceId]);
    }),
  );

  it.effect('rejects cross-tenant creation before persistence', () =>
    Effect.gen(function* variantCrossTenantTest() {
      const run = context({});
      const error = yield* handleCreateVariant(
        {
          classification: creationClassification('Wrong tenant', ['sheet']),
          evidenceRefs: ['sheet'],
          expectedProductRevision: 1,
          productRef,
          reason: 'Wrong tenant',
          variantRef: { ...variantRef, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
        },
        run.value,
      ).pipe(Effect.flip);
      expect(error.code).toBe('variant_action_not_found');
    }),
  );

  it.effect('rejects a cross-tenant parent before persistence', () =>
    Effect.gen(function* variantParentTenantTest() {
      const run = context({});
      const error = yield* handleCreateVariant(
        {
          classification: creationClassification('Wrong parent tenant', ['sheet']),
          evidenceRefs: ['sheet'],
          expectedProductRevision: 1,
          productRef: { ...productRef, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
          reason: 'Wrong parent tenant',
          variantRef,
        },
        run.value,
      ).pipe(Effect.flip);
      expect(error.code).toBe('variant_action_not_found');
      expect(run.reads).toEqual([]);
    }),
  );

  it.effect('maps concurrent identity collision to typed conflict', () =>
    Effect.gen(function* variantCollisionTest() {
      const run = context({ create: () => Effect.succeed({ _tag: 'identity_conflict' }) });
      const error = yield* handleCreateVariant(
        {
          classification: creationClassification('Duplicate', ['sheet']),
          evidenceRefs: ['sheet'],
          expectedProductRevision: 1,
          productRef,
          reason: 'Duplicate',
          variantRef,
        },
        run.value,
      ).pipe(Effect.flip);
      expect(error).toMatchObject({ code: 'variant_action_conflict', conflict: 'IDENTITY' });
    }),
  );

  it.effect('retirement affects only its exact Variant and maps stale revision', () =>
    Effect.gen(function* variantRetireTest() {
      const run = context({
        retire: (input) =>
          Effect.sync(() => {
            expect(input.variantRef).toEqual(variantRef);
            return { _tag: 'revision_conflict', actualRevision: 3 } as const;
          }),
      });
      const error = yield* handleRetireVariant(
        { expectedVariantRevision: 2, reason: 'Retire', variantRef },
        run.value,
      ).pipe(Effect.flip);
      expect(error).toMatchObject({ code: 'variant_action_conflict', conflict: 'REVISION' });
    }),
  );

  it.effect('passes semantic classification through to owner-local persistence', () =>
    Effect.gen(function* variantClassificationTest() {
      const run = context({
        change: (input) =>
          Effect.sync(() => {
            expect(input.classification).toBe('EVIDENCED_CORRECTION');
            return { _tag: 'invalid_change' } as const;
          }),
      });
      const error = yield* handleChangeVariant(
        {
          classification: 'EVIDENCED_RECORD_CORRECTION',
          currentProductRef: productRef,
          evidenceRefs: ['drawing'],
          expectedVariantRevision: 1,
          originalDataErrorEvidenceRef: 'drawing',
          reason: 'Wrong record',
          variantRef,
        },
        run.value,
      ).pipe(Effect.flip);
      expect(error).toMatchObject({ code: 'variant_action_conflict', conflict: 'INVALID_CHANGE' });
    }),
  );

  it.effect('decodes legacy change input but fails closed before persistence without Current Product evidence', () =>
    Effect.gen(function* legacyVariantChangeTest() {
      const run = context({});
      const error = yield* handleChangeVariant(
        {
          classification: 'EVIDENCED_RECORD_CORRECTION',
          evidenceRefs: ['drawing'],
          expectedVariantRevision: 1,
          originalDataErrorEvidenceRef: 'drawing',
          reason: 'Wrong record',
          variantRef,
        },
        run.value,
      ).pipe(Effect.flip);
      expect(Schema.is(VariantCurrentBasisUnavailable)(error)).toBe(true);
      expect(error.reason).toContain('Current Product evidence');
    }),
  );

  it.effect('returns the exact correction decision for durable result capture', () =>
    Effect.gen(function* variantDecisionCaptureTest() {
      const run = context({ change: () => Effect.succeed({ _tag: 'changed', revision: 2, variant }) });
      const result = yield* handleChangeVariant(
        {
          classification: 'EVIDENCED_RECORD_CORRECTION',
          currentProductRef: productRef,
          evidenceRefs: ['drawing'],
          expectedVariantRevision: 1,
          originalDataErrorEvidenceRef: 'drawing',
          reason: 'Wrong record',
          variantRef,
        },
        run.value,
      );
      expect(result.decision).toEqual({
        classification: 'EVIDENCED_RECORD_CORRECTION',
        evidenceRefs: ['drawing'],
        reason: 'Wrong record',
        variantRef,
      });
    }),
  );

  it.effect('rejects a record correction without evidence naming the original data error', () =>
    Effect.gen(function* variantCorrectionEvidenceTest() {
      const run = context({});
      const error = yield* handleChangeVariant(
        {
          classification: 'EVIDENCED_RECORD_CORRECTION',
          currentProductRef: productRef,
          evidenceRefs: ['drawing'],
          expectedVariantRevision: 1,
          originalDataErrorEvidenceRef: 'different-record',
          reason: 'Wrong record',
          variantRef,
        },
        run.value,
      ).pipe(Effect.flip);
      expect(Schema.is(VariantActionConflict)(error)).toBe(true);
      expect(error).toMatchObject({ conflict: 'INVALID_CHANGE' });
      expect(error.reason).toContain('original data error');
    }),
  );

  it.effect('fails closed when Cart cannot prove the complete open-selection impact', () =>
    Effect.gen(function* variantCorrectionSelectionTest() {
      const run = context({
        assessOpenSelectionImpact: () =>
          Effect.fail(
            new CatalogOpenSelectionImpactUnavailable({
              code: 'catalog_open_selection_impact_unavailable',
              reason: 'Cart population unavailable',
            }),
          ),
      });
      const error = yield* handleChangeVariant(
        {
          classification: 'EVIDENCED_RECORD_CORRECTION',
          currentProductRef: productRef,
          evidenceRefs: ['drawing'],
          expectedVariantRevision: 1,
          originalDataErrorEvidenceRef: 'drawing',
          reason: 'Wrong record',
          variantRef,
        },
        run.value,
      ).pipe(Effect.flip);
      expect(Schema.is(VariantCurrentBasisUnavailable)(error)).toBe(true);
      expect(error.reason).toBe('Cart population unavailable');
    }),
  );

  it.effect('preserves parent-correction intent and fails closed when current basis is unavailable', () =>
    Effect.gen(function* variantParentCorrectionTest() {
      const targetProductRef = { ...productRef, resourceId: '77777777-7777-4777-8777-777777777777' };
      const run = context({
        change: (input) => {
          expect(input.classification).toBe('EVIDENCED_PARENT_CORRECTION');
          expect(input.targetProductRef).toEqual(targetProductRef);
          return Effect.fail(
            new VariantCurrentBasisUnavailable({
              code: 'variant_current_basis_unavailable',
              reason: 'Current basis unavailable',
            }),
          );
        },
      });
      const error = yield* handleChangeVariant(
        {
          classification: 'EVIDENCED_PARENT_CORRECTION',
          currentProductRef: productRef,
          evidenceRefs: ['original record'],
          expectedVariantRevision: 1,
          reason: 'Correct mistaken parent',
          targetProductRef,
          variantRef,
        },
        run.value,
      ).pipe(Effect.flip);
      expect(error.code).toBe('variant_current_basis_unavailable');
      expect(run.reads).toEqual([]);
    }),
  );

  it.effect('rejects cross-tenant parent correction before persistence', () =>
    Effect.gen(function* variantCrossTenantCorrectionTest() {
      const run = context({});
      const error = yield* handleChangeVariant(
        {
          classification: 'EVIDENCED_PARENT_CORRECTION',
          currentProductRef: productRef,
          evidenceRefs: ['original record'],
          expectedVariantRevision: 1,
          reason: 'Wrong tenant',
          targetProductRef: { ...productRef, tenantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
          variantRef,
        },
        run.value,
      ).pipe(Effect.flip);
      expect(error.code).toBe('variant_action_not_found');
    }),
  );

  it.effect('keeps retired and colliding reactivation outcomes typed', () =>
    Effect.gen(function* variantReactivationTest() {
      const retired = context({ change: () => Effect.succeed({ _tag: 'lifecycle_conflict' }) });
      const changeError = yield* handleChangeVariant(
        {
          classification: 'SAME_MEANING_RENAME',
          currentProductRef: productRef,
          evidenceRefs: ['record'],
          expectedVariantRevision: 2,
          reason: 'Rename retired variant',
          variantRef,
        },
        retired.value,
      ).pipe(Effect.flip);
      expect(changeError).toMatchObject({ code: 'variant_action_conflict', conflict: 'LIFECYCLE' });

      const collision = context({ reactivate: () => Effect.succeed({ _tag: 'identity_conflict' }) });
      const reactivateError = yield* handleReactivateVariant(
        { evidenceRefs: ['record'], expectedVariantRevision: 2, reason: 'Restore', variantRef },
        collision.value,
      ).pipe(Effect.flip);
      expect(reactivateError).toMatchObject({ code: 'variant_action_conflict', conflict: 'IDENTITY' });
    }),
  );

  it.effect('keeps an open-selection revalidation requirement distinct from a lifecycle conflict', () =>
    Effect.gen(function* variantSelectionRevalidationTest() {
      const run = context({ reactivate: () => Effect.succeed({ _tag: 'selection_revalidation_required' }) });
      const error = yield* handleReactivateVariant(
        { evidenceRefs: ['record'], expectedVariantRevision: 2, reason: 'Restore', variantRef },
        run.value,
      ).pipe(Effect.flip);
      expect(error).toMatchObject({ code: 'variant_action_conflict', conflict: 'SELECTION_REVALIDATION' });
      expect(Schema.is(VariantActionConflict)(error) && error.conflict).not.toBe('LIFECYCLE');
    }),
  );
});
