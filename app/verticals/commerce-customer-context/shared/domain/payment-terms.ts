import { Match, Predicate, Schema } from 'effect';
import type { CustomerPaymentTermEntitlementRef } from '../resources/customer-payment-term-entitlement.ts';
import {
  CustomerPaymentTermEntitlementSchema,
  CustomerPaymentTermsStateSchema,
  PaymentTermDefinitionSnapshotSchema,
  PaymentTermReferenceSchema,
  PaymentTermsTimestampSchema,
} from './payment-term-contracts.ts';
import type {
  CustomerPaymentTermEntitlement,
  CustomerPaymentTermPreference,
  CustomerPaymentTermsState,
  PaymentTermDefinitionSnapshot,
  PaymentTermReference,
} from './payment-term-contracts.ts';

const refKey = (ref: PaymentTermReference): string =>
  `${ref.tenantId}:${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`;
const entitlementRefKey = (ref: CustomerPaymentTermEntitlementRef): string =>
  `${ref.tenantId}:${ref.moduleId}:${ref.resourceType}:${ref.resourceId}`;

const effectivePeriodsOverlap = (
  left: Readonly<{ effectiveFrom: string; effectiveTo?: string | undefined }>,
  right: Readonly<{ effectiveFrom: string; effectiveTo?: string | undefined }>,
): boolean =>
  (left.effectiveTo === undefined || right.effectiveFrom < left.effectiveTo) &&
  (right.effectiveTo === undefined || left.effectiveFrom < right.effectiveTo);

export const isEffectiveAt = (
  period: Readonly<{ effectiveFrom: string; effectiveTo?: string | undefined }>,
  at: string,
): boolean => period.effectiveFrom <= at && (period.effectiveTo === undefined || at < period.effectiveTo);

export type CustomerPaymentTermsProjection = Readonly<{
  currentEntitlements: readonly CustomerPaymentTermEntitlement[];
  currentPreference?: CustomerPaymentTermPreference;
  state: CustomerPaymentTermsState;
}>;

/** Builds an as-of view; cancelled never-effective records are audit facts, not effective history. */
export const projectCustomerPaymentTermsAt = (
  state: CustomerPaymentTermsState,
  asOf: string,
  includeHistorical: boolean,
): CustomerPaymentTermsProjection => {
  const currentEntitlements = state.entitlements.filter(
    (entitlement) => entitlement.status === 'ACTIVE' && isEffectiveAt(entitlement, asOf),
  );
  const currentPreferences = state.preferences.filter((preference) => isEffectiveAt(preference, asOf));
  const visibleEntitlements = includeHistorical
    ? state.entitlements.filter((entitlement) => entitlement.status === 'ACTIVE' && entitlement.effectiveFrom <= asOf)
    : currentEntitlements;
  const visiblePreferences = includeHistorical
    ? state.preferences.filter((preference) => preference.effectiveFrom <= asOf)
    : currentPreferences;
  const [currentPreference] = currentPreferences;
  const projectedState = {
    ...state,
    entitlements: visibleEntitlements,
    preferences: visiblePreferences,
  };
  return currentPreference === undefined
    ? { currentEntitlements, state: projectedState }
    : { currentEntitlements, currentPreference, state: projectedState };
};

const definitionIsCurrent = (definition: PaymentTermDefinitionSnapshot, at: string): boolean =>
  definition.lifecycle.effectiveFrom <= at &&
  (definition.lifecycle.effectiveTo === null || at < definition.lifecycle.effectiveTo);

const sameTerm = (left: PaymentTermReference, right: PaymentTermReference): boolean => refKey(left) === refKey(right);

const validPeriod = (period: { effectiveFrom: string; effectiveTo?: string | undefined }): boolean =>
  period.effectiveTo === undefined || period.effectiveFrom < period.effectiveTo;

const GrantCustomerPaymentTermEntitlementSchema = Schema.TaggedStruct('GRANT_ENTITLEMENT', {
  effectiveFrom: PaymentTermsTimestampSchema,
  effectiveTo: Schema.optionalKey(PaymentTermsTimestampSchema),
  entitlementRef: CustomerPaymentTermEntitlementSchema.fields.entitlementRef,
  paymentTermRef: PaymentTermReferenceSchema,
  semanticRevisionId: CustomerPaymentTermEntitlementSchema.fields.semanticRevisionId,
});
export const SetCustomerPaymentTermPreferenceSchema = Schema.TaggedStruct('SET_PREFERENCE', {
  effectiveFrom: PaymentTermsTimestampSchema,
  effectiveTo: Schema.optionalKey(PaymentTermsTimestampSchema),
  paymentTermRef: PaymentTermReferenceSchema,
});
export const ClearCustomerPaymentTermPreferenceSchema = Schema.TaggedStruct('CLEAR_PREFERENCE', {
  effectiveAt: PaymentTermsTimestampSchema,
});
const EndCustomerPaymentTermEntitlementSchema = Schema.TaggedStruct('END_ENTITLEMENT', {
  effectiveAt: PaymentTermsTimestampSchema,
  entitlementRef: CustomerPaymentTermEntitlementSchema.fields.entitlementRef,
});
export const CustomerPaymentTermsChangeSchema = Schema.Union([
  GrantCustomerPaymentTermEntitlementSchema,
  SetCustomerPaymentTermPreferenceSchema,
  ClearCustomerPaymentTermPreferenceSchema,
  EndCustomerPaymentTermEntitlementSchema,
]);
export type CustomerPaymentTermsChange = typeof CustomerPaymentTermsChangeSchema.Type;

const ChangeCustomerPaymentTermsInputSchema = Schema.Struct({
  catalogDefinitions: Schema.Array(PaymentTermDefinitionSnapshotSchema),
  changes: Schema.Array(CustomerPaymentTermsChangeSchema).check(Schema.isMinLength(1), Schema.isMaxLength(50)),
  expectedRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  state: CustomerPaymentTermsStateSchema,
});
export type ChangeCustomerPaymentTermsInput = typeof ChangeCustomerPaymentTermsInputSchema.Type;

const ChangeCustomerPaymentTermsOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('CHANGED', {
    changed: Schema.Boolean,
    state: CustomerPaymentTermsStateSchema,
  }),
  Schema.TaggedStruct('REVISION_CONFLICT', {
    currentRevision: Schema.Finite,
    expectedRevision: Schema.Finite,
  }),
  Schema.TaggedStruct('ENTITLEMENT_OVERLAP', { paymentTermRef: PaymentTermReferenceSchema }),
  Schema.TaggedStruct('PAYMENT_TERM_UNUSABLE', {
    paymentTermRef: PaymentTermReferenceSchema,
    reason: Schema.Literals(['MISSING_DEFINITION', 'NOT_CURRENT', 'INCOMPATIBLE_REVISION', 'INCOMPATIBLE_CONSUMER']),
  }),
  Schema.TaggedStruct('PREFERENCE_CONFLICT', { reason: Schema.String }),
  Schema.TaggedStruct('ENTITLEMENT_NOT_FOUND', {
    entitlementRef: CustomerPaymentTermEntitlementSchema.fields.entitlementRef,
  }),
  Schema.TaggedStruct('REMOVAL_CONFLICT', { reason: Schema.String }),
  Schema.TaggedStruct('INVALID_PAYMENT_TERMS_CHANGE', { reason: Schema.String }),
]);
export type ChangeCustomerPaymentTermsOutcome = typeof ChangeCustomerPaymentTermsOutcomeSchema.Type;

const clearPreferencesAt = (
  preferences: readonly CustomerPaymentTermPreference[],
  effectiveAt: string,
  onlyTerm?: PaymentTermReference,
): readonly CustomerPaymentTermPreference[] =>
  preferences.flatMap((preference) => {
    if (onlyTerm !== undefined && !sameTerm(preference.paymentTermRef, onlyTerm)) {
      return [preference];
    }
    if (preference.effectiveTo !== undefined && preference.effectiveTo <= effectiveAt) {
      return [preference];
    }
    if (preference.effectiveFrom >= effectiveAt) {
      return [];
    }
    return [{ ...preference, effectiveTo: effectiveAt }];
  });

export const CustomerPaymentTermRemovalKindSchema = Schema.Literals(['CANCELLED', 'ENDED']);

const RemovalAppliedSchema = Schema.TaggedStruct('REMOVAL_APPLIED', {
  changed: Schema.Boolean,
  preferenceCleared: Schema.Boolean,
  removalKind: CustomerPaymentTermRemovalKindSchema,
  state: CustomerPaymentTermsStateSchema,
});
type RemovalApplied = typeof RemovalAppliedSchema.Type;

const applyRemoval = (
  state: CustomerPaymentTermsState,
  entitlementRef: CustomerPaymentTermEntitlementRef,
  effectiveAt: string,
): RemovalApplied | Exclude<ChangeCustomerPaymentTermsOutcome, { readonly _tag: 'CHANGED' }> => {
  const index = state.entitlements.findIndex(
    (entitlement) => entitlementRefKey(entitlement.entitlementRef) === entitlementRefKey(entitlementRef),
  );
  const entitlement = state.entitlements[index];
  if (entitlement === undefined) {
    return { _tag: 'ENTITLEMENT_NOT_FOUND', entitlementRef };
  }
  if (entitlement.status === 'CANCELLED') {
    if (entitlement.cancelledAt === effectiveAt) {
      return {
        _tag: 'REMOVAL_APPLIED',
        changed: false,
        preferenceCleared: false,
        removalKind: 'CANCELLED',
        state,
      };
    }
    return {
      _tag: 'REMOVAL_CONFLICT',
      reason: 'The entitlement has a different cancellation schedule',
    };
  }
  if (entitlement.effectiveTo !== undefined) {
    if (entitlement.effectiveTo === effectiveAt) {
      return {
        _tag: 'REMOVAL_APPLIED',
        changed: false,
        preferenceCleared: false,
        removalKind: 'ENDED',
        state,
      };
    }
    return { _tag: 'REMOVAL_CONFLICT', reason: 'The entitlement has a different effective end' };
  }

  const cancellation = effectiveAt <= entitlement.effectiveFrom;
  const replacement: CustomerPaymentTermEntitlement = cancellation
    ? { ...entitlement, cancelledAt: effectiveAt, status: 'CANCELLED' }
    : { ...entitlement, effectiveTo: effectiveAt };
  const preferences = clearPreferencesAt(state.preferences, effectiveAt, entitlement.paymentTermRef);
  const nextEntitlements = [...state.entitlements];
  nextEntitlements[index] = replacement;
  return {
    _tag: 'REMOVAL_APPLIED',
    changed: true,
    preferenceCleared:
      preferences.length !== state.preferences.length ||
      preferences.some(
        (value, preferenceIndex) => value.effectiveTo !== state.preferences[preferenceIndex]?.effectiveTo,
      ),
    removalKind: cancellation ? 'CANCELLED' : 'ENDED',
    state: { ...state, entitlements: nextEntitlements, preferences },
  };
};

const preferenceCoveredByEntitlement = (
  preference: CustomerPaymentTermPreference,
  entitlements: readonly CustomerPaymentTermEntitlement[],
): boolean =>
  entitlements.some(
    (entitlement) =>
      entitlement.status === 'ACTIVE' &&
      sameTerm(entitlement.paymentTermRef, preference.paymentTermRef) &&
      entitlement.effectiveFrom <= preference.effectiveFrom &&
      (entitlement.effectiveTo === undefined ||
        (preference.effectiveTo !== undefined && preference.effectiveTo <= entitlement.effectiveTo)),
  );

