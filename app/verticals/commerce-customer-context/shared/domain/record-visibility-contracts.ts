import { DateTime, Option, Schema, SchemaGetter } from 'effect';
import { CounterpartyPurchasingProfileRefSchema } from '../resources/counterparty-purchasing-profile.ts';
import { RetailCustomerProfileRefSchema } from '../resources/retail-customer-profile.ts';
import { CounterpartyRefSchema } from './access-contract.ts';

const NonEmptyTextSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const ActionKeySchema = NonEmptyTextSchema.pipe(
  Schema.brand('CustomerRecordVisibilityActionKey'),
  Schema.decodeTo(Schema.String),
);
const DataAccessEvidencePolicyKeySchema = NonEmptyTextSchema.pipe(
  Schema.brand('CustomerRecordVisibilityDataAccessEvidencePolicyKey'),
  Schema.decodeTo(Schema.String),
);
const ModuleIdSchema = NonEmptyTextSchema.pipe(
  Schema.brand('CustomerRecordVisibilityModuleId'),
  Schema.decodeTo(Schema.String),
);
const ResourceIdSchema = NonEmptyTextSchema.pipe(
  Schema.brand('CustomerRecordVisibilityResourceId'),
  Schema.decodeTo(Schema.String),
);
const historyCanonicalInstant = Schema.makeFilter((value: string) => {
  const parsed = DateTime.make(value);
  if (Option.isNone(parsed) || DateTime.formatIso(parsed.value) !== value) {
    return 'timestamp must be one canonical UTC instant with millisecond precision';
  }
  // oxlint-disable-next-line unicorn/no-useless-undefined -- Schema filter success is represented explicitly as undefined.
  return undefined;
});
const HistoryInstantSchema = Schema.String.check(historyCanonicalInstant).pipe(
  Schema.decodeTo(Schema.toType(Schema.DateTimeUtc), {
    decode: SchemaGetter.transform(DateTime.makeUnsafe),
    encode: SchemaGetter.transform(DateTime.formatIso),
  }),
);
export const HistoryInstantJsonSchema = Schema.toEncoded(HistoryInstantSchema);
export type HistoryInstant = typeof HistoryInstantJsonSchema.Type;
const TenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('CustomerRecordVisibilityTenantId'),
  Schema.decodeTo(Schema.String),
);

export const HistoricalRecordRefSchema = Schema.Struct({
  moduleId: ModuleIdSchema,
  resourceId: ResourceIdSchema,
  resourceType: NonEmptyTextSchema,
  tenantId: TenantIdSchema,
});
export type HistoricalRecordRef = typeof HistoricalRecordRefSchema.Type;

const RetailHistorySubjectSchema = Schema.Struct({
  kind: Schema.Literal('RETAIL_PROFILE'),
  profileRef: RetailCustomerProfileRefSchema,
});
type RetailHistorySubject = typeof RetailHistorySubjectSchema.Type;

const CounterpartyHistorySubjectSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  kind: Schema.Literal('COUNTERPARTY'),
  profileRef: CounterpartyPurchasingProfileRefSchema,
});
type CounterpartyHistorySubject = typeof CounterpartyHistorySubjectSchema.Type;

export const CustomerHistorySubjectSchema = Schema.Union([
  RetailHistorySubjectSchema,
  CounterpartyHistorySubjectSchema,
]);
export type CustomerHistorySubject = typeof CustomerHistorySubjectSchema.Type;

export const CustomerFacingFieldSetSchema = Schema.Struct({
  name: NonEmptyTextSchema,
  version: NonEmptyTextSchema,
});
export type CustomerFacingFieldSet = typeof CustomerFacingFieldSetSchema.Type;

const CustomerRecordVisibilityStateSchema = Schema.Literals([
  'CUSTOMER_VISIBLE',
  'CUSTOMER_HIDDEN',
  'CUSTOMER_RESTRICTED',
]);

