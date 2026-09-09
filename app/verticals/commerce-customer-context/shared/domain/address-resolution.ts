import { CounterpartyRefSchema } from '@app/party-registry/resources/counterparty';
import { PartyContactPointRefSchema } from '@app/party-registry/resources/party-contact-point';
import { PartyOfficialIdentifierRefSchema } from '@app/party-registry/resources/party-official-identifier';
import { PartyRefSchema } from '@app/party-registry/resources/party';
import { Effect, Schema } from 'effect';
import {
  AddressBookProfileSchema,
  PostalAddressSchema,
  isAddressEligibleFor,
} from './address-book.ts';
import type { AddressBookProfile, PostalAddress, SavedAddress } from './address-book.ts';
import type { AddressBookUnavailable } from './address-errors.ts';
import { ProfileInstantSchema, SellingLegalEntityRefSchema } from './profile-contracts.ts';
import { SavedAddressRefSchema } from '../resources/saved-address.ts';

const StableTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const PositiveRevisionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
export const ResolutionTenantIdSchema = Schema.String.check(Schema.isUUID()).pipe(
  Schema.brand('ResolutionTenantId'),
  Schema.decodeTo(Schema.String),
);
export const ResolutionCartIdSchema = StableTextSchema.pipe(
  Schema.brand('ResolutionCartId'),
  Schema.decodeTo(Schema.String),
);
export const ResolutionChannelIdSchema = StableTextSchema.pipe(
  Schema.brand('ResolutionChannelId'),
  Schema.decodeTo(Schema.String),
);
export const ResolutionMarketIdSchema = StableTextSchema.pipe(
  Schema.brand('ResolutionMarketId'),
  Schema.decodeTo(Schema.String),
);
export const ResolutionLegalEntityIdSchema = StableTextSchema.pipe(
  Schema.brand('ResolutionLegalEntityId'),
  Schema.decodeTo(Schema.String),
);
export const ResolutionStorefrontIdSchema = StableTextSchema.pipe(
  Schema.brand('ResolutionStorefrontId'),
  Schema.decodeTo(Schema.String),
);
export const ResolutionPrincipalIdSchema = StableTextSchema.pipe(
  Schema.brand('ResolutionPrincipalId'),
  Schema.decodeTo(Schema.String),
);
export const ResolutionModuleIdSchema = StableTextSchema.pipe(
  Schema.brand('ResolutionModuleId'),
  Schema.decodeTo(Schema.String),
);
export const ResolutionResourceIdSchema = StableTextSchema.pipe(
  Schema.brand('ResolutionResourceId'),
  Schema.decodeTo(Schema.String),
);

export type AddressLookup<A> =
  | Readonly<{ kind: 'FOUND'; value: A }>
  | Readonly<{ kind: 'NOT_FOUND' }>;
export const found = <A>(value: A): AddressLookup<A> => ({ kind: 'FOUND', value });
export const notFound = <A>(): AddressLookup<A> => ({ kind: 'NOT_FOUND' });
export type AddressDefaultLookup<A> =
  | Readonly<{ kind: 'FOUND'; value: A }>
  | Readonly<{ kind: 'NONE' }>
  | Readonly<{ kind: 'INVALID'; reason: string }>;

export const ResolutionSourceRevisionSchema = Schema.Struct({
  revision: StableTextSchema,
  source: StableTextSchema,
});
export const ResolutionSourceRevisionVectorSchema = Schema.Array(
  ResolutionSourceRevisionSchema,
).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(100),
  Schema.makeFilter((values) =>
    new Set(values.map(({ source }) => source)).size === values.length
      ? undefined
      : 'Resolution source revisions must contain one value per source',
  ),
);
export type ResolutionSourceRevisionVector = typeof ResolutionSourceRevisionVectorSchema.Type;

export const PurchaseResolutionContextClaimSchema = Schema.Struct({
  cartId: ResolutionCartIdSchema,
  channelId: ResolutionChannelIdSchema,
  expectedProposalRevision: PositiveRevisionSchema,
  expectedSourceRevisions: ResolutionSourceRevisionVectorSchema,
  marketId: ResolutionMarketIdSchema,
  sellingLegalEntityId: ResolutionLegalEntityIdSchema,
  storefrontId: ResolutionStorefrontIdSchema,
  tenantId: ResolutionTenantIdSchema,
});
export type PurchaseResolutionContextClaim = typeof PurchaseResolutionContextClaimSchema.Type;

