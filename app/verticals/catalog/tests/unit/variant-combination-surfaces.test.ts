import type { ActionHandlerContext } from '@app/core-runtime';
import { ReadHandlerNotFound, ReadHandlerUnavailable, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type { ConfirmVariantCombinationPayload } from '../../shared/actions/confirm-variant-combination.ts';
import { ConfirmVariantCombinationPayloadSchema } from '../../shared/actions/confirm-variant-combination.ts';
import type { GovernVariantAllowedValuesPayload } from '../../shared/actions/govern-variant-allowed-values.ts';
import { GovernVariantAllowedValuesPayloadSchema } from '../../shared/actions/govern-variant-allowed-values.ts';
import { ListRecordedVariantsResponseSchema } from '../../shared/apis/list-recorded-variants.ts';
import {
  confirmVariantCombinationAction,
  handleConfirmVariantCombination,
} from '../../src/actions/confirm-variant-combination.action.ts';
import { handleGovernVariantAllowedValues } from '../../src/actions/govern-variant-allowed-values.action.ts';
import { VariantCombinationConflict } from '../../src/actions/variant-combination-conflict.ts';
import { readListRecordedVariants } from '../../src/api/list-recorded-variants.read.ts';
import type { VariantAxisPersistence } from '../../src/persistence/variant-axis-persistence.ts';
import {
  GovernVariantAllowedValuesOutcomeSchema,
  VariantAxisBasisUnavailable,
  VariantAxisWriteConflict,
} from '../../src/persistence/variant-axis-persistence.ts';
import type { VariantPersistence } from '../../src/persistence/variant-persistence.ts';
import { ConfirmVariantCombinationOutcomeSchema } from '../../src/persistence/variant-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const productId = '22222222-2222-4222-8222-222222222222';
const definitionId = '33333333-3333-4333-8333-333333333333';
const variantId = '66666666-6666-4666-8666-666666666666';
const valueSetId = '77777777-7777-4777-8777-777777777777';
const controlledValueId = '88888888-8888-4888-8888-888888888888';

const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:variant-combination-surfaces:run:1',
    authMethod: 'system',
    principalId: '55555555-5555-4555-8555-555555555555',
    tenantId,
  }),
  correlationId: 'variant-combination-surfaces',
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

const controlledValue = {
  kind: 'CONTROLLED',
  valueRef: {
    moduleId: 'commerce.catalog',
    resourceId: controlledValueId,
    resourceType: 'commerce.catalog.controlled-attribute-value',
    tenantId,
  },
} as const;
const controlledItem = {
  attributeDefinitionId: definitionId,
  attributeValueSetId: valueSetId,
  controlledAttributeValueId: controlledValueId,
  numericValue: null,
  ordinal: 0,
  specialState: null,
  tenantId,
  textValue: null,
  unit: null,
  valueKind: 'CONTROLLED',
};
const currentAxes = {
  axes: [
    {
      attributeDefinitionId: definitionId,
      controlledValueKind: 'COLOR',
      definitionRevision: 3,
      inheritable: false,
      multiplicity: 'SINGLE',
      ordinal: 0,
      valueKind: 'CONTROLLED',
    },
  ],
  axisRevision: 1,
  productId,
  productTypeRevision: 2,
};

const unexpected = () => Effect.die('Unexpected persistence call');

const variantServices = (overrides: Partial<VariantPersistence> = {}): VariantPersistence => ({
  change: unexpected,
  confirm: unexpected,
  create: unexpected,
  reactivate: unexpected,
  recoverCreateVariant: unexpected,
  retire: unexpected,
  ...overrides,
});

const axisServices = (overrides: Partial<VariantAxisPersistence> = {}): VariantAxisPersistence => ({
  govern: unexpected,
  governAllowedValues: unexpected,
  readCurrent: unexpected,
  readCurrentAllowedValues: unexpected,
  readEffectiveValues: unexpected,
  readRecordedCombinations: unexpected,
  readRecordedVariants: unexpected,
  ...overrides,
});

const confirmContext = (confirm: VariantPersistence['confirm']) =>
  ({
    actionInvocationId: '99999999-9999-4999-8999-999999999999',
    addDomainEvent: () => Effect.succeed(Object.create(null)),
    addOutboxMessage: () => Effect.void,
    recordAuditEvidence: () => Effect.void,
    recordDataAccess: () => Effect.void,
    scope,
    services: variantServices({ confirm }),
  }) satisfies ActionHandlerContext<Readonly<Record<string, never>>, VariantPersistence>;

const allowedValuesContext = (governAllowedValues: VariantAxisPersistence['governAllowedValues']) =>
  ({
    actionInvocationId: '99999999-9999-4999-8999-999999999999',
    addDomainEvent: () => Effect.succeed(Object.create(null)),
    addOutboxMessage: () => Effect.void,
    recordAuditEvidence: () => Effect.void,
    recordDataAccess: () => Effect.void,
    scope,
    services: axisServices({ governAllowedValues }),
  }) satisfies ActionHandlerContext<Readonly<Record<string, never>>, VariantAxisPersistence>;

