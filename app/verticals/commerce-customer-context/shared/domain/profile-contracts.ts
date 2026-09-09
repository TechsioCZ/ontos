import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { DateTime, Option, Schema, SchemaGetter } from 'effect';

export const ProfileBoundedKeySchema = Schema.toEncoded(
  Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(
    Schema.brand('ProfileBoundedKey'),
  ),
);
const BoundedReasonSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(1000));
const RevisionSchema = Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0));
const TenantIdSchema = Schema.toEncoded(
  Schema.String.check(Schema.isUUID()).pipe(Schema.brand('TenantId')),
);

const ProfileInstantDecodedSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    const parsed = DateTime.make(value);
    return Option.isSome(parsed) && DateTime.formatIso(parsed.value) === value
      ? undefined
      : 'must be a valid canonical UTC instant with millisecond precision';
  }),
).pipe(
  Schema.decodeTo(Schema.toType(Schema.DateTimeUtc), {
    decode: SchemaGetter.transform(DateTime.makeUnsafe),
    encode: SchemaGetter.transform(DateTime.formatIso),
  }),
);
export const ProfileInstantSchema = Schema.toEncoded(ProfileInstantDecodedSchema);
export type ProfileInstant = typeof ProfileInstantSchema.Type;

export const SellingLegalEntityRefSchema = Schema.Struct({
  moduleId: Schema.Literal('core.identity'),
  resourceId: ProfileBoundedKeySchema,
  resourceType: Schema.Literal('core.identity.legal-entity'),
  tenantId: TenantIdSchema,
});
export type SellingLegalEntityRef = typeof SellingLegalEntityRefSchema.Type;

export const ProfileActorSchema = Schema.Struct({
  actorId: ProfileBoundedKeySchema,
  actorType: Schema.Literals(['HUMAN', 'SERVICE', 'ASSISTED_SUPPORT']),
});
export type ProfileActor = typeof ProfileActorSchema.Type;

export const CommerceCustomerProfileKindSchema = Schema.Literals(['RETAIL', 'COUNTERPARTY']);
export type CommerceCustomerProfileKind = typeof CommerceCustomerProfileKindSchema.Type;

export const CommerceCustomerProfileStateSchema = Schema.Literals([
  'ACTIVE',
  'SUSPENDED',
  'ARCHIVED',
]);
export type CommerceCustomerProfileState = typeof CommerceCustomerProfileStateSchema.Type;

export const RetailCustomerProfileSubjectSchema = Schema.Struct({
  kind: Schema.Literal('RETAIL'),
  partyRef: PartyRefSchema,
  sellingLegalEntityRef: SellingLegalEntityRefSchema,
}).check(
  Schema.makeFilter(({ partyRef, sellingLegalEntityRef }) =>
    partyRef.tenantId === sellingLegalEntityRef.tenantId
      ? undefined
      : {
          issue: 'Retail Party and Selling Legal Entity must belong to the same Tenant',
          path: ['sellingLegalEntityRef', 'tenantId'],
        },
  ),
);
export type RetailCustomerProfileSubject = typeof RetailCustomerProfileSubjectSchema.Type;

export const CounterpartyPurchasingProfileSubjectSchema = Schema.Struct({
  counterpartyRef: CounterpartyRefSchema,
  kind: Schema.Literal('COUNTERPARTY'),
  /** The currently authorized seller scope; this is evidence, never part of the global key. */
  sellingLegalEntityRef: Schema.optionalKey(SellingLegalEntityRefSchema),
});
export type CounterpartyPurchasingProfileSubject =
  typeof CounterpartyPurchasingProfileSubjectSchema.Type;

export const CommerceCustomerProfileSubjectSchema = Schema.Union([
  RetailCustomerProfileSubjectSchema,
  CounterpartyPurchasingProfileSubjectSchema,
]);
export type CommerceCustomerProfileSubject = typeof CommerceCustomerProfileSubjectSchema.Type;

export const ProfileLifecycleOperationSchema = Schema.Literals([
  'SUSPEND',
  'REACTIVATE',
  'ARCHIVE',
]);
export type ProfileLifecycleOperation = typeof ProfileLifecycleOperationSchema.Type;

