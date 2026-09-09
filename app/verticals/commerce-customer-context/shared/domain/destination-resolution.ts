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
const PositiveQuantitySchema = Schema.String.check(
  Schema.isPattern(/^(?:0*[1-9][0-9]*)(?:\.[0-9]+)?$/u),
);

const OwnerResourceRefSchema = Schema.Struct({
  moduleId: ResolutionModuleIdSchema,
  resourceId: ResolutionResourceIdSchema,
  resourceType: StableTextSchema,
  tenantId: ResolutionTenantIdSchema,
});

export const PickupDestinationRefSchema = Schema.Struct({
  moduleId: ResolutionModuleIdSchema,
  resourceId: ResolutionResourceIdSchema,
  resourceType: Schema.Literal('fulfillment.pickup-destination'),
  tenantId: ResolutionTenantIdSchema,
});
export type PickupDestinationRef = typeof PickupDestinationRefSchema.Type;

export const PickupDestinationSnapshotSchema = Schema.Struct({
  displayName: StableTextSchema,
  ownerRevision: StableTextSchema,
  pickupDestinationRef: PickupDestinationRefSchema,
  postalAddress: PostalAddressSchema,
  safeProviderCorrelation: StableTextSchema,
  validFrom: ProfileInstantSchema,
  validUntil: ProfileInstantSchema,
});
export type PickupDestinationSnapshot = typeof PickupDestinationSnapshotSchema.Type;

export const DeliveryProductQuantitySchema = Schema.Struct({
  configurationRevision: StableTextSchema,
  productRef: OwnerResourceRefSchema,
  quantity: PositiveQuantitySchema,
  unitOfMeasure: StableTextSchema,
});

export const CurrentDeliveryProposalSchema = Schema.Struct({
  carrierRef: Schema.optional(OwnerResourceRefSchema),
  deliveryChargeRevision: Schema.optional(StableTextSchema),
  deliveryMethodRef: Schema.optional(OwnerResourceRefSchema),
  productQuantities: Schema.Array(DeliveryProductQuantitySchema).check(Schema.isMinLength(1)),
  proposalRevision: PositiveRevisionSchema,
});
export type CurrentDeliveryProposal = typeof CurrentDeliveryProposalSchema.Type;

export const DeliveryDestinationChoiceSchema = Schema.Union([
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
    const subjectMatches =
      subject.kind === 'GUEST' || subject.profile.profileRef.tenantId === tenantId;
    const choiceMatches =
      choiceTenantId(explicitChoice, tenantId) === tenantId &&
      (explicitChoice?.kind !== 'SAVED_ADDRESS' || subject.kind === 'PROFILE');
    return subjectMatches && choiceMatches
      ? undefined
      : 'The Delivery Destination subject and every nested reference must share one Tenant; Guests cannot select saved addresses';
  }),
);
export type DeliveryDestinationResolutionRequest =
  typeof DeliveryDestinationResolutionRequestSchema.Type;

export const DeliveryPostalSourceSchema = Schema.Union([
  ResolvedSavedAddressSourceSchema,
  Schema.Struct({ choiceEvidenceRef: StableTextSchema, kind: Schema.Literal('ONE_TIME') }),
  Schema.Struct({
    kind: Schema.Literal('POLICY'),
    policyDecision: ResolutionDecisionEvidenceSchema,
  }),
]);

