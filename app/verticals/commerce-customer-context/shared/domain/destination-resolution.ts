import { Effect, Schema } from 'effect';
import { PostalAddressSchema, isAddressEligibleFor } from './address-book.ts';
import type { AddressBookProfile, PostalAddress, SavedAddress } from './address-book.ts';
import type { AddressBookUnavailable } from './address-errors.ts';
import {
  CurrentPurchaseResolutionContextSchema,
  PurchaseResolutionContextClaimSchema,
  PurchaseResolutionSubjectSchema,
  ResolvedSavedAddressSourceSchema,
  ResolutionDecisionEvidenceSchema,
  ResolutionModuleIdSchema,
  ResolutionResourceIdSchema,
  ResolutionSourceRevisionVectorSchema,
  ResolutionTenantIdSchema,
  hasExactResolutionRevisions,
  purchaseResolutionSubjectsMatch,
  purchaseResolutionContextMatches,
} from './address-resolution.ts';
import type {
  AddressDefaultLookup,
  AddressLookup,
  CurrentPurchaseResolutionContext,
  PurchaseResolutionContextClaim,
  PurchaseResolutionSubject,
  ResolvedSavedPostalAddress,
  ResolutionDecisionEvidence,
  ResolutionSourceRevisionVector,
  ResolutionTrustedScope,
} from './address-resolution.ts';
import { ProfileInstantSchema } from './profile-contracts.ts';
import { SavedAddressRefSchema } from '../resources/saved-address.ts';

const StableTextSchema = Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(300));
const PositiveRevisionSchema = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const PositiveQuantitySchema = Schema.String.check(Schema.isPattern(/^(?:0*[1-9][0-9]*)(?:\.[0-9]+)?$/u));

const OwnerResourceRefSchema = Schema.Struct({
  moduleId: ResolutionModuleIdSchema,
  resourceId: ResolutionResourceIdSchema,
  resourceType: StableTextSchema,
  tenantId: ResolutionTenantIdSchema,
});

const PickupDestinationRefSchema = Schema.Struct({
  moduleId: ResolutionModuleIdSchema,
  resourceId: ResolutionResourceIdSchema,
  resourceType: Schema.Literal('fulfillment.pickup-destination'),
  tenantId: ResolutionTenantIdSchema,
});
type PickupDestinationRef = typeof PickupDestinationRefSchema.Type;

const PickupDestinationSnapshotSchema = Schema.Struct({
  displayName: StableTextSchema,
  ownerRevision: StableTextSchema,
  pickupDestinationRef: PickupDestinationRefSchema,
  postalAddress: PostalAddressSchema,
  safeProviderCorrelation: StableTextSchema,
  validFrom: ProfileInstantSchema,
  validUntil: ProfileInstantSchema,
});
type PickupDestinationSnapshot = typeof PickupDestinationSnapshotSchema.Type;

const DeliveryProductQuantitySchema = Schema.Struct({
  configurationRevision: StableTextSchema,
  productRef: OwnerResourceRefSchema,
  quantity: PositiveQuantitySchema,
  unitOfMeasure: StableTextSchema,
});

const CurrentDeliveryProposalSchema = Schema.Struct({
  carrierRef: Schema.optional(OwnerResourceRefSchema),
  deliveryChargeRevision: Schema.optional(StableTextSchema),
  deliveryMethodRef: Schema.optional(OwnerResourceRefSchema),
  productQuantities: Schema.Array(DeliveryProductQuantitySchema).check(Schema.isMinLength(1)),
  proposalRevision: PositiveRevisionSchema,
});
type CurrentDeliveryProposal = typeof CurrentDeliveryProposalSchema.Type;

const DeliveryDestinationChoiceSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('SAVED_ADDRESS'), savedAddressRef: SavedAddressRefSchema }),
  Schema.Struct({
    choiceEvidenceRef: StableTextSchema,
    kind: Schema.Literal('ONE_TIME'),
    postalAddress: PostalAddressSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('PICKUP'),
    pickupDestinationRef: PickupDestinationRefSchema,
  }),
]);
type DeliveryDestinationChoice = typeof DeliveryDestinationChoiceSchema.Type;

const choiceTenantId = (choice: DeliveryDestinationChoice | undefined, fallback: string) => {
  if (choice?.kind === 'SAVED_ADDRESS') {
    return choice.savedAddressRef.tenantId;
  }
  if (choice?.kind === 'PICKUP') {
    return choice.pickupDestinationRef.tenantId;
  }
  return fallback;
};