type ChangeRejected = Exclude<ChangeCustomerPaymentTermsOutcome, { readonly _tag: 'CHANGED' }>;
const ChangeAppliedSchema = Schema.TaggedStruct('CHANGE_APPLIED', {
  changed: Schema.Boolean,
  state: CustomerPaymentTermsStateSchema,
});
type ChangeApplied = typeof ChangeAppliedSchema.Type;
type ChangeStepOutcome = ChangeApplied | ChangeRejected;

const grantEntitlementInputProblem = (
  state: CustomerPaymentTermsState,
  change: typeof GrantCustomerPaymentTermEntitlementSchema.Type,
): ChangeRejected | undefined => {
  if (
    !validPeriod(change) ||
    change.entitlementRef.tenantId !== state.profileRef.tenantId ||
    change.paymentTermRef.tenantId !== state.profileRef.tenantId
  ) {
    return {
      _tag: 'INVALID_PAYMENT_TERMS_CHANGE',
      reason: 'Entitlement scope or effective period is invalid',
    };
  }
  return undefined;
};

const grantEntitlementDefinitionProblem = (
  change: typeof GrantCustomerPaymentTermEntitlementSchema.Type,
  definitions: ReadonlyMap<string, PaymentTermDefinitionSnapshot>,
): ChangeRejected | undefined => {
  const definition = definitions.get(refKey(change.paymentTermRef));
  if (definition === undefined) {
    return {
      _tag: 'PAYMENT_TERM_UNUSABLE',
      paymentTermRef: change.paymentTermRef,
      reason: 'MISSING_DEFINITION',
    };
  }
  if (!definition.compatibleWith.includes('customer-payment-terms.v1')) {
    return {
      _tag: 'PAYMENT_TERM_UNUSABLE',
      paymentTermRef: change.paymentTermRef,
      reason: 'INCOMPATIBLE_CONSUMER',
    };
  }
  if (!definitionIsCurrent(definition, change.effectiveFrom)) {
    return {
      _tag: 'PAYMENT_TERM_UNUSABLE',
      paymentTermRef: change.paymentTermRef,
      reason: 'NOT_CURRENT',
    };
  }
  if (definition.semanticRevisionId !== change.semanticRevisionId) {
    return {
      _tag: 'PAYMENT_TERM_UNUSABLE',
      paymentTermRef: change.paymentTermRef,
      reason: 'INCOMPATIBLE_REVISION',
    };
  }
  return undefined;
};

const grantEntitlementConflict = (
  state: CustomerPaymentTermsState,
  change: typeof GrantCustomerPaymentTermEntitlementSchema.Type,
): ChangeRejected | undefined => {
  if (
    state.entitlements.some(
      (entitlement) => entitlementRefKey(entitlement.entitlementRef) === entitlementRefKey(change.entitlementRef),
    )
  ) {
    return {
      _tag: 'INVALID_PAYMENT_TERMS_CHANGE',
      reason: 'The entitlement identity is already in use',
    };
  }
  if (
    state.entitlements.some(
      (entitlement) =>
        entitlement.status === 'ACTIVE' &&
        sameTerm(entitlement.paymentTermRef, change.paymentTermRef) &&
        effectivePeriodsOverlap(entitlement, change),
    )
  ) {
    return { _tag: 'ENTITLEMENT_OVERLAP', paymentTermRef: change.paymentTermRef };
  }
  return undefined;
};

const grantEntitlement = (
  state: CustomerPaymentTermsState,
  change: typeof GrantCustomerPaymentTermEntitlementSchema.Type,
  definitions: ReadonlyMap<string, PaymentTermDefinitionSnapshot>,
): ChangeStepOutcome => {
  const inputProblem = grantEntitlementInputProblem(state, change);
  if (inputProblem !== undefined) {
    return inputProblem;
  }
  const definitionProblem = grantEntitlementDefinitionProblem(change, definitions);
  if (definitionProblem !== undefined) {
    return definitionProblem;
  }
  const conflict = grantEntitlementConflict(state, change);
  if (conflict !== undefined) {
    return conflict;
  }
  const entitlement: CustomerPaymentTermEntitlement =
    change.effectiveTo === undefined
      ? {
          effectiveFrom: change.effectiveFrom,
          entitlementRef: change.entitlementRef,
          paymentTermRef: change.paymentTermRef,
          semanticRevisionId: change.semanticRevisionId,
          status: 'ACTIVE',
        }
      : {
          effectiveFrom: change.effectiveFrom,
          effectiveTo: change.effectiveTo,
          entitlementRef: change.entitlementRef,
          paymentTermRef: change.paymentTermRef,
          semanticRevisionId: change.semanticRevisionId,
          status: 'ACTIVE',
        };
  return {
    _tag: 'CHANGE_APPLIED',
    changed: true,
    state: { ...state, entitlements: [...state.entitlements, entitlement] },
  };
};

const setPreference = (
  state: CustomerPaymentTermsState,
  change: typeof SetCustomerPaymentTermPreferenceSchema.Type,
): ChangeStepOutcome => {
  if (!validPeriod(change)) {
    return {
      _tag: 'INVALID_PAYMENT_TERMS_CHANGE',
      reason: 'Preference effective period is invalid',
    };
  }
  const preference: CustomerPaymentTermPreference =
    change.effectiveTo === undefined
      ? { effectiveFrom: change.effectiveFrom, paymentTermRef: change.paymentTermRef }
      : {
          effectiveFrom: change.effectiveFrom,
          effectiveTo: change.effectiveTo,
          paymentTermRef: change.paymentTermRef,
        };
  if (!preferenceCoveredByEntitlement(preference, state.entitlements)) {
    return {
      _tag: 'PREFERENCE_CONFLICT',
      reason: 'Preference must be covered by one entitlement period',
    };
  }
  const unchanged = state.preferences.some(
    (existing) =>
      sameTerm(existing.paymentTermRef, preference.paymentTermRef) &&
      existing.effectiveFrom === preference.effectiveFrom &&
      existing.effectiveTo === preference.effectiveTo,
  );
  if (unchanged) {
    return { _tag: 'CHANGE_APPLIED', changed: false, state };
  }

  const preserved = clearPreferencesAt(state.preferences, change.effectiveFrom);
  if (preserved.some((existing) => effectivePeriodsOverlap(existing, preference))) {
    return {
      _tag: 'PREFERENCE_CONFLICT',
      reason: 'The requested preference conflicts with an incompatible scheduled preference',
    };
  }
  return {
    _tag: 'CHANGE_APPLIED',
    changed: true,
    state: { ...state, preferences: [...preserved, preference] },
  };
};