export const ResolutionActorSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('PRINCIPAL'), principalId: ResolutionPrincipalIdSchema }),
  Schema.Struct({
    guestEvidenceRef: StableTextSchema,
    guestSessionRef: StableTextSchema,
    kind: Schema.Literal('GUEST'),
  }),
]);

export const CurrentPurchaseResolutionContextSchema = Schema.Struct({
  actor: ResolutionActorSchema,
  cartId: ResolutionCartIdSchema,
  channelId: ResolutionChannelIdSchema,
  decidedAt: ProfileInstantSchema,
  marketId: ResolutionMarketIdSchema,
  proposalRevision: PositiveRevisionSchema,
  sellingLegalEntityRef: SellingLegalEntityRefSchema,
  storefrontId: ResolutionStorefrontIdSchema,
  tenantId: ResolutionTenantIdSchema,
});
export type CurrentPurchaseResolutionContext = typeof CurrentPurchaseResolutionContextSchema.Type;

export const ResolutionDecisionEvidenceSchema = Schema.Struct({
  decidedAt: ProfileInstantSchema,
  decisionRef: StableTextSchema,
  owner: Schema.Literals([
    'PARTY_REGISTRY',
    'CUSTOMER_COMMERCE_POLICY',
    'TAX',
    'BILLING_DOCUMENTS',
    'FULFILLMENT',
    'DELIVERY_AVAILABILITY',
    'PICKUP_PROVIDER',
  ]),
  revision: StableTextSchema,
  validUntil: Schema.optional(ProfileInstantSchema),
});
export type ResolutionDecisionEvidence = typeof ResolutionDecisionEvidenceSchema.Type;

export const InvoiceRecipientOfficialIdentifierSchema = Schema.Union([
  Schema.Struct({
    identifierType: StableTextSchema,
    normalizedValue: StableTextSchema,
    officialIdentifierRef: PartyOfficialIdentifierRefSchema,
    source: Schema.Literal('PARTY_REGISTRY'),
    sourceRevision: PositiveRevisionSchema,
    verification: Schema.Literal('VERIFIED'),
  }),
  Schema.Struct({
    evidenceRef: StableTextSchema,
    identifierType: StableTextSchema,
    normalizedValue: StableTextSchema,
    source: Schema.Literal('PURCHASE_EVIDENCE'),
    sourceRevision: PositiveRevisionSchema,
    verification: Schema.Literal('VERIFIED'),
  }),
]);

const InvoiceRecipientIdentityFields = {
  displayName: StableTextSchema,
  legalName: StableTextSchema,
  officialIdentifiers: Schema.Array(InvoiceRecipientOfficialIdentifierSchema).check(
    Schema.isMaxLength(50),
  ),
  sourceRevision: PositiveRevisionSchema,
} as const;

export const InvoiceRecipientIdentitySchema = Schema.Union([
  Schema.Struct({
    ...InvoiceRecipientIdentityFields,
    kind: Schema.Literal('RETAIL_PARTY'),
    partyRef: PartyRefSchema,
  }),
  Schema.Struct({
    ...InvoiceRecipientIdentityFields,
    counterpartyRef: CounterpartyRefSchema,
    kind: Schema.Literal('COUNTERPARTY_PARTY'),
    partyRef: PartyRefSchema,
  }),
  Schema.Struct({
    ...InvoiceRecipientIdentityFields,
    guestEvidenceRef: StableTextSchema,
    kind: Schema.Literal('GUEST_SNAPSHOT'),
  }),
]);
export type InvoiceRecipientIdentity = typeof InvoiceRecipientIdentitySchema.Type;

export const InvoiceRecipientChoiceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('SAVED_ADDRESS'), savedAddressRef: SavedAddressRefSchema }),
  Schema.Struct({
    choiceEvidenceRef: StableTextSchema,
    kind: Schema.Literal('ONE_TIME'),
    postalAddress: PostalAddressSchema,
  }),
]);

export const PurchaseResolutionSubjectSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('PROFILE'), profile: AddressBookProfileSchema }),
  Schema.Struct({
    guestEvidenceRef: StableTextSchema,
    guestSessionRef: StableTextSchema,
    kind: Schema.Literal('GUEST'),
  }),
]);
export type PurchaseResolutionSubject = typeof PurchaseResolutionSubjectSchema.Type;
export const InvoiceRecipientSubjectSchema = PurchaseResolutionSubjectSchema;