export const DeliveryDestinationResolutionRequestSchema = Schema.Struct({
  explicitChoice: Schema.optional(DeliveryDestinationChoiceSchema),
  purchasingContext: PurchaseResolutionContextClaimSchema,
  subject: PurchaseResolutionSubjectSchema,
}).check(
  Schema.makeFilter(({ explicitChoice, purchasingContext, subject }) => {
    const { tenantId } = purchasingContext;
    const subjectMatches = subject.kind === 'GUEST' || subject.profile.profileRef.tenantId === tenantId;
    const choiceMatches =
      choiceTenantId(explicitChoice, tenantId) === tenantId &&
      (explicitChoice?.kind !== 'SAVED_ADDRESS' || subject.kind === 'PROFILE');
    return subjectMatches && choiceMatches
      ? undefined
      : 'The Delivery Destination subject and every nested reference must share one Tenant; Guests cannot select saved addresses';
  }),
);
export type DeliveryDestinationResolutionRequest = typeof DeliveryDestinationResolutionRequestSchema.Type;

const DeliveryPostalSourceSchema = Schema.Union([
  ResolvedSavedAddressSourceSchema,
  Schema.Struct({ choiceEvidenceRef: StableTextSchema, kind: Schema.Literal('ONE_TIME') }),
  Schema.Struct({
    kind: Schema.Literal('POLICY'),
    policyDecision: ResolutionDecisionEvidenceSchema,
  }),
]);

const AcceptedDeliveryDestinationSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('POSTAL'),
    postalAddress: PostalAddressSchema,
    source: DeliveryPostalSourceSchema,
  }),
  Schema.Struct({
    kind: Schema.Literal('PICKUP'),
    pickup: PickupDestinationSnapshotSchema,
  }),
]);
type AcceptedDeliveryDestination = typeof AcceptedDeliveryDestinationSchema.Type;

const deliveryDestinationMatchesTenant = (destination: AcceptedDeliveryDestination, tenantId: string) => {
  if (destination.kind === 'PICKUP') {
    return destination.pickup.pickupDestinationRef.tenantId === tenantId;
  }
  if (destination.source.kind !== 'SAVED_ADDRESS') {
    return true;
  }
  if (destination.source.savedAddressRef.tenantId !== tenantId) {
    return false;
  }
  return (
    destination.source.originKind === 'COMMERCE_ONLY' ||
    (destination.source.storedContactPointRef.tenantId === tenantId &&
      destination.source.storedPartyRef.tenantId === tenantId &&
      destination.source.currentContactPointRef.tenantId === tenantId &&
      destination.source.currentPartyRef.tenantId === tenantId)
  );
};

const deliveryProposalMatchesTenant = (proposal: CurrentDeliveryProposal, tenantId: string) =>
  proposal.productQuantities.every(({ productRef }) => productRef.tenantId === tenantId) &&
  (proposal.carrierRef === undefined || proposal.carrierRef.tenantId === tenantId) &&
  (proposal.deliveryMethodRef === undefined || proposal.deliveryMethodRef.tenantId === tenantId);

const deliveryDestinationDecisionIsCoherent = (
  destination: AcceptedDeliveryDestination,
  proposal: CurrentDeliveryProposal,
  purchasingContext: CurrentPurchaseResolutionContext,
  subject: PurchaseResolutionSubject,
) => {
  const { tenantId } = purchasingContext;
  return (
    (subject.kind === 'GUEST' || subject.profile.profileRef.tenantId === tenantId) &&
    purchasingContext.sellingLegalEntityRef.tenantId === tenantId &&
    deliveryDestinationMatchesTenant(destination, tenantId) &&
    deliveryProposalMatchesTenant(proposal, tenantId)
  );
};

const DeliveryDestinationDecisionBundleSchema = Schema.Struct({
  acceptedHandoff: Schema.Literal('ORDER_ACCEPTANCE_DELIVERY_DESTINATION_V1'),
  deliveryEvidence: ResolutionDecisionEvidenceSchema,
  destination: AcceptedDeliveryDestinationSchema,
  fulfillmentEvidence: ResolutionDecisionEvidenceSchema,
  proposal: CurrentDeliveryProposalSchema,
  purchasingContext: CurrentPurchaseResolutionContextSchema,
  sourceRevisions: ResolutionSourceRevisionVectorSchema,
  subject: PurchaseResolutionSubjectSchema,
}).check(
  Schema.makeFilter(({ destination, proposal, purchasingContext, subject }) =>
    deliveryDestinationDecisionIsCoherent(destination, proposal, purchasingContext, subject)
      ? undefined
      : 'Delivery Destination decision references must belong to the trusted purchase Tenant',
  ),
);