const clearPreference = (
  state: CustomerPaymentTermsState,
  change: typeof ClearCustomerPaymentTermPreferenceSchema.Type,
): ChangeApplied => {
  const preferences = clearPreferencesAt(state.preferences, change.effectiveAt);
  const changed =
    preferences.length !== state.preferences.length ||
    preferences.some((value, preferenceIndex) => value.effectiveTo !== state.preferences[preferenceIndex]?.effectiveTo);
  return { _tag: 'CHANGE_APPLIED', changed, state: { ...state, preferences } };
};

const endEntitlement = (
  state: CustomerPaymentTermsState,
  change: typeof EndCustomerPaymentTermEntitlementSchema.Type,
): ChangeStepOutcome => {
  const removal = applyRemoval(state, change.entitlementRef, change.effectiveAt);
  return Predicate.isTagged(removal, 'REMOVAL_APPLIED')
    ? {
        _tag: 'CHANGE_APPLIED',
        changed: removal.changed,
        state: removal.state,
      }
    : removal;
};

const applyChange = (
  state: CustomerPaymentTermsState,
  change: CustomerPaymentTermsChange,
  definitions: ReadonlyMap<string, PaymentTermDefinitionSnapshot>,
): ChangeStepOutcome =>
  Match.value(change).pipe(
    Match.tag('GRANT_ENTITLEMENT', (candidate) => grantEntitlement(state, candidate, definitions)),
    Match.tag('SET_PREFERENCE', (candidate) => setPreference(state, candidate)),
    Match.tag('CLEAR_PREFERENCE', (candidate) => clearPreference(state, candidate)),
    Match.tag('END_ENTITLEMENT', (candidate) => endEntitlement(state, candidate)),
    Match.exhaustive,
  );

export const changeCustomerPaymentTerms = (
  input: ChangeCustomerPaymentTermsInput,
): ChangeCustomerPaymentTermsOutcome => {
  if (input.expectedRevision !== input.state.revision) {
    return {
      _tag: 'REVISION_CONFLICT',
      currentRevision: input.state.revision,
      expectedRevision: input.expectedRevision,
    };
  }
  let state: CustomerPaymentTermsState = {
    ...input.state,
    entitlements: [...input.state.entitlements],
    preferences: [...input.state.preferences],
  };
  let changed = false;
  const definitions = new Map(
    input.catalogDefinitions.map((definition) => [refKey(definition.paymentTermRef), definition]),
  );

  for (const change of input.changes) {
    const applied = applyChange(state, change, definitions);
    if (!Predicate.isTagged(applied, 'CHANGE_APPLIED')) {
      return applied;
    }
    changed ||= applied.changed;
    ({ state } = applied);
  }
  return {
    _tag: 'CHANGED',
    changed,
    state: changed ? { ...state, revision: state.revision + 1 } : state,
  };
};

const RemoveCustomerPaymentTermInputSchema = Schema.Struct({
  effectiveAt: PaymentTermsTimestampSchema,
  entitlementRef: CustomerPaymentTermEntitlementSchema.fields.entitlementRef,
  expectedRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
  state: CustomerPaymentTermsStateSchema,
});
export type RemoveCustomerPaymentTermInput = typeof RemoveCustomerPaymentTermInputSchema.Type;

const RemoveCustomerPaymentTermOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('REMOVED', {
    changed: Schema.Boolean,
    preferenceCleared: Schema.Boolean,
    removalKind: CustomerPaymentTermRemovalKindSchema,
    state: CustomerPaymentTermsStateSchema,
  }),
  ChangeCustomerPaymentTermsOutcomeSchema,
]);
export type RemoveCustomerPaymentTermOutcome = typeof RemoveCustomerPaymentTermOutcomeSchema.Type;

export const removeCustomerPaymentTerm = (input: RemoveCustomerPaymentTermInput): RemoveCustomerPaymentTermOutcome => {
  if (input.expectedRevision !== input.state.revision) {
    return {
      _tag: 'REVISION_CONFLICT',
      currentRevision: input.state.revision,
      expectedRevision: input.expectedRevision,
    };
  }
  const removal = applyRemoval(input.state, input.entitlementRef, input.effectiveAt);
  if (!Predicate.isTagged(removal, 'REMOVAL_APPLIED')) {
    return removal;
  }
  return {
    _tag: 'REMOVED',
    changed: removal.changed,
    preferenceCleared: removal.preferenceCleared,
    removalKind: removal.removalKind,
    state: removal.changed ? { ...removal.state, revision: removal.state.revision + 1 } : removal.state,
  };
};

const ResolvedPaymentTermSchema = Schema.Struct({
  // Guest resolution has no customer-settings aggregate, represented explicitly as JSON null.
  customerPaymentTermsRevision: Schema.Union([
    Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
    Schema.Null,
  ]),
  definition: PaymentTermDefinitionSnapshotSchema,
  policyRevision: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  policySource: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  purchasingContextRevision: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  resolvedAt: PaymentTermsTimestampSchema,
  sourceEntitlementRef: Schema.optionalKey(CustomerPaymentTermEntitlementSchema.fields.entitlementRef),
  sourcePreferenceEffectiveFrom: Schema.optionalKey(PaymentTermsTimestampSchema),
});

