import { PrincipalRefSchema } from '@app/core-runtime';
import type { OperationalScope, PrincipalRef } from '@app/core-runtime';
import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import type { CounterpartyRef } from '@app/party-registry/resources/counterparty';
import { Context, Match, Schema } from 'effect';
import type { Effect } from 'effect';
import { PurchaseLimitPolicyRefSchema } from '../resources/purchase-limit-policy.ts';
import { MonetaryAmountSchema } from './purchase-limit.ts';

export const PurchaseLimitRevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));
const UtcTimestampSchema = Schema.DateTimeUtcFromString;

export const PurchaseLimitCounterpartyRefSchema = CounterpartyRefSchema;
export type PurchaseLimitCounterpartyRef = CounterpartyRef;

export const PurchaseLimitPolicySchema = Schema.Union([
  Schema.TaggedStruct('MONETARY_LIMIT', { limit: MonetaryAmountSchema }),
  Schema.TaggedStruct('UNLIMITED', {}),
]);
export type PurchaseLimitPolicy = typeof PurchaseLimitPolicySchema.Type;

const PurchaseLimitPolicySubjectSchema = Schema.Union([
  Schema.TaggedStruct('COUNTERPARTY_DEFAULT', {
    counterpartyRef: PurchaseLimitCounterpartyRefSchema,
  }),
  Schema.TaggedStruct('PRINCIPAL_OVERRIDE', {
    counterpartyRef: PurchaseLimitCounterpartyRefSchema,
    principalRef: PrincipalRefSchema,
  }),
]);
export type PurchaseLimitPolicySubject = typeof PurchaseLimitPolicySubjectSchema.Type;

export const PurchaseLimitPolicySnapshotSchema = Schema.Struct({
  changedAt: UtcTimestampSchema,
  policy: PurchaseLimitPolicySchema,
  policyRef: PurchaseLimitPolicyRefSchema,
  revision: PurchaseLimitRevisionSchema,
  subject: PurchaseLimitPolicySubjectSchema,
});
export type PurchaseLimitPolicySnapshot = typeof PurchaseLimitPolicySnapshotSchema.Type;

export const EffectivePurchaseLimitPolicySchema = Schema.Struct({
  policy: PurchaseLimitPolicySchema,
  policyRef: PurchaseLimitPolicyRefSchema,
  revision: PurchaseLimitRevisionSchema,
  source: Schema.Literals(['COUNTERPARTY_DEFAULT', 'PRINCIPAL_OVERRIDE']),
});
export type EffectivePurchaseLimitPolicy = typeof EffectivePurchaseLimitPolicySchema.Type;

export const EffectivePurchaseLimitPolicyResultSchema = Schema.Union([
  Schema.TaggedStruct('EFFECTIVE_POLICY', {
    effectivePolicy: EffectivePurchaseLimitPolicySchema,
  }),
  Schema.TaggedStruct('NO_EFFECTIVE_POLICY', {}),
  Schema.TaggedStruct('INCONSISTENT_POLICY', {
    reasonCode: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  }),
]);
export type EffectivePurchaseLimitPolicyResult = typeof EffectivePurchaseLimitPolicyResultSchema.Type;

export interface ResolveEffectivePurchaseLimitPolicyInput {
  readonly counterpartyPolicies: readonly PurchaseLimitPolicySnapshot[];
  readonly counterpartyRef: PurchaseLimitCounterpartyRef;
  readonly principalId: string;
  readonly principalOverrides: readonly PurchaseLimitPolicySnapshot[];
}

const isSameCounterparty = (expected: PurchaseLimitCounterpartyRef, actual: PurchaseLimitCounterpartyRef) =>
  actual.moduleId === expected.moduleId &&
  actual.resourceId === expected.resourceId &&
  actual.resourceType === expected.resourceType &&
  actual.tenantId === expected.tenantId;

