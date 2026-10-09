import {
  PricingCommercialFeeCatalogTargetEvidenceSchema,
  PricingCommercialFeeIdentityKeySchema,
  PricingCommercialFeeScheduleAcknowledgementSchema,
  PricingCommercialFeeScheduleSnapshotSchema,
  ScheduledPricingCommercialFeeRevisionSchema,
} from '@app/pricing-contracts/domain/commercial-fee';
import type { executeProductVariantSnapshotWithAuthorization } from '@app/catalog/api/client';
import { PersistenceFailure } from '@app/core-runtime';
import { DateTime, Effect, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { mapReviseCommercialFeeActionProblem } from '../../api/revise-commercial-fee-action-problems.ts';
import { mapManageProductCommercialFeesBulkActionProblem } from '../../api/manage-product-commercial-fees-bulk-action-problems.ts';
import {
  DefineCommercialFeePayloadSchema,
  DefineCommercialFeeRejected,
  applyCommercialFeeDefinition,
  defineCommercialFeeAction,
} from '../../src/actions/define-commercial-fee.action.ts';
import type { DefineCommercialFeeActionServices } from '../../src/actions/define-commercial-fee.action.ts';
import {
  ReviseCommercialFeeAcknowledgementRequired,
  ReviseCommercialFeePayloadSchema,
  ReviseCommercialFeeRejected,
  applyCommercialFeeRevision,
  reviseCommercialFeeAction,
} from '../../src/actions/revise-commercial-fee.action.ts';
import type { ReviseCommercialFeeActionServices } from '../../src/actions/revise-commercial-fee.action.ts';
import { readCommercialFeeDefinition } from '../../src/api/commercial-fee-definition.read.ts';
import { readCommercialFeeSchedule } from '../../src/api/commercial-fee-schedule.read.ts';
import {
  CatalogSelectionGatewayCredentialService,
  PricingCatalogSelectionUnavailable,
} from '../../shared/domain/catalog-selection-gateway-credential.ts';
import { commercialFeeCatalogTargetAssessmentPortFromEnvironment } from '../../src/integrations/commercial-fee-catalog-target-evidence.ts';
import { CurrencySupportPersistenceUnavailable } from '../../src/actions/currency-support-persistence-unavailable.ts';
import { ProductCommercialFeeBulkUnavailable } from '../../src/services/product-commercial-fee-bulk-rejected.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const otherTenantId = '11111111-1111-4111-8111-111111111112';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const otherLegalEntityId = '22222222-2222-4222-8222-222222222223';
const principalId = '33333333-3333-4333-8333-333333333333';
const otherPrincipalId = '33333333-3333-4333-8333-333333333334';
const operationAt = '2026-09-27T11:00:00.000Z';
const currentPeriod = {
  effectiveFrom: '2026-09-27T10:00:00.000Z',
  effectiveTo: '2026-09-27T13:00:00.000Z',
};
const futurePeriod = {
  effectiveFrom: '2026-09-27T15:00:00.000Z',
  effectiveTo: '2026-09-27T17:00:00.000Z',
};
const productRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'commerce.catalog.product' as const,
  tenantId,
};
const variantRef = {
  moduleId: 'commerce.catalog' as const,
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'commerce.catalog.variant' as const,
  tenantId,
};
const feeRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'commerce.pricing.commercial-fee' as const,
  tenantId,
};
const identityKey = Schema.decodeSync(PricingCommercialFeeIdentityKeySchema)({
  calculationBasis: { kind: 'FIXED_PER_LINE' },
  commercialScope: { channelId: 'B2C', marketId: 'cz-launch', sellingLegalEntityId: legalEntityId },
  currencyCode: 'CZK',
  family: 'RECYCLING_FEE',
  monetaryBoundary: 'PRE_TAX',
  target: { variantRef },
});
const catalogTargetEvidence = Schema.decodeSync(PricingCommercialFeeCatalogTargetEvidenceSchema)({
  capturedAt: '2026-09-27T08:00:00.000Z',
  catalogOwnerRevision: 'catalog:products:797',
  productRef,
  snapshotId: 'c'.repeat(64),
  targetId: variantRef.resourceId,
  variantRef,
});
const catalogSnapshotTarget = {
  catalogEvidence: {
    assessedAt: catalogTargetEvidence.capturedAt,
    basis: [
      { role: 'PRODUCT' as const, source: { resourceRef: productRef, revision: 7 } },
      { role: 'VARIANT' as const, source: { resourceRef: variantRef, revision: 11 } },
      {
        provenance: 'CATALOG_OWNER_CONFIRMED_UNTYPED_DECISION' as const,
        role: 'PRODUCT_TYPE_UNTYPED_DECISION' as const,
        source: { resourceRef: productRef, revision: 7 },
      },
    ],
    membership: {
      attestationId: 'catalog-membership:797',
      observedAt: catalogTargetEvidence.capturedAt,
      productRef,
      source: 'CATALOG_OWNER_CURRENT_READ' as const,
      variant: { resourceRef: variantRef, revision: 11 },
    },
    purpose: 'PRICING' as const,
    selection: { productRef, variantRef },
    status: 'VALID' as const,
  },
  target: { productRef, variantRef },
  targetId: variantRef.resourceId,
};
const catalogSnapshotResponse = {
  capturedAt: catalogTargetEvidence.capturedAt,
  catalogOwnerRevision: catalogTargetEvidence.catalogOwnerRevision,
  productRef,
  snapshotId: catalogTargetEvidence.snapshotId,
  targets: [catalogSnapshotTarget],
  targetSetCompleteness: {
    observedAt: catalogTargetEvidence.capturedAt,
    ownerRevision: catalogTargetEvidence.catalogOwnerRevision,
    scope: {
      kind: 'EXACT_PREDICATE' as const,
      predicateRef: `commerce.catalog.product.active-variants:${tenantId}:${productRef.resourceId}`,
    },
  },
};
const currentRevision = Schema.decodeSync(ScheduledPricingCommercialFeeRevisionSchema)({
  definition: {
    catalogTargetEvidence,
    feeRef,
    identityKey,
    revision: {
      configuredAmount: { amount: '5.000000000', currencyCode: 'CZK' },
      effectiveFrom: currentPeriod.effectiveFrom,
      revision: 1,
      revisionId: '77777777-7777-4777-8777-777777777777',
    },
  },
  effectivePeriod: currentPeriod,
  lineage: { correctedRevisionId: null, kind: 'INITIAL', previousRevisionId: null },
});
const futureRevision = Schema.decodeSync(ScheduledPricingCommercialFeeRevisionSchema)({
  definition: {
    catalogTargetEvidence,
    feeRef,
    identityKey,
    revision: {
      configuredAmount: { amount: '9.000000000', currencyCode: 'CZK' },
      effectiveFrom: futurePeriod.effectiveFrom,
      revision: 2,
      revisionId: '88888888-8888-4888-8888-888888888888',
    },
  },
  effectivePeriod: futurePeriod,
  lineage: {
    correctedRevisionId: null,
    kind: 'SCHEDULED',
    previousRevisionId: currentRevision.definition.revision.revisionId,
  },
});
const schedule = Schema.decodeSync(PricingCommercialFeeScheduleSnapshotSchema)({
  current: currentRevision,
  feeRef,
  future: [futureRevision],
  identityKey,
  observedAt: operationAt,
  revisions: [currentRevision, futureRevision],
  scheduleRevision: 2,
});
const expectedCurrent = {
  effectivePeriod: currentPeriod,
  feeRef,
  identityKey,
  revision: currentRevision.definition.revision.revision,
  revisionId: currentRevision.definition.revision.revisionId,
  scheduleRevision: schedule.scheduleRevision,
};
const acknowledgement = Schema.decodeSync(PricingCommercialFeeScheduleAcknowledgementSchema)({
  actingPrincipalId: principalId,
  feeRef,
  fingerprint: 'a'.repeat(64),
  identityKey,
  intendedConfiguredAmount: { amount: '6.000000000', currencyCode: 'CZK' },
  intendedEffectivePeriod: { effectiveFrom: operationAt, effectiveTo: currentPeriod.effectiveTo },
  intent: 'VALUE_ONLY_CURRENT',
  presentedFuture: [futureRevision],
  scheduleRevision: schedule.scheduleRevision,
  targetEffectivePeriod: currentPeriod,
  targetRevisionId: currentRevision.definition.revision.revisionId,
});
const trusted = {
  actingPrincipalId: principalId,
  actionInvocationId: '99999999-9999-4999-8999-999999999999',
  legalEntityId,
  requestCorrelationId: 'commercial-fee-management-797',
  tenantId,
  trustedOperationAt: DateTime.toDateUtc(DateTime.makeUnsafe(operationAt)),
};

const supportRootRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  resourceType: 'commerce.pricing.currency-support' as const,
  tenantId,
};
const supportRevisionRef = {
  moduleId: 'commerce.pricing' as const,
  resourceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  resourceType: 'commerce.pricing.currency-support-revision' as const,
  supportRootId: supportRootRef.resourceId,
  tenantId,
};
const currentCurrencySupport = {
  currentnessEvidence: {
    evaluatedAt: operationAt,
    evaluationMode: 'CURRENT_WITH_REVALIDATION' as const,
    observedAt: operationAt,
    revalidatedAt: operationAt,
    scheduleRevision: 1,
    supportRevisionRef,
    supportRootRef,
  },
  effectivePeriod: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null },
  generation: 1,
  observedAt: operationAt,
  pricingRevision: 'pricing-currency-support:1',
  scheduleRevision: 1,
  supportedCurrencies: ['CZK'] as const,
  supportRevisionRef,
  supportRootRef,
};

const decodeDefinePayload = Schema.decodeUnknownSync(DefineCommercialFeePayloadSchema, {
  onExcessProperty: 'error',
});
const definePayload = decodeDefinePayload({
  catalogTargetEvidence,
  configuredAmount: { amount: '5', currencyCode: 'CZK' },
  effectivePeriod: currentPeriod,
  identityKey,
  reason: 'Define one exact Variant Commercial Fee',
});
const decodeRevisePayload = Schema.decodeUnknownSync(ReviseCommercialFeePayloadSchema, {
  onExcessProperty: 'error',
});
const valuePayload = decodeRevisePayload({
  acknowledgement,
  catalogTargetEvidence,
  configuredAmount: { amount: '6', currencyCode: 'CZK' },
  effectiveFrom: operationAt,
  expectedCurrent,
  identityKey,
  intent: 'VALUE_ONLY_CURRENT',
  reason: 'Revise Current after reviewing the exact future schedule',
});
const unacknowledgedValuePayload = decodeRevisePayload({
  catalogTargetEvidence,
  configuredAmount: { amount: '6', currencyCode: 'CZK' },
  effectiveFrom: operationAt,
  expectedCurrent,
  identityKey,
  intent: 'VALUE_ONLY_CURRENT',
  reason: 'Revise Current after reviewing the exact future schedule',
});
const schedulePayload = decodeRevisePayload({
  catalogTargetEvidence,
  configuredAmount: { amount: '7', currencyCode: 'CZK' },
  effectivePeriod: futurePeriod,
  expectedScheduleRevision: schedule.scheduleRevision,
  identityKey,
  intent: 'SCHEDULE_REVISION',
  reason: 'Schedule a future Fee',
});
const correctionPayload = decodeRevisePayload({
  catalogTargetEvidence,
  configuredAmount: { amount: '6', currencyCode: 'CZK' },
  expectedScheduleRevision: schedule.scheduleRevision,
  identityKey,
  intent: 'CORRECT_REVISION',
  reason: 'Correct the exact original Revision',
  targetEffectivePeriod: currentPeriod,
  targetRevisionId: currentRevision.definition.revision.revisionId,
});
if (schedulePayload.intent !== 'SCHEDULE_REVISION' || correctionPayload.intent !== 'CORRECT_REVISION') {
  throw new Error('Commercial Fee management acceptance fixtures must retain their exact intents');
}