export const PaymentTermsResolutionOutcomeSchema = Schema.Union([
  Schema.TaggedStruct('EXPLICIT_CHOICE', { ...ResolvedPaymentTermSchema.fields }),
  Schema.TaggedStruct('PREFERRED_ENTITLEMENT', { ...ResolvedPaymentTermSchema.fields }),
  Schema.TaggedStruct('POLICY_FALLBACK', { ...ResolvedPaymentTermSchema.fields }),
  Schema.TaggedStruct('EXPLICIT_CHOICE_INVALID', {
    paymentTermRef: PaymentTermReferenceSchema,
    reason: Schema.String,
  }),
  Schema.TaggedStruct('BROKEN_ENTITLEMENT', {
    entitlementRef: CustomerPaymentTermEntitlementSchema.fields.entitlementRef,
    paymentTermRef: PaymentTermReferenceSchema,
    reason: Schema.Literals(['INCOMPATIBLE_REVISION', 'MISSING_DEFINITION', 'NOT_CURRENT']),
  }),
  Schema.TaggedStruct('NO_USABLE_PAYMENT_TERM', { reason: Schema.String }),
  Schema.TaggedStruct('INCONSISTENT_CONFIGURATION', { reason: Schema.String }),
]);
export type PaymentTermsResolutionOutcome = typeof PaymentTermsResolutionOutcomeSchema.Type;

const paymentTermsPolicyIdentifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const paymentTermsPolicyChannelId = paymentTermsPolicyIdentifier.pipe(
  Schema.brand('CustomerCommercePaymentTermsPolicyChannelId'),
  Schema.decodeTo(Schema.String),
);
const paymentTermsPolicyMarketId = paymentTermsPolicyIdentifier.pipe(
  Schema.brand('CustomerCommercePaymentTermsPolicyMarketId'),
  Schema.decodeTo(Schema.String),
);
const paymentTermsPolicyStorefrontId = paymentTermsPolicyIdentifier.pipe(
  Schema.brand('CustomerCommercePaymentTermsPolicyStorefrontId'),
  Schema.decodeTo(Schema.String),
);
const paymentTermsPolicyLegalEntityId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('CustomerCommercePaymentTermsPolicyLegalEntityId'),
  Schema.decodeTo(Schema.String),
);
const paymentTermsPolicyTenantId = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('CustomerCommercePaymentTermsPolicyTenantId'),
  Schema.decodeTo(Schema.String),
);

const CustomerCommercePaymentTermsPolicyRuleSchema = Schema.Struct({
  audience: Schema.Literals(['BOTH', 'GUEST', 'PROFILE']),
  effectiveFrom: PaymentTermsTimestampSchema,
  effectiveTo: Schema.optionalKey(PaymentTermsTimestampSchema),
  eligiblePaymentTermRefs: Schema.Array(PaymentTermReferenceSchema).check(Schema.isMaxLength(200)),
  explicitlyPermittedPaymentTermRefs: Schema.Array(PaymentTermReferenceSchema).check(Schema.isMaxLength(200)),
  fallbackPaymentTermRefs: Schema.Array(PaymentTermReferenceSchema).check(Schema.isMaxLength(200)),
  policyRevision: paymentTermsPolicyIdentifier,
  scope: Schema.Struct({
    channelId: paymentTermsPolicyChannelId,
    marketId: paymentTermsPolicyMarketId,
    sellingLegalEntityId: paymentTermsPolicyLegalEntityId,
    storefrontId: paymentTermsPolicyStorefrontId,
    tenantId: paymentTermsPolicyTenantId,
  }),
});

export const CustomerCommercePaymentTermsPolicyConfigurationSchema = Schema.Struct({
  configurationRevision: paymentTermsPolicyIdentifier,
  policySource: paymentTermsPolicyIdentifier,
  rules: Schema.Array(CustomerCommercePaymentTermsPolicyRuleSchema).check(Schema.isMaxLength(500)),
});
export type CustomerCommercePaymentTermsPolicyConfiguration =
  typeof CustomerCommercePaymentTermsPolicyConfigurationSchema.Type;

export interface CustomerCommercePaymentTermsPolicyContext {
  readonly at: string;
  readonly audience: 'GUEST' | 'PROFILE';
  readonly purchasingContext: Readonly<{
    readonly channelId: string;
    readonly marketId: string;
    readonly sellingLegalEntityId: string;
    readonly storefrontId: string;
  }>;
  readonly tenantId: string;
  /** Storefront identity established by the gateway, never copied from the request payload. */
  readonly trustedStorefrontId: string;
}

export interface PaymentTermsPolicyDecision {
  readonly eligiblePaymentTermRefs: readonly PaymentTermReference[];
  readonly explicitlyPermittedPaymentTermRefs: readonly PaymentTermReference[];
  readonly fallbackPaymentTermRefs: readonly PaymentTermReference[];
  readonly policyRevision: string;
  readonly policySource: string;
}

export type PaymentTermsPolicyResolution =
  | PaymentTermsPolicyDecision
  | Extract<PaymentTermsResolutionOutcome, { readonly _tag: 'INCONSISTENT_CONFIGURATION' }>;

const uniquePaymentTermReferences = (references: readonly PaymentTermReference[]): readonly PaymentTermReference[] => [
  ...new Map(references.map((ref) => [refKey(ref), ref])).values(),
];

const policyConflict = (reason: string): PaymentTermsPolicyResolution => ({
  _tag: 'INCONSISTENT_CONFIGURATION',
  reason,
});

