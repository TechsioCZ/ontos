import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';
import type { OwnerVerifiableSetCompletenessEvidenceEncoded } from '@app/shared-contracts';
import { Match, Result, Schema } from 'effect';
import { CounterpartyPurchasingProfileRefSchema } from '../resources/counterparty-purchasing-profile.ts';
import { CommerceQuantityRuleRefSchema } from '../resources/commerce-quantity-rule.ts';
import { RetailCustomerProfileRefSchema } from '../resources/retail-customer-profile.ts';
import {
  CommerceQuantityPolicyScopeSchema,
  CommerceQuantityRuleRevisionSchema,
  CommerceQuantityRuleValueSchema,
  CustomerCommercePolicyActionInvocationIdSchema,
  CustomerCommercePolicyActorPrincipalIdSchema,
  CustomerCommercePolicyChannelIdSchema,
  CustomerCommercePolicyCommerceMarketIdSchema,
  CustomerCommercePolicyIdempotencyKeySchema,
  CustomerCommercePolicyInstantSchema,
  CustomerCommercePolicyRevisionIdSchema,
  CustomerCommercePolicySellingLegalEntityIdSchema,
  CustomerCommercePolicyTenantIdSchema,
  MarketBootstrapPolicyRevisionSchema,
  MarketBootstrapPolicyScopeSchema,
  MarketBootstrapValueSchema,
  OrdinaryCustomerCommercePolicyScopeSchema,
  PaymentTermPolicyRevisionSchema,
  PaymentTermValueSchema,
  PurchaseCurrencyPolicyRevisionSchema,
  PurchaseCurrencyValueSchema,
} from './customer-commerce-policy.ts';
import type {
  CommerceQuantityRuleRevision,
  CustomerCommercePolicyFieldId,
  CustomerCommercePolicyInstant,
  CustomerCommercePolicyRevision,
  MarketBootstrapPolicyRevision,
  PaymentTermPolicyRevision,
  PurchaseCurrencyPolicyRevision,
} from './customer-commerce-policy.ts';

const boundedReason = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const nonNegativeGeneration = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const policyLifecycleSchema = Schema.Literals(['SCHEDULED', 'ACTIVE', 'RETIRED']);
const assignmentIdSchema = Schema.toEncoded(
  Schema.String.check(Schema.isUUID()).pipe(Schema.brand('CommerceQuantityAssignmentId')),
);
const jsonString = Schema.fromJsonString(Schema.Unknown);
const invalidHalfOpenPeriodIssue = 'effectiveTo must be later than effectiveFrom';
const encodeJson = <Value>(value: Value): string => Result.getOrThrow(Schema.encodeResult(jsonString)(value));

export const CustomerCommercePolicyTrustedActionContextSchema = Schema.Struct({
  actionInvocationId: CustomerCommercePolicyActionInvocationIdSchema,
  actorPrincipalId: CustomerCommercePolicyActorPrincipalIdSchema,
  sellingLegalEntityId: CustomerCommercePolicySellingLegalEntityIdSchema,
  tenantId: CustomerCommercePolicyTenantIdSchema,
});
export type CustomerCommercePolicyTrustedActionContext = typeof CustomerCommercePolicyTrustedActionContextSchema.Type;

const trustedCommandFields = {
  actionInvocationId: CustomerCommercePolicyActionInvocationIdSchema,
  actorPrincipalId: CustomerCommercePolicyActorPrincipalIdSchema,
  observedAt: CustomerCommercePolicyInstantSchema,
  sellingLegalEntityId: CustomerCommercePolicySellingLegalEntityIdSchema,
  tenantId: CustomerCommercePolicyTenantIdSchema,
} as const;

const makeRevisionPayloadSchema = <
  const Field extends CustomerCommercePolicyFieldId,
  Scope extends Schema.Top,
  Value extends Schema.Top,
>({
  field,
  scope,
  value,
}: {
  readonly field: Field;
  readonly scope: Scope;
  readonly value: Value;
}) =>
  Schema.Struct({
    effectiveFrom: CustomerCommercePolicyInstantSchema,
    effectiveTo: Schema.toEncoded(Schema.OptionFromNullOr(CustomerCommercePolicyInstantSchema)),
    field: Schema.Literal(field),
    idempotencyKey: CustomerCommercePolicyIdempotencyKeySchema,
    lifecycle: policyLifecycleSchema,
    reason: boundedReason,
    revisionId: CustomerCommercePolicyRevisionIdSchema,
    scope,
    value,
  });

const halfOpenPayloadPeriod = Schema.makeFilter(
  (revision: { readonly effectiveFrom: string; readonly effectiveTo: null | string }) =>
    revision.effectiveTo === null || revision.effectiveTo > revision.effectiveFrom
      ? undefined
      : [{ issue: invalidHalfOpenPeriodIssue, path: ['effectiveTo'] }],
);

const MarketBootstrapPolicyRevisionPayloadSchema = makeRevisionPayloadSchema({
  field: 'MARKET_BOOTSTRAP',
  scope: MarketBootstrapPolicyScopeSchema,
  value: MarketBootstrapValueSchema,
}).check(halfOpenPayloadPeriod);
const PurchaseCurrencyPolicyRevisionPayloadSchema = makeRevisionPayloadSchema({
  field: 'PURCHASE_CURRENCY',
  scope: OrdinaryCustomerCommercePolicyScopeSchema,
  value: PurchaseCurrencyValueSchema,
}).check(halfOpenPayloadPeriod);
const PaymentTermPolicyRevisionPayloadSchema = makeRevisionPayloadSchema({
  field: 'PAYMENT_TERM',
  scope: OrdinaryCustomerCommercePolicyScopeSchema,
  value: PaymentTermValueSchema,
}).check(halfOpenPayloadPeriod);
const CommerceQuantityRuleRevisionPayloadSchema = makeRevisionPayloadSchema({
  field: 'COMMERCE_QUANTITY_RULE',
  scope: CommerceQuantityPolicyScopeSchema,
  value: CommerceQuantityRuleValueSchema,
}).check(halfOpenPayloadPeriod);

const makeAdministrationPayloadSchema = <Revision extends Schema.Top>(revision: Revision) =>
  Schema.Union([
    Schema.TaggedStruct('CREATE_REVISION', {
      expectedGeneration: nonNegativeGeneration,
      revision,
    }),
    Schema.TaggedStruct('ACTIVATE_REVISION', {
      effectiveAt: CustomerCommercePolicyInstantSchema,
      expectedGeneration: nonNegativeGeneration,
      idempotencyKey: CustomerCommercePolicyIdempotencyKeySchema,
      reason: boundedReason,
      revisionId: CustomerCommercePolicyRevisionIdSchema,
    }),
    Schema.TaggedStruct('RETIRE_REVISION', {
      effectiveAt: CustomerCommercePolicyInstantSchema,
      expectedGeneration: nonNegativeGeneration,
      idempotencyKey: CustomerCommercePolicyIdempotencyKeySchema,
      reason: boundedReason,
      revisionId: CustomerCommercePolicyRevisionIdSchema,
    }),
    Schema.TaggedStruct('REPLACE_REVISION', {
      expectedGeneration: nonNegativeGeneration,
      replacedRevisionId: CustomerCommercePolicyRevisionIdSchema,
      replacement: revision,
    }),
  ]);

const makeAdministrationCommandSchema = <Revision extends Schema.Top>(revision: Revision) =>
  Schema.Union([
    Schema.TaggedStruct('CREATE_REVISION', {
      ...trustedCommandFields,
      expectedGeneration: nonNegativeGeneration,
      revision,
    }),
    Schema.TaggedStruct('ACTIVATE_REVISION', {
      ...trustedCommandFields,
      effectiveAt: CustomerCommercePolicyInstantSchema,
      expectedGeneration: nonNegativeGeneration,
      idempotencyKey: CustomerCommercePolicyIdempotencyKeySchema,
      reason: boundedReason,
      revisionId: CustomerCommercePolicyRevisionIdSchema,
    }),
    Schema.TaggedStruct('RETIRE_REVISION', {
      ...trustedCommandFields,
      effectiveAt: CustomerCommercePolicyInstantSchema,
      expectedGeneration: nonNegativeGeneration,
      idempotencyKey: CustomerCommercePolicyIdempotencyKeySchema,
      reason: boundedReason,
      revisionId: CustomerCommercePolicyRevisionIdSchema,
    }),
    Schema.TaggedStruct('REPLACE_REVISION', {
      ...trustedCommandFields,
      expectedGeneration: nonNegativeGeneration,
      replacedRevisionId: CustomerCommercePolicyRevisionIdSchema,
      replacement: revision,
    }),
  ]);

