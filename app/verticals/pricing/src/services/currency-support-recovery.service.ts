import {
  CurrencySupportEffectivePeriodSchema,
  PricingNonEmptyCurrencyCodeSetSchema,
} from '@app/pricing-contracts/domain/currency-support';
import type { SetSupportedCurrenciesV2Payload } from '@app/pricing-contracts/domain/currency-support';
import { PricingInstantSchema } from '@app/pricing-contracts/current-supported-currencies';
import { Context, Effect, Schema } from 'effect';

const checkedUuid = Schema.String.check(Schema.isUUID(), Schema.isTrimmed());
const ActionInvocationIdSchema = checkedUuid.pipe(Schema.brand('PricingRecoveryActionInvocationId'));
const ActingPrincipalIdSchema = checkedUuid.pipe(Schema.brand('PricingRecoveryActingPrincipalId'));
const LegalEntityIdSchema = checkedUuid.pipe(Schema.brand('PricingRecoveryLegalEntityId'));
const TenantIdSchema = checkedUuid.pipe(Schema.brand('PricingRecoveryTenantId'));
const stableReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed());
const reason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());

export const LegacyCurrencySupportRecordSchema = Schema.Struct({
  effectivePeriod: CurrencySupportEffectivePeriodSchema,
  legacyGeneration: Schema.Int.check(Schema.isGreaterThan(0)),
  legacyRevisionRef: stableReference,
  originalScope: Schema.Struct({
    legalEntityId: LegalEntityIdSchema,
    scopeRef: stableReference,
    scopeType: Schema.Literals(['CART', 'CHANNEL', 'CONTEXT', 'MARKET', 'STOREFRONT', 'SUBJECT']),
  }),
  recordedAt: PricingInstantSchema,
  supportedCurrencies: PricingNonEmptyCurrencyCodeSetSchema,
  tenantId: TenantIdSchema,
});
export type LegacyCurrencySupportRecord = typeof LegacyCurrencySupportRecordSchema.Type;

export const LegacyCurrencySupportMappingSchema = Schema.Struct({
  authorityRef: stableReference,
  authorityVersion: stableReference,
  disposition: Schema.Literal('HISTORY_ONLY'),
  legacyRevisionRef: stableReference,
  mappingRef: stableReference,
  mappingVersion: stableReference,
  reason,
});
export type LegacyCurrencySupportMapping = typeof LegacyCurrencySupportMappingSchema.Type;

export const CurrencySupportRecoveryRequestSchema = Schema.Struct({
  actingPrincipalId: ActingPrincipalIdSchema,
  actionInvocationId: ActionInvocationIdSchema,
  baseline: Schema.Struct({
    authorityRef: stableReference,
    authorityVersion: stableReference,
    effectivePeriod: CurrencySupportEffectivePeriodSchema,
    mappingRef: stableReference,
    mappingVersion: stableReference,
    reason,
    supportedCurrencies: PricingNonEmptyCurrencyCodeSetSchema,
    tenantId: TenantIdSchema,
  }),
  bridgeMode: Schema.Literal('LEGACY_READ_ONLY'),
  canonicalState: Schema.Literals(['ABSENT', 'PRESENT']),
  legacyMappings: Schema.Array(LegacyCurrencySupportMappingSchema),
  legacyRecords: Schema.Array(LegacyCurrencySupportRecordSchema),
  schemaVersion: Schema.Literal('1'),
  trustedOperationAt: PricingInstantSchema,
});
export type CurrencySupportRecoveryRequest = typeof CurrencySupportRecoveryRequestSchema.Type;

export const CurrencySupportRecoveryHeldReasonSchema = Schema.Literals([
  'CANONICAL_AUTHORITY_ALREADY_EXISTS',
  'DUPLICATE_LEGACY_REVISION',
  'LEGACY_MAPPING_INCOMPLETE',
  'LEGACY_MAPPING_NOT_EXACT',
  'TENANT_SCOPE_MISMATCH',
  'UNAUTHORIZED_CURRENCY_ACTIVATION',
]);
export type CurrencySupportRecoveryHeldReason = typeof CurrencySupportRecoveryHeldReasonSchema.Type;

export interface CurrencySupportRecoveryPlan {
  readonly audit: {
    readonly authorityRef: string;
    readonly authorityVersion: string;
    readonly legacyRevisionRefs: readonly string[];
    readonly mappingRef: string;
    readonly mappingVersion: string;
    readonly reason: string;
  };
  readonly baselineDerivation: 'EXPLICIT_GOVERNED_INPUT_ONLY';
  readonly bridgeMode: 'LEGACY_READ_ONLY';
  readonly command: {
    readonly actingPrincipalId: string;
    readonly actionInvocationId: string;
    readonly payload: SetSupportedCurrenciesV2Payload;
    readonly tenantId: string;
    readonly trustedOperationAt: CurrencySupportRecoveryRequest['trustedOperationAt'];
  };
  readonly qualifiedLegacyHistory: readonly {
    readonly mapping: LegacyCurrencySupportMapping;
    readonly record: LegacyCurrencySupportRecord;
  }[];
  readonly rollbackMode: 'NEW_AUDITED_TRANSITION_REQUIRED';
  readonly schemaVersion: '1';
}