/**
 * Resolves the launch Payment Terms policy from owner-authored rules. The trusted Storefront selects
 * the rule; request Channel/Market/Storefront values are only claims verified against that rule.
 */
export const resolveCustomerCommercePaymentTermsPolicy = (
  configuration: CustomerCommercePaymentTermsPolicyConfiguration,
  context: CustomerCommercePaymentTermsPolicyContext,
): PaymentTermsPolicyResolution => {
  if (context.purchasingContext.storefrontId !== context.trustedStorefrontId) {
    return policyConflict('The purchasing context does not match the trusted Storefront');
  }
  const currentRules = configuration.rules.filter(
    (rule) =>
      rule.scope.tenantId === context.tenantId &&
      rule.scope.sellingLegalEntityId === context.purchasingContext.sellingLegalEntityId &&
      rule.scope.storefrontId === context.trustedStorefrontId &&
      (rule.audience === 'BOTH' || rule.audience === context.audience) &&
      isEffectiveAt(rule, context.at),
  );
  if (currentRules.length > 1) {
    return policyConflict('Several Current Payment Terms policy rules match the trusted scope');
  }
  const [rule] = currentRules;
  if (rule === undefined) {
    return {
      eligiblePaymentTermRefs: [],
      explicitlyPermittedPaymentTermRefs: [],
      fallbackPaymentTermRefs: [],
      policyRevision: configuration.configurationRevision,
      policySource: configuration.policySource,
    };
  }
  if (
    rule.scope.channelId !== context.purchasingContext.channelId ||
    rule.scope.marketId !== context.purchasingContext.marketId
  ) {
    return policyConflict(
      'The purchasing Channel or Commerce Market does not match the authoritative Storefront policy',
    );
  }
  const eligiblePaymentTermRefs = uniquePaymentTermReferences(rule.eligiblePaymentTermRefs);
  const eligibleKeys = new Set(eligiblePaymentTermRefs.map(refKey));
  const configuredRefs = [
    ...rule.eligiblePaymentTermRefs,
    ...rule.explicitlyPermittedPaymentTermRefs,
    ...rule.fallbackPaymentTermRefs,
  ];
  if (configuredRefs.some((ref) => ref.tenantId !== context.tenantId)) {
    return policyConflict('The Payment Terms policy contains a cross-Tenant reference');
  }
  if (
    [...rule.explicitlyPermittedPaymentTermRefs, ...rule.fallbackPaymentTermRefs].some(
      (ref) => !eligibleKeys.has(refKey(ref)),
    )
  ) {
    return policyConflict('Permitted choices and fallbacks must be included in policy eligibility');
  }
  return {
    eligiblePaymentTermRefs,
    explicitlyPermittedPaymentTermRefs: uniquePaymentTermReferences(rule.explicitlyPermittedPaymentTermRefs),
    fallbackPaymentTermRefs: uniquePaymentTermReferences(rule.fallbackPaymentTermRefs),
    policyRevision: rule.policyRevision,
    policySource: configuration.policySource,
  };
};

const PaymentTermsResolutionInputSchema = Schema.Struct({
  at: PaymentTermsTimestampSchema,
  definitions: Schema.Array(PaymentTermDefinitionSnapshotSchema),
  eligiblePaymentTermRefs: Schema.Array(PaymentTermReferenceSchema),
  explicitChoice: Schema.optionalKey(PaymentTermReferenceSchema),
  policyExplicitlyPermittedRefs: Schema.Array(PaymentTermReferenceSchema),
  policyFallbackRefs: Schema.Array(PaymentTermReferenceSchema),
  policyRevision: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  policySource: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  purchasingContextRevision: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  state: CustomerPaymentTermsStateSchema,
});
export type PaymentTermsResolutionInput = typeof PaymentTermsResolutionInputSchema.Type;

type InconsistentConfiguration = Extract<
  PaymentTermsResolutionOutcome,
  { readonly _tag: 'INCONSISTENT_CONFIGURATION' }
>;
type BrokenEntitlement = Extract<PaymentTermsResolutionOutcome, { readonly _tag: 'BROKEN_ENTITLEMENT' }>;

const findConfigurationProblem = (
  state: CustomerPaymentTermsState,
  activePreferences: readonly CustomerPaymentTermPreference[],
): InconsistentConfiguration | undefined => {
  const overlapping = state.entitlements.some(
    (left, leftIndex) =>
      left.status === 'ACTIVE' &&
      state.entitlements
        .slice(leftIndex + 1)
        .some(
          (right) =>
            right.status === 'ACTIVE' &&
            sameTerm(left.paymentTermRef, right.paymentTermRef) &&
            effectivePeriodsOverlap(left, right),
        ),
  );
  if (overlapping) {
    return {
      _tag: 'INCONSISTENT_CONFIGURATION',
      reason: 'Overlapping entitlement periods exist',
    };
  }
  return activePreferences.length > 1
    ? { _tag: 'INCONSISTENT_CONFIGURATION', reason: 'Several preferences are current' }
    : undefined;
};

const findBrokenEntitlement = (
  activeEntitlements: readonly CustomerPaymentTermEntitlement[],
  definitions: ReadonlyMap<string, PaymentTermDefinitionSnapshot>,
  at: string,
): BrokenEntitlement | undefined => {
  for (const entitlement of activeEntitlements) {
    const definition = definitions.get(refKey(entitlement.paymentTermRef));
    if (definition === undefined) {
      return {
        _tag: 'BROKEN_ENTITLEMENT',
        entitlementRef: entitlement.entitlementRef,
        paymentTermRef: entitlement.paymentTermRef,
        reason: 'MISSING_DEFINITION',
      };
    }
    if (definition.semanticRevisionId !== entitlement.semanticRevisionId) {
      return {
        _tag: 'BROKEN_ENTITLEMENT',
        entitlementRef: entitlement.entitlementRef,
        paymentTermRef: entitlement.paymentTermRef,
        reason: 'INCOMPATIBLE_REVISION',
      };
    }
    if (!definitionIsCurrent(definition, at)) {
      return {
        _tag: 'BROKEN_ENTITLEMENT',
        entitlementRef: entitlement.entitlementRef,
        paymentTermRef: entitlement.paymentTermRef,
        reason: 'NOT_CURRENT',
      };
    }
  }
  return undefined;
};