export const MarketBootstrapPolicyAdministrationPayloadSchema = makeAdministrationPayloadSchema(
  MarketBootstrapPolicyRevisionPayloadSchema,
);
export const PurchaseCurrencyPolicyAdministrationPayloadSchema = makeAdministrationPayloadSchema(
  PurchaseCurrencyPolicyRevisionPayloadSchema,
);
export const PaymentTermPolicyAdministrationPayloadSchema = makeAdministrationPayloadSchema(
  PaymentTermPolicyRevisionPayloadSchema,
);
export const CommerceQuantityRuleAdministrationPayloadSchema = makeAdministrationPayloadSchema(
  CommerceQuantityRuleRevisionPayloadSchema,
);

export type MarketBootstrapPolicyAdministrationPayload = typeof MarketBootstrapPolicyAdministrationPayloadSchema.Type;
export type PurchaseCurrencyPolicyAdministrationPayload = typeof PurchaseCurrencyPolicyAdministrationPayloadSchema.Type;
export type PaymentTermPolicyAdministrationPayload = typeof PaymentTermPolicyAdministrationPayloadSchema.Type;
export type CommerceQuantityRuleAdministrationPayload = typeof CommerceQuantityRuleAdministrationPayloadSchema.Type;

const MarketBootstrapPolicyAdministrationCommandSchema = makeAdministrationCommandSchema(
  MarketBootstrapPolicyRevisionSchema,
);
export const PurchaseCurrencyPolicyAdministrationCommandSchema = makeAdministrationCommandSchema(
  PurchaseCurrencyPolicyRevisionSchema,
);
const PaymentTermPolicyAdministrationCommandSchema = makeAdministrationCommandSchema(PaymentTermPolicyRevisionSchema);
const CommerceQuantityRuleAdministrationCommandSchema = makeAdministrationCommandSchema(
  CommerceQuantityRuleRevisionSchema,
);

type CustomerCommercePolicyAdministrationPayload =
  | CommerceQuantityRuleAdministrationPayload
  | MarketBootstrapPolicyAdministrationPayload
  | PaymentTermPolicyAdministrationPayload
  | PurchaseCurrencyPolicyAdministrationPayload;

const trustedPolicyCommandInput = (
  payload: CustomerCommercePolicyAdministrationPayload,
  trusted: CustomerCommercePolicyTrustedActionContext,
  observedAt: string,
) => {
  const base = { ...payload, ...trusted, observedAt };
  return Match.value(payload).pipe(
    Match.tag('CREATE_REVISION', (create) => ({
      ...base,
      revision: {
        ...create.revision,
        actionInvocationId: trusted.actionInvocationId,
        actorPrincipalId: trusted.actorPrincipalId,
        tenantId: trusted.tenantId,
      },
    })),
    Match.tag('REPLACE_REVISION', (replace) => ({
      ...base,
      replacement: {
        ...replace.replacement,
        actionInvocationId: trusted.actionInvocationId,
        actorPrincipalId: trusted.actorPrincipalId,
        tenantId: trusted.tenantId,
      },
    })),
    Match.orElse(() => base),
  );
};

export const toTrustedMarketBootstrapPolicyAdministrationCommand = (
  payload: MarketBootstrapPolicyAdministrationPayload,
  trusted: CustomerCommercePolicyTrustedActionContext,
  observedAt: string,
) =>
  Result.getOrThrow(
    Schema.decodeUnknownResult(MarketBootstrapPolicyAdministrationCommandSchema)(
      trustedPolicyCommandInput(payload, trusted, observedAt),
    ),
  );

export const toTrustedPurchaseCurrencyPolicyAdministrationCommand = (
  payload: PurchaseCurrencyPolicyAdministrationPayload,
  trusted: CustomerCommercePolicyTrustedActionContext,
  observedAt: string,
) =>
  Result.getOrThrow(
    Schema.decodeUnknownResult(PurchaseCurrencyPolicyAdministrationCommandSchema)(
      trustedPolicyCommandInput(payload, trusted, observedAt),
    ),
  );

export const toTrustedPaymentTermPolicyAdministrationCommand = (
  payload: PaymentTermPolicyAdministrationPayload,
  trusted: CustomerCommercePolicyTrustedActionContext,
  observedAt: string,
) =>
  Result.getOrThrow(
    Schema.decodeUnknownResult(PaymentTermPolicyAdministrationCommandSchema)(
      trustedPolicyCommandInput(payload, trusted, observedAt),
    ),
  );

export const toTrustedCommerceQuantityRuleAdministrationCommand = (
  payload: CommerceQuantityRuleAdministrationPayload,
  trusted: CustomerCommercePolicyTrustedActionContext,
  observedAt: string,
) =>
  Result.getOrThrow(
    Schema.decodeUnknownResult(CommerceQuantityRuleAdministrationCommandSchema)(
      trustedPolicyCommandInput(payload, trusted, observedAt),
    ),
  );

export const CustomerCommercePolicyMutationSummarySchema = Schema.Struct({
  changed: Schema.Boolean,
  completeness: Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema),
  generation: nonNegativeGeneration,
  revisionIds: Schema.Array(CustomerCommercePolicyRevisionIdSchema),
});
export type CustomerCommercePolicyMutationSummary = typeof CustomerCommercePolicyMutationSummarySchema.Type;