const DeliveryNotRequiredDecisionBundleSchema = Schema.Struct({
  acceptedHandoff: Schema.Literal('ORDER_ACCEPTANCE_NO_DELIVERY_V1'),
  fulfillmentEvidence: ResolutionDecisionEvidenceSchema,
  proposal: CurrentDeliveryProposalSchema,
  purchasingContext: CurrentPurchaseResolutionContextSchema,
  sourceRevisions: ResolutionSourceRevisionVectorSchema,
  subject: PurchaseResolutionSubjectSchema,
}).check(
  Schema.makeFilter(({ proposal, purchasingContext, subject }) => {
    const { tenantId } = purchasingContext;
    const proposalMatches =
      proposal.productQuantities.every(({ productRef }) => productRef.tenantId === tenantId) &&
      (proposal.carrierRef === undefined || proposal.carrierRef.tenantId === tenantId) &&
      (proposal.deliveryMethodRef === undefined || proposal.deliveryMethodRef.tenantId === tenantId);
    const subjectMatches = subject.kind === 'GUEST' || subject.profile.profileRef.tenantId === tenantId;
    return subjectMatches && purchasingContext.sellingLegalEntityRef.tenantId === tenantId && proposalMatches
      ? undefined
      : 'No-delivery decision references must belong to the trusted purchase Tenant';
  }),
);

export const DeliveryDestinationResolutionSchema = Schema.Union([
  Schema.Struct({
    decisionBundle: DeliveryDestinationDecisionBundleSchema,
    kind: Schema.Literal('DELIVERY_DESTINATION_RESOLVED'),
    source: Schema.Literals(['EXPLICIT', 'DEFAULT', 'POLICY']),
  }),
  Schema.Struct({
    decisionBundle: DeliveryNotRequiredDecisionBundleSchema,
    kind: Schema.Literal('DELIVERY_NOT_REQUIRED'),
  }),
  Schema.Struct({
    kind: Schema.Literals([
      'EXPLICIT_CHOICE_INVALID',
      'DELIVERY_DESTINATION_REQUIRED',
      'DEFAULT_DESTINATION_INVALID',
      'DESTINATION_NOT_DELIVERABLE',
      'PICKUP_DESTINATION_UNAVAILABLE_OR_EXPIRED',
      'INCONSISTENT_CONFIGURATION',
      'STALE_SOURCE',
    ]),
    reason: Schema.String,
  }),
]);
export type DeliveryDestinationResolution = typeof DeliveryDestinationResolutionSchema.Type;

export interface DeliveryDestinationCurrentFacts {
  readonly deliveryRequired: boolean;
  readonly fulfillmentEvidence: ResolutionDecisionEvidence;
  readonly proposal: CurrentDeliveryProposal;
  readonly purchasingContext: CurrentPurchaseResolutionContext;
  readonly sourceRevisions: ResolutionSourceRevisionVector;
  readonly subject: PurchaseResolutionSubject;
}

type DeliveryAvailabilityDecision =
  | Readonly<{
      deliveryEvidence: ResolutionDecisionEvidence;
      fulfillmentEvidence: ResolutionDecisionEvidence;
      kind: 'ACCEPTED';
    }>
  | Readonly<{
      kind:
        | 'DESTINATION_NOT_DELIVERABLE'
        | 'PICKUP_DESTINATION_UNAVAILABLE_OR_EXPIRED'
        | 'INCONSISTENT_CONFIGURATION'
        | 'STALE_SOURCE';
      reason: string;
    }>;

interface DeliveryPolicyCandidate {
  readonly policyDecision: ResolutionDecisionEvidence;
  readonly postalAddress: PostalAddress;
}