export const InvoiceRecipientResolutionRequestSchema = Schema.Struct({
  explicitChoice: Schema.optional(InvoiceRecipientChoiceSchema),
  purchasingContext: PurchaseResolutionContextClaimSchema,
  subject: InvoiceRecipientSubjectSchema,
}).check(
  Schema.makeFilter(({ explicitChoice, purchasingContext, subject }) => {
    const profileTenantId = subject.kind === 'PROFILE' ? subject.profile.profileRef.tenantId : null;
    const subjectMatches =
      profileTenantId === null || purchasingContext.tenantId === profileTenantId;
    const choiceMatches =
      explicitChoice?.kind !== 'SAVED_ADDRESS' ||
      (subject.kind === 'PROFILE' &&
        explicitChoice.savedAddressRef.tenantId === purchasingContext.tenantId);
    return subjectMatches && choiceMatches
      ? undefined
      : 'The Invoice Recipient subject and every nested reference must share one Tenant; Guests cannot select saved addresses';
  }),
);
export type InvoiceRecipientResolutionRequest = typeof InvoiceRecipientResolutionRequestSchema.Type;

export const ResolvedSavedAddressSourceSchema = Schema.Union([
  Schema.Struct({
    currentContactPointRef: PartyContactPointRefSchema,
    currentPartyRef: PartyRefSchema,
    currentSourceRevision: PositiveRevisionSchema,
    kind: Schema.Literal('SAVED_ADDRESS'),
    originKind: Schema.Literal('PARTY_BACKED'),
    savedAddressRef: SavedAddressRefSchema,
    savedAddressRevision: PositiveRevisionSchema,
    storedContactPointRef: PartyContactPointRefSchema,
    storedPartyRef: PartyRefSchema,
    storedSourceRevision: PositiveRevisionSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('SAVED_ADDRESS'),
    originKind: Schema.Literal('COMMERCE_ONLY'),
    savedAddressRef: SavedAddressRefSchema,
    savedAddressRevision: PositiveRevisionSchema,
  }),
]);
export type ResolvedSavedAddressSource = typeof ResolvedSavedAddressSourceSchema.Type;

export type ResolvedSavedPostalAddress =
  | Readonly<{
      currentContactPointRef: typeof PartyContactPointRefSchema.Type;
      currentPartyRef: typeof PartyRefSchema.Type;
      currentSourceRevision: number;
      kind: 'PARTY_BACKED';
      postalAddress: PostalAddress;
    }>
  | Readonly<{ kind: 'COMMERCE_ONLY'; postalAddress: PostalAddress }>;

export const InvoiceRecipientAddressSourceSchema = Schema.Union([
  ResolvedSavedAddressSourceSchema,
  Schema.Struct({ choiceEvidenceRef: StableTextSchema, kind: Schema.Literal('ONE_TIME') }),
  Schema.Struct({
    kind: Schema.Literal('POLICY'),
    policyDecision: ResolutionDecisionEvidenceSchema,
  }),
]);

export const AcceptedInvoiceRecipientSchema = Schema.Struct({
  billingAddress: PostalAddressSchema,
  countryCode: PostalAddressSchema.fields.countryCode,
  identity: InvoiceRecipientIdentitySchema,
  source: InvoiceRecipientAddressSourceSchema,
  subject: InvoiceRecipientSubjectSchema,
}).check(
  Schema.makeFilter(({ billingAddress, countryCode, identity, source, subject }) => {
    const tenantId = subject.kind === 'PROFILE' ? subject.profile.profileRef.tenantId : undefined;
    const identityMatches =
      subject.kind === 'GUEST'
        ? identity.kind === 'GUEST_SNAPSHOT' &&
          identity.guestEvidenceRef === subject.guestEvidenceRef
        : identity.kind !== 'GUEST_SNAPSHOT' &&
          identity.partyRef.tenantId === tenantId &&
          (identity.kind !== 'COUNTERPARTY_PARTY' ||
            identity.counterpartyRef.tenantId === tenantId);
    const sourceMatches =
      source.kind === 'SAVED_ADDRESS'
        ? subject.kind === 'PROFILE' &&
          source.savedAddressRef.tenantId === tenantId &&
          (source.originKind === 'COMMERCE_ONLY' ||
            (source.storedContactPointRef.tenantId === tenantId &&
              source.storedPartyRef.tenantId === tenantId &&
              source.currentContactPointRef.tenantId === tenantId &&
              source.currentPartyRef.tenantId === tenantId))
        : true;
    return billingAddress.countryCode === countryCode && identityMatches && sourceMatches
      ? undefined
      : 'Accepted Invoice Recipient references and country must be coherent';
  }),
);
export type AcceptedInvoiceRecipient = typeof AcceptedInvoiceRecipientSchema.Type;