export class CustomerCommercePolicyAdministrationRejected extends Schema.TaggedError<CustomerCommercePolicyAdministrationRejected>()(
  'CustomerCommercePolicyAdministrationRejected',
  {
    code: Schema.Literals([
      'GENERATION_CONFLICT',
      'IDEMPOTENCY_CONFLICT',
      'INVALID_LIFECYCLE_TRANSITION',
      'OVERLAPPING_CURRENT_REVISION',
      'OVERLAPPING_ASSIGNMENT',
      'REVISION_NOT_FOUND',
      'BROKEN_ASSIGNMENT',
      'ASSIGNMENT_NOT_FOUND',
      'SCOPE_MISMATCH',
      'PERSISTENCE_UNAVAILABLE',
    ]),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

interface CustomerCommercePolicyCommandReceipt {
  readonly fingerprint: string;
  readonly idempotencyKey: string;
}

interface CustomerCommercePolicyLifecycleTransition {
  readonly actionInvocationId: string;
  readonly actorPrincipalId: string;
  readonly effectiveAt: CustomerCommercePolicyInstant;
  readonly idempotencyKey: string;
  readonly lifecycle: 'ACTIVE' | 'RETIRED';
  readonly observedAt: CustomerCommercePolicyInstant;
  readonly reason: string;
  readonly revisionId: string;
}

export interface CustomerCommercePolicySet<Revision extends CustomerCommercePolicyRevision> {
  readonly commandReceipts?: readonly CustomerCommercePolicyCommandReceipt[];
  readonly field: Revision['field'];
  readonly generation: number;
  readonly lifecycleTransitions?: readonly CustomerCommercePolicyLifecycleTransition[];
  readonly revisions: readonly Revision[];
}

export const emptyCustomerCommercePolicySet = <Field extends CustomerCommercePolicyFieldId>(field: Field) => ({
  commandReceipts: [],
  field,
  generation: 0,
  lifecycleTransitions: [],
  revisions: [],
});

interface TrustedCommandMetadata {
  readonly actionInvocationId: string;
  readonly actorPrincipalId: string;
  readonly observedAt: CustomerCommercePolicyInstant;
  readonly sellingLegalEntityId: string;
  readonly tenantId: string;
}

export const CreateRevisionCommandTagSchema = Schema.TaggedStruct('CREATE_REVISION', {});
const ActivateRevisionCommandTagSchema = Schema.TaggedStruct('ACTIVATE_REVISION', {});
const RetireRevisionCommandTagSchema = Schema.TaggedStruct('RETIRE_REVISION', {});
export const ReplaceRevisionCommandTagSchema = Schema.TaggedStruct('REPLACE_REVISION', {});
export const CustomerCommercePolicyChangedTagSchema = Schema.TaggedStruct('CHANGED', {});
export const CustomerCommercePolicyUnchangedTagSchema = Schema.TaggedStruct('UNCHANGED', {});
export const GenerationConflictTagSchema = Schema.TaggedStruct('GENERATION_CONFLICT', {});
export const IdempotencyConflictTagSchema = Schema.TaggedStruct('IDEMPOTENCY_CONFLICT', {});
export const InvalidLifecycleTransitionTagSchema = Schema.TaggedStruct('INVALID_LIFECYCLE_TRANSITION', {});
export const OverlappingCurrentRevisionTagSchema = Schema.TaggedStruct('OVERLAPPING_CURRENT_REVISION', {});
export const ScopeMismatchTagSchema = Schema.TaggedStruct('SCOPE_MISMATCH', {});
const RevisionNotFoundTagSchema = Schema.TaggedStruct('REVISION_NOT_FOUND', {});
export const AssignCommerceQuantityCommandTagSchema = Schema.TaggedStruct('ASSIGN', {});
const UnassignCommerceQuantityCommandTagSchema = Schema.TaggedStruct('UNASSIGN', {});
export const BrokenAssignmentTagSchema = Schema.TaggedStruct('BROKEN_ASSIGNMENT', {});
const AssignmentNotFoundTagSchema = Schema.TaggedStruct('ASSIGNMENT_NOT_FOUND', {});
const OverlappingAssignmentTagSchema = Schema.TaggedStruct('OVERLAPPING_ASSIGNMENT', {});

interface CreateRevisionCommand<Revision extends CustomerCommercePolicyRevision>
  extends TrustedCommandMetadata, Schema.Schema.Type<typeof CreateRevisionCommandTagSchema> {
  readonly expectedGeneration: number;
  readonly revision: Revision;
}

interface ActivateRevisionCommand
  extends TrustedCommandMetadata, Schema.Schema.Type<typeof ActivateRevisionCommandTagSchema> {
  readonly effectiveAt: CustomerCommercePolicyInstant;
  readonly expectedGeneration: number;
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly revisionId: string;
}

interface RetireRevisionCommand
  extends TrustedCommandMetadata, Schema.Schema.Type<typeof RetireRevisionCommandTagSchema> {
  readonly effectiveAt: CustomerCommercePolicyInstant;
  readonly expectedGeneration: number;
  readonly idempotencyKey: string;
  readonly reason: string;
  readonly revisionId: string;
}

interface ReplaceRevisionCommand<Revision extends CustomerCommercePolicyRevision>
  extends TrustedCommandMetadata, Schema.Schema.Type<typeof ReplaceRevisionCommandTagSchema> {
  readonly expectedGeneration: number;
  readonly replacedRevisionId: string;
  readonly replacement: Revision;
}

export type CustomerCommercePolicyAdministrationCommand<Revision extends CustomerCommercePolicyRevision> =
  | ActivateRevisionCommand
  | CreateRevisionCommand<Revision>
  | ReplaceRevisionCommand<Revision>
  | RetireRevisionCommand;

interface PolicyChanged<Revision extends CustomerCommercePolicyRevision> extends Schema.Schema.Type<
  typeof CustomerCommercePolicyChangedTagSchema
> {
  readonly completeness: OwnerVerifiableSetCompletenessEvidenceEncoded;
  readonly state: CustomerCommercePolicySet<Revision>;
}

interface PolicyUnchanged<Revision extends CustomerCommercePolicyRevision> extends Schema.Schema.Type<
  typeof CustomerCommercePolicyUnchangedTagSchema
> {
  readonly completeness: OwnerVerifiableSetCompletenessEvidenceEncoded;
  readonly state: CustomerCommercePolicySet<Revision>;
}

interface GenerationConflict extends Schema.Schema.Type<typeof GenerationConflictTagSchema> {
  readonly actualGeneration: number;
  readonly expectedGeneration: number;
}

type PolicyConflictTag =
  | Schema.Schema.Type<typeof IdempotencyConflictTagSchema>
  | Schema.Schema.Type<typeof InvalidLifecycleTransitionTagSchema>
  | Schema.Schema.Type<typeof OverlappingCurrentRevisionTagSchema>
  | Schema.Schema.Type<typeof ScopeMismatchTagSchema>;

type PolicyConflict = PolicyConflictTag & {
  readonly reason: string;
};

interface RevisionNotFound extends Schema.Schema.Type<typeof RevisionNotFoundTagSchema> {
  readonly revisionId: string;
}

export type CustomerCommercePolicyAdministrationResult<Revision extends CustomerCommercePolicyRevision> =
  | GenerationConflict
  | PolicyChanged<Revision>
  | PolicyConflict
  | PolicyUnchanged<Revision>
  | RevisionNotFound;

const revisionBusinessFingerprint = (revision: CustomerCommercePolicyRevision): string =>
  encodeJson({
    effectiveFrom: revision.effectiveFrom,
    effectiveTo: revision.effectiveTo,
    field: revision.field,
    lifecycle: revision.lifecycle,
    reason: revision.reason,
    revisionId: revision.revisionId,
    scope: revision.scope,
    tenantId: revision.tenantId,
    value: revision.value,
  });

const commandFingerprint = <Revision extends CustomerCommercePolicyRevision>(
  command: CustomerCommercePolicyAdministrationCommand<Revision>,
): string =>
  Match.value(command).pipe(
    Match.tag('CREATE_REVISION', (create) =>
      encodeJson({
        _tag: create._tag,
        revision: revisionBusinessFingerprint(create.revision),
      }),
    ),
    Match.tag('REPLACE_REVISION', (replace) =>
      encodeJson({
        _tag: replace._tag,
        replacedRevisionId: replace.replacedRevisionId,
        replacement: revisionBusinessFingerprint(replace.replacement),
      }),
    ),
    Match.tag('ACTIVATE_REVISION', (transition) =>
      encodeJson({
        _tag: transition._tag,
        effectiveAt: transition.effectiveAt,
        reason: transition.reason,
        revisionId: transition.revisionId,
        sellingLegalEntityId: transition.sellingLegalEntityId,
        tenantId: transition.tenantId,
      }),
    ),
    Match.tag('RETIRE_REVISION', (transition) =>
      encodeJson({
        _tag: transition._tag,
        effectiveAt: transition.effectiveAt,
        reason: transition.reason,
        revisionId: transition.revisionId,
        sellingLegalEntityId: transition.sellingLegalEntityId,
        tenantId: transition.tenantId,
      }),
    ),
    Match.exhaustive,
  );

const commandIdempotencyKey = <Revision extends CustomerCommercePolicyRevision>(
  command: CustomerCommercePolicyAdministrationCommand<Revision>,
): string =>
  Match.value(command).pipe(
    Match.tag('CREATE_REVISION', ({ revision }) => revision.idempotencyKey),
    Match.tag('REPLACE_REVISION', ({ replacement }) => replacement.idempotencyKey),
    Match.tag('ACTIVATE_REVISION', ({ idempotencyKey }) => idempotencyKey),
    Match.tag('RETIRE_REVISION', ({ idempotencyKey }) => idempotencyKey),
    Match.exhaustive,
  );

const scopeKey = (revision: CustomerCommercePolicyRevision): string => encodeJson(revision.scope);

const candidateKey = (revision: CustomerCommercePolicyRevision): string => {
  if (Schema.is(MarketBootstrapPolicyRevisionSchema)(revision)) {
    return revision.value.kind;
  }
  if (Schema.is(PurchaseCurrencyPolicyRevisionSchema)(revision)) {
    return revision.value.kind === 'ALLOWED_CURRENCY_CONSTRAINT'
      ? `${revision.value.kind}:${revision.value.currencyCode}`
      : revision.value.kind;
  }
  if (Schema.is(PaymentTermPolicyRevisionSchema)(revision)) {
    return revision.value.kind === 'APPLICABLE_PAYMENT_TERM_CONSTRAINT'
      ? `${revision.value.kind}:${revision.value.paymentTermRef.resourceId}`
      : revision.value.kind;
  }
  return revision.value.constraintMode === 'NON_RELAXABLE_CONSTRAINT'
    ? `${revision.value.constraintMode}:${encodeJson(revision.value.selector)}:${revision.revisionId}`
    : `${revision.value.constraintMode}:${encodeJson(revision.value.selector)}`;
};

const periodsOverlap = (left: CustomerCommercePolicyRevision, right: CustomerCommercePolicyRevision): boolean =>
  (left.effectiveTo === null || right.effectiveFrom < left.effectiveTo) &&
  (right.effectiveTo === null || left.effectiveFrom < right.effectiveTo);

const exactCandidateOverlaps = (
  revisions: readonly CustomerCommercePolicyRevision[],
  candidate: CustomerCommercePolicyRevision,
): boolean =>
  revisions.some(
    (revision) =>
      revision.revisionId !== candidate.revisionId &&
      scopeKey(revision) === scopeKey(candidate) &&
      candidateKey(revision) === candidateKey(candidate) &&
      periodsOverlap(revision, candidate),
  );

const policyBoundaries = <Revision extends CustomerCommercePolicyRevision>(
  state: CustomerCommercePolicySet<Revision>,
): readonly string[] => [
  ...state.revisions.flatMap(({ effectiveFrom, effectiveTo }) => [
    effectiveFrom,
    ...(effectiveTo === null ? [] : [effectiveTo]),
  ]),
  ...(state.lifecycleTransitions ?? []).map(({ effectiveAt }) => effectiveAt),
];

const nextBoundary = (boundaries: readonly string[], observedAt: string): string | undefined =>
  boundaries.filter((boundary) => boundary > observedAt).toSorted()[0];

const completenessEvidence = <Revision extends CustomerCommercePolicyRevision>(
  state: CustomerCommercePolicySet<Revision>,
  observedAt: string,
): OwnerVerifiableSetCompletenessEvidenceEncoded => {
  const boundary = nextBoundary(policyBoundaries(state), observedAt);
  const evidence = {
    observedAt,
    ownerRevision: `${state.field}:${state.generation}`,
    scope: {
      kind: 'EXACT_PREDICATE' as const,
      predicateRef: `commerce.customer-context.policy.${state.field.toLowerCase()}.current`,
    },
  };
  return boundary === undefined ? evidence : { ...evidence, nextApplicabilityBoundary: boundary };
};

const changed = <Revision extends CustomerCommercePolicyRevision>(
  state: CustomerCommercePolicySet<Revision>,
  command: CustomerCommercePolicyAdministrationCommand<Revision>,
  changes: Partial<CustomerCommercePolicySet<Revision>>,
): PolicyChanged<Revision> => {
  const receipt = {
    fingerprint: commandFingerprint(command),
    idempotencyKey: commandIdempotencyKey(command),
  };
  const nextState: CustomerCommercePolicySet<Revision> = {
    ...state,
    ...changes,
    commandReceipts: [...(state.commandReceipts ?? []), receipt],
    generation: state.generation + 1,
  };
  return {
    _tag: 'CHANGED',
    completeness: completenessEvidence(nextState, command.observedAt),
    state: nextState,
  };
};

const unchanged = <Revision extends CustomerCommercePolicyRevision>(
  state: CustomerCommercePolicySet<Revision>,
  observedAt: string,
): PolicyUnchanged<Revision> => ({
  _tag: 'UNCHANGED',
  completeness: completenessEvidence(state, observedAt),
  state,
});

const revisionMatchesTrustedScope = (
  revision: CustomerCommercePolicyRevision,
  command: TrustedCommandMetadata,
): boolean => {
  if (revision.tenantId !== command.tenantId || revision.scope.sellingLegalEntityId !== command.sellingLegalEntityId) {
    return false;
  }
  if (revision.field === 'PAYMENT_TERM' && 'paymentTermRef' in revision.value) {
    return revision.value.paymentTermRef.tenantId === command.tenantId;
  }
  if (revision.field !== 'COMMERCE_QUANTITY_RULE') {
    return true;
  }
  let selectorTenantId = command.tenantId;
  if (revision.value.selector.kind === 'PRODUCT') {
    selectorTenantId = revision.value.selector.productRef.tenantId;
  } else if (revision.value.selector.kind === 'VARIANT') {
    selectorTenantId = revision.value.selector.variantRef.tenantId;
  } else if (revision.value.selector.kind === 'PACKAGE_OPTION') {
    selectorTenantId = revision.value.selector.packageOptionRef.tenantId;
  }
  return (
    selectorTenantId === command.tenantId &&
    revision.value.basis.targetRef.tenantId === command.tenantId &&
    revision.value.basis.unitRef.tenantId === command.tenantId
  );
};

const lifecycleTransition = (
  command: ActivateRevisionCommand | RetireRevisionCommand,
): CustomerCommercePolicyLifecycleTransition => ({
  actionInvocationId: command.actionInvocationId,
  actorPrincipalId: command.actorPrincipalId,
  effectiveAt: command.effectiveAt,
  idempotencyKey: command.idempotencyKey,
  lifecycle: Schema.is(ActivateRevisionCommandTagSchema)(command) ? 'ACTIVE' : 'RETIRED',
  observedAt: command.observedAt,
  reason: command.reason,
  revisionId: command.revisionId,
});

const derivedLifecycleAt = <Revision extends CustomerCommercePolicyRevision>(
  state: CustomerCommercePolicySet<Revision>,
  revision: Revision,
  at: string,
): Revision['lifecycle'] => {
  const transition = (state.lifecycleTransitions ?? [])
    .filter((candidate) => candidate.revisionId === revision.revisionId && candidate.effectiveAt <= at)
    .toSorted((left, right) => left.effectiveAt.localeCompare(right.effectiveAt))
    .at(-1);
  return transition?.lifecycle ?? revision.lifecycle;
};

const createPolicyRevision = <Revision extends CustomerCommercePolicyRevision>(
  state: CustomerCommercePolicySet<Revision>,
  command: CreateRevisionCommand<Revision>,
): CustomerCommercePolicyAdministrationResult<Revision> => {
  if (!revisionMatchesTrustedScope(command.revision, command)) {
    return { _tag: 'SCOPE_MISMATCH', reason: 'Revision does not match the trusted Tenant and Legal Entity scope' };
  }
  if (state.field !== command.revision.field) {
    return { _tag: 'INVALID_LIFECYCLE_TRANSITION', reason: 'Revision belongs to a different field family' };
  }
  if (command.revision.lifecycle === 'RETIRED') {
    return { _tag: 'INVALID_LIFECYCLE_TRANSITION', reason: 'A new revision cannot be created as retired' };
  }
  if (state.revisions.some(({ revisionId }) => revisionId === command.revision.revisionId)) {
    return { _tag: 'INVALID_LIFECYCLE_TRANSITION', reason: 'Revision identity cannot be reused' };
  }
  if (exactCandidateOverlaps(state.revisions, command.revision)) {
    return { _tag: 'OVERLAPPING_CURRENT_REVISION', reason: 'An exact candidate already overlaps this period' };
  }
  return changed(state, command, { revisions: [...state.revisions, command.revision] });
};

const replacePolicyRevision = <Revision extends CustomerCommercePolicyRevision>(
  state: CustomerCommercePolicySet<Revision>,
  command: ReplaceRevisionCommand<Revision>,
): CustomerCommercePolicyAdministrationResult<Revision> => {
  const replaced = state.revisions.find(({ revisionId }) => revisionId === command.replacedRevisionId);
  if (replaced === undefined) {
    return { _tag: 'REVISION_NOT_FOUND', revisionId: command.replacedRevisionId };
  }
  if (!revisionMatchesTrustedScope(replaced, command) || !revisionMatchesTrustedScope(command.replacement, command)) {
    return { _tag: 'SCOPE_MISMATCH', reason: 'Replacement does not match the trusted Tenant and Legal Entity scope' };
  }
  if (state.field !== command.replacement.field) {
    return { _tag: 'INVALID_LIFECYCLE_TRANSITION', reason: 'Replacement belongs to a different field family' };
  }
  if (command.replacement.lifecycle === 'RETIRED') {
    return { _tag: 'INVALID_LIFECYCLE_TRANSITION', reason: 'A replacement revision cannot be created as retired' };
  }
  if (state.revisions.some(({ revisionId }) => revisionId === command.replacement.revisionId)) {
    return { _tag: 'INVALID_LIFECYCLE_TRANSITION', reason: 'Replacement revision identity cannot be reused' };
  }
  if (command.replacement.effectiveFrom <= replaced.effectiveFrom) {
    return { _tag: 'INVALID_LIFECYCLE_TRANSITION', reason: 'Replacement must begin after its predecessor' };
  }
  if (replaced.effectiveTo !== null && command.replacement.effectiveFrom >= replaced.effectiveTo) {
    return { _tag: 'INVALID_LIFECYCLE_TRANSITION', reason: 'Replacement must begin while its predecessor applies' };
  }
  if (
    (state.lifecycleTransitions ?? []).some(
      (transition) =>
        transition.revisionId === replaced.revisionId && transition.effectiveAt > command.replacement.effectiveFrom,
    )
  ) {
    return {
      _tag: 'INVALID_LIFECYCLE_TRANSITION',
      reason: 'Replacement cannot precede an existing lifecycle transition',
    };
  }
  if (derivedLifecycleAt(state, replaced, command.replacement.effectiveFrom) !== 'ACTIVE') {
    return { _tag: 'INVALID_LIFECYCLE_TRANSITION', reason: 'Only an active revision can be replaced' };
  }
  const withoutReplaced = state.revisions.filter(({ revisionId }) => revisionId !== replaced.revisionId);
  if (exactCandidateOverlaps(withoutReplaced, command.replacement)) {
    return { _tag: 'OVERLAPPING_CURRENT_REVISION', reason: 'Replacement overlaps another exact candidate' };
  }
  const predecessorRetirement: CustomerCommercePolicyLifecycleTransition = {
    actionInvocationId: command.actionInvocationId,
    actorPrincipalId: command.actorPrincipalId,
    effectiveAt: command.replacement.effectiveFrom,
    idempotencyKey: `${command.replacement.idempotencyKey}:retire`,
    lifecycle: 'RETIRED',
    observedAt: command.observedAt,
    reason: command.replacement.reason,
    revisionId: replaced.revisionId,
  };
  const replacementTransitions =
    command.replacement.lifecycle === 'SCHEDULED'
      ? [
          {
            ...predecessorRetirement,
            idempotencyKey: `${command.replacement.idempotencyKey}:activate`,
            lifecycle: 'ACTIVE' as const,
            revisionId: command.replacement.revisionId,
          },
        ]
      : [];
  return changed(state, command, {
    lifecycleTransitions: [...(state.lifecycleTransitions ?? []), predecessorRetirement, ...replacementTransitions],
    revisions: [...state.revisions, command.replacement],
  });
};

const transitionPolicyRevision = <Revision extends CustomerCommercePolicyRevision>(
  state: CustomerCommercePolicySet<Revision>,
  command: ActivateRevisionCommand | RetireRevisionCommand,
): CustomerCommercePolicyAdministrationResult<Revision> => {
  const revision = state.revisions.find(({ revisionId }) => revisionId === command.revisionId);
  if (revision === undefined) {
    return { _tag: 'REVISION_NOT_FOUND', revisionId: command.revisionId };
  }
  if (!revisionMatchesTrustedScope(revision, command)) {
    return { _tag: 'SCOPE_MISMATCH', reason: 'Revision does not match the trusted Tenant and Legal Entity scope' };
  }
  if (command.effectiveAt < revision.effectiveFrom) {
    return { _tag: 'INVALID_LIFECYCLE_TRANSITION', reason: 'Lifecycle change cannot precede the effective start' };
  }
  if (revision.effectiveTo !== null && command.effectiveAt >= revision.effectiveTo) {
    return { _tag: 'INVALID_LIFECYCLE_TRANSITION', reason: 'Lifecycle change must occur inside the half-open period' };
  }
  const lifecycle = derivedLifecycleAt(state, revision, command.effectiveAt);
  if (Schema.is(ActivateRevisionCommandTagSchema)(command) && lifecycle !== 'SCHEDULED') {
    return { _tag: 'INVALID_LIFECYCLE_TRANSITION', reason: 'Only a scheduled revision can activate' };
  }
  if (Schema.is(RetireRevisionCommandTagSchema)(command) && lifecycle !== 'ACTIVE') {
    return { _tag: 'INVALID_LIFECYCLE_TRANSITION', reason: 'Only an active revision can retire' };
  }
  return changed(state, command, {
    lifecycleTransitions: [...(state.lifecycleTransitions ?? []), lifecycleTransition(command)],
  });
};

const administerPolicy = <Revision extends CustomerCommercePolicyRevision>(
  state: CustomerCommercePolicySet<Revision>,
  command: CustomerCommercePolicyAdministrationCommand<Revision>,
): CustomerCommercePolicyAdministrationResult<Revision> => {
  const fingerprint = commandFingerprint(command);
  const receipt = (state.commandReceipts ?? []).find(
    ({ idempotencyKey }) => idempotencyKey === commandIdempotencyKey(command),
  );
  if (receipt !== undefined) {
    return receipt.fingerprint === fingerprint
      ? unchanged(state, command.observedAt)
      : { _tag: 'IDEMPOTENCY_CONFLICT', reason: 'Idempotency key identifies a different command payload' };
  }
  if (state.generation !== command.expectedGeneration) {
    return {
      _tag: 'GENERATION_CONFLICT',
      actualGeneration: state.generation,
      expectedGeneration: command.expectedGeneration,
    };
  }
  return Match.value(command).pipe(
    Match.tag('CREATE_REVISION', (create) => createPolicyRevision(state, create)),
    Match.tag('REPLACE_REVISION', (replace) => replacePolicyRevision(state, replace)),
    Match.tag('ACTIVATE_REVISION', (activate) => transitionPolicyRevision(state, activate)),
    Match.tag('RETIRE_REVISION', (retire) => transitionPolicyRevision(state, retire)),
    Match.exhaustive,
  );
};

export const administerMarketBootstrapPolicy = (
  state: CustomerCommercePolicySet<MarketBootstrapPolicyRevision>,
  command: CustomerCommercePolicyAdministrationCommand<MarketBootstrapPolicyRevision>,
) => administerPolicy(state, command);

export const administerPurchaseCurrencyPolicy = (
  state: CustomerCommercePolicySet<PurchaseCurrencyPolicyRevision>,
  command: CustomerCommercePolicyAdministrationCommand<PurchaseCurrencyPolicyRevision>,
) => administerPolicy(state, command);

export const administerPaymentTermPolicy = (
  state: CustomerCommercePolicySet<PaymentTermPolicyRevision>,
  command: CustomerCommercePolicyAdministrationCommand<PaymentTermPolicyRevision>,
) => administerPolicy(state, command);

export const administerCommerceQuantityRule = (
  state: CustomerCommercePolicySet<CommerceQuantityRuleRevision>,
  command: CustomerCommercePolicyAdministrationCommand<CommerceQuantityRuleRevision>,
) => administerPolicy(state, command);

export interface CurrentCustomerCommercePolicySet<Revision extends CustomerCommercePolicyRevision> {
  readonly completeness: OwnerVerifiableSetCompletenessEvidenceEncoded;
  readonly revisions: readonly Revision[];
}

const makeCurrentPolicyCandidateSchema = <Scope extends Schema.Top, Value extends Schema.Top>({
  scope,
  value,
}: {
  readonly scope: Scope;
  readonly value: Value;
}) =>
  Schema.Struct({
    effectiveFrom: CustomerCommercePolicyInstantSchema,
    effectiveTo: Schema.toEncoded(Schema.OptionFromNullOr(CustomerCommercePolicyInstantSchema)),
    policyRevisionId: CustomerCommercePolicyRevisionIdSchema,
    scope,
    value,
  });

const makeCurrentCandidateSetSchema = <Candidate extends Schema.Top>(candidate: Candidate) =>
  Schema.Struct({
    candidates: Schema.Array(candidate),
    completeness: Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema),
  });

export const CurrentPurchaseCurrencyPolicyCandidateSchema = makeCurrentPolicyCandidateSchema({
  scope: OrdinaryCustomerCommercePolicyScopeSchema,
  value: PurchaseCurrencyValueSchema,
});
export type CurrentPurchaseCurrencyPolicyCandidate = typeof CurrentPurchaseCurrencyPolicyCandidateSchema.Type;
export const CurrentPurchaseCurrencyPolicySetSchema = makeCurrentCandidateSetSchema(
  CurrentPurchaseCurrencyPolicyCandidateSchema,
);
export type CurrentPurchaseCurrencyPolicySet = typeof CurrentPurchaseCurrencyPolicySetSchema.Type;

export const CurrentPaymentTermPolicyCandidateSchema = makeCurrentPolicyCandidateSchema({
  scope: OrdinaryCustomerCommercePolicyScopeSchema,
  value: PaymentTermValueSchema,
});
export type CurrentPaymentTermPolicyCandidate = typeof CurrentPaymentTermPolicyCandidateSchema.Type;
export const CurrentPaymentTermPolicySetSchema = makeCurrentCandidateSetSchema(CurrentPaymentTermPolicyCandidateSchema);
export type CurrentPaymentTermPolicySet = typeof CurrentPaymentTermPolicySetSchema.Type;

export const CurrentCommerceQuantityRuleCandidateSchema = makeCurrentPolicyCandidateSchema({
  scope: CommerceQuantityPolicyScopeSchema,
  value: CommerceQuantityRuleValueSchema,
});
const CurrentCommerceQuantityRuleSetSchema = makeCurrentCandidateSetSchema(CurrentCommerceQuantityRuleCandidateSchema);
export type CurrentCommerceQuantityRuleSet = typeof CurrentCommerceQuantityRuleSetSchema.Type;

export const MarketBootstrapPolicyBatchCurrentRequestSchema = Schema.Struct({
  at: CustomerCommercePolicyInstantSchema,
  eligibleSellingLegalEntityIds: Schema.Array(CustomerCommercePolicySellingLegalEntityIdSchema).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
    Schema.makeFilter((ids) =>
      new Set(ids).size === ids.length ? undefined : 'Eligible Selling Legal Entity IDs must be unique',
    ),
  ),
});
export type MarketBootstrapPolicyBatchCurrentRequest = typeof MarketBootstrapPolicyBatchCurrentRequestSchema.Type;