export interface DeliveryDestinationPorts {
  readonly constructPolicyDestination: (
    current: DeliveryDestinationCurrentFacts,
  ) => Effect.Effect<AddressLookup<DeliveryPolicyCandidate>, AddressBookUnavailable>;
  readonly loadCurrent: (
    request: DeliveryDestinationResolutionRequest,
    scope: ResolutionTrustedScope,
  ) => Effect.Effect<DeliveryDestinationCurrentFacts, AddressBookUnavailable>;
  readonly loadDefaultDeliveryAddress: (
    profile: AddressBookProfile,
  ) => Effect.Effect<AddressDefaultLookup<SavedAddress>, AddressBookUnavailable>;
  readonly loadSavedAddress: (request: {
    profile: AddressBookProfile;
    resourceId: string;
  }) => Effect.Effect<AddressLookup<SavedAddress>, AddressBookUnavailable>;
  readonly resolvePickupDestination: (request: {
    current: DeliveryDestinationCurrentFacts;
    pickupDestinationRef: PickupDestinationRef;
  }) => Effect.Effect<AddressLookup<PickupDestinationSnapshot>, AddressBookUnavailable>;
  readonly resolvePostalAddress: (
    address: SavedAddress,
  ) => Effect.Effect<AddressLookup<ResolvedSavedPostalAddress>, AddressBookUnavailable>;
  readonly validatePickupAvailability: (request: {
    current: DeliveryDestinationCurrentFacts;
    pickup: PickupDestinationSnapshot;
  }) => Effect.Effect<DeliveryAvailabilityDecision, AddressBookUnavailable>;
  readonly validatePostalAvailability: (request: {
    current: DeliveryDestinationCurrentFacts;
    postalAddress: PostalAddress;
  }) => Effect.Effect<DeliveryAvailabilityDecision, AddressBookUnavailable>;
}

const invalid = (
  kind: Exclude<DeliveryDestinationResolution['kind'], 'DELIVERY_DESTINATION_RESOLVED' | 'DELIVERY_NOT_REQUIRED'>,
  reason: string,
): DeliveryDestinationResolution => ({ kind, reason });

const savedPostalSource = (
  address: SavedAddress,
  resolved: ResolvedSavedPostalAddress,
): typeof DeliveryPostalSourceSchema.Type => {
  if (address.origin.kind === 'PARTY_BACKED' && resolved.kind === 'PARTY_BACKED') {
    return {
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
    };
  }
  return {
    kind: 'SAVED_ADDRESS',
    originKind: 'COMMERCE_ONLY',
    savedAddressRef: address.savedAddressRef,
    savedAddressRevision: address.revision,
  };
};

const validateCurrentContext = (
  claim: PurchaseResolutionContextClaim,
  requestedSubject: PurchaseResolutionSubject,
  current: DeliveryDestinationCurrentFacts,
  scope: ResolutionTrustedScope,
): DeliveryDestinationResolution | undefined => {
  const actorMatches =
    purchaseResolutionSubjectsMatch(requestedSubject, current.subject) &&
    (requestedSubject.kind === 'GUEST'
      ? current.purchasingContext.actor.kind === 'GUEST' &&
        current.purchasingContext.actor.guestEvidenceRef === requestedSubject.guestEvidenceRef &&
        current.purchasingContext.actor.guestSessionRef === requestedSubject.guestSessionRef
      : current.purchasingContext.actor.kind === 'PRINCIPAL' &&
        current.purchasingContext.actor.principalId === scope.principalId);
  if (!actorMatches) {
    return invalid(
      'INCONSISTENT_CONFIGURATION',
      'The Delivery Destination subject does not match the Current trusted actor evidence.',
    );
  }
  if (!purchaseResolutionContextMatches(claim, current.purchasingContext)) {
    return invalid(
      'INCONSISTENT_CONFIGURATION',
      'The claimed purchase context does not match the Current trusted context.',
    );
  }
  return hasExactResolutionRevisions(claim.expectedSourceRevisions, current.sourceRevisions)
    ? undefined
    : invalid('STALE_SOURCE', 'One or more Delivery Destination sources changed.');
};

const accepted = (
  current: DeliveryDestinationCurrentFacts,
  destination: AcceptedDeliveryDestination,
  validation: Extract<DeliveryAvailabilityDecision, { readonly kind: 'ACCEPTED' }>,
  source: 'EXPLICIT' | 'DEFAULT' | 'POLICY',
): DeliveryDestinationResolution => ({
  decisionBundle: {
    acceptedHandoff: 'ORDER_ACCEPTANCE_DELIVERY_DESTINATION_V1',
    deliveryEvidence: validation.deliveryEvidence,
    destination,
    fulfillmentEvidence: validation.fulfillmentEvidence,
    proposal: current.proposal,
    purchasingContext: current.purchasingContext,
    sourceRevisions: current.sourceRevisions,
    subject: current.subject,
  },
  kind: 'DELIVERY_DESTINATION_RESOLVED',
  source,
});