export const InvoiceRecipientDecisionBundleSchema = Schema.Struct({
  acceptedHandoff: Schema.Literal('ORDER_ACCEPTANCE_INVOICE_RECIPIENT_V1'),
  billingEvidence: ResolutionDecisionEvidenceSchema,
  legalEvidence: ResolutionDecisionEvidenceSchema,
  purchasingContext: CurrentPurchaseResolutionContextSchema,
  recipient: AcceptedInvoiceRecipientSchema,
  sourceRevisions: ResolutionSourceRevisionVectorSchema,
  taxEvidence: ResolutionDecisionEvidenceSchema,
}).check(
  Schema.makeFilter(({ purchasingContext, recipient }) => {
    const { tenantId } = purchasingContext;
    const subjectMatches =
      recipient.subject.kind === 'GUEST' ||
      recipient.subject.profile.profileRef.tenantId === tenantId;
    const identityMatches =
      recipient.identity.kind === 'GUEST_SNAPSHOT' ||
      (recipient.identity.partyRef.tenantId === tenantId &&
        (recipient.identity.kind !== 'COUNTERPARTY_PARTY' ||
          recipient.identity.counterpartyRef.tenantId === tenantId) &&
        recipient.identity.officialIdentifiers.every(
          (identifier) =>
            identifier.source !== 'PARTY_REGISTRY' ||
            identifier.officialIdentifierRef.tenantId === tenantId,
        ));
    return purchasingContext.sellingLegalEntityRef.tenantId === tenantId &&
      subjectMatches &&
      identityMatches
      ? undefined
      : 'Invoice Recipient decision references must belong to the trusted purchase Tenant';
  }),
);

export const InvoiceRecipientResolutionSchema = Schema.Union([
  Schema.Struct({
    decisionBundle: InvoiceRecipientDecisionBundleSchema,
    kind: Schema.Literal('INVOICE_RECIPIENT_RESOLVED'),
    source: Schema.Literals(['EXPLICIT', 'DEFAULT', 'POLICY']),
  }),
  Schema.Struct({
    kind: Schema.Literals([
      'EXPLICIT_CHOICE_INVALID',
      'INVOICE_RECIPIENT_REQUIRED',
      'DEFAULT_BILLING_ADDRESS_INVALID',
      'IDENTITY_OR_OFFICIAL_IDENTIFIER_INCOMPLETE',
      'BILLING_ADDRESS_NOT_ELIGIBLE',
      'TAX_OR_LEGAL_VALIDATION_REQUIRED',
      'INCONSISTENT_CONFIGURATION',
      'STALE_SOURCE',
    ]),
    reason: Schema.String,
  }),
]);
export type InvoiceRecipientResolution = typeof InvoiceRecipientResolutionSchema.Type;

export interface InvoiceRecipientCurrentFacts {
  readonly identity: InvoiceRecipientIdentity;
  readonly purchasingContext: CurrentPurchaseResolutionContext;
  readonly sourceRevisions: ResolutionSourceRevisionVector;
  readonly subject: PurchaseResolutionSubject;
}

export type InvoiceRecipientValidationDecision =
  | Readonly<{
      billingEvidence: ResolutionDecisionEvidence;
      kind: 'ACCEPTED';
      legalEvidence: ResolutionDecisionEvidence;
      taxEvidence: ResolutionDecisionEvidence;
    }>
  | Readonly<{
      kind:
        | 'IDENTITY_OR_OFFICIAL_IDENTIFIER_INCOMPLETE'
        | 'BILLING_ADDRESS_NOT_ELIGIBLE'
        | 'TAX_OR_LEGAL_VALIDATION_REQUIRED'
        | 'INCONSISTENT_CONFIGURATION'
        | 'STALE_SOURCE';
      reason: string;
    }>;