const CustomerRecordVisibilityFactSchema = Schema.Struct({
  decidedAt: HistoryInstantJsonSchema,
  effectiveFrom: HistoryInstantJsonSchema,
  effectiveTo: Schema.optionalKey(HistoryInstantJsonSchema),
  evidenceRef: HistoricalRecordRefSchema,
  fieldSet: CustomerFacingFieldSetSchema,
  freshness: Schema.Literals(['CURRENT', 'STALE']),
  ownerModuleId: ModuleIdSchema,
  policyRevision: NonEmptyTextSchema,
  reasonCode: NonEmptyTextSchema,
  recordRef: HistoricalRecordRefSchema,
  restrictionDecision: Schema.optionalKey(Schema.Literals(['ALLOWED', 'DENIED', 'INDETERMINATE'])),
  sourceRevision: NonEmptyTextSchema,
  state: CustomerRecordVisibilityStateSchema,
  subject: CustomerHistorySubjectSchema,
});
export type CustomerRecordVisibilityFact = typeof CustomerRecordVisibilityFactSchema.Type;

export const CustomerRecordVisibilityGrantSchema = Schema.Struct({
  evidenceRef: HistoricalRecordRefSchema,
  fieldSet: CustomerFacingFieldSetSchema,
  outcome: Schema.Literal('VISIBLE'),
  ownerModuleId: ModuleIdSchema,
  policyRevision: NonEmptyTextSchema,
  reasonCode: NonEmptyTextSchema,
  recordRef: HistoricalRecordRefSchema,
  sourceRevision: NonEmptyTextSchema,
});

export const CustomerRecordVisibilityDecisionSchema = Schema.Union([
  CustomerRecordVisibilityGrantSchema,
  Schema.Struct({
    outcome: Schema.Literal('DENIED'),
    reason: Schema.Literals([
      'CUSTOMER_HIDDEN',
      'FIELD_SET_NOT_ALLOWED',
      'RESTRICTED_FIELD_SET_REQUIRED',
      'SUBJECT_MISMATCH',
      'VISIBILITY_MISSING',
      'VISIBILITY_NOT_EFFECTIVE',
    ]),
  }),
  Schema.Struct({
    outcome: Schema.Literal('UNAVAILABLE'),
    reason: Schema.Literals([
      'RESTRICTED_POLICY_INDETERMINATE',
      'VISIBILITY_CONTRACT_INVALID',
      'VISIBILITY_INDETERMINATE',
      'VISIBILITY_STALE',
    ]),
  }),
]);
export type CustomerRecordVisibilityDecision = typeof CustomerRecordVisibilityDecisionSchema.Type;

/**
 * Owner-published contract for admitting one record type to customer history/archive composition.
 * An absent entry is a closed default: the record type cannot be listed, detailed, or exported.
 */