type PostalCandidateResult =
  | Readonly<{
      kind: 'CANDIDATE';
      postalAddress: PostalAddress;
      postalSource: typeof DeliveryPostalSourceSchema.Type;
      source: 'EXPLICIT' | 'DEFAULT' | 'POLICY';
    }>
  | Readonly<{ kind: 'FAILURE'; resolution: DeliveryDestinationResolution }>;

type PostalCandidateFailure = Extract<PostalCandidateResult, { readonly kind: 'FAILURE' }>;

const postalFailure = (
  kind: Exclude<DeliveryDestinationResolution['kind'], 'DELIVERY_DESTINATION_RESOLVED' | 'DELIVERY_NOT_REQUIRED'>,
  reason: string,
): PostalCandidateFailure => ({ kind: 'FAILURE', resolution: invalid(kind, reason) });

type PostalSavedAddressPlan = Readonly<{ kind: 'RESOLVE'; savedAddress: SavedAddress }> | PostalCandidateFailure;

const planPostalSavedAddress = (savedAddress: SavedAddress, source: 'EXPLICIT' | 'DEFAULT'): PostalSavedAddressPlan =>
  isAddressEligibleFor(savedAddress, 'DELIVERY')
    ? { kind: 'RESOLVE', savedAddress }
    : postalFailure(
        source === 'EXPLICIT' ? 'EXPLICIT_CHOICE_INVALID' : 'DEFAULT_DESTINATION_INVALID',
        source === 'EXPLICIT'
          ? 'The explicit saved address is missing, inactive, or not delivery eligible.'
          : 'The configured delivery default is inactive or ineligible.',
      );

const planExplicitPostalSavedAddress = (saved: AddressLookup<SavedAddress>): PostalSavedAddressPlan =>
  saved.kind === 'FOUND'
    ? planPostalSavedAddress(saved.value, 'EXPLICIT')
    : postalFailure(
        'EXPLICIT_CHOICE_INVALID',
        'The explicit saved address is missing, inactive, or not delivery eligible.',
      );

const planDefaultPostalSavedAddress = (
  saved: AddressDefaultLookup<SavedAddress>,
): PostalSavedAddressPlan | undefined => {
  if (saved.kind === 'INVALID') {
    return postalFailure('DEFAULT_DESTINATION_INVALID', saved.reason);
  }
  return saved.kind === 'FOUND' ? planPostalSavedAddress(saved.value, 'DEFAULT') : undefined;
};

const resolvedPostalSavedAddressCandidate = (
  savedAddress: SavedAddress,
  resolved: AddressLookup<ResolvedSavedPostalAddress>,
  source: 'EXPLICIT' | 'DEFAULT',
): PostalCandidateResult => {
  if (resolved.kind !== 'FOUND' || resolved.value.kind !== savedAddress.origin.kind) {
    return postalFailure(
      source === 'EXPLICIT' ? 'EXPLICIT_CHOICE_INVALID' : 'DEFAULT_DESTINATION_INVALID',
      source === 'EXPLICIT'
        ? 'The explicit Party-backed source is no longer Current.'
        : 'The configured Party-backed default is no longer Current.',
    );
  }
  return {
    kind: 'CANDIDATE',
    postalAddress: resolved.value.postalAddress,
    postalSource: savedPostalSource(savedAddress, resolved.value),
    source,
  };
};

type ExplicitPostalCandidateResult = PostalCandidateResult | Readonly<{ kind: 'NO_EXPLICIT_CHOICE' }>;

const resolveExplicitPostalCandidate = Effect.fn('DestinationResolution.resolveExplicitPostalCandidate')(
  function* resolveExplicitPostalCandidateEffect(
    request: DeliveryDestinationResolutionRequest,
    ports: DeliveryDestinationPorts,
  ): Effect.fn.Return<ExplicitPostalCandidateResult, AddressBookUnavailable> {
    const choice = request.explicitChoice;
    if (choice === undefined || choice.kind === 'PICKUP') {
      return { kind: 'NO_EXPLICIT_CHOICE' };
    }
    if (choice.kind === 'ONE_TIME') {
      const { choiceEvidenceRef, postalAddress } = choice;
      return {
        kind: 'CANDIDATE',
        postalAddress,
        postalSource: { choiceEvidenceRef, kind: 'ONE_TIME' },
        source: 'EXPLICIT',
      };
    }
    if (request.subject.kind !== 'PROFILE') {
      return postalFailure('EXPLICIT_CHOICE_INVALID', 'Guests cannot select a saved address.');
    }
    const saved = yield* ports.loadSavedAddress({
      profile: request.subject.profile,
      resourceId: choice.savedAddressRef.resourceId,
    });
    const plan = planExplicitPostalSavedAddress(saved);
    if (plan.kind === 'FAILURE') {
      return plan;
    }
    const resolved = yield* ports.resolvePostalAddress(plan.savedAddress);
    return resolvedPostalSavedAddressCandidate(plan.savedAddress, resolved, 'EXPLICIT');
  },
);