const decodeConfirmOutcome = Schema.decodeUnknownSync(ConfirmVariantCombinationOutcomeSchema);
const decodeAllowedValuesOutcome = Schema.decodeUnknownSync(GovernVariantAllowedValuesOutcomeSchema);

const confirmPayload: ConfirmVariantCombinationPayload = Schema.decodeUnknownSync(
  ConfirmVariantCombinationPayloadSchema,
)({
  evidenceRefs: ['evidence'],
  expectedAxisRevision: 1,
  expectedVariantRevision: 1,
  productRef,
  reason: 'Explicit realization',
  variantRef,
});

const allowedValuesPayload: GovernVariantAllowedValuesPayload = Schema.decodeUnknownSync(
  GovernVariantAllowedValuesPayloadSchema,
)({
  attributeDefinitionRef: {
    moduleId: 'commerce.catalog',
    resourceId: definitionId,
    resourceType: 'commerce.catalog.attribute-definition',
    tenantId,
  },
  definitionRevision: 3,
  evidenceRefs: ['evidence'],
  expectedAllowanceRevision: 0,
  expectedAxisRevision: 1,
  productRef,
  reason: 'Product-specific allowed colors',
  values: [controlledValue],
});

describe('Confirm Variant combination Action surface (#440)', () => {
  const conflictCases = [
    { expected: 'DUPLICATE', outcome: decodeConfirmOutcome({ _tag: 'duplicate_combination' }) },
    {
      expected: 'MISSING_AXIS',
      outcome: decodeConfirmOutcome({ _tag: 'missing_axis', attributeDefinitionId: definitionId }),
    },
    {
      expected: 'IMPERMISSIBLE',
      outcome: decodeConfirmOutcome({ _tag: 'impermissible_value', attributeDefinitionId: definitionId }),
    },
    {
      expected: 'STALE_BASIS',
      outcome: decodeConfirmOutcome({ _tag: 'stale_basis', actualAxisRevision: 2, expectedAxisRevision: 1 }),
    },
    { expected: 'REVISION', outcome: decodeConfirmOutcome({ _tag: 'revision_conflict', actualRevision: 2 }) },
    { expected: 'LIFECYCLE', outcome: decodeConfirmOutcome({ _tag: 'lifecycle_conflict' }) },
    { expected: 'INVALID_CHANGE', outcome: decodeConfirmOutcome({ _tag: 'invalid_change' }) },
  ] as const;

  for (const { expected, outcome } of conflictCases) {
    it.effect(`maps ${outcome._tag} to a distinct typed conflict`, () =>
      Effect.gen(function* mapsConflict() {
        const error = yield* Effect.flip(
          handleConfirmVariantCombination(
            confirmPayload,
            confirmContext(() => Effect.succeed(outcome)),
          ),
        );
        expect(Schema.is(VariantCombinationConflict)(error)).toBe(true);
        if (Schema.is(VariantCombinationConflict)(error)) {
          expect(error.conflict).toBe(expected);
        }
      }),
    );
  }

  it.effect('returns the confirmed combination without inventing a second Current form', () =>
    Effect.gen(function* confirmed() {
      const variant = { lifecycle: 'ACTIVE' as const, productRef, variantId, variantRef };
      const outcome = decodeConfirmOutcome({
        _tag: 'confirmed',
        combinationAxisRevision: 1,
        combinationKey: 'a'.repeat(64),
        revision: 2,
        variant,
      });
      const result = yield* handleConfirmVariantCombination(
        confirmPayload,
        confirmContext(() => Effect.succeed(outcome)),
      );
      expect(result).toEqual({
        combinationAxisRevision: 1,
        combinationKey: 'a'.repeat(64),
        variant,
      });
    }),
  );

  it('declares one explicit tenant-scoped permission and idempotency identity', () => {
    expect(confirmVariantCombinationAction.descriptor).toMatchObject({
      actionKey: 'commerce.catalog.confirm-variant-combination',
      idempotency: 'required',
      legalEntityScope: 'forbidden',
    });
  });
});