export const AcceptedDeliveryDestinationSchema = Schema.Union([
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
export type AcceptedDeliveryDestination = typeof AcceptedDeliveryDestinationSchema.Type;

export const DeliveryDestinationDecisionBundleSchema = Schema.Struct({
  acceptedHandoff: Schema.Literal('ORDER_ACCEPTANCE_DELIVERY_DESTINATION_V1'),
  deliveryEvidence: ResolutionDecisionEvidenceSchema,
  destination: AcceptedDeliveryDestinationSchema,
  fulfillmentEvidence: ResolutionDecisionEvidenceSchema,
  proposal: CurrentDeliveryProposalSchema,
  purchasingContext: CurrentPurchaseResolutionContextSchema,
  sourceRevisions: ResolutionSourceRevisionVectorSchema,
  subject: PurchaseResolutionSubjectSchema,
}).check(
  Schema.makeFilter(({ destination, proposal, purchasingContext, subject }) => {
    const { tenantId } = purchasingContext;
    const destinationMatches =
      destination.kind === 'PICKUP'
        ? destination.pickup.pickupDestinationRef.tenantId === tenantId
        : destination.source.kind !== 'SAVED_ADDRESS' ||
          (destination.source.savedAddressRef.tenantId === tenantId &&
            (destination.source.originKind === 'COMMERCE_ONLY' ||
              (destination.source.storedContactPointRef.tenantId === tenantId &&
                destination.source.storedPartyRef.tenantId === tenantId &&
                destination.source.currentContactPointRef.tenantId === tenantId &&
                destination.source.currentPartyRef.tenantId === tenantId)));
    const proposalMatches =
      proposal.productQuantities.every(({ productRef }) => productRef.tenantId === tenantId) &&
      (proposal.carrierRef === undefined || proposal.carrierRef.tenantId === tenantId) &&
      (proposal.deliveryMethodRef === undefined ||
        proposal.deliveryMethodRef.tenantId === tenantId);
    const subjectMatches =
      subject.kind === 'GUEST' || subject.profile.profileRef.tenantId === tenantId;
    return subjectMatches &&
      purchasingContext.sellingLegalEntityRef.tenantId === tenantId &&
      destinationMatches &&
      proposalMatches
      ? undefined
      : 'Delivery Destination decision references must belong to the trusted purchase Tenant';
  }),
);

export const DeliveryNotRequiredDecisionBundleSchema = Schema.Struct({
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
      (proposal.deliveryMethodRef === undefined ||
        proposal.deliveryMethodRef.tenantId === tenantId);
    const subjectMatches =
      subject.kind === 'GUEST' || subject.profile.profileRef.tenantId === tenantId;
    return subjectMatches &&
      purchasingContext.sellingLegalEntityRef.tenantId === tenantId &&
      proposalMatches
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

export type DeliveryAvailabilityDecision =
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

export interface DeliveryPolicyCandidate {
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
  kind: Exclude<
    DeliveryDestinationResolution['kind'],
    'DELIVERY_DESTINATION_RESOLVED' | 'DELIVERY_NOT_REQUIRED'
  >,
  reason: string,
): DeliveryDestinationResolution => ({ kind, reason });

const savedPostalSource = (
  address: SavedAddress,
  resolved: ResolvedSavedPostalAddress,
): typeof DeliveryPostalSourceSchema.Type =>
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

const postalFailure = (
  kind: Exclude<
    DeliveryDestinationResolution['kind'],
    'DELIVERY_DESTINATION_RESOLVED' | 'DELIVERY_NOT_REQUIRED'
  >,
  reason: string,
): PostalCandidateResult => ({ kind: 'FAILURE', resolution: invalid(kind, reason) });

const resolvePostalCandidate = Effect.fn('DestinationResolution.resolvePostalCandidate')(
  function* resolvePostalCandidateEffect(
    request: DeliveryDestinationResolutionRequest,
    current: DeliveryDestinationCurrentFacts,
    ports: DeliveryDestinationPorts,
  ): Effect.fn.Return<PostalCandidateResult, AddressBookUnavailable> {
    if (request.explicitChoice?.kind === 'ONE_TIME') {
      const { choiceEvidenceRef, postalAddress } = request.explicitChoice;
      return {
        kind: 'CANDIDATE',
        postalAddress,
        postalSource: { choiceEvidenceRef, kind: 'ONE_TIME' },
        source: 'EXPLICIT',
      };
    }
    if (request.explicitChoice?.kind === 'SAVED_ADDRESS') {
      if (request.subject.kind !== 'PROFILE') {
        return postalFailure('EXPLICIT_CHOICE_INVALID', 'Guests cannot select a saved address.');
      }
      const saved = yield* ports.loadSavedAddress({
        profile: request.subject.profile,
        resourceId: request.explicitChoice.savedAddressRef.resourceId,
      });
      if (saved.kind !== 'FOUND' || !isAddressEligibleFor(saved.value, 'DELIVERY')) {
        return postalFailure(
          'EXPLICIT_CHOICE_INVALID',
          'The explicit saved address is missing, inactive, or not delivery eligible.',
        );
      }
      const resolved = yield* ports.resolvePostalAddress(saved.value);
      return resolved.kind === 'FOUND' && resolved.value.kind === saved.value.origin.kind
        ? {
            kind: 'CANDIDATE',
            postalAddress: resolved.value.postalAddress,
            postalSource: savedPostalSource(saved.value, resolved.value),
            source: 'EXPLICIT',
          }
        : postalFailure(
            'EXPLICIT_CHOICE_INVALID',
            'The explicit Party-backed source is no longer Current.',
          );
    }

    const saved =
      request.subject.kind === 'PROFILE'
        ? yield* ports.loadDefaultDeliveryAddress(request.subject.profile)
        : ({ kind: 'NONE' } as const);
    if (saved.kind === 'INVALID') {
      return postalFailure('DEFAULT_DESTINATION_INVALID', saved.reason);
    }
    if (saved.kind === 'FOUND') {
      if (!isAddressEligibleFor(saved.value, 'DELIVERY')) {
        return postalFailure(
          'DEFAULT_DESTINATION_INVALID',
          'The configured delivery default is inactive or ineligible.',
        );
      }
      const resolved = yield* ports.resolvePostalAddress(saved.value);
      return resolved.kind === 'FOUND' && resolved.value.kind === saved.value.origin.kind
        ? {
            kind: 'CANDIDATE',
            postalAddress: resolved.value.postalAddress,
            postalSource: savedPostalSource(saved.value, resolved.value),
            source: 'DEFAULT',
          }
        : postalFailure(
            'DEFAULT_DESTINATION_INVALID',
            'The configured Party-backed default is no longer Current.',
          );
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

export const resolveDeliveryDestination = Effect.fn(
  'DestinationResolution.resolveDeliveryDestination',
)(function* resolveDeliveryDestinationEffect(
  request: DeliveryDestinationResolutionRequest,
  scope: ResolutionTrustedScope,
  ports: DeliveryDestinationPorts,
) {
  const current = yield* ports.loadCurrent(request, scope);
  const invalidContext = validateCurrentContext(
    request.purchasingContext,
    request.subject,
    current,
    scope,
  );
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
});