export type CurrencySupportRecoveryPlanningOutcome =
  | { readonly outcome: 'RECOVERY_HELD'; readonly reason: CurrencySupportRecoveryHeldReason }
  | { readonly outcome: 'RECOVERY_READY'; readonly plan: CurrencySupportRecoveryPlan };

const held = (heldReason: CurrencySupportRecoveryHeldReason): CurrencySupportRecoveryPlanningOutcome => ({
  outcome: 'RECOVERY_HELD',
  reason: heldReason,
});

const duplicateValues = (values: readonly string[]): boolean => new Set(values).size !== values.length;

/**
 * Produces the only allowed Launch recovery command from an explicit governed Tenant baseline.
 * Legacy rows remain qualified history; their values are never unioned, intersected, or ranked.
 */
export const planCurrencySupportRecovery = (
  request: CurrencySupportRecoveryRequest,
): CurrencySupportRecoveryPlanningOutcome => {
  const { baseline, legacyMappings, legacyRecords } = request;
  if (request.canonicalState !== 'ABSENT') {
    return held('CANONICAL_AUTHORITY_ALREADY_EXISTS');
  }
  if (baseline.supportedCurrencies.length !== 1 || baseline.supportedCurrencies[0] !== 'CZK') {
    return held('UNAUTHORIZED_CURRENCY_ACTIVATION');
  }
  if (legacyRecords.some((record) => record.tenantId !== baseline.tenantId)) {
    return held('TENANT_SCOPE_MISMATCH');
  }
  const recordRefs = legacyRecords.map(({ legacyRevisionRef }) => legacyRevisionRef);
  const mappingRefs = legacyMappings.map(({ legacyRevisionRef }) => legacyRevisionRef);
  const recordRefSet = new Set(recordRefs);
  const mappingRefSet = new Set(mappingRefs);
  if (duplicateValues(recordRefs) || duplicateValues(mappingRefs)) {
    return held('DUPLICATE_LEGACY_REVISION');
  }
  if (recordRefs.length !== mappingRefs.length || recordRefs.some((reference) => !mappingRefSet.has(reference))) {
    return held('LEGACY_MAPPING_INCOMPLETE');
  }
  if (mappingRefs.some((reference) => !recordRefSet.has(reference))) {
    return held('LEGACY_MAPPING_NOT_EXACT');
  }

  const payload = {
    expectedState: { state: 'ABSENT' },
    intendedEffectivePeriod: baseline.effectivePeriod,
    intent: 'ESTABLISH_CURRENT',
    reason: baseline.reason,
    schemaVersion: '2',
    supportedCurrencies: baseline.supportedCurrencies,
  } satisfies SetSupportedCurrenciesV2Payload;
  const mappingByRef = new Map(legacyMappings.map((mapping) => [mapping.legacyRevisionRef, mapping]));
  const qualifiedLegacyHistory = legacyRecords.flatMap((record) => {
    const mapping = mappingByRef.get(record.legacyRevisionRef);
    return mapping === undefined ? [] : [{ mapping, record }];
  });
  return {
    outcome: 'RECOVERY_READY',
    plan: {
      audit: {
        authorityRef: baseline.authorityRef,
        authorityVersion: baseline.authorityVersion,
        legacyRevisionRefs: recordRefs,
        mappingRef: baseline.mappingRef,
        mappingVersion: baseline.mappingVersion,
        reason: baseline.reason,
      },
      baselineDerivation: 'EXPLICIT_GOVERNED_INPUT_ONLY',
      bridgeMode: 'LEGACY_READ_ONLY',
      command: {
        actingPrincipalId: request.actingPrincipalId,
        actionInvocationId: request.actionInvocationId,
        payload,
        tenantId: baseline.tenantId,
        trustedOperationAt: request.trustedOperationAt,
      },
      qualifiedLegacyHistory,
      rollbackMode: 'NEW_AUDITED_TRANSITION_REQUIRED',
      schemaVersion: '1',
    },
  };
};

export type CurrencySupportRecoveryResultLookup =
  | { readonly outcome: 'NOT_FOUND' }
  | {
      readonly actionInvocationId: string;
      readonly outcome: 'FOUND';
      readonly supportedCurrencies: readonly string[];
      readonly tenantId: string;
    };