type PaymentTermsResolutionSelection = Readonly<{
  definition: PaymentTermDefinitionSnapshot;
  source?: PaymentTermsResolutionSource;
  tag: 'EXPLICIT_CHOICE' | 'POLICY_FALLBACK' | 'PREFERRED_ENTITLEMENT';
}>;
type PaymentTermsResolutionSource = Readonly<{
  entitlementRef?: CustomerPaymentTermEntitlementRef;
  preferenceEffectiveFrom?: string;
}>;

const makeResolvedPaymentTerm = (
  input: PaymentTermsResolutionInput,
  selection: PaymentTermsResolutionSelection,
): PaymentTermsResolutionOutcome => {
  const { source } = selection;
  const resolved = {
    _tag: selection.tag,
    customerPaymentTermsRevision: input.state.revision,
    definition: selection.definition,
    policyRevision: input.policyRevision,
    policySource: input.policySource,
    purchasingContextRevision: input.purchasingContextRevision,
    resolvedAt: input.at,
  };
  if (source?.entitlementRef === undefined) {
    return source?.preferenceEffectiveFrom === undefined
      ? resolved
      : { ...resolved, sourcePreferenceEffectiveFrom: source.preferenceEffectiveFrom };
  }
  return source.preferenceEffectiveFrom === undefined
    ? { ...resolved, sourceEntitlementRef: source.entitlementRef }
    : {
        ...resolved,
        sourceEntitlementRef: source.entitlementRef,
        sourcePreferenceEffectiveFrom: source.preferenceEffectiveFrom,
      };
};

const resolveExplicitPaymentTerm = (
  input: PaymentTermsResolutionInput,
  explicitChoice: PaymentTermReference,
  activeEntitlements: readonly CustomerPaymentTermEntitlement[],
  definitions: ReadonlyMap<string, PaymentTermDefinitionSnapshot>,
  eligible: ReadonlySet<string>,
  permitted: ReadonlySet<string>,
): PaymentTermsResolutionOutcome => {
  const key = refKey(explicitChoice);
  const definition = definitions.get(key);
  const matchingEntitlements = activeEntitlements.filter((entitlement) =>
    sameTerm(entitlement.paymentTermRef, explicitChoice),
  );
  const selectedEntitlementProblem = findBrokenEntitlement(matchingEntitlements, definitions, input.at);
  if (selectedEntitlementProblem !== undefined) {
    return selectedEntitlementProblem;
  }
  if (
    definition === undefined ||
    !definitionIsCurrent(definition, input.at) ||
    !eligible.has(key) ||
    (matchingEntitlements.length === 0 && !permitted.has(key))
  ) {
    return {
      _tag: 'EXPLICIT_CHOICE_INVALID',
      paymentTermRef: explicitChoice,
      reason: 'The explicit Payment Term is not currently entitled, policy-permitted, and usable',
    };
  }
  const [matchingEntitlement] = matchingEntitlements;
  return matchingEntitlement === undefined
    ? makeResolvedPaymentTerm(input, { definition, tag: 'EXPLICIT_CHOICE' })
    : makeResolvedPaymentTerm(input, {
        definition,
        source: { entitlementRef: matchingEntitlement.entitlementRef },
        tag: 'EXPLICIT_CHOICE',
      });
};

const resolvePreferredPaymentTerm = (
  input: PaymentTermsResolutionInput,
  activeEntitlements: readonly CustomerPaymentTermEntitlement[],
  activePreferences: readonly CustomerPaymentTermPreference[],
  definitions: ReadonlyMap<string, PaymentTermDefinitionSnapshot>,
  eligible: ReadonlySet<string>,
): PaymentTermsResolutionOutcome | undefined => {
  const [preference] = activePreferences;
  if (preference === undefined) {
    return undefined;
  }
  const entitlement = activeEntitlements.find((candidate) =>
    sameTerm(candidate.paymentTermRef, preference.paymentTermRef),
  );
  if (entitlement === undefined) {
    return {
      _tag: 'INCONSISTENT_CONFIGURATION',
      reason: 'The current preference is not currently entitled',
    };
  }
  const key = refKey(preference.paymentTermRef);
  const definition = definitions.get(key);
  if (definition !== undefined && definitionIsCurrent(definition, input.at) && eligible.has(key)) {
    return makeResolvedPaymentTerm(input, {
      definition,
      source: {
        entitlementRef: entitlement.entitlementRef,
        preferenceEffectiveFrom: preference.effectiveFrom,
      },
      tag: 'PREFERRED_ENTITLEMENT',
    });
  }
  return undefined;
};

const resolveFallbackPaymentTerm = (
  input: PaymentTermsResolutionInput,
  definitions: ReadonlyMap<string, PaymentTermDefinitionSnapshot>,
  eligible: ReadonlySet<string>,
): PaymentTermsResolutionOutcome => {
  const fallbacks = input.policyFallbackRefs.flatMap((reference) => {
    const key = refKey(reference);
    const definition = definitions.get(key);
    return definition !== undefined && definitionIsCurrent(definition, input.at) && eligible.has(key)
      ? [definition]
      : [];
  });
  if (fallbacks.length > 1) {
    return { _tag: 'INCONSISTENT_CONFIGURATION', reason: 'Several usable policy fallbacks exist' };
  }
  const [fallback] = fallbacks;
  return fallback === undefined
    ? {
        _tag: 'NO_USABLE_PAYMENT_TERM',
        reason: 'No usable Payment Term exists for the current purchase',
      }
    : makeResolvedPaymentTerm(input, { definition: fallback, tag: 'POLICY_FALLBACK' });
};