const allowedLifecycleTransition = (
  operation: ProfileLifecycleOperation,
  fromState: CommerceCustomerProfileState,
  toState: CommerceCustomerProfileState,
): boolean =>
  (operation === 'SUSPEND' && fromState === 'ACTIVE' && toState === 'SUSPENDED') ||
  (operation === 'REACTIVATE' &&
    (fromState === 'SUSPENDED' || fromState === 'ARCHIVED') &&
    toState === 'ACTIVE') ||
  (operation === 'ARCHIVE' &&
    (fromState === 'ACTIVE' || fromState === 'SUSPENDED') &&
    toState === 'ARCHIVED');

export const ProfileLifecycleTransitionSchema = Schema.Struct({
  actor: ProfileActorSchema,
  effectiveAt: ProfileInstantSchema,
  expectedRevision: RevisionSchema,
  fromState: CommerceCustomerProfileStateSchema,
  idempotencyKey: ProfileBoundedKeySchema,
  operation: ProfileLifecycleOperationSchema,
  reason: BoundedReasonSchema,
  toState: CommerceCustomerProfileStateSchema,
}).check(
  Schema.makeFilter(({ fromState, operation, toState }) =>
    allowedLifecycleTransition(operation, fromState, toState)
      ? undefined
      : 'operation, fromState, and toState do not form a supported profile lifecycle transition',
  ),
);
export type ProfileLifecycleTransition = typeof ProfileLifecycleTransitionSchema.Type;

export const ProfileLifecycleDecisionSchema = Schema.Union([
  Schema.Struct({
    currentRevision: RevisionSchema,
    currentState: CommerceCustomerProfileStateSchema,
    outcome: Schema.Literal('CURRENT_STATE_CONFLICT'),
  }),
  Schema.Struct({
    currentRevision: RevisionSchema,
    currentState: CommerceCustomerProfileStateSchema,
    outcome: Schema.Literal('INVALID_LIFECYCLE_TRANSITION'),
    requestedOperation: ProfileLifecycleOperationSchema,
  }),
  Schema.Struct({
    currentRevision: RevisionSchema,
    currentState: CommerceCustomerProfileStateSchema,
    outcome: Schema.Literal('PROFILE_RECONCILIATION_REQUIRED'),
  }),
  Schema.Struct({
    currentRevision: RevisionSchema,
    currentState: CommerceCustomerProfileStateSchema,
    outcome: Schema.Literal('DEPENDENCY_UNAVAILABLE'),
  }),
  Schema.Struct({
    currentRevision: RevisionSchema,
    currentState: CommerceCustomerProfileStateSchema,
    outcome: Schema.Literal('REACTIVATION_RECONFIRMATION_REQUIRED'),
  }),
  Schema.Struct({
    currentRevision: RevisionSchema,
    outcome: Schema.Literal('IDEMPOTENT'),
    resultingState: CommerceCustomerProfileStateSchema,
  }),
  Schema.Struct({
    outcome: Schema.Literal('APPLIED'),
    resultingRevision: RevisionSchema,
    resultingState: CommerceCustomerProfileStateSchema,
  }),
]);
export type ProfileLifecycleDecision = typeof ProfileLifecycleDecisionSchema.Type;

export const ProfileCreateTriggerSchema = Schema.Literals([
  'AUTHORIZED_ONBOARDING',
  'ENSURE_BEFORE_ORDER_ACCEPTANCE',
  'GUEST_RETAIL_ATTRIBUTION',
]);
export type ProfileCreateTrigger = typeof ProfileCreateTriggerSchema.Type;

export const ProfileCreateObservedStateSchema = Schema.Literals([
  'ABSENT',
  'ACTIVE',
  'SUSPENDED',
  'ARCHIVED',
  'SUBJECT_NOT_RESOLVED_OR_INVALID',
  'COUNTERPARTY_ROLE_NOT_ELIGIBLE',
  'PROFILE_KIND_OR_SUBJECT_CONFLICT',
  'PROFILE_RECONCILIATION_REQUIRED',
  'CURRENT_STATE_CONFLICT',
  'DEPENDENCY_UNAVAILABLE',
  'PERSISTENCE_UNAVAILABLE',
  'COMMIT_INDETERMINATE',
]);
export type ProfileCreateObservedState = typeof ProfileCreateObservedStateSchema.Type;

export const DependencyFreshnessSchema = Schema.Struct({
  observedAt: ProfileInstantSchema,
  revision: Schema.optionalKey(ProfileBoundedKeySchema),
  sourceModuleId: ProfileBoundedKeySchema,
  status: Schema.Literals(['CURRENT', 'STALE', 'UNAVAILABLE', 'INDETERMINATE']),
});
export type DependencyFreshness = typeof DependencyFreshnessSchema.Type;