export const CustomerRecordTypeOnboardingSchema = Schema.Struct({
  // A record owner must name at least one current policy before the record type can
  // participate in a customer-facing projection.  An empty list would turn the
  // onboarding document into an accidental policy bypass.
  additionalBusinessPolicies: Schema.Array(NonEmptyTextSchema).check(Schema.isMinLength(1)),
  callerPermissions: Schema.Array(NonEmptyTextSchema).check(Schema.isMinLength(1)),
  canonicalOwnerModuleId: ModuleIdSchema,
  canonicalResourceType: NonEmptyTextSchema,
  customerContextRelationship: Schema.Literals([
    'EXACT_RETAIL_PROFILE',
    'EXACT_COUNTERPARTY',
    'RETAIL_OR_COUNTERPARTY',
  ]),
  defaultVisibilityState: Schema.Literals(['CUSTOMER_HIDDEN', 'CUSTOMER_RESTRICTED']),
  exportPolicy: Schema.Union([
    Schema.Struct({ outcome: Schema.Literal('NOT_SUPPORTED') }),
    Schema.Struct({
      dataAccessEvidencePolicyKey: DataAccessEvidencePolicyKeySchema,
      fieldSet: CustomerFacingFieldSetSchema,
      outcome: Schema.Literal('GOVERNED_AUTHORITATIVE_CURRENT'),
    }),
  ]),
  fieldAllowlist: Schema.Struct({
    detail: Schema.Array(NonEmptyTextSchema).check(Schema.isMinLength(1)),
    download: Schema.Array(NonEmptyTextSchema),
    list: Schema.Array(NonEmptyTextSchema).check(Schema.isMinLength(1)),
  }),
  fieldContracts: Schema.Struct({
    detail: CustomerFacingFieldSetSchema,
    download: Schema.Union([CustomerFacingFieldSetSchema, Schema.Null]),
    list: CustomerFacingFieldSetSchema,
  }),
  freshnessPolicy: Schema.Struct({
    detail: Schema.Literal('AUTHORITATIVE_CURRENT'),
    download: Schema.Literal('AUTHORITATIVE_CURRENT'),
    listMaxAgeMilliseconds: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  }),
  migrationAndReconciliationPolicy: NonEmptyTextSchema,
  partialFailurePolicy: Schema.Literal('OMIT_PROTECTED_CONTENT_AND_REPORT_TYPED_DEGRADATION'),
  retentionVisibilityRelationship: Schema.Literal('INDEPENDENT'),
  transitionContract: Schema.Struct({
    actionKey: ActionKeySchema,
    eventTopic: NonEmptyTextSchema,
    ownerModuleId: ModuleIdSchema,
  }),
}).check(
  Schema.makeFilter((contract) => {
    const issues: Schema.FilterIssue[] = [];
    if (contract.transitionContract.ownerModuleId !== contract.canonicalOwnerModuleId) {
      issues.push({
        issue: 'visibility transitions must be owned by the canonical record owner',
        path: ['transitionContract', 'ownerModuleId'],
      });
    }
    if (contract.exportPolicy.outcome === 'NOT_SUPPORTED' && contract.fieldContracts.download !== null) {
      issues.push({
        issue: 'a record type without export support cannot publish a download field contract',
        path: ['fieldContracts', 'download'],
      });
    }
    if (contract.exportPolicy.outcome === 'NOT_SUPPORTED' && contract.fieldAllowlist.download.length > 0) {
      issues.push({
        issue: 'a record type without export support cannot publish download fields',
        path: ['fieldAllowlist', 'download'],
      });
    }
    if (
      contract.exportPolicy.outcome === 'GOVERNED_AUTHORITATIVE_CURRENT' &&
      (contract.fieldContracts.download === null ||
        contract.fieldContracts.download.name !== contract.exportPolicy.fieldSet.name ||
        contract.fieldContracts.download.version !== contract.exportPolicy.fieldSet.version)
    ) {
      issues.push({
        issue: 'a governed export must use the exact declared download field contract',
        path: ['exportPolicy', 'fieldSet'],
      });
    }
    return issues;
  }),
);
export type CustomerRecordTypeOnboarding = typeof CustomerRecordTypeOnboardingSchema.Type;

// oxlint-disable-next-line eslint/no-unused-vars -- Reserved private schema retained as part of the visibility contract structure.
const CustomerRecordVisibilityTransitionInputSchema = Schema.Struct({
  effectiveAt: HistoryInstantJsonSchema,
  expectedSourceRevision: NonEmptyTextSchema,
  fieldSet: CustomerFacingFieldSetSchema,
  reasonCode: NonEmptyTextSchema,
  recordRef: HistoricalRecordRefSchema,
  requestedState: CustomerRecordVisibilityStateSchema,
  subject: CustomerHistorySubjectSchema,
});

// oxlint-disable-next-line eslint/no-unused-vars -- Reserved private schema retained as part of the visibility contract structure.
const CustomerRecordVisibilityTransitionResultSchema = Schema.Union([
  Schema.Struct({
    fact: CustomerRecordVisibilityFactSchema,
    outcome: Schema.Literal('CHANGED'),
  }),
  Schema.Struct({
    fact: CustomerRecordVisibilityFactSchema,
    outcome: Schema.Literal('UNCHANGED_EQUIVALENT'),
  }),
]);