export const resolvePaymentTerms = (input: PaymentTermsResolutionInput): PaymentTermsResolutionOutcome => {
  const activeEntitlements = input.state.entitlements.filter(
    (entitlement) => entitlement.status === 'ACTIVE' && isEffectiveAt(entitlement, input.at),
  );
  const activePreferences = input.state.preferences.filter((preference) => isEffectiveAt(preference, input.at));
  const configurationProblem = findConfigurationProblem(input.state, activePreferences);
  if (configurationProblem !== undefined) {
    return configurationProblem;
  }

  const definitions = new Map(input.definitions.map((definition) => [refKey(definition.paymentTermRef), definition]));
  const eligible = new Set(input.eligiblePaymentTermRefs.map(refKey));
  const permitted = new Set(input.policyExplicitlyPermittedRefs.map(refKey));

  if (input.explicitChoice !== undefined) {
    return resolveExplicitPaymentTerm(
      input,
      input.explicitChoice,
      activeEntitlements,
      definitions,
      eligible,
      permitted,
    );
  }

  const brokenEntitlement = findBrokenEntitlement(activeEntitlements, definitions, input.at);
  if (brokenEntitlement !== undefined) {
    return brokenEntitlement;
  }

  const preferred = resolvePreferredPaymentTerm(input, activeEntitlements, activePreferences, definitions, eligible);
  if (preferred !== undefined) {
    return preferred;
  }

  return resolveFallbackPaymentTerm(input, definitions, eligible);
};

export interface GuestPaymentTermsResolutionInput {
  readonly at: string;
  readonly definitions: readonly PaymentTermDefinitionSnapshot[];
  readonly eligiblePaymentTermRefs: readonly PaymentTermReference[];
  readonly explicitChoice?: PaymentTermReference;
  readonly policyExplicitlyPermittedRefs: readonly PaymentTermReference[];
  readonly policyFallbackRefs: readonly PaymentTermReference[];
  readonly policyRevision: string;
  readonly policySource: string;
  readonly purchasingContextRevision: string;
}

const guestResolved = (
  input: GuestPaymentTermsResolutionInput,
  tag: 'EXPLICIT_CHOICE' | 'POLICY_FALLBACK',
  definition: PaymentTermDefinitionSnapshot,
): PaymentTermsResolutionOutcome => ({
  _tag: tag,
  customerPaymentTermsRevision: null,
  definition,
  policyRevision: input.policyRevision,
  policySource: input.policySource,
  purchasingContextRevision: input.purchasingContextRevision,
  resolvedAt: input.at,
});

const resolveGuestExplicitChoice = (
  input: GuestPaymentTermsResolutionInput,
  definitions: ReadonlyMap<string, PaymentTermDefinitionSnapshot>,
  eligible: ReadonlySet<string>,
  permitted: ReadonlySet<string>,
): PaymentTermsResolutionOutcome | undefined => {
  if (input.explicitChoice === undefined) {
    return undefined;
  }
  const explicitKey = refKey(input.explicitChoice);
  const definition = definitions.get(explicitKey);
  if (
    definition === undefined ||
    !definitionIsCurrent(definition, input.at) ||
    !eligible.has(explicitKey) ||
    !permitted.has(explicitKey)
  ) {
    return {
      _tag: 'EXPLICIT_CHOICE_INVALID',
      paymentTermRef: input.explicitChoice,
      reason: 'The explicit Guest Payment Term is not currently policy-permitted and usable',
    };
  }
  return guestResolved(input, 'EXPLICIT_CHOICE', definition);
};

const resolveGuestFallback = (
  input: GuestPaymentTermsResolutionInput,
  definitions: ReadonlyMap<string, PaymentTermDefinitionSnapshot>,
  eligible: ReadonlySet<string>,
): PaymentTermsResolutionOutcome => {
  const uniqueFallbacks = new Map(input.policyFallbackRefs.map((reference) => [refKey(reference), reference]));
  const usableFallbacks: PaymentTermDefinitionSnapshot[] = [];
  for (const [key, reference] of uniqueFallbacks) {
    const definition = definitions.get(key);
    if (definition === undefined) {
      return {
        _tag: 'INCONSISTENT_CONFIGURATION',
        reason: `Guest policy fallback ${reference.resourceId} has no catalog definition`,
      };
    }
    if (definitionIsCurrent(definition, input.at) && eligible.has(key)) {
      usableFallbacks.push(definition);
    }
  }
  if (usableFallbacks.length > 1) {
    return {
      _tag: 'INCONSISTENT_CONFIGURATION',
      reason: 'Several usable Guest policy fallbacks exist',
    };
  }
  const [fallback] = usableFallbacks;
  return fallback === undefined
    ? {
        _tag: 'NO_USABLE_PAYMENT_TERM',
        reason: 'No usable Guest Payment Term exists for the current purchase',
      }
    : guestResolved(input, 'POLICY_FALLBACK', fallback);
};

/** Guest resolution is policy-only: it never consults a customer profile, entitlement, or preference. */
export const resolveGuestPaymentTerms = (input: GuestPaymentTermsResolutionInput): PaymentTermsResolutionOutcome => {
  const definitions = new Map(input.definitions.map((definition) => [refKey(definition.paymentTermRef), definition]));
  const eligible = new Set(input.eligiblePaymentTermRefs.map(refKey));
  const permitted = new Set(input.policyExplicitlyPermittedRefs.map(refKey));
  const explicitChoice = resolveGuestExplicitChoice(input, definitions, eligible, permitted);
  if (explicitChoice !== undefined) {
    return explicitChoice;
  }
  return resolveGuestFallback(input, definitions, eligible);
};