export const ProfileReadProvenanceSchema = Schema.Struct({
  freshness: DependencyFreshnessSchema,
  projection: Schema.Literals([
    'PROFILE',
    'PARTY_REGISTRY',
    'RETAIL_BINDING',
    'COUNTERPARTY_ACCESS',
    'OWNING_CAPABILITY',
  ]),
  sourceResourceRef: Schema.optionalKey(ProfileBoundedKeySchema),
});
export type ProfileReadProvenance = typeof ProfileReadProvenanceSchema.Type;

export const RETAIL_PORTAL_PERMISSION_CODES = [
  'retail.profile.read',
  'retail.settings.currency.manage',
  'retail.settings.payment_term_preference.manage',
  'retail.address_book.use',
  'retail.address_book.manage',
  'retail.history.read',
  'retail.repeat_order',
  'retail.guest_order.claim',
  'retail.aftercare.read',
  'retail.claim.create',
  'retail.consent.manage',
  'retail.notifications.manage',
] as const;

export const RetailPortalPermissionCodeSchema = Schema.Literals(RETAIL_PORTAL_PERMISSION_CODES);
export type RetailPortalPermissionCode = typeof RetailPortalPermissionCodeSchema.Type;

export const RETAIL_PORTAL_PERMISSION_CATALOG = [
  {
    code: 'retail.profile.read',
    launchBaseline: true,
    meaning: 'Read the permitted Current Commerce Retail Customer Profile view.',
    optionalCapability: null,
  },
  {
    code: 'retail.settings.currency.manage',
    launchBaseline: false,
    meaning: 'Set or clear the bound profile currency preference.',
    optionalCapability: 'CUSTOMER_CURRENCY_PREFERENCE',
  },
  {
    code: 'retail.settings.payment_term_preference.manage',
    launchBaseline: false,
    meaning: 'Select or clear a preference among already entitled Payment Terms.',
    optionalCapability: 'PAYMENT_TERM_PREFERENCE',
  },
  {
    code: 'retail.address_book.use',
    launchBaseline: true,
    meaning: 'Use permitted address candidates for a purchase by the bound profile.',
    optionalCapability: null,
  },
  {
    code: 'retail.address_book.manage',
    launchBaseline: true,
    meaning: 'Manage Commerce-owned saved addresses and persistent defaults.',
    optionalCapability: null,
  },
  {
    code: 'retail.history.read',
    launchBaseline: true,
    meaning: 'Read Orders independently made customer-visible to the bound profile.',
    optionalCapability: null,
  },
  {
    code: 'retail.repeat_order',
    launchBaseline: true,
    meaning: 'Prepare a new Cart from an eligible visible historical Order.',
    optionalCapability: null,
  },
  {
    code: 'retail.guest_order.claim',
    launchBaseline: false,
    meaning: 'Invoke explicitly verified Guest Order Claim when enabled.',
    optionalCapability: 'GUEST_ORDER_CLAIM',
  },
  {
    code: 'retail.aftercare.read',
    launchBaseline: true,
    meaning: 'Read customer-visible Claim and aftercare records.',
    optionalCapability: null,
  },
  {
    code: 'retail.claim.create',
    launchBaseline: true,
    meaning: 'Create a Claim for an eligible visible Order line.',
    optionalCapability: null,
  },
  {
    code: 'retail.consent.manage',
    launchBaseline: true,
    meaning: 'Manage consent preferences through their owning capability.',
    optionalCapability: null,
  },
  {
    code: 'retail.notifications.manage',
    launchBaseline: false,
    meaning: 'Manage notification preferences when enabled.',
    optionalCapability: 'NOTIFICATIONS',
  },
] as const satisfies readonly {
  readonly code: RetailPortalPermissionCode;
  readonly launchBaseline: boolean;
  readonly meaning: string;
  readonly optionalCapability: null | string;
}[];

export const RETAIL_PORTAL_SELF_SERVICE_BASELINE = RETAIL_PORTAL_PERMISSION_CATALOG.flatMap(
  ({ code, launchBaseline }) => (launchBaseline ? [code] : []),
);