const MarketBootstrapDefaultTupleSchema = Schema.Struct({
  channelId: CustomerCommercePolicyChannelIdSchema,
  commerceMarketId: CustomerCommercePolicyCommerceMarketIdSchema,
  sellingLegalEntityId: CustomerCommercePolicySellingLegalEntityIdSchema,
});

const MarketBootstrapPolicyBatchCandidateSchema = Schema.Struct({
  defaultTuple: MarketBootstrapDefaultTupleSchema,
  policyRevisionId: CustomerCommercePolicyRevisionIdSchema,
  scope: MarketBootstrapPolicyScopeSchema,
}).check(
  Schema.makeFilter(({ defaultTuple, scope }) => {
    const scopeMatches =
      scope.sellingLegalEntityId === defaultTuple.sellingLegalEntityId &&
      (scope.kind === 'SELLER' || scope.channelId === defaultTuple.channelId);
    return scopeMatches
      ? undefined
      : 'Bootstrap candidate tuple must match every seller and Channel fixed by its scope';
  }),
);

const MarketBootstrapPolicySellerPartitionSchema = Schema.Struct({
  candidates: Schema.Array(MarketBootstrapPolicyBatchCandidateSchema),
  completeness: Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema),
  sellingLegalEntityId: CustomerCommercePolicySellingLegalEntityIdSchema,
}).check(
  Schema.makeFilter((partition) => {
    if (
      partition.candidates.some(
        ({ defaultTuple, scope }) =>
          defaultTuple.sellingLegalEntityId !== partition.sellingLegalEntityId ||
          scope.sellingLegalEntityId !== partition.sellingLegalEntityId,
      )
    ) {
      return 'Every bootstrap candidate must belong to its seller partition';
    }
    return partition.completeness.scope.predicateRef.includes(partition.sellingLegalEntityId)
      ? undefined
      : 'Bootstrap completeness evidence must be seller-qualified';
  }),
);