describe('Govern Variant allowed values Action surface (#438)', () => {
  it.effect('returns the new allowance revision when the snapshot is appended', () =>
    Effect.gen(function* governed() {
      const outcome = decodeAllowedValuesOutcome({ _tag: 'governed', allowanceRevision: 1, changed: true });
      const result = yield* handleGovernVariantAllowedValues(
        allowedValuesPayload,
        allowedValuesContext(() => Effect.succeed(outcome)),
      );
      expect(result).toEqual({ allowanceRevision: 1, changed: true, productRef });
    }),
  );

  it.effect('reports a stale basis as a conflict instead of appending guidance', () =>
    Effect.gen(function* axisConflict() {
      const outcome = decodeAllowedValuesOutcome({ _tag: 'axis_conflict', actualAxisRevision: 2 });
      const error = yield* Effect.flip(
        handleGovernVariantAllowedValues(
          allowedValuesPayload,
          allowedValuesContext(() => Effect.succeed(outcome)),
        ),
      );
      expect(Schema.is(VariantAxisWriteConflict)(error)).toBe(true);
      if (Schema.is(VariantAxisWriteConflict)(error)) {
        expect(error.conflict).toBe('REVISION');
      }
    }),
  );

  it.effect('rejects a foreign tenant before any persistence access', () =>
    Effect.gen(function* foreignTenant() {
      let calls = 0;
      const outcome = decodeAllowedValuesOutcome({ _tag: 'governed', allowanceRevision: 1, changed: true });
      const foreignPayload = Schema.decodeUnknownSync(GovernVariantAllowedValuesPayloadSchema)({
        ...allowedValuesPayload,
        attributeDefinitionRef: { ...allowedValuesPayload.attributeDefinitionRef, tenantId: foreignTenantId },
        productRef: { ...productRef, tenantId: foreignTenantId },
      });
      const error = yield* Effect.flip(
        handleGovernVariantAllowedValues(
          foreignPayload,
          allowedValuesContext(() => {
            calls += 1;
            return Effect.succeed(outcome);
          }),
        ),
      );
      expect(Schema.is(VariantAxisWriteConflict)(error)).toBe(true);
      expect(calls).toBe(0);
    }),
  );
});

describe('List recorded variants read surface (#438)', () => {
  const recorded = {
    axisRevision: 1,
    combinationKey: 'b'.repeat(64),
    values: [
      {
        attributeDefinitionId: definitionId,
        definitionRevision: 3,
        items: [controlledItem],
        source: 'VARIANT' as const,
        sourceRevision: 5,
        sourceValueSetRef: { attributeValueSetId: valueSetId, tenantId },
      },
    ],
    variantId,
  };

  it.effect('returns exactly the recorded ACTIVE forms with canonical values', () =>
    Effect.gen(function* listsRecorded() {
      const outcome = yield* readListRecordedVariants(
        { productRef },
        tenantId,
        axisServices({
          readCurrent: () => Effect.succeed(currentAxes),
          readRecordedVariants: () => Effect.succeed([recorded]),
        }),
      );
      expect(outcome.evidence).toEqual({ resultCount: 1 });
      expect(Schema.is(ListRecordedVariantsResponseSchema)(outcome.result)).toBe(true);
      expect(outcome.result).toEqual({
        axisRevision: 1,
        productRef,
        variants: [
          {
            combinationKey: 'b'.repeat(64),
            values: [
              {
                attributeDefinitionRef: {
                  moduleId: 'commerce.catalog',
                  resourceId: definitionId,
                  resourceType: 'commerce.catalog.attribute-definition',
                  tenantId,
                },
                definitionRevision: 3,
                values: [controlledValue],
              },
            ],
            variantRef,
          },
        ],
      });
    }),
  );

  it.effect('fails closed with an unavailable result when the recorded basis cannot be read', () =>
    Effect.gen(function* basisUnavailable() {
      const failure = yield* Effect.flip(
        readListRecordedVariants(
          { productRef },
          tenantId,
          axisServices({
            readCurrent: () => Effect.succeed(currentAxes),
            readRecordedVariants: () =>
              Effect.fail(
                new VariantAxisBasisUnavailable({
                  code: 'variant_axis_basis_unavailable',
                  reason: 'Recorded basis cannot be verified',
                }),
              ),
          }),
        ),
      );
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    }),
  );

  it.effect('rejects a foreign Product before reading the owner basis', () =>
    Effect.gen(function* foreignProduct() {
      let calls = 0;
      const failure = yield* Effect.flip(
        readListRecordedVariants(
          { productRef: { ...productRef, tenantId: foreignTenantId } },
          tenantId,
          axisServices({
            readCurrent: () => {
              calls += 1;
              return Effect.succeed(currentAxes);
            },
            readRecordedVariants: () => Effect.succeed([]),
          }),
        ),
      );
      expect(Schema.is(ReadHandlerNotFound)(failure)).toBe(true);
      expect(calls).toBe(0);
    }),
  );

  it.effect('never substitutes a Cartesian product when a value no longer decodes', () =>
    Effect.gen(function* undecodable() {
      const failure = yield* Effect.flip(
        readListRecordedVariants(
          { productRef },
          tenantId,
          axisServices({
            readCurrent: () => Effect.succeed(currentAxes),
            readRecordedVariants: () =>
              Effect.succeed([
                {
                  ...recorded,
                  values: [
                    {
                      ...recorded.values[0],
                      items: [{ ...controlledItem, controlledAttributeValueId: null }],
                    },
                  ],
                },
              ]),
          }),
        ),
      );
      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    }),
  );
});