export interface InvoiceRecipientPolicyCandidate {
  readonly policyDecision: ResolutionDecisionEvidence;
  readonly postalAddress: PostalAddress;
}

export interface ResolutionTrustedScope {
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly storefrontId: string;
  readonly tenantId: string;
}

export interface InvoiceRecipientPorts {
  readonly constructPolicyRecipient: (
    current: InvoiceRecipientCurrentFacts,
  ) => Effect.Effect<AddressLookup<InvoiceRecipientPolicyCandidate>, AddressBookUnavailable>;
  readonly loadCurrent: (
    request: InvoiceRecipientResolutionRequest,
    scope: ResolutionTrustedScope,
  ) => Effect.Effect<InvoiceRecipientCurrentFacts, AddressBookUnavailable>;
  readonly loadDefaultBillingAddress: (
    profile: AddressBookProfile,
  ) => Effect.Effect<AddressDefaultLookup<SavedAddress>, AddressBookUnavailable>;
  readonly loadSavedAddress: (request: {
    profile: AddressBookProfile;
    resourceId: string;
  }) => Effect.Effect<AddressLookup<SavedAddress>, AddressBookUnavailable>;
  readonly resolvePostalAddress: (
    address: SavedAddress,
  ) => Effect.Effect<AddressLookup<ResolvedSavedPostalAddress>, AddressBookUnavailable>;
  readonly validateRecipient: (request: {
    candidate: AcceptedInvoiceRecipient;
    current: InvoiceRecipientCurrentFacts;
  }) => Effect.Effect<InvoiceRecipientValidationDecision, AddressBookUnavailable>;
}

const invalid = (
  kind: Exclude<InvoiceRecipientResolution['kind'], 'INVOICE_RECIPIENT_RESOLVED'>,
  reason: string,
): InvoiceRecipientResolution => ({ kind, reason });

const revisionMap = (revisions: ResolutionSourceRevisionVector) =>
  new Map(revisions.map(({ revision, source }) => [source, revision]));

export const hasExactResolutionRevisions = (
  expected: ResolutionSourceRevisionVector,
  current: ResolutionSourceRevisionVector,
) => {
  const expectedBySource = revisionMap(expected);
  const currentBySource = revisionMap(current);
  return (
    expectedBySource.size === currentBySource.size &&
    [...expectedBySource].every(([source, revision]) => currentBySource.get(source) === revision)
  );
};

export const purchaseResolutionContextMatches = (
  claim: PurchaseResolutionContextClaim,
  current: CurrentPurchaseResolutionContext,
) =>
  claim.cartId === current.cartId &&
  claim.channelId === current.channelId &&
  claim.expectedProposalRevision === current.proposalRevision &&
  claim.marketId === current.marketId &&
  claim.sellingLegalEntityId === current.sellingLegalEntityRef.resourceId &&
  claim.storefrontId === current.storefrontId &&
  claim.tenantId === current.tenantId;

const savedAddressSource = (
  address: SavedAddress,
  resolved: ResolvedSavedPostalAddress,
): ResolvedSavedAddressSource =>
  address.origin.kind === 'PARTY_BACKED' && resolved.kind === 'PARTY_BACKED'
    ? {
        currentContactPointRef: resolved.currentContactPointRef,
        currentPartyRef: resolved.currentPartyRef,
        currentSourceRevision: resolved.currentSourceRevision,
        kind: 'SAVED_ADDRESS',
        originKind: 'PARTY_BACKED',
        savedAddressRef: address.savedAddressRef,
        savedAddressRevision: address.revision,
        storedContactPointRef: address.origin.contactPointRef,
        storedPartyRef: address.origin.partyRef,
        storedSourceRevision: address.origin.sourceRevision,
      }
    : {
        kind: 'SAVED_ADDRESS',
        originKind: 'COMMERCE_ONLY',
        savedAddressRef: address.savedAddressRef,
        savedAddressRevision: address.revision,
      };

const resourceRefsMatch = (
  left: Readonly<{
    moduleId: string;
    resourceId: string;
    resourceType: string;
    tenantId: string;
  }>,
  right: Readonly<{
    moduleId: string;
    resourceId: string;
    resourceType: string;
    tenantId: string;
  }>,
) =>
  left.moduleId === right.moduleId &&
  left.resourceId === right.resourceId &&
  left.resourceType === right.resourceType &&
  left.tenantId === right.tenantId;