export class CurrencySupportRecoveryUnavailable extends Schema.TaggedError<CurrencySupportRecoveryUnavailable>()(
  'CurrencySupportRecoveryUnavailable',
  { reason },
) {}

export interface CurrencySupportRecoveryExecutionPort {
  readonly establish: (
    command: CurrencySupportRecoveryPlan['command'],
  ) => Effect.Effect<{ readonly changed: boolean }, CurrencySupportRecoveryUnavailable>;
  readonly lookupOriginalInvocation: (
    tenantId: string,
    actionInvocationId: string,
  ) => Effect.Effect<CurrencySupportRecoveryResultLookup, CurrencySupportRecoveryUnavailable>;
}

class CurrencySupportRecoveryExecution extends Context.Service<
  CurrencySupportRecoveryExecution,
  CurrencySupportRecoveryExecutionPort
>()('@app/pricing/services/currency-support-recovery.service/CurrencySupportRecoveryExecution') {}

type CurrencySupportRecoveryExecutionOutcome =
  | { readonly outcome: 'RECOVERY_APPLIED' | 'RECOVERY_RECONCILED' }
  | { readonly outcome: 'RECOVERY_CONFLICT'; readonly reason: 'ORIGINAL_INTENT_MISMATCH' };

export type CurrencySupportRecoveryRollbackRequest =
  | { readonly phase: 'BEFORE_CANONICAL_COMMIT'; readonly plan: CurrencySupportRecoveryPlan }
  | {
      readonly committedActionInvocationId: string;
      readonly phase: 'AFTER_CANONICAL_COMMIT';
      readonly plan: CurrencySupportRecoveryPlan;
    };

export type CurrencySupportRecoveryRollbackOutcome =
  | { readonly outcome: 'ROLLBACK_COMPLETE_WITHOUT_CANONICAL_CHANGE' }
  | { readonly outcome: 'ROLLBACK_REFUSED'; readonly reason: 'COMMITTED_INTENT_MISMATCH' }
  | {
      readonly nextStep: 'CREATE_NEW_GOVERNED_TENANT_TRANSITION';
      readonly outcome: 'ROLLBACK_REQUIRES_AUDITED_TRANSITION';
      readonly reason: 'LEGACY_AUTHORITY_RESTORATION_FORBIDDEN';
    };

const sameCurrencies = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((currency, index) => currency === right[index]);

/** Looks up the original intent before retrying; a new idempotency key is never manufactured. */
export const executeCurrencySupportRecovery = Effect.fn('CurrencySupportRecovery.execute')(function* execute(
  plan: CurrencySupportRecoveryPlan,
  port: CurrencySupportRecoveryExecutionPort,
) {
  const execution = CurrencySupportRecoveryExecution.of(port);
  const { actionInvocationId, payload, tenantId } = plan.command;
  const lookup = yield* execution.lookupOriginalInvocation(tenantId, actionInvocationId);
  if (lookup.outcome === 'FOUND') {
    return lookup.actionInvocationId === actionInvocationId &&
      lookup.tenantId === tenantId &&
      sameCurrencies(lookup.supportedCurrencies, payload.supportedCurrencies)
      ? ({ outcome: 'RECOVERY_RECONCILED' } as const satisfies CurrencySupportRecoveryExecutionOutcome)
      : ({
          outcome: 'RECOVERY_CONFLICT',
          reason: 'ORIGINAL_INTENT_MISMATCH',
        } as const satisfies CurrencySupportRecoveryExecutionOutcome);
  }
  yield* execution.establish(plan.command);
  return { outcome: 'RECOVERY_APPLIED' } as const satisfies CurrencySupportRecoveryExecutionOutcome;
});

/**
 * Recovery rollback never deletes a proven commit or makes legacy per-context rows writable again.
 * Before commit it is a no-op; after commit it requires a new governed Tenant transition.
 */
export const evaluateCurrencySupportRecoveryRollback = (
  request: CurrencySupportRecoveryRollbackRequest,
): CurrencySupportRecoveryRollbackOutcome => {
  if (request.phase === 'BEFORE_CANONICAL_COMMIT') {
    return { outcome: 'ROLLBACK_COMPLETE_WITHOUT_CANONICAL_CHANGE' };
  }
  if (request.committedActionInvocationId === request.plan.command.actionInvocationId) {
    return {
      nextStep: 'CREATE_NEW_GOVERNED_TENANT_TRANSITION',
      outcome: 'ROLLBACK_REQUIRES_AUDITED_TRANSITION',
      reason: 'LEGACY_AUTHORITY_RESTORATION_FORBIDDEN',
    };
  }
  return { outcome: 'ROLLBACK_REFUSED', reason: 'COMMITTED_INTENT_MISMATCH' };
};