export const MarketBootstrapPolicyBatchCurrentResponseSchema = Schema.Struct({
  sellers: Schema.Array(MarketBootstrapPolicySellerPartitionSchema).check(
    Schema.makeFilter((sellers) =>
      new Set(sellers.map(({ sellingLegalEntityId }) => sellingLegalEntityId)).size === sellers.length
        ? undefined
        : 'Bootstrap response may contain only one partition per Selling Legal Entity',
    ),
  ),
});
export type MarketBootstrapPolicyBatchCurrentResponse = typeof MarketBootstrapPolicyBatchCurrentResponseSchema.Type;

export const MarketBootstrapPolicyBatchCurrentExchangeSchema = Schema.Struct({
  request: MarketBootstrapPolicyBatchCurrentRequestSchema,
  response: MarketBootstrapPolicyBatchCurrentResponseSchema,
}).check(
  Schema.makeFilter(({ request, response }) => {
    const requested = request.eligibleSellingLegalEntityIds.toSorted();
    const returned = response.sellers.map(({ sellingLegalEntityId }) => sellingLegalEntityId).toSorted();
    return requested.length === returned.length && requested.every((sellerId, index) => sellerId === returned[index])
      ? undefined
      : 'Bootstrap response must contain exactly one partition for every requested Selling Legal Entity';
  }),
);