const resolvePostalCandidate = Effect.fn('DestinationResolution.resolvePostalCandidate')(
  function* resolvePostalCandidateEffect(
    request: DeliveryDestinationResolutionRequest,
    current: DeliveryDestinationCurrentFacts,
    ports: DeliveryDestinationPorts,
  ): Effect.fn.Return<PostalCandidateResult, AddressBookUnavailable> {
    const explicit = yield* resolveExplicitPostalCandidate(request, ports);
    if (explicit.kind !== 'NO_EXPLICIT_CHOICE') {
      return explicit;
    }

    const saved =
      request.subject.kind === 'PROFILE'
        ? yield* ports.loadDefaultDeliveryAddress(request.subject.profile)
        : ({ kind: 'NONE' } as const);
    const plan = planDefaultPostalSavedAddress(saved);
    if (plan?.kind === 'FAILURE') {
      return plan;
    }
    if (plan?.kind === 'RESOLVE') {
      const resolved = yield* ports.resolvePostalAddress(plan.savedAddress);
      return resolvedPostalSavedAddressCandidate(plan.savedAddress, resolved, 'DEFAULT');
    }
    const policy = yield* ports.constructPolicyDestination(current);
    return policy.kind === 'FOUND'
      ? {
          kind: 'CANDIDATE',
          postalAddress: policy.value.postalAddress,
          postalSource: {
            kind: 'POLICY',
            policyDecision: policy.value.policyDecision,
          },
          source: 'POLICY',
        }
      : postalFailure('DELIVERY_DESTINATION_REQUIRED', 'No Delivery Destination can be resolved.');
  },
);

export const resolveDeliveryDestination = Effect.fn('DestinationResolution.resolveDeliveryDestination')(
  function* resolveDeliveryDestinationEffect(
    request: DeliveryDestinationResolutionRequest,
    scope: ResolutionTrustedScope,
    ports: DeliveryDestinationPorts,
  ) {
    const current = yield* ports.loadCurrent(request, scope);
    const invalidContext = validateCurrentContext(request.purchasingContext, request.subject, current, scope);
    if (invalidContext !== undefined) {
      return invalidContext;
    }
    if (!current.deliveryRequired) {
      return {
        decisionBundle: {
          acceptedHandoff: 'ORDER_ACCEPTANCE_NO_DELIVERY_V1' as const,
          fulfillmentEvidence: current.fulfillmentEvidence,
          proposal: current.proposal,
          purchasingContext: current.purchasingContext,
          sourceRevisions: current.sourceRevisions,
          subject: current.subject,
        },
        kind: 'DELIVERY_NOT_REQUIRED' as const,
      };
    }

    if (request.explicitChoice?.kind === 'PICKUP') {
      const pickup = yield* ports.resolvePickupDestination({
        current,
        pickupDestinationRef: request.explicitChoice.pickupDestinationRef,
      });
      if (pickup.kind !== 'FOUND') {
        return invalid(
          'PICKUP_DESTINATION_UNAVAILABLE_OR_EXPIRED',
          'The selected pickup destination is unavailable or expired.',
        );
      }
      const validation = yield* ports.validatePickupAvailability({ current, pickup: pickup.value });
      return validation.kind === 'ACCEPTED'
        ? accepted(current, { kind: 'PICKUP', pickup: pickup.value }, validation, 'EXPLICIT')
        : invalid(validation.kind, validation.reason);
    }

    const candidate = yield* resolvePostalCandidate(request, current, ports);
    if (candidate.kind === 'FAILURE') {
      return candidate.resolution;
    }
    const { postalAddress, postalSource, source } = candidate;
    const validation = yield* ports.validatePostalAvailability({ current, postalAddress });
    return validation.kind === 'ACCEPTED'
      ? accepted(current, { kind: 'POSTAL', postalAddress, source: postalSource }, validation, source)
      : invalid(validation.kind, validation.reason);
  },
);