export const RetailPortalAuthorityGroupSchema = Schema.Struct({
  groupKey: Schema.Literal('RETAIL_PORTAL_SELF_SERVICE'),
  permissions: Schema.Array(RetailPortalPermissionCodeSchema).check(
    Schema.isMinLength(RETAIL_PORTAL_SELF_SERVICE_BASELINE.length),
    Schema.makeFilter((permissions) =>
      new Set(permissions).size === permissions.length
        ? undefined
        : 'Authority group Permission codes must be unique',
    ),
    Schema.makeFilter((permissions) =>
      RETAIL_PORTAL_SELF_SERVICE_BASELINE.every((permission) => permissions.includes(permission))
        ? undefined
        : 'Retail Portal Self-Service must retain every reviewed baseline Permission',
    ),
  ),
  version: ProfileBoundedKeySchema,
});
export type RetailPortalAuthorityGroup = typeof RetailPortalAuthorityGroupSchema.Type;

export const RetailPortalBindingStateSchema = Schema.Literals(['ACTIVE', 'REVOKED']);
export type RetailPortalBindingState = typeof RetailPortalBindingStateSchema.Type;

/** Durable owner-local authorization state; it is independent from the binding lifecycle. */
export const RetailPortalBindingAuthorizationStateSchema = Schema.Literals([
  'ACTIVE',
  'REVOKED',
  'PENDING_GRANT',
  'PENDING_REVOKE',
  'RECONCILIATION_REQUIRED',
]);
export type RetailPortalBindingAuthorizationState =
  typeof RetailPortalBindingAuthorizationStateSchema.Type;
export const RetailPortalBindingAuthorizationOperationSchema = Schema.Literals(['grant', 'revoke']);
export type RetailPortalBindingAuthorizationOperation =
  typeof RetailPortalBindingAuthorizationOperationSchema.Type;

export const ReconciliationCaseStateSchema = Schema.Literals([
  'OPEN',
  'BLOCKED',
  'READY_TO_COMPLETE',
  'COMPLETED',
]);
export type ReconciliationCaseState = typeof ReconciliationCaseStateSchema.Type;

export const RECONCILIATION_REQUIRED_OWNERS = [
  'PROFILE_LIFECYCLE',
  'CUSTOMER_GROUP_MEMBERSHIP',
  'PRICE_GROUP_ASSIGNMENT',
  'CURRENCY_PREFERENCE',
  'PAYMENT_TERMS',
  'ADDRESS_BOOK',
  'RETAIL_PORTAL_BINDING',
  'COUNTERPARTY_ACCESS',
  'PURCHASE_LIMITS',
  'APPROVAL',
  'CONNECTOR_CORRELATION',
] as const;

export const ReconciliationOwnerSchema = Schema.Literals(RECONCILIATION_REQUIRED_OWNERS);
export type ReconciliationOwner = typeof ReconciliationOwnerSchema.Type;

export const ReconciliationOwnerOutcomeSchema = Schema.Struct({
  evidenceRef: Schema.optionalKey(ProfileBoundedKeySchema),
  owner: ReconciliationOwnerSchema,
  status: Schema.Literals(['PENDING', 'RESOLVED', 'BLOCKED', 'NOT_APPLICABLE']),
}).check(
  Schema.makeFilter(({ evidenceRef, status }) =>
    (status === 'RESOLVED' || status === 'NOT_APPLICABLE') && evidenceRef === undefined
      ? 'Completed owner outcomes require a safe evidence reference'
      : undefined,
  ),
);
export type ReconciliationOwnerOutcome = typeof ReconciliationOwnerOutcomeSchema.Type;

export const GuestPartyResolutionOutcomeSchema = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal('EXISTING_PARTY_RESOLVED'), partyRef: PartyRefSchema }),
  Schema.Struct({ outcome: Schema.Literal('UNRESOLVED_PARTY_CREATED'), partyRef: PartyRefSchema }),
  Schema.Struct({ caseRef: ProfileBoundedKeySchema, outcome: Schema.Literal('AMBIGUOUS_MATCH') }),
  Schema.Struct({
    outcome: Schema.Literal('INVALID_OR_INSUFFICIENT_EVIDENCE'),
    reason: BoundedReasonSchema,
  }),
  Schema.Struct({
    outcome: Schema.Literal('PARTY_OWNER_UNAVAILABLE'),
    retryable: Schema.Literal(true),
  }),
  Schema.Struct({
    outcome: Schema.Literal('PARTY_OWNER_INDETERMINATE'),
    retryable: Schema.Literal(true),
  }),
]);
export type GuestPartyResolutionOutcome = typeof GuestPartyResolutionOutcomeSchema.Type;

export const ProfileRevisionSchema = RevisionSchema;
export const ProfileBoundedReasonSchema = BoundedReasonSchema;