/** Schema-only owner event payload. The owner Action/Event identity remains owner-local. */
// oxlint-disable-next-line eslint/no-unused-vars -- Reserved private schema retained as part of the visibility contract structure.
const CustomerRecordVisibilityChangedEventSchema = Schema.Struct({
  changedAt: HistoryInstantJsonSchema,
  current: CustomerRecordVisibilityFactSchema,
  previousSourceRevision: NonEmptyTextSchema,
  reasonCode: NonEmptyTextSchema,
});

interface ResourceIdentity {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly tenantId: string;
}

const sameResourceIdentity = (left: ResourceIdentity, right: ResourceIdentity): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceType === right.resourceType &&
  left.resourceId === right.resourceId &&
  left.tenantId === right.tenantId;

const sameRetailProfileRef = (left: RetailHistorySubject, right: RetailHistorySubject): boolean =>
  sameResourceIdentity(left.profileRef, right.profileRef);

const sameCounterpartyProfileRef = (left: CounterpartyHistorySubject, right: CounterpartyHistorySubject): boolean =>
  sameResourceIdentity(left.profileRef, right.profileRef) &&
  sameResourceIdentity(left.counterpartyRef, right.counterpartyRef);

const sameProfileRef = (left: CustomerHistorySubject, right: CustomerHistorySubject): boolean => {
  if (left.kind === 'RETAIL_PROFILE') {
    return right.kind === 'RETAIL_PROFILE' && sameRetailProfileRef(left, right);
  }
  return right.kind === 'COUNTERPARTY' && sameCounterpartyProfileRef(left, right);
};

const sameFieldSet = (left: CustomerFacingFieldSet, right: CustomerFacingFieldSet): boolean =>
  left.name === right.name && left.version === right.version;

const sameRecordRef = (left: HistoricalRecordRef, right: HistoricalRecordRef): boolean =>
  sameResourceIdentity(left, right);

const fieldSetDeniedReason = (
  fact: CustomerRecordVisibilityFact,
): 'FIELD_SET_NOT_ALLOWED' | 'RESTRICTED_FIELD_SET_REQUIRED' =>
  fact.state === 'CUSTOMER_RESTRICTED' ? 'RESTRICTED_FIELD_SET_REQUIRED' : 'FIELD_SET_NOT_ALLOWED';

const restrictedStateDecision = (fact: CustomerRecordVisibilityFact): CustomerRecordVisibilityDecision | null => {
  if (fact.state !== 'CUSTOMER_RESTRICTED') {
    return null;
  }
  if (fact.restrictionDecision === 'INDETERMINATE') {
    return { outcome: 'UNAVAILABLE', reason: 'RESTRICTED_POLICY_INDETERMINATE' };
  }
  if (fact.restrictionDecision === 'ALLOWED') {
    return null;
  }
  return { outcome: 'DENIED', reason: 'RESTRICTED_FIELD_SET_REQUIRED' };
};

interface CustomerRecordVisibilityEvaluationInput {
  readonly fact: CustomerRecordVisibilityFact | 'INDETERMINATE' | null;
  readonly now: string;
  readonly recordRef: HistoricalRecordRef;
  readonly requestedFieldSet: CustomerFacingFieldSet;
  readonly subject: CustomerHistorySubject;
}

type ResolvedCustomerRecordVisibilityEvaluationInput = Omit<CustomerRecordVisibilityEvaluationInput, 'fact'> & {
  readonly fact: CustomerRecordVisibilityFact;
};

type CustomerRecordVisibilityRuleEvaluator = (
  input: ResolvedCustomerRecordVisibilityEvaluationInput,
) => CustomerRecordVisibilityDecision | null;

const evaluateSubjectTenantRule = (
  input: CustomerRecordVisibilityEvaluationInput,
): CustomerRecordVisibilityDecision | null => {
  if (
    input.recordRef.tenantId !== input.subject.profileRef.tenantId ||
    (input.subject.kind === 'COUNTERPARTY' && input.subject.counterpartyRef.tenantId !== input.recordRef.tenantId)
  ) {
    return { outcome: 'DENIED', reason: 'SUBJECT_MISMATCH' };
  }
  return null;
};