export const purchaseResolutionSubjectsMatch = (
  requested: PurchaseResolutionSubject,
  current: PurchaseResolutionSubject,
) => {
  if (requested.kind === 'GUEST' || current.kind === 'GUEST') {
    return (
      requested.kind === 'GUEST' &&
      current.kind === 'GUEST' &&
      requested.guestEvidenceRef === current.guestEvidenceRef &&
      requested.guestSessionRef === current.guestSessionRef
    );
  }
  if (
    requested.profile.kind !== current.profile.kind ||
    !resourceRefsMatch(requested.profile.profileRef, current.profile.profileRef)
  ) {
    return false;
  }
  return requested.profile.kind === 'RETAIL' || current.profile.kind === 'RETAIL'
    ? requested.profile.kind === current.profile.kind
    : resourceRefsMatch(requested.profile.counterpartyRef, current.profile.counterpartyRef);
};

const invoiceSubjectMatchesCurrent = (
  request: InvoiceRecipientResolutionRequest,
  current: InvoiceRecipientCurrentFacts,
  scope: ResolutionTrustedScope,
) =>
  purchaseResolutionSubjectsMatch(request.subject, current.subject) &&
  (request.subject.kind === 'GUEST'
    ? current.purchasingContext.actor.kind === 'GUEST' &&
      current.purchasingContext.actor.guestEvidenceRef === request.subject.guestEvidenceRef &&
      current.purchasingContext.actor.guestSessionRef === request.subject.guestSessionRef &&
      current.identity.kind === 'GUEST_SNAPSHOT' &&
      current.identity.guestEvidenceRef === request.subject.guestEvidenceRef
    : current.purchasingContext.actor.kind === 'PRINCIPAL' &&
      current.purchasingContext.actor.principalId === scope.principalId &&
      current.identity.kind !== 'GUEST_SNAPSHOT');

type InvoiceAddressCandidateResult =
  | Readonly<{
      addressSource: typeof InvoiceRecipientAddressSourceSchema.Type;
      kind: 'CANDIDATE';
      postalAddress: PostalAddress;
      source: 'EXPLICIT' | 'DEFAULT' | 'POLICY';
    }>
  | Readonly<{ kind: 'FAILURE'; resolution: InvoiceRecipientResolution }>;

const invoiceCandidateFailure = (
  kind: Exclude<InvoiceRecipientResolution['kind'], 'INVOICE_RECIPIENT_RESOLVED'>,
  reason: string,
): InvoiceAddressCandidateResult => ({ kind: 'FAILURE', resolution: invalid(kind, reason) });