type CatalogSnapshotResponse = Effect.Success<ReturnType<typeof executeProductVariantSnapshotWithAuthorization>>;
interface CatalogSnapshotFixture {
  readonly capturedAt: typeof catalogTargetEvidence.capturedAt;
  readonly catalogOwnerRevision: string;
  readonly productRef: typeof productRef;
  readonly snapshotId: string;
  readonly targets: readonly unknown[];
  readonly targetSetCompleteness: unknown;
}

const catalogGateway = {
  issue: () =>
    Effect.succeed({
      baseUrl: new URL('https://catalog.example.test'),
      credential: Redacted.make('Bearer catalog-owner-assertion'),
    }),
};

const revisionServices = (
  revise: ReviseCommercialFeeActionServices['revise'],
  validateCatalogTarget: ReviseCommercialFeeActionServices['validateCatalogTarget'] = () => Effect.succeed(true),
): ReviseCommercialFeeActionServices => ({
  loadCurrencySupport: () => Effect.succeed({ _tag: 'current', current: currentCurrencySupport }),
  revise,
  validateCatalogTarget,
});

describe('Commercial Fee management Actions issue #797', () => {
  it('maps unavailable bulk execution and owner validation to typed retryable HTTP problems', () => {
    expect([
      mapManageProductCommercialFeesBulkActionProblem(
        new ProductCommercialFeeBulkUnavailable({
          code: 'product_commercial_fee_bulk_unavailable',
          reason: 'The authoritative Product bulk command adapter is not installed',
          retryable: true,
        }),
      ),
      mapManageProductCommercialFeesBulkActionProblem(
        new PricingCatalogSelectionUnavailable({
          code: 'pricing_catalog_selection_unavailable',
          reason: 'Catalog is unavailable',
          retryable: true,
        }),
      ),
      mapManageProductCommercialFeesBulkActionProblem(
        new CurrencySupportPersistenceUnavailable({ reason: 'Currency Support is unavailable' }),
      ),
    ]).toMatchObject([
      { code: 'product_commercial_fee_bulk_unavailable', retryable: true, status: 503 },
      { code: 'pricing_catalog_selection_unavailable', retryable: true, status: 503 },
      { code: 'currency_support_persistence_unavailable', retryable: true, status: 503 },
    ]);
  });

  it('publishes generated tenant-scoped, Legal-Entity-scoped Actions and all four management intents', () => {
    expect(
      [defineCommercialFeeAction, reviseCommercialFeeAction].map(({ descriptor }) => ({
        actionKey: descriptor.actionKey,
        authorization: descriptor.entrypoint.authorization,
        idempotency: descriptor.idempotency,
        legalEntityScope: descriptor.legalEntityScope,
        scope: descriptor.entrypoint.scope,
      })),
    ).toEqual([
      {
        actionKey: 'commerce.pricing.define-commercial-fee',
        authorization: { kind: 'action_execution', provisioning: 'explicit' },
        idempotency: 'required',
        legalEntityScope: 'required',
        scope: 'tenant',
      },
      {
        actionKey: 'commerce.pricing.revise-commercial-fee',
        authorization: { kind: 'action_execution', provisioning: 'explicit' },
        idempotency: 'required',
        legalEntityScope: 'required',
        scope: 'tenant',
      },
    ]);

    expect(
      [
        unacknowledgedValuePayload,
        schedulePayload,
        correctionPayload,
        {
          effectiveTo: operationAt,
          expectedCurrent,
          identityKey,
          intent: 'RETIRE_CURRENT',
          reason: 'Retire only Current',
        },
      ].map((payload) => decodeRevisePayload(payload).intent),
    ).toEqual(['VALUE_ONLY_CURRENT', 'SCHEDULE_REVISION', 'CORRECT_REVISION', 'RETIRE_CURRENT']);
  });

  it('requires a Variant identity and keeps Product only as Catalog target evidence', () => {
    expect(definePayload.identityKey.target).toEqual({ variantRef });
    expect(definePayload.catalogTargetEvidence.productRef).toEqual(productRef);
    expect(() =>
      decodeDefinePayload({
        ...definePayload,
        identityKey: { ...identityKey, target: { productRef } },
      }),
    ).toThrow();
    expect(() =>
      decodeDefinePayload({
        ...definePayload,
        identityKey: { ...identityKey, target: { productRef, variantRef } },
      }),
    ).toThrow();
  });

  it.effect('rejects untrusted Tenant/SLE/currency or stale Catalog evidence before persistence', () =>
    Effect.gen(function* exactDefinitionGuards() {
      let catalogChecks = 0;
      let writes = 0;
      const services: DefineCommercialFeeActionServices = {
        define: () => {
          writes += 1;
          return Effect.die('A rejected definition must not reach persistence');
        },
        loadCurrencySupport: () => Effect.succeed({ _tag: 'current', current: currentCurrencySupport }),
        validateCatalogTarget: () => {
          catalogChecks += 1;
          return Effect.succeed(true);
        },
      };
      const tenantFailure = yield* applyCommercialFeeDefinition(
        definePayload,
        { ...trusted, tenantId: otherTenantId },
        services,
      ).pipe(Effect.flip);
      const legalEntityFailure = yield* applyCommercialFeeDefinition(
        definePayload,
        { ...trusted, legalEntityId: otherLegalEntityId },
        services,
      ).pipe(Effect.flip);
      const euroPayload = decodeDefinePayload({
        ...definePayload,
        configuredAmount: { amount: '5', currencyCode: 'EUR' },
        identityKey: { ...identityKey, currencyCode: 'EUR' },
      });
      const currencyFailure = yield* applyCommercialFeeDefinition(euroPayload, trusted, services).pipe(Effect.flip);
      const catalogFailure = yield* applyCommercialFeeDefinition(definePayload, trusted, {
        ...services,
        validateCatalogTarget: () => {
          catalogChecks += 1;
          return Effect.succeed(false);
        },
      }).pipe(Effect.flip);

      expect(tenantFailure).toBeInstanceOf(DefineCommercialFeeRejected);
      expect(tenantFailure).toMatchObject({ code: 'define_commercial_fee_scope_mismatch' });
      expect(legalEntityFailure).toMatchObject({ code: 'define_commercial_fee_scope_mismatch' });
      expect(currencyFailure).toMatchObject({ code: 'define_commercial_fee_currency_not_enabled' });
      expect(catalogFailure).toMatchObject({ code: 'define_commercial_fee_target_evidence_mismatch' });
      expect(catalogChecks).toBe(1);
      expect(writes).toBe(0);
    }),
  );

  it.effect('accepts normalized acknowledgement amounts but rejects principal and intent mismatches', () =>
    Effect.gen(function* exactAcknowledgementBinding() {
      const commands: unknown[] = [];
      const accepted = yield* applyCommercialFeeRevision(
        valuePayload,
        trusted,
        revisionServices((command) => {
          commands.push(command);
          return Effect.succeed({ outcome: 'COMMERCIAL_FEE_UNCHANGED' as const, schedule });
        }),
      );
      const principalFailure = yield* applyCommercialFeeRevision(
        valuePayload,
        { ...trusted, actingPrincipalId: otherPrincipalId },
        revisionServices(() => Effect.die('A mismatched Principal acknowledgement must not reach persistence')),
      ).pipe(Effect.flip);
      const wrongIntentAcknowledgement = yield* Schema.decodeEffect(PricingCommercialFeeScheduleAcknowledgementSchema)({
        ...acknowledgement,
        intendedEffectivePeriod: { effectiveFrom: currentPeriod.effectiveFrom, effectiveTo: operationAt },
        intent: 'RETIRE_CURRENT',
      });
      const intentFailure = yield* applyCommercialFeeRevision(
        decodeRevisePayload({ ...valuePayload, acknowledgement: wrongIntentAcknowledgement }),
        trusted,
        revisionServices(() => Effect.die('A mismatched intent acknowledgement must not reach persistence')),
      ).pipe(Effect.flip);
      const wrongBoundaryAcknowledgement = yield* Schema.decodeEffect(
        PricingCommercialFeeScheduleAcknowledgementSchema,
      )({
        ...acknowledgement,
        intendedEffectivePeriod: { effectiveFrom: '2026-09-27T11:30:00.000Z', effectiveTo: currentPeriod.effectiveTo },
      });
      const boundaryFailure = yield* applyCommercialFeeRevision(
        decodeRevisePayload({ ...valuePayload, acknowledgement: wrongBoundaryAcknowledgement }),
        trusted,
        revisionServices(() => Effect.die('A mismatched successor boundary must not reach persistence')),
      ).pipe(Effect.flip);

      expect(accepted.outcome).toBe('COMMERCIAL_FEE_UNCHANGED');
      expect(commands).toHaveLength(1);
      expect(commands[0]).toMatchObject({
        acknowledgement: { intendedConfiguredAmount: { amount: '6.000000000' } },
        actingPrincipalId: principalId,
        configuredAmount: { amount: '6' },
        intent: 'VALUE_ONLY_CURRENT',
      });
      expect(principalFailure).toBeInstanceOf(ReviseCommercialFeeRejected);
      expect(principalFailure).toMatchObject({ code: 'revise_commercial_fee_acknowledgement_mismatch' });
      expect(intentFailure).toMatchObject({ code: 'revise_commercial_fee_acknowledgement_mismatch' });
      expect(boundaryFailure).toMatchObject({ code: 'revise_commercial_fee_acknowledgement_mismatch' });
    }),
  );

  it.effect('preserves the exact future-schedule acknowledgement in the typed HTTP warning', () =>
    Effect.gen(function* exactWarning() {
      const warning = yield* applyCommercialFeeRevision(
        unacknowledgedValuePayload,
        trusted,
        revisionServices(() =>
          Effect.succeed({ acknowledgement, outcome: 'COMMERCIAL_FEE_ACKNOWLEDGEMENT_REQUIRED' as const }),
        ),
      ).pipe(Effect.flip);

      const isAcknowledgementWarning = Schema.is(ReviseCommercialFeeAcknowledgementRequired);
      expect(isAcknowledgementWarning(warning)).toBe(true);
      if (!isAcknowledgementWarning(warning)) {
        throw new Error('Expected a Commercial Fee acknowledgement warning');
      }
      expect(warning.acknowledgement).toEqual(acknowledgement);
      expect(mapReviseCommercialFeeActionProblem(warning)).toMatchObject({
        acknowledgement,
        code: 'commercial_fee_schedule_acknowledgement_required',
        status: 422,
      });
    }),
  );

  it.effect('decodes and forwards correction and retirement without inventing retirement Catalog evidence', () =>
    Effect.gen(function* correctionAndRetirement() {
      const commands: unknown[] = [];
      let catalogChecks = 0;
      let currencyReads = 0;
      const retirement = decodeRevisePayload({
        effectiveTo: operationAt,
        expectedCurrent,
        identityKey,
        intent: 'RETIRE_CURRENT',
        reason: 'Retire only the exact Current Fee',
      });
      const sharedRevise: ReviseCommercialFeeActionServices['revise'] = (command) => {
        commands.push(command);
        return Effect.succeed({ outcome: 'COMMERCIAL_FEE_REVISED' as const, schedule });
      };

      yield* applyCommercialFeeRevision(correctionPayload, trusted, {
        loadCurrencySupport: () => {
          currencyReads += 1;
          return Effect.succeed({ _tag: 'current', current: currentCurrencySupport });
        },
        revise: sharedRevise,
        validateCatalogTarget: () => {
          catalogChecks += 1;
          return Effect.succeed(true);
        },
      });
      yield* applyCommercialFeeRevision(retirement, trusted, {
        loadCurrencySupport: () => Effect.die('Retirement must not fabricate a Currency Support prerequisite'),
        revise: sharedRevise,
        validateCatalogTarget: () => Effect.die('Retirement must not fabricate Catalog target evidence'),
      });

      expect(catalogChecks).toBe(1);
      expect(currencyReads).toBe(1);
      expect(commands).toHaveLength(2);
      expect(commands[0]).toMatchObject({
        actingPrincipalId: principalId,
        catalogTargetEvidence,
        configuredAmount: { amount: '6', currencyCode: 'CZK' },
        expectedScheduleRevision: 2,
        intent: 'CORRECT_REVISION',
        targetEffectivePeriod: currentPeriod,
        targetRevisionId: currentRevision.definition.revision.revisionId,
      });
      expect(commands[1]).toMatchObject({
        actingPrincipalId: principalId,
        effectiveTo: operationAt,
        expectedCurrent,
        intent: 'RETIRE_CURRENT',
      });
      expect(commands[1]).not.toHaveProperty('catalogTargetEvidence');
      expect(commands[1]).not.toHaveProperty('configuredAmount');
    }),
  );

  it.effect('distinguishes every Currency Support trust failure for definitions without persisting', () =>
    Effect.gen(function* definitionCurrencyTrust() {
      let writes = 0;
      const cases = [
        {
          code: 'define_commercial_fee_currency_support_absent',
          outcome: { _tag: 'absent' as const, observedAt: operationAt },
        },
        {
          code: 'define_commercial_fee_currency_support_gap',
          outcome: { _tag: 'gap' as const, observedAt: operationAt },
        },
        {
          code: 'define_commercial_fee_currency_support_conflict',
          outcome: { _tag: 'conflict' as const, observedAt: operationAt },
        },
        {
          code: 'define_commercial_fee_currency_not_enabled',
          outcome: {
            _tag: 'current' as const,
            current: { ...currentCurrencySupport, supportedCurrencies: ['EUR'] as const },
          },
        },
      ];

      const failures = yield* Effect.forEach((testCase: (typeof cases)[number]) =>
        applyCommercialFeeDefinition(definePayload, trusted, {
          define: () => {
            writes += 1;
            return Effect.die('Invalid Currency Support must not reach definition persistence');
          },
          loadCurrencySupport: () => Effect.succeed(testCase.outcome),
          validateCatalogTarget: () => Effect.die('Invalid Currency Support must stop before Catalog validation'),
        }).pipe(Effect.flip),
      )(cases);

      const unavailableFailure = yield* applyCommercialFeeDefinition(definePayload, trusted, {
        define: () => {
          writes += 1;
          return Effect.die('Unavailable Currency Support must not reach definition persistence');
        },
        loadCurrencySupport: () =>
          Effect.fail(
            new PersistenceFailure({
              cause: 'fixture driver failure',
              reason: 'Currency Support owner is unavailable',
            }),
          ),
        validateCatalogTarget: () => Effect.die('Unavailable Currency Support must stop before Catalog validation'),
      }).pipe(Effect.flip);

      expect(Schema.is(CurrencySupportPersistenceUnavailable)(unavailableFailure)).toBe(true);
      expect(failures).toMatchObject(cases.map(({ code }) => ({ code })));
      expect(writes).toBe(0);
    }),
  );

  it.effect('distinguishes every Currency Support trust failure for revisions without persisting', () =>
    Effect.gen(function* revisionCurrencyTrust() {
      let writes = 0;
      const cases = [
        {
          code: 'revise_commercial_fee_currency_support_absent',
          outcome: { _tag: 'absent' as const, observedAt: operationAt },
        },
        {
          code: 'revise_commercial_fee_currency_support_gap',
          outcome: { _tag: 'gap' as const, observedAt: operationAt },
        },
        {
          code: 'revise_commercial_fee_currency_support_conflict',
          outcome: { _tag: 'conflict' as const, observedAt: operationAt },
        },
        {
          code: 'revise_commercial_fee_currency_not_enabled',
          outcome: {
            _tag: 'current' as const,
            current: { ...currentCurrencySupport, supportedCurrencies: ['EUR'] as const },
          },
        },
      ];

      const failures = yield* Effect.forEach((testCase: (typeof cases)[number]) =>
        applyCommercialFeeRevision(unacknowledgedValuePayload, trusted, {
          loadCurrencySupport: () => Effect.succeed(testCase.outcome),
          revise: () => {
            writes += 1;
            return Effect.die('Invalid Currency Support must not reach revision persistence');
          },
          validateCatalogTarget: () => Effect.die('Invalid Currency Support must stop before Catalog validation'),
        }).pipe(Effect.flip),
      )(cases);

      const unavailableFailure = yield* applyCommercialFeeRevision(unacknowledgedValuePayload, trusted, {
        loadCurrencySupport: () =>
          Effect.fail(
            new PersistenceFailure({
              cause: 'fixture driver failure',
              reason: 'Currency Support owner is unavailable',
            }),
          ),
        revise: () => {
          writes += 1;
          return Effect.die('Unavailable Currency Support must not reach revision persistence');
        },
        validateCatalogTarget: () => Effect.die('Unavailable Currency Support must stop before Catalog validation'),
      }).pipe(Effect.flip);

      expect(Schema.is(CurrencySupportPersistenceUnavailable)(unavailableFailure)).toBe(true);
      expect(failures).toMatchObject(cases.map(({ code }) => ({ code })));
      expect(writes).toBe(0);
    }),
  );

  it.effect('queries Currency Support at the exact effectivity instant for every value-bearing intent', () =>
    Effect.gen(function* exactCurrencyEffectivity() {
      const queries: unknown[] = [];
      let writes = 0;
      const definitionServices: DefineCommercialFeeActionServices = {
        define: () => {
          writes += 1;
          return Effect.die('Effectivity probing must not persist');
        },
        loadCurrencySupport: (query) => {
          queries.push(query);
          return Effect.succeed({ _tag: 'current', current: currentCurrencySupport });
        },
        validateCatalogTarget: () => Effect.succeed(false),
      };
      const revisionEffectivityServices: ReviseCommercialFeeActionServices = {
        loadCurrencySupport: (query) => {
          queries.push(query);
          return Effect.succeed({ _tag: 'current', current: currentCurrencySupport });
        },
        revise: () => {
          writes += 1;
          return Effect.die('Effectivity probing must not persist');
        },
        validateCatalogTarget: () => Effect.succeed(false),
      };

      yield* applyCommercialFeeDefinition(definePayload, trusted, definitionServices).pipe(Effect.flip);
      yield* applyCommercialFeeRevision(unacknowledgedValuePayload, trusted, revisionEffectivityServices).pipe(
        Effect.flip,
      );
      yield* applyCommercialFeeRevision(schedulePayload, trusted, revisionEffectivityServices).pipe(Effect.flip);
      yield* applyCommercialFeeRevision(correctionPayload, trusted, revisionEffectivityServices).pipe(Effect.flip);

      expect(queries).toEqual([
        { effectiveAt: definePayload.effectivePeriod.effectiveFrom, tenantId },
        { effectiveAt: operationAt, tenantId },
        { effectiveAt: schedulePayload.effectivePeriod.effectiveFrom, tenantId },
        { effectiveAt: correctionPayload.targetEffectivePeriod.effectiveFrom, tenantId },
      ]);
      expect(writes).toBe(0);
    }),
  );

  it.effect(
    'revalidates exact current Catalog snapshot evidence and blocks stale owner evidence before persistence',
    () =>
      Effect.gen(function* catalogOwnerTrust() {
        const executed: unknown[] = [];
        const portFor = (response: CatalogSnapshotFixture) =>
          commercialFeeCatalogTargetAssessmentPortFromEnvironment(
            { compositionRevision: 'a'.repeat(64), legalEntityId, requestCorrelation: trusted.requestCorrelationId },
            (payload, credential, requestCorrelation, options) =>
              Effect.sync(() => {
                executed.push({
                  credential: Redacted.value(credential),
                  options,
                  payload,
                  requestCorrelation,
                });
                return response as CatalogSnapshotResponse;
              }),
          );
        const exactPort = yield* portFor(catalogSnapshotResponse);
        expect(yield* exactPort.validate(catalogTargetEvidence)).toBe(true);

        const laterObservationPort = yield* portFor({
          ...catalogSnapshotResponse,
          capturedAt: '2026-09-27T08:00:01.000Z',
          targets: [
            {
              ...catalogSnapshotTarget,
              catalogEvidence: {
                ...catalogSnapshotTarget.catalogEvidence,
                assessedAt: '2026-09-27T08:00:01.000Z',
                membership: {
                  ...catalogSnapshotTarget.catalogEvidence.membership,
                  observedAt: '2026-09-27T08:00:01.000Z',
                },
              },
            },
          ],
          targetSetCompleteness: {
            ...catalogSnapshotResponse.targetSetCompleteness,
            observedAt: '2026-09-27T08:00:01.000Z',
          },
        });
        expect(yield* laterObservationPort.validate(catalogTargetEvidence)).toBe(true);

        const mismatchedSnapshots = [
          { ...catalogSnapshotResponse, snapshotId: 'd'.repeat(64) },
          { ...catalogSnapshotResponse, catalogOwnerRevision: 'catalog:products:stale' },
          { ...catalogSnapshotResponse, capturedAt: '2026-09-27T07:59:59.999Z' },
          {
            ...catalogSnapshotResponse,
            targets: [{ ...catalogSnapshotTarget, targetId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' }],
          },
          {
            ...catalogSnapshotResponse,
            targets: [
              {
                ...catalogSnapshotTarget,
                target: { ...catalogSnapshotTarget.target, configuration: { kind: 'CONFIGURED' } },
              },
            ],
          },
        ];
        const validationResults = yield* Effect.forEach((response: (typeof mismatchedSnapshots)[number]) =>
          Effect.flatMap(portFor(response), (port) => port.validate(catalogTargetEvidence)),
        )(mismatchedSnapshots);
        expect(validationResults).toEqual([false, false, false, false, false]);

        const stalePort = yield* portFor(mismatchedSnapshots[0] ?? catalogSnapshotResponse);
        let writes = 0;
        const definitionFailure = yield* applyCommercialFeeDefinition(definePayload, trusted, {
          define: () => {
            writes += 1;
            return Effect.die('Stale Catalog evidence must not reach definition persistence');
          },
          loadCurrencySupport: () => Effect.succeed({ _tag: 'current', current: currentCurrencySupport }),
          validateCatalogTarget: stalePort.validate,
        }).pipe(Effect.flip);
        const revisionFailure = yield* applyCommercialFeeRevision(unacknowledgedValuePayload, trusted, {
          loadCurrencySupport: () => Effect.succeed({ _tag: 'current', current: currentCurrencySupport }),
          revise: () => {
            writes += 1;
            return Effect.die('Stale Catalog evidence must not reach revision persistence');
          },
          validateCatalogTarget: stalePort.validate,
        }).pipe(Effect.flip);

        expect(definitionFailure).toMatchObject({ code: 'define_commercial_fee_target_evidence_mismatch' });
        expect(revisionFailure).toMatchObject({ code: 'revise_commercial_fee_target_evidence_mismatch' });
        expect(writes).toBe(0);
        expect(executed[0]).toEqual({
          credential: 'Bearer catalog-owner-assertion',
          options: { baseUrl: new URL('https://catalog.example.test'), compositionRevision: 'a'.repeat(64) },
          payload: { productRef },
          requestCorrelation: trusted.requestCorrelationId,
        });
      }).pipe(Effect.provideService(CatalogSelectionGatewayCredentialService, catalogGateway)),
  );

  it.effect('fails governed definition and schedule reads closed before owner persistence on scope mismatch', () =>
    Effect.gen(function* readScopeFailure() {
      const definition = yield* readCommercialFeeDefinition(
        { identityKey },
        { legalEntityId, tenantId: otherTenantId, trustedOperationAt: trusted.trustedOperationAt },
        () => Effect.die('A cross-Tenant definition read must not reach persistence'),
      );
      const feeSchedule = yield* readCommercialFeeSchedule(
        { identityKey },
        { legalEntityId: otherLegalEntityId, tenantId, trustedOperationAt: trusted.trustedOperationAt },
        () => Effect.die('A cross-Legal-Entity schedule read must not reach persistence'),
      );

      expect(definition).toMatchObject({ identityKey, outcome: 'COMMERCIAL_FEE_CURRENT_ABSENT' });
      expect(feeSchedule).toEqual({ identityKey, outcome: 'COMMERCIAL_FEE_SCHEDULE_ABSENT' });
    }),
  );
});