const currentPolicyRevisions = <Revision extends CustomerCommercePolicyRevision>(
  state: CustomerCommercePolicySet<Revision>,
  at: string,
): readonly Revision[] =>
  state.revisions.filter(
    (revision) =>
      revision.effectiveFrom <= at &&
      (revision.effectiveTo === null || at < revision.effectiveTo) &&
      derivedLifecycleAt(state, revision, at) === 'ACTIVE',
  );

const currentPolicySet = <Revision extends CustomerCommercePolicyRevision>(
  state: CustomerCommercePolicySet<Revision>,
  at: string,
): CurrentCustomerCommercePolicySet<Revision> => ({
  completeness: completenessEvidence(state, at),
  revisions: currentPolicyRevisions(state, at),
});

type CurrentPolicyCandidate<Revision extends CustomerCommercePolicyRevision> = Readonly<{
  effectiveFrom: Revision['effectiveFrom'];
  effectiveTo: Revision['effectiveTo'];
  policyRevisionId: Revision['revisionId'];
  scope: Revision['scope'];
  value: Revision['value'];
}>;

const toCurrentPolicyCandidate = <Revision extends CustomerCommercePolicyRevision>(
  revision: Revision,
): CurrentPolicyCandidate<Revision> => ({
  effectiveFrom: revision.effectiveFrom,
  effectiveTo: revision.effectiveTo,
  policyRevisionId: revision.revisionId,
  scope: revision.scope,
  value: revision.value,
});

export const currentMarketBootstrapPolicySet = (
  state: CustomerCommercePolicySet<MarketBootstrapPolicyRevision>,
  at: string,
) => currentPolicySet(state, at);
export const currentPurchaseCurrencyPolicySet = (
  state: CustomerCommercePolicySet<PurchaseCurrencyPolicyRevision>,
  at: string,
): CurrentPurchaseCurrencyPolicySet => ({
  candidates: currentPolicyRevisions(state, at).map((revision) => toCurrentPolicyCandidate(revision)),
  completeness: completenessEvidence(state, at),
});
export const currentPaymentTermPolicySet = (
  state: CustomerCommercePolicySet<PaymentTermPolicyRevision>,
  at: string,
): CurrentPaymentTermPolicySet => ({
  candidates: currentPolicyRevisions(state, at).map((revision) => toCurrentPolicyCandidate(revision)),
  completeness: completenessEvidence(state, at),
});
export const currentCommerceQuantityRuleSet = (
  state: CustomerCommercePolicySet<CommerceQuantityRuleRevision>,
  at: string,
): CurrentCommerceQuantityRuleSet => ({
  candidates: currentPolicyRevisions(state, at).map((revision) => toCurrentPolicyCandidate(revision)),
  completeness: completenessEvidence(state, at),
});

const CommerceQuantityAssignmentProfileSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('RETAIL'), profileRef: RetailCustomerProfileRefSchema }),
  Schema.Struct({ kind: Schema.Literal('COUNTERPARTY'), profileRef: CounterpartyPurchasingProfileRefSchema }),
]);

export const CommerceQuantityRuleAssignmentSchema = Schema.Struct({
  actionInvocationId: CustomerCommercePolicyActionInvocationIdSchema,
  actorPrincipalId: CustomerCommercePolicyActorPrincipalIdSchema,
  assignmentId: assignmentIdSchema,
  effectiveFrom: CustomerCommercePolicyInstantSchema,
  effectiveTo: Schema.toEncoded(Schema.OptionFromNullOr(CustomerCommercePolicyInstantSchema)),
  idempotencyKey: CustomerCommercePolicyIdempotencyKeySchema,
  lifecycle: policyLifecycleSchema,
  profile: CommerceQuantityAssignmentProfileSchema,
  reason: boundedReason,
  recordedAt: CustomerCommercePolicyInstantSchema,
  ruleRevisionRef: CommerceQuantityRuleRefSchema,
  sellingLegalEntityId: CustomerCommercePolicySellingLegalEntityIdSchema,
}).check(
  Schema.makeFilter((assignment) => {
    const issues: Schema.FilterIssue[] = [];
    if (assignment.effectiveTo !== null && assignment.effectiveTo <= assignment.effectiveFrom) {
      issues.push({ issue: invalidHalfOpenPeriodIssue, path: ['effectiveTo'] });
    }
    if (assignment.profile.profileRef.tenantId !== assignment.ruleRevisionRef.tenantId) {
      issues.push({ issue: 'Profile and Quantity Rule Revision must share one Tenant', path: ['profile'] });
    }
    return issues;
  }),
);
type CommerceQuantityRuleAssignment = typeof CommerceQuantityRuleAssignmentSchema.Type;

const CommerceQuantityRuleAssignmentPayloadValueSchema = Schema.Struct({
  assignmentId: assignmentIdSchema,
  effectiveFrom: CustomerCommercePolicyInstantSchema,
  effectiveTo: Schema.toEncoded(Schema.OptionFromNullOr(CustomerCommercePolicyInstantSchema)),
  idempotencyKey: CustomerCommercePolicyIdempotencyKeySchema,
  lifecycle: policyLifecycleSchema,
  profile: CommerceQuantityAssignmentProfileSchema,
  reason: boundedReason,
  ruleRevisionRef: CommerceQuantityRuleRefSchema,
}).check(
  Schema.makeFilter((assignment) =>
    assignment.effectiveTo === null || assignment.effectiveTo > assignment.effectiveFrom
      ? undefined
      : [{ issue: invalidHalfOpenPeriodIssue, path: ['effectiveTo'] }],
  ),
);

export const CommerceQuantityAssignmentPayloadSchema = Schema.Union([
  Schema.TaggedStruct('ASSIGN', {
    assignment: CommerceQuantityRuleAssignmentPayloadValueSchema,
    expectedGeneration: nonNegativeGeneration,
  }),
  Schema.TaggedStruct('UNASSIGN', {
    assignmentId: assignmentIdSchema,
    effectiveAt: CustomerCommercePolicyInstantSchema,
    expectedGeneration: nonNegativeGeneration,
    idempotencyKey: CustomerCommercePolicyIdempotencyKeySchema,
    reason: boundedReason,
  }),
]);
export type CommerceQuantityAssignmentPayload = typeof CommerceQuantityAssignmentPayloadSchema.Type;

const CommerceQuantityAssignmentCommandSchema = Schema.Union([
  Schema.TaggedStruct('ASSIGN', {
    ...trustedCommandFields,
    assignment: CommerceQuantityRuleAssignmentSchema,
    expectedGeneration: nonNegativeGeneration,
  }),
  Schema.TaggedStruct('UNASSIGN', {
    ...trustedCommandFields,
    assignmentId: assignmentIdSchema,
    effectiveAt: CustomerCommercePolicyInstantSchema,
    expectedGeneration: nonNegativeGeneration,
    idempotencyKey: CustomerCommercePolicyIdempotencyKeySchema,
    reason: boundedReason,
  }),
]);