const evaluateVisibilityContractRule: CustomerRecordVisibilityRuleEvaluator = (input) => {
  if (
    !sameRecordRef(input.fact.recordRef, input.recordRef) ||
    input.fact.ownerModuleId !== input.fact.recordRef.moduleId ||
    input.fact.evidenceRef.tenantId !== input.fact.recordRef.tenantId ||
    input.fact.evidenceRef.moduleId !== input.fact.ownerModuleId
  ) {
    return { outcome: 'UNAVAILABLE', reason: 'VISIBILITY_CONTRACT_INVALID' };
  }
  return null;
};

const evaluateVisibilityFreshnessRule: CustomerRecordVisibilityRuleEvaluator = (input) => {
  if (input.fact.freshness === 'STALE' || input.fact.decidedAt > input.now) {
    return { outcome: 'UNAVAILABLE', reason: 'VISIBILITY_STALE' };
  }
  return null;
};

const evaluateVisibilitySubjectRule: CustomerRecordVisibilityRuleEvaluator = (input) => {
  if (!sameProfileRef(input.fact.subject, input.subject)) {
    return { outcome: 'DENIED', reason: 'SUBJECT_MISMATCH' };
  }
  return null;
};

const evaluateVisibilityEffectiveRule: CustomerRecordVisibilityRuleEvaluator = (input) => {
  if (
    input.now < input.fact.effectiveFrom ||
    (input.fact.effectiveTo !== undefined && input.now >= input.fact.effectiveTo)
  ) {
    return { outcome: 'DENIED', reason: 'VISIBILITY_NOT_EFFECTIVE' };
  }
  return null;
};

const evaluateVisibilityStateRule: CustomerRecordVisibilityRuleEvaluator = ({ fact }) => {
  if (fact.state === 'CUSTOMER_HIDDEN') {
    return { outcome: 'DENIED', reason: 'CUSTOMER_HIDDEN' };
  }
  return restrictedStateDecision(fact);
};

const evaluateVisibilityFieldSetRule: CustomerRecordVisibilityRuleEvaluator = (input) => {
  if (!sameFieldSet(input.fact.fieldSet, input.requestedFieldSet)) {
    return {
      outcome: 'DENIED',
      reason: fieldSetDeniedReason(input.fact),
    };
  }
  return null;
};

const visibilityRuleEvaluators = [
  evaluateVisibilityContractRule,
  evaluateVisibilityFreshnessRule,
  evaluateVisibilitySubjectRule,
  evaluateVisibilityEffectiveRule,
  evaluateVisibilityStateRule,
  evaluateVisibilityFieldSetRule,
] as const satisfies readonly CustomerRecordVisibilityRuleEvaluator[];

const evaluateResolvedCustomerRecordVisibility = (
  input: ResolvedCustomerRecordVisibilityEvaluationInput,
): CustomerRecordVisibilityDecision => {
  for (const evaluateRule of visibilityRuleEvaluators) {
    const decision = evaluateRule(input);
    if (decision !== null) {
      return decision;
    }
  }
  return {
    evidenceRef: input.fact.evidenceRef,
    fieldSet: input.fact.fieldSet,
    outcome: 'VISIBLE',
    ownerModuleId: input.fact.ownerModuleId,
    policyRevision: input.fact.policyRevision,
    reasonCode: input.fact.reasonCode,
    recordRef: input.fact.recordRef,
    sourceRevision: input.fact.sourceRevision,
  };
};

export const evaluateCustomerRecordVisibility = (
  input: CustomerRecordVisibilityEvaluationInput,
): CustomerRecordVisibilityDecision => {
  const subjectTenantDecision = evaluateSubjectTenantRule(input);
  if (subjectTenantDecision !== null) {
    return subjectTenantDecision;
  }
  if (input.fact === 'INDETERMINATE') {
    return { outcome: 'UNAVAILABLE', reason: 'VISIBILITY_INDETERMINATE' };
  }
  if (input.fact === null) {
    return { outcome: 'DENIED', reason: 'VISIBILITY_MISSING' };
  }
  return evaluateResolvedCustomerRecordVisibility({ ...input, fact: input.fact });
};