const resolveInvoiceAddressCandidate = Effect.fn(
  'AddressResolution.resolveInvoiceAddressCandidate',
)(function* resolveInvoiceAddressCandidateEffect(
  request: InvoiceRecipientResolutionRequest,
  current: InvoiceRecipientCurrentFacts,
  ports: InvoiceRecipientPorts,
): Effect.fn.Return<InvoiceAddressCandidateResult, AddressBookUnavailable> {
  if (request.explicitChoice?.kind === 'ONE_TIME') {
    return {
      addressSource: {
        choiceEvidenceRef: request.explicitChoice.choiceEvidenceRef,
        kind: 'ONE_TIME',
      },
      kind: 'CANDIDATE',
      postalAddress: request.explicitChoice.postalAddress,
      source: 'EXPLICIT',
    };
  }
  if (request.explicitChoice?.kind === 'SAVED_ADDRESS') {
    if (request.subject.kind !== 'PROFILE') {
      return invoiceCandidateFailure(
        'EXPLICIT_CHOICE_INVALID',
        'Guests cannot select a saved address.',
      );
    }
    const saved = yield* ports.loadSavedAddress({
      profile: request.subject.profile,
      resourceId: request.explicitChoice.savedAddressRef.resourceId,
    });
    if (saved.kind !== 'FOUND' || !isAddressEligibleFor(saved.value, 'BILLING')) {
      return invoiceCandidateFailure(
        'EXPLICIT_CHOICE_INVALID',
        'The explicit saved address is missing, inactive, or not billing eligible.',
      );
    }
    const resolved = yield* ports.resolvePostalAddress(saved.value);
    return resolved.kind === 'FOUND' && resolved.value.kind === saved.value.origin.kind
      ? {
          addressSource: savedAddressSource(saved.value, resolved.value),
          kind: 'CANDIDATE',
          postalAddress: resolved.value.postalAddress,
          source: 'EXPLICIT',
        }
      : invoiceCandidateFailure(
          'EXPLICIT_CHOICE_INVALID',
          'The explicit Party-backed source is no longer Current.',
        );
  }

  const saved =
    request.subject.kind === 'PROFILE'
      ? yield* ports.loadDefaultBillingAddress(request.subject.profile)
      : ({ kind: 'NONE' } as const);
  if (saved.kind === 'INVALID') {
    return invoiceCandidateFailure('DEFAULT_BILLING_ADDRESS_INVALID', saved.reason);
  }
  if (saved.kind === 'FOUND') {
    if (!isAddressEligibleFor(saved.value, 'BILLING')) {
      return invoiceCandidateFailure(
        'DEFAULT_BILLING_ADDRESS_INVALID',
        'The configured billing default is inactive or ineligible.',
      );
    }
    const resolved = yield* ports.resolvePostalAddress(saved.value);
    return resolved.kind === 'FOUND' && resolved.value.kind === saved.value.origin.kind
      ? {
          addressSource: savedAddressSource(saved.value, resolved.value),
          kind: 'CANDIDATE',
          postalAddress: resolved.value.postalAddress,
          source: 'DEFAULT',
        }
      : invoiceCandidateFailure(
          'DEFAULT_BILLING_ADDRESS_INVALID',
          'The configured Party-backed default is no longer Current.',
        );
  }
  const policy = yield* ports.constructPolicyRecipient(current);
  return policy.kind === 'FOUND'
    ? {
        addressSource: {
          kind: 'POLICY',
          policyDecision: policy.value.policyDecision,
        },
        kind: 'CANDIDATE',
        postalAddress: policy.value.postalAddress,
        source: 'POLICY',
      }
    : invoiceCandidateFailure(
        'INVOICE_RECIPIENT_REQUIRED',
        'No Invoice Recipient can be resolved.',
      );
});

export const resolveInvoiceRecipient = Effect.fn('AddressResolution.resolveInvoiceRecipient')(
  function* resolveInvoiceRecipientEffect(
    request: InvoiceRecipientResolutionRequest,
    scope: ResolutionTrustedScope,
    ports: InvoiceRecipientPorts,
  ) {
    const current = yield* ports.loadCurrent(request, scope);
    if (!invoiceSubjectMatchesCurrent(request, current, scope)) {
      return invalid(
        'INCONSISTENT_CONFIGURATION',
        'The Invoice Recipient subject does not match the Current trusted actor evidence.',
      );
    }
    if (!purchaseResolutionContextMatches(request.purchasingContext, current.purchasingContext)) {
      return invalid(
        'INCONSISTENT_CONFIGURATION',
        'The claimed purchase context does not match the Current trusted context.',
      );
    }
    if (
      !hasExactResolutionRevisions(
        request.purchasingContext.expectedSourceRevisions,
        current.sourceRevisions,
      )
    ) {
      return invalid('STALE_SOURCE', 'One or more Invoice Recipient sources changed.');
    }

    const candidateResolution = yield* resolveInvoiceAddressCandidate(request, current, ports);
    if (candidateResolution.kind === 'FAILURE') {
      return candidateResolution.resolution;
    }
    const { addressSource, postalAddress, source } = candidateResolution;

    const candidate: AcceptedInvoiceRecipient = {
      billingAddress: postalAddress,
      countryCode: postalAddress.countryCode,
      identity: current.identity,
      source: addressSource,
      subject: request.subject,
    };
    const validation = yield* ports.validateRecipient({ candidate, current });
    if (validation.kind !== 'ACCEPTED') {
      return invalid(validation.kind, validation.reason);
    }
    return {
      decisionBundle: {
        acceptedHandoff: 'ORDER_ACCEPTANCE_INVOICE_RECIPIENT_V1' as const,
        billingEvidence: validation.billingEvidence,
        legalEvidence: validation.legalEvidence,
        purchasingContext: current.purchasingContext,
        recipient: candidate,
        sourceRevisions: current.sourceRevisions,
        taxEvidence: validation.taxEvidence,
      },
      kind: 'INVOICE_RECIPIENT_RESOLVED' as const,
      source,
    };
  },
);