export const resolveEffectivePurchaseLimitPolicy = (
  input: ResolveEffectivePurchaseLimitPolicyInput,
): EffectivePurchaseLimitPolicyResult => {
  const validDefaults = input.counterpartyPolicies.filter(({ subject }) =>
    Match.value(subject).pipe(
      Match.tag('COUNTERPARTY_DEFAULT', ({ counterpartyRef }) =>
        isSameCounterparty(input.counterpartyRef, counterpartyRef),
      ),
      Match.tag('PRINCIPAL_OVERRIDE', () => false),
      Match.exhaustive,
    ),
  );
  const validOverrides = input.principalOverrides.filter(({ subject }) =>
    Match.value(subject).pipe(
      Match.tag('COUNTERPARTY_DEFAULT', () => false),
      Match.tag(
        'PRINCIPAL_OVERRIDE',
        ({ counterpartyRef, principalRef }) =>
          principalRef.principalId === input.principalId &&
          principalRef.tenantId === input.counterpartyRef.tenantId &&
          isSameCounterparty(input.counterpartyRef, counterpartyRef),
      ),
      Match.exhaustive,
    ),
  );
  if (
    validDefaults.length !== input.counterpartyPolicies.length ||
    validOverrides.length !== input.principalOverrides.length
  ) {
    return { _tag: 'INCONSISTENT_POLICY', reasonCode: 'policy_subject_scope_mismatch' };
  }
  if (validDefaults.length > 1 || validOverrides.length > 1) {
    return { _tag: 'INCONSISTENT_POLICY', reasonCode: 'overlapping_current_policy' };
  }
  const selected = validOverrides[0] ?? validDefaults[0];
  if (selected === undefined) {
    return { _tag: 'NO_EFFECTIVE_POLICY' };
  }
  return {
    _tag: 'EFFECTIVE_POLICY',
    effectivePolicy: {
      policy: selected.policy,
      policyRef: selected.policyRef,
      revision: selected.revision,
      source: validOverrides[0] === undefined ? 'COUNTERPARTY_DEFAULT' : 'PRINCIPAL_OVERRIDE',
    },
  };
};

export const PurchaseLimitPolicyChangeSchema = Schema.Union([
  Schema.TaggedStruct('SET', { policy: PurchaseLimitPolicySchema }),
  Schema.TaggedStruct('CLEAR', {}),
]);
type PurchaseLimitPolicyChange = typeof PurchaseLimitPolicyChangeSchema.Type;

export const PurchaseLimitPolicyMutationResultSchema = Schema.Struct({
  currentPolicy: Schema.Union([PurchaseLimitPolicySnapshotSchema, Schema.Null]),
  previousPolicy: Schema.Union([PurchaseLimitPolicySnapshotSchema, Schema.Null]),
  status: Schema.Literals(['CHANGED', 'UNCHANGED']),
});
export type PurchaseLimitPolicyMutationResult = typeof PurchaseLimitPolicyMutationResultSchema.Type;

export const PurchaseLimitPolicyAuditEvidenceSchema = Schema.Struct({
  changeReason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000)),
  currentPolicyRef: Schema.Union([PurchaseLimitPolicyRefSchema, Schema.Null]),
  currentRevision: Schema.Union([PurchaseLimitRevisionSchema, Schema.Null]),
  previousPolicyRef: Schema.Union([PurchaseLimitPolicyRefSchema, Schema.Null]),
  previousRevision: Schema.Union([PurchaseLimitRevisionSchema, Schema.Null]),
});

const PurchaseLimitPolicyChangeKindSchema = Schema.Literals(['SET', 'CHANGED', 'CLEARED']);

export const CounterpartyPurchaseLimitChangedEventSchema = Schema.Struct({
  changeKind: PurchaseLimitPolicyChangeKindSchema,
  counterpartyRef: PurchaseLimitCounterpartyRefSchema,
  currentPolicyRef: Schema.Union([PurchaseLimitPolicyRefSchema, Schema.Null]),
  currentRevision: Schema.Union([PurchaseLimitRevisionSchema, Schema.Null]),
  currentState: Schema.Literals(['EXPLICIT_DEFAULT_CURRENT', 'NO_EXPLICIT_DEFAULT']),
  previousPolicyRef: Schema.Union([PurchaseLimitPolicyRefSchema, Schema.Null]),
  previousRevision: Schema.Union([PurchaseLimitRevisionSchema, Schema.Null]),
});