export const toTrustedCommerceQuantityAssignmentCommand = (
  payload: CommerceQuantityAssignmentPayload,
  trusted: CustomerCommercePolicyTrustedActionContext,
  observedAt: string,
) => {
  const base = { ...payload, ...trusted, observedAt };
  const command = Match.value(payload).pipe(
    Match.tag('ASSIGN', ({ assignment }) => ({
      ...base,
      assignment: {
        ...assignment,
        actionInvocationId: trusted.actionInvocationId,
        actorPrincipalId: trusted.actorPrincipalId,
        recordedAt: observedAt,
        sellingLegalEntityId: trusted.sellingLegalEntityId,
      },
    })),
    Match.tag('UNASSIGN', () => base),
    Match.exhaustive,
  );
  return Result.getOrThrow(
    Schema.decodeUnknownResult(CommerceQuantityAssignmentCommandSchema, { onExcessProperty: 'error' })(command),
  );
};

interface CommerceQuantityRuleUnassignment {
  readonly actionInvocationId: string;
  readonly actorPrincipalId: string;
  readonly assignmentId: string;
  readonly effectiveAt: CustomerCommercePolicyInstant;
  readonly idempotencyKey: string;
  readonly observedAt: CustomerCommercePolicyInstant;
  readonly reason: string;
}

export interface CommerceQuantityAssignmentSet {
  readonly assignments: readonly CommerceQuantityRuleAssignment[];
  readonly commandReceipts?: readonly CustomerCommercePolicyCommandReceipt[];
  readonly generation: number;
  readonly unassignments?: readonly CommerceQuantityRuleUnassignment[];
}

export const emptyQuantityAssignmentSet = (): CommerceQuantityAssignmentSet => ({
  assignments: [],
  commandReceipts: [],
  generation: 0,
  unassignments: [],
});

export type CommerceQuantityAssignmentCommand = typeof CommerceQuantityAssignmentCommandSchema.Type;

type CommerceQuantityAssignmentConflictTag =
  | Schema.Schema.Type<typeof IdempotencyConflictTagSchema>
  | Schema.Schema.Type<typeof InvalidLifecycleTransitionTagSchema>
  | Schema.Schema.Type<typeof OverlappingAssignmentTagSchema>
  | Schema.Schema.Type<typeof ScopeMismatchTagSchema>;

export type CommerceQuantityAssignmentResult =
  | (Schema.Schema.Type<typeof BrokenAssignmentTagSchema> & { readonly ruleRevisionId: string })
  | GenerationConflict
  | (Schema.Schema.Type<typeof AssignmentNotFoundTagSchema> & { readonly assignmentId: string })
  | (CommerceQuantityAssignmentConflictTag & { readonly reason: string })
  | (Schema.Schema.Type<typeof CustomerCommercePolicyChangedTagSchema> & {
      readonly completeness: OwnerVerifiableSetCompletenessEvidenceEncoded;
      readonly state: CommerceQuantityAssignmentSet;
    })
  | (Schema.Schema.Type<typeof CustomerCommercePolicyUnchangedTagSchema> & {
      readonly completeness: OwnerVerifiableSetCompletenessEvidenceEncoded;
      readonly state: CommerceQuantityAssignmentSet;
    });

const assignmentBoundaries = (state: CommerceQuantityAssignmentSet): readonly string[] => [
  ...state.assignments.flatMap(({ effectiveFrom, effectiveTo }) => [
    effectiveFrom,
    ...(effectiveTo === null ? [] : [effectiveTo]),
  ]),
  ...(state.unassignments ?? []).map(({ effectiveAt }) => effectiveAt),
];

const assignmentCompleteness = (
  state: CommerceQuantityAssignmentSet,
  observedAt: string,
): OwnerVerifiableSetCompletenessEvidenceEncoded => {
  const boundary = nextBoundary(assignmentBoundaries(state), observedAt);
  const evidence = {
    observedAt,
    ownerRevision: `COMMERCE_QUANTITY_ASSIGNMENT:${state.generation}`,
    scope: {
      kind: 'EXACT_PREDICATE' as const,
      predicateRef: 'commerce.customer-context.policy.commerce_quantity_assignment.current',
    },
  };
  return boundary === undefined ? evidence : { ...evidence, nextApplicabilityBoundary: boundary };
};

const assignmentFingerprint = (command: CommerceQuantityAssignmentCommand): string =>
  Match.value(command).pipe(
    Match.tag('ASSIGN', (assign) =>
      encodeJson({
        _tag: command._tag,
        assignment: {
          assignmentId: assign.assignment.assignmentId,
          effectiveFrom: assign.assignment.effectiveFrom,
          effectiveTo: assign.assignment.effectiveTo,
          lifecycle: assign.assignment.lifecycle,
          profile: assign.assignment.profile,
          reason: assign.assignment.reason,
          ruleRevisionRef: assign.assignment.ruleRevisionRef,
          sellingLegalEntityId: assign.assignment.sellingLegalEntityId,
        },
      }),
    ),
    Match.tag('UNASSIGN', (unassign) =>
      encodeJson({
        _tag: unassign._tag,
        assignmentId: unassign.assignmentId,
        effectiveAt: unassign.effectiveAt,
        reason: unassign.reason,
        sellingLegalEntityId: unassign.sellingLegalEntityId,
        tenantId: unassign.tenantId,
      }),
    ),
    Match.exhaustive,
  );

const assignmentIdempotencyKey = (command: CommerceQuantityAssignmentCommand): string =>
  Match.value(command).pipe(
    Match.tag('ASSIGN', ({ assignment }) => assignment.idempotencyKey),
    Match.tag('UNASSIGN', ({ idempotencyKey }) => idempotencyKey),
    Match.exhaustive,
  );

const changedAssignment = (
  state: CommerceQuantityAssignmentSet,
  command: CommerceQuantityAssignmentCommand,
  changes: Partial<CommerceQuantityAssignmentSet>,
): Extract<CommerceQuantityAssignmentResult, { readonly _tag: 'CHANGED' }> => {
  const nextState: CommerceQuantityAssignmentSet = {
    ...state,
    ...changes,
    commandReceipts: [
      ...(state.commandReceipts ?? []),
      { fingerprint: assignmentFingerprint(command), idempotencyKey: assignmentIdempotencyKey(command) },
    ],
    generation: state.generation + 1,
  };
  return {
    _tag: 'CHANGED',
    completeness: assignmentCompleteness(nextState, command.observedAt),
    state: nextState,
  };
};

const assignmentApplicabilityEnd = (
  state: CommerceQuantityAssignmentSet,
  assignment: CommerceQuantityRuleAssignment,
): string | null => {
  let unassignedAt: string | undefined;
  for (const unassignment of state.unassignments ?? []) {
    if (
      unassignment.assignmentId === assignment.assignmentId &&
      (unassignedAt === undefined || unassignment.effectiveAt < unassignedAt)
    ) {
      unassignedAt = unassignment.effectiveAt;
    }
  }
  if (unassignedAt === undefined) {
    return assignment.effectiveTo;
  }
  return assignment.effectiveTo === null || unassignedAt < assignment.effectiveTo
    ? unassignedAt
    : assignment.effectiveTo;
};

const assignmentOverlaps = (state: CommerceQuantityAssignmentSet, candidate: CommerceQuantityRuleAssignment): boolean =>
  state.assignments.some((assignment) => {
    const applicabilityEnd = assignmentApplicabilityEnd(state, assignment);
    return (
      assignment.assignmentId !== candidate.assignmentId &&
      assignment.profile.kind === candidate.profile.kind &&
      assignment.profile.profileRef.resourceId === candidate.profile.profileRef.resourceId &&
      assignment.ruleRevisionRef.resourceId === candidate.ruleRevisionRef.resourceId &&
      (applicabilityEnd === null || candidate.effectiveFrom < applicabilityEnd) &&
      (candidate.effectiveTo === null || assignment.effectiveFrom < candidate.effectiveTo)
    );
  });

const assignQuantityRule = (
  state: CommerceQuantityAssignmentSet,
  quantityRuleState: CustomerCommercePolicySet<CommerceQuantityRuleRevision>,
  command: Extract<
    CommerceQuantityAssignmentCommand,
    Schema.Schema.Type<typeof AssignCommerceQuantityCommandTagSchema>
  >,
): CommerceQuantityAssignmentResult => {
  const { assignment } = command;
  if (
    assignment.ruleRevisionRef.tenantId !== command.tenantId ||
    assignment.profile.profileRef.tenantId !== command.tenantId ||
    assignment.sellingLegalEntityId !== command.sellingLegalEntityId
  ) {
    return { _tag: 'SCOPE_MISMATCH', reason: 'Assignment references do not match the trusted scope' };
  }
  if (assignment.lifecycle !== 'ACTIVE') {
    return { _tag: 'INVALID_LIFECYCLE_TRANSITION', reason: 'A new assignment must enter as active' };
  }
  if (state.assignments.some(({ assignmentId }) => assignmentId === assignment.assignmentId)) {
    return { _tag: 'INVALID_LIFECYCLE_TRANSITION', reason: 'Assignment identity cannot be reused' };
  }
  const rule = quantityRuleState.revisions.find(
    ({ revisionId }) => revisionId === assignment.ruleRevisionRef.resourceId,
  );
  if (rule === undefined) {
    return { _tag: 'BROKEN_ASSIGNMENT', ruleRevisionId: assignment.ruleRevisionRef.resourceId };
  }
  if (rule.tenantId !== command.tenantId || rule.scope.sellingLegalEntityId !== command.sellingLegalEntityId) {
    return { _tag: 'SCOPE_MISMATCH', reason: 'Quantity Rule Revision does not match the trusted scope' };
  }
  if (
    !currentPolicyRevisions(quantityRuleState, assignment.effectiveFrom).some(
      ({ revisionId }) => revisionId === rule.revisionId,
    )
  ) {
    return {
      _tag: 'INVALID_LIFECYCLE_TRANSITION',
      reason: 'Assignment must begin while its Quantity Rule Revision is current and active',
    };
  }
  if (
    assignment.effectiveFrom < rule.effectiveFrom ||
    (rule.effectiveTo !== null && (assignment.effectiveTo === null || assignment.effectiveTo > rule.effectiveTo))
  ) {
    return {
      _tag: 'INVALID_LIFECYCLE_TRANSITION',
      reason: 'Assignment period must be contained by its immutable Quantity Rule Revision period',
    };
  }
  if (assignmentOverlaps(state, assignment)) {
    return { _tag: 'OVERLAPPING_ASSIGNMENT', reason: 'The same profile and rule already overlap this period' };
  }
  return changedAssignment(state, command, { assignments: [...state.assignments, assignment] });
};

const unassignQuantityRule = (
  state: CommerceQuantityAssignmentSet,
  command: Extract<
    CommerceQuantityAssignmentCommand,
    Schema.Schema.Type<typeof UnassignCommerceQuantityCommandTagSchema>
  >,
): CommerceQuantityAssignmentResult => {
  const assignment = state.assignments.find(({ assignmentId }) => assignmentId === command.assignmentId);
  if (assignment === undefined) {
    return { _tag: 'ASSIGNMENT_NOT_FOUND', assignmentId: command.assignmentId };
  }
  if (
    assignment.ruleRevisionRef.tenantId !== command.tenantId ||
    assignment.profile.profileRef.tenantId !== command.tenantId ||
    assignment.sellingLegalEntityId !== command.sellingLegalEntityId
  ) {
    return { _tag: 'SCOPE_MISMATCH', reason: 'Assignment does not match the trusted scope' };
  }
  if ((state.unassignments ?? []).some(({ assignmentId }) => assignmentId === command.assignmentId)) {
    return { _tag: 'INVALID_LIFECYCLE_TRANSITION', reason: 'Assignment has already been unassigned' };
  }
  if (
    assignment.lifecycle !== 'ACTIVE' ||
    command.effectiveAt <= assignment.effectiveFrom ||
    (assignment.effectiveTo !== null && command.effectiveAt >= assignment.effectiveTo)
  ) {
    return {
      _tag: 'INVALID_LIFECYCLE_TRANSITION',
      reason: 'Unassignment must end an active assignment inside its half-open period',
    };
  }
  const unassignment: CommerceQuantityRuleUnassignment = {
    actionInvocationId: command.actionInvocationId,
    actorPrincipalId: command.actorPrincipalId,
    assignmentId: command.assignmentId,
    effectiveAt: command.effectiveAt,
    idempotencyKey: command.idempotencyKey,
    observedAt: command.observedAt,
    reason: command.reason,
  };
  return changedAssignment(state, command, {
    unassignments: [...(state.unassignments ?? []), unassignment],
  });
};

export const assignCommerceQuantityRule = (
  state: CommerceQuantityAssignmentSet,
  quantityRuleState: CustomerCommercePolicySet<CommerceQuantityRuleRevision>,
  command: CommerceQuantityAssignmentCommand,
): CommerceQuantityAssignmentResult => {
  const fingerprint = assignmentFingerprint(command);
  const receipt = (state.commandReceipts ?? []).find(
    ({ idempotencyKey }) => idempotencyKey === assignmentIdempotencyKey(command),
  );
  if (receipt !== undefined) {
    return receipt.fingerprint === fingerprint
      ? {
          _tag: 'UNCHANGED',
          completeness: assignmentCompleteness(state, command.observedAt),
          state,
        }
      : { _tag: 'IDEMPOTENCY_CONFLICT', reason: 'Idempotency key identifies a different assignment payload' };
  }
  if (state.generation !== command.expectedGeneration) {
    return {
      _tag: 'GENERATION_CONFLICT',
      actualGeneration: state.generation,
      expectedGeneration: command.expectedGeneration,
    };
  }
  return Match.value(command).pipe(
    Match.tag('ASSIGN', (assign) => assignQuantityRule(state, quantityRuleState, assign)),
    Match.tag('UNASSIGN', (unassign) => unassignQuantityRule(state, unassign)),
    Match.exhaustive,
  );
};

export const CurrentCommerceQuantityAssignmentSchema = Schema.Struct({
  assignmentId: assignmentIdSchema,
  effectiveFrom: CustomerCommercePolicyInstantSchema,
  effectiveTo: Schema.toEncoded(Schema.OptionFromNullOr(CustomerCommercePolicyInstantSchema)),
  profile: CommerceQuantityAssignmentProfileSchema,
  ruleRevisionRef: CommerceQuantityRuleRefSchema,
  sellingLegalEntityId: CustomerCommercePolicySellingLegalEntityIdSchema,
});
export type CurrentCommerceQuantityAssignment = typeof CurrentCommerceQuantityAssignmentSchema.Type;

const CurrentCommerceQuantityAssignmentSetSchema = Schema.Struct({
  assignments: Schema.Array(CurrentCommerceQuantityAssignmentSchema),
  completeness: Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema),
});
export type CurrentCommerceQuantityAssignmentSet = typeof CurrentCommerceQuantityAssignmentSetSchema.Type;

export const currentCommerceQuantityAssignmentSet = (
  state: CommerceQuantityAssignmentSet,
  at: string,
): CurrentCommerceQuantityAssignmentSet => ({
  assignments: state.assignments.flatMap((assignment) =>
    assignment.lifecycle === 'ACTIVE' &&
    assignment.effectiveFrom <= at &&
    (assignment.effectiveTo === null || at < assignment.effectiveTo) &&
    !(state.unassignments ?? []).some(
      (unassignment) => unassignment.assignmentId === assignment.assignmentId && unassignment.effectiveAt <= at,
    )
      ? [
          {
            assignmentId: assignment.assignmentId,
            effectiveFrom: assignment.effectiveFrom,
            effectiveTo: assignment.effectiveTo,
            profile: assignment.profile,
            ruleRevisionRef: assignment.ruleRevisionRef,
            sellingLegalEntityId: assignment.sellingLegalEntityId,
          },
        ]
      : [],
  ),
  completeness: assignmentCompleteness(state, at),
});

export const CurrentCommerceQuantityPolicySetSchema = Schema.Struct({
  assignmentSet: CurrentCommerceQuantityAssignmentSetSchema,
  ruleSet: CurrentCommerceQuantityRuleSetSchema,
});
export type CurrentCommerceQuantityPolicySet = typeof CurrentCommerceQuantityPolicySetSchema.Type;

export const currentCommerceQuantityPolicySet = (
  ruleState: CustomerCommercePolicySet<CommerceQuantityRuleRevision>,
  assignmentState: CommerceQuantityAssignmentSet,
  at: string,
): CurrentCommerceQuantityPolicySet => ({
  assignmentSet: currentCommerceQuantityAssignmentSet(assignmentState, at),
  ruleSet: currentCommerceQuantityRuleSet(ruleState, at),
});

export const summarizePolicyAdministrationResult = <Revision extends CustomerCommercePolicyRevision>(
  result: PolicyChanged<Revision> | PolicyUnchanged<Revision>,
): CustomerCommercePolicyMutationSummary => ({
  changed: Schema.is(CustomerCommercePolicyChangedTagSchema)(result),
  completeness: result.completeness,
  generation: result.state.generation,
  revisionIds: result.state.revisions.map(({ revisionId }) => revisionId),
});

export const summarizeAssignmentResult = (
  result: Extract<CommerceQuantityAssignmentResult, { readonly _tag: 'CHANGED' | 'UNCHANGED' }>,
): CustomerCommercePolicyMutationSummary => ({
  changed: Schema.is(CustomerCommercePolicyChangedTagSchema)(result),
  completeness: result.completeness,
  generation: result.state.generation,
  revisionIds: result.state.assignments.map(({ assignmentId }) => assignmentId),
});