export const PrincipalPurchaseLimitOverrideChangedEventSchema = Schema.Struct({
  changeKind: PurchaseLimitPolicyChangeKindSchema,
  counterpartyRef: PurchaseLimitCounterpartyRefSchema,
  currentPolicyRef: Schema.Union([PurchaseLimitPolicyRefSchema, Schema.Null]),
  currentRevision: Schema.Union([PurchaseLimitRevisionSchema, Schema.Null]),
  currentState: Schema.Literals(['EXPLICIT_OVERRIDE_CURRENT', 'COUNTERPARTY_DEFAULT_APPLIES']),
  previousPolicyRef: Schema.Union([PurchaseLimitPolicyRefSchema, Schema.Null]),
  previousRevision: Schema.Union([PurchaseLimitRevisionSchema, Schema.Null]),
  principalRef: PrincipalRefSchema,
});

export const PurchaseLimitPolicyConflictSchema = Schema.TaggedStruct('PurchaseLimitPolicyConflict', {
  code: Schema.Literal('purchase_limit_policy_conflict'),
  currentRevision: Schema.Union([PurchaseLimitRevisionSchema, Schema.Null]),
  reason: Schema.String,
});
export type PurchaseLimitPolicyConflict = typeof PurchaseLimitPolicyConflictSchema.Type;

export const PurchaseLimitDependencyUnavailableSchema = Schema.TaggedStruct('PurchaseLimitDependencyUnavailable', {
  code: Schema.Literal('purchase_limit_dependency_unavailable'),
  dependency: Schema.String,
  reason: Schema.String,
});
export type PurchaseLimitDependencyUnavailable = typeof PurchaseLimitDependencyUnavailableSchema.Type;

export const PurchaseLimitSubjectScopeMismatchSchema = Schema.TaggedStruct('PurchaseLimitSubjectScopeMismatch', {
  code: Schema.Literal('purchase_limit_subject_scope_mismatch'),
  reason: Schema.String,
});
export type PurchaseLimitSubjectScopeMismatch = typeof PurchaseLimitSubjectScopeMismatchSchema.Type;

export const PurchaseLimitPrincipalIneligibleSchema = Schema.TaggedStruct('PurchaseLimitPrincipalIneligible', {
  code: Schema.Literal('purchase_limit_principal_ineligible'),
  reason: Schema.String,
});
type PurchaseLimitPrincipalIneligible = typeof PurchaseLimitPrincipalIneligibleSchema.Type;

export interface ChangeCounterpartyPurchaseLimitInput {
  readonly actionInvocationId: string;
  readonly actorPrincipalId: OperationalScope['principalId'];
  readonly change: PurchaseLimitPolicyChange;
  readonly counterpartyRef: PurchaseLimitCounterpartyRef;
  readonly expectedRevision: null | number;
  readonly reason: string;
}

export interface ChangePrincipalPurchaseLimitOverrideInput extends ChangeCounterpartyPurchaseLimitInput {
  readonly principalRef: PrincipalRef;
}

export type PurchaseLimitPolicyService = Readonly<{
  changeCounterpartyPolicy: (
    input: ChangeCounterpartyPurchaseLimitInput,
  ) => Effect.Effect<
    PurchaseLimitPolicyMutationResult,
    PurchaseLimitDependencyUnavailable | PurchaseLimitPolicyConflict | PurchaseLimitSubjectScopeMismatch
  >;
  changePrincipalOverride: (
    input: ChangePrincipalPurchaseLimitOverrideInput,
  ) => Effect.Effect<
    PurchaseLimitPolicyMutationResult,
    | PurchaseLimitDependencyUnavailable
    | PurchaseLimitPolicyConflict
    | PurchaseLimitPrincipalIneligible
    | PurchaseLimitSubjectScopeMismatch
  >;
  readCurrent: (input: {
    readonly counterpartyRef: PurchaseLimitCounterpartyRef;
    readonly principalRef: PrincipalRef;
  }) => Effect.Effect<EffectivePurchaseLimitPolicyResult, PurchaseLimitDependencyUnavailable>;
}>;

export interface PurchaseLimitPolicyServiceFactoryContract {
  readonly make: <Transaction>(
    transaction: Transaction,
    scope: OperationalScope,
  ) => Effect.Effect<PurchaseLimitPolicyService, PurchaseLimitDependencyUnavailable>;
}

export class PurchaseLimitPolicyServiceFactory extends Context.Service<
  PurchaseLimitPolicyServiceFactory,
  PurchaseLimitPolicyServiceFactoryContract
>()('@app/commerce-customer-context/shared/domain/purchase-limit-policy/PurchaseLimitPolicyServiceFactory') {}
