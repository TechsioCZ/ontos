import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { ActiveSavedAddressSchema, reconcileDefaults } from '../../shared/domain/address-book.ts';
import { UpdateSavedAddressPayloadSchema } from '../../shared/domain/address-actions.ts';
import {
  InvoiceRecipientResolutionRequestSchema,
  found,
  notFound,
  resolveInvoiceRecipient,
} from '../../shared/domain/address-resolution.ts';
import type {
  InvoiceRecipientCurrentFacts,
  InvoiceRecipientPorts,
  ResolutionDecisionEvidence,
  ResolutionTrustedScope,
} from '../../shared/domain/address-resolution.ts';
import { AddressBookUnavailable } from '../../shared/domain/address-errors.ts';
import {
  DeliveryDestinationResolutionRequestSchema,
  resolveDeliveryDestination,
} from '../../shared/domain/destination-resolution.ts';
import type {
  DeliveryDestinationCurrentFacts,
  DeliveryDestinationPorts,
} from '../../shared/domain/destination-resolution.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const profile = {
  kind: 'RETAIL',
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'profile-1',
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId,
  },
} as const;
const ref = {
  moduleId: 'commerce.customer-context',
  resourceId: 'address-1',
  resourceType: 'commerce.customer-context.saved-address',
  tenantId,
} as const;
const postal = {
  addressLine1: '1 Main Street',
  city: 'Prague',
  countryCode: 'CZ',
  postalCode: '11000',
} as const;
const saved = {
  lifecycle: 'ACTIVE',
  origin: { kind: 'COMMERCE_ONLY', postalAddress: postal },
  profile,
  purposes: ['BILLING'] as const,
  revision: 1,
  savedAddressRef: ref,
} as const;
const storedPartyRef = {
  moduleId: 'party.registry',
  resourceId: 'stored-party-1',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const storedContactPointRef = {
  moduleId: 'party.registry',
  resourceId: 'contact-point-1',
  resourceType: 'party.registry.party-contact-point',
  tenantId,
} as const;
const partySaved = {
  ...saved,
  origin: {
    contactPointRef: storedContactPointRef,
    kind: 'PARTY_BACKED',
    partyRef: storedPartyRef,
    sourceRevision: 7,
  },
} as const;
const evidence = (owner: ResolutionDecisionEvidence['owner']): ResolutionDecisionEvidence => ({
  decidedAt: '2026-09-09T10:00:00.000Z',
  decisionRef: `${owner.toLowerCase()}-decision-1`,
  owner,
  revision: 'revision-1',
});
const sourceRevisions = [
  { revision: 'cart-r4', source: 'cart' },
  { revision: 'party-r2', source: 'party' },
] as const;
const purchasingContext = {
  cartId: 'cart-1',
  channelId: 'web',
  expectedProposalRevision: 4,
  expectedSourceRevisions: sourceRevisions,
  marketId: 'cz',
  sellingLegalEntityId: 'legal-entity-1',
  storefrontId: 'storefront-1',
  tenantId,
} as const;
const currentPurchasingContext = {
  actor: { kind: 'PRINCIPAL', principalId: 'principal-1' },
  cartId: purchasingContext.cartId,
  channelId: purchasingContext.channelId,
  decidedAt: '2026-09-09T10:00:00.000Z',
  marketId: purchasingContext.marketId,
  proposalRevision: purchasingContext.expectedProposalRevision,
  sellingLegalEntityRef: {
    moduleId: 'core.identity',
    resourceId: purchasingContext.sellingLegalEntityId,
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  storefrontId: purchasingContext.storefrontId,
  tenantId,
} as const;
const trustedScope: ResolutionTrustedScope = {
  legalEntityId: purchasingContext.sellingLegalEntityId,
  principalId: 'principal-1',
  storefrontId: purchasingContext.storefrontId,
  tenantId,
};
const invoiceCurrent: InvoiceRecipientCurrentFacts = {
  identity: {
    displayName: 'Ada Lovelace',
    kind: 'RETAIL_PARTY',
    legalName: 'Ada Lovelace',
    officialIdentifiers: [],
    partyRef: {
      moduleId: 'party.registry',
      resourceId: 'party-1',
      resourceType: 'party.registry.party',
      tenantId,
    },
    sourceRevision: 2,
  },
  purchasingContext: currentPurchasingContext,
  sourceRevisions,
  subject: { kind: 'PROFILE', profile },
};
const guestSubject = {
  guestEvidenceRef: 'checkout-guest-evidence-1',
  guestSessionRef: 'guest-session-1',
  kind: 'GUEST',
} as const;
const guestInvoiceCurrent: InvoiceRecipientCurrentFacts = {
  identity: {
    displayName: 'Guest buyer',
    guestEvidenceRef: guestSubject.guestEvidenceRef,
    kind: 'GUEST_SNAPSHOT',
    legalName: 'Guest buyer',
    officialIdentifiers: [],
    sourceRevision: 1,
  },
  purchasingContext: {
    ...currentPurchasingContext,
    actor: {
      guestEvidenceRef: guestSubject.guestEvidenceRef,
      guestSessionRef: guestSubject.guestSessionRef,
      kind: 'GUEST',
    },
  },
  sourceRevisions,
  subject: guestSubject,
};
const deliveryCurrent: DeliveryDestinationCurrentFacts = {
  deliveryRequired: true,
  fulfillmentEvidence: evidence('FULFILLMENT'),
  proposal: {
    deliveryMethodRef: {
      moduleId: 'fulfillment',
      resourceId: 'standard-delivery',
      resourceType: 'fulfillment.delivery-method',
      tenantId,
    },
    productQuantities: [
      {
        configurationRevision: 'product-r3',
        productRef: {
          moduleId: 'commerce.catalog',
          resourceId: 'product-1',
          resourceType: 'commerce.catalog.product',
          tenantId,
        },
        quantity: '2',
        unitOfMeasure: 'EA',
      },
    ],
    proposalRevision: purchasingContext.expectedProposalRevision,
  },
  purchasingContext: currentPurchasingContext,
  sourceRevisions,
  subject: { kind: 'PROFILE', profile },
};
const guestDeliveryCurrent: DeliveryDestinationCurrentFacts = {
  ...deliveryCurrent,
  purchasingContext: guestInvoiceCurrent.purchasingContext,
  subject: guestSubject,
};

const invoicePorts = (overrides: Partial<InvoiceRecipientPorts> = {}): InvoiceRecipientPorts => ({
  constructPolicyRecipient: () =>
    Effect.succeed(
      found({ policyDecision: evidence('CUSTOMER_COMMERCE_POLICY'), postalAddress: postal }),
    ),
  loadCurrent: () => Effect.succeed(invoiceCurrent),
  loadDefaultBillingAddress: () => Effect.succeed({ kind: 'NONE' }),
  loadSavedAddress: () => Effect.succeed(notFound()),
  resolvePostalAddress: () =>
    Effect.succeed(found({ kind: 'COMMERCE_ONLY', postalAddress: postal })),
  validateRecipient: () =>
    Effect.succeed({
      billingEvidence: evidence('BILLING_DOCUMENTS'),
      kind: 'ACCEPTED',
      legalEvidence: evidence('PARTY_REGISTRY'),
      taxEvidence: evidence('TAX'),
    }),
  ...overrides,
});

const deliveryPorts = (
  overrides: Partial<DeliveryDestinationPorts> = {},
): DeliveryDestinationPorts => ({
  constructPolicyDestination: () =>
    Effect.succeed(
      found({ policyDecision: evidence('CUSTOMER_COMMERCE_POLICY'), postalAddress: postal }),
    ),
  loadCurrent: () => Effect.succeed(deliveryCurrent),
  loadDefaultDeliveryAddress: () => Effect.succeed({ kind: 'NONE' }),
  loadSavedAddress: () => Effect.succeed(notFound()),
  resolvePickupDestination: () => Effect.succeed(notFound()),
  resolvePostalAddress: () =>
    Effect.succeed(found({ kind: 'COMMERCE_ONLY', postalAddress: postal })),
  validatePickupAvailability: () =>
    Effect.succeed({
      deliveryEvidence: evidence('PICKUP_PROVIDER'),
      fulfillmentEvidence: evidence('FULFILLMENT'),
      kind: 'ACCEPTED',
    }),
  validatePostalAvailability: () =>
    Effect.succeed({
      deliveryEvidence: evidence('DELIVERY_AVAILABILITY'),
      fulfillmentEvidence: evidence('FULFILLMENT'),
      kind: 'ACCEPTED',
    }),
  ...overrides,
});

it('clears a default after permanent purpose loss and never auto-selects a replacement', () => {
  expect(
    reconcileDefaults({ billing: ref, profile, revision: 2 }, { ...saved, purposes: [] }),
  ).toEqual({ profile, revision: 3 });
});

it('keeps removed addresses out of every ordinary address-book response contract', () => {
  expect(Schema.is(ActiveSavedAddressSchema)({ ...saved, lifecycle: 'REMOVED' })).toBe(false);
});

it('rejects saved-address selection by a guest before resolution', () => {
  expect(
    Schema.is(InvoiceRecipientResolutionRequestSchema)({
      explicitChoice: { kind: 'SAVED_ADDRESS', savedAddressRef: ref },
      purchasingContext,
      subject: guestSubject,
    }),
  ).toBe(false);
  expect(
    Schema.is(DeliveryDestinationResolutionRequestSchema)({
      explicitChoice: { kind: 'SAVED_ADDRESS', savedAddressRef: ref },
      purchasingContext,
      subject: guestSubject,
    }),
  ).toBe(false);
});

it('rejects a nested pickup reference from another Tenant', () => {
  expect(
    Schema.is(DeliveryDestinationResolutionRequestSchema)({
      explicitChoice: {
        kind: 'PICKUP',
        pickupDestinationRef: {
          moduleId: 'fulfillment',
          resourceId: 'pickup-1',
          resourceType: 'fulfillment.pickup-destination',
          tenantId: '90000000-0000-4000-8000-000000000009',
        },
      },
      purchasingContext,
      subject: { kind: 'PROFILE', profile },
    }),
  ).toBe(false);
});

it('requires an attributable reason and positive revision for ordinary address updates', () => {
  expect(
    Schema.is(UpdateSavedAddressPayloadSchema)({
      expectedRevision: 0,
      label: 'Main',
      profile,
      savedAddressRef: ref,
    }),
  ).toBe(false);
  expect(
    Schema.is(UpdateSavedAddressPayloadSchema)({
      expectedRevision: 1,
      label: 'Main',
      profile,
      reason: 'Buyer corrected the label',
      savedAddressRef: ref,
    }),
  ).toBe(true);
});

it.effect('does not fall back when an explicit invoice choice is invalid', () =>
  Effect.gen(function* explicitInvoiceChoice() {
    let defaultReads = 0;
    const resolution = yield* resolveInvoiceRecipient(
      {
        explicitChoice: { kind: 'SAVED_ADDRESS', savedAddressRef: ref },
        purchasingContext,
        subject: { kind: 'PROFILE', profile },
      },
      trustedScope,
      invoicePorts({
        loadDefaultBillingAddress: () => {
          defaultReads += 1;
          return Effect.succeed({ kind: 'FOUND', value: saved });
        },
      }),
    );
    expect(resolution.kind).toBe('EXPLICIT_CHOICE_INVALID');
    expect(defaultReads).toBe(0);
  }),
);

it.effect('does not fall back when an explicit delivery choice is invalid', () =>
  Effect.gen(function* explicitDeliveryChoice() {
    let defaultReads = 0;
    const resolution = yield* resolveDeliveryDestination(
      {
        explicitChoice: { kind: 'SAVED_ADDRESS', savedAddressRef: ref },
        purchasingContext,
        subject: { kind: 'PROFILE', profile },
      },
      trustedScope,
      deliveryPorts({
        loadDefaultDeliveryAddress: () => {
          defaultReads += 1;
          return Effect.succeed({
            kind: 'FOUND',
            value: { ...saved, purposes: ['DELIVERY'] as const },
          });
        },
      }),
    );
    expect(resolution.kind).toBe('EXPLICIT_CHOICE_INVALID');
    expect(defaultReads).toBe(0);
  }),
);

it.effect('fails closed with a typed retryable error when tax policy is unavailable', () =>
  Effect.gen(function* unavailableTaxPolicy() {
    const failure = yield* resolveInvoiceRecipient(
      {
        explicitChoice: {
          choiceEvidenceRef: 'checkout-one-time-address-1',
          kind: 'ONE_TIME',
          postalAddress: postal,
        },
        purchasingContext,
        subject: { kind: 'PROFILE', profile },
      },
      trustedScope,
      invoicePorts({
        validateRecipient: () =>
          Effect.fail(
            new AddressBookUnavailable({
              code: 'address_book_unavailable',
              dependency: 'tax-policy',
              retryable: true,
            }),
          ),
      }),
    ).pipe(Effect.flip);
    expect(failure).toMatchObject({ dependency: 'tax-policy', retryable: true });
  }),
);

it.effect('returns the exact current invoice handoff evidence bundle', () =>
  Effect.gen(function* currentInvoiceBundle() {
    const resolution = yield* resolveInvoiceRecipient(
      {
        explicitChoice: {
          choiceEvidenceRef: 'checkout-one-time-address-1',
          kind: 'ONE_TIME',
          postalAddress: postal,
        },
        purchasingContext,
        subject: { kind: 'PROFILE', profile },
      },
      trustedScope,
      invoicePorts(),
    );
    expect(resolution).toMatchObject({
      decisionBundle: {
        acceptedHandoff: 'ORDER_ACCEPTANCE_INVOICE_RECIPIENT_V1',
        purchasingContext: currentPurchasingContext,
        sourceRevisions,
      },
      kind: 'INVOICE_RECIPIENT_RESOLVED',
      source: 'EXPLICIT',
    });
  }),
);

it.effect('keeps stored Party provenance while handing off the corrected Current revision', () =>
  Effect.gen(function* correctedPartyRevision() {
    const currentPartyRef = { ...storedPartyRef, resourceId: 'canonical-party-1' };
    const resolution = yield* resolveInvoiceRecipient(
      {
        explicitChoice: { kind: 'SAVED_ADDRESS', savedAddressRef: ref },
        purchasingContext,
        subject: { kind: 'PROFILE', profile },
      },
      trustedScope,
      invoicePorts({
        loadSavedAddress: () => Effect.succeed(found(partySaved)),
        resolvePostalAddress: () =>
          Effect.succeed(
            found({
              currentContactPointRef: storedContactPointRef,
              currentPartyRef,
              currentSourceRevision: 8,
              kind: 'PARTY_BACKED',
              postalAddress: postal,
            }),
          ),
      }),
    );
    expect(resolution).toMatchObject({
      decisionBundle: {
        recipient: {
          source: {
            currentPartyRef,
            currentSourceRevision: 8,
            originKind: 'PARTY_BACKED',
            storedPartyRef,
            storedSourceRevision: 7,
          },
        },
      },
      kind: 'INVOICE_RECIPIENT_RESOLVED',
    });
    expect(partySaved.origin.sourceRevision).toBe(7);
  }),
);

it.effect('resolves a guest snapshot without reading a profile address book', () =>
  Effect.gen(function* currentGuestBundle() {
    let profileAddressReads = 0;
    const resolution = yield* resolveInvoiceRecipient(
      {
        explicitChoice: {
          choiceEvidenceRef: 'checkout-guest-address-evidence-1',
          kind: 'ONE_TIME',
          postalAddress: postal,
        },
        purchasingContext,
        subject: guestSubject,
      },
      trustedScope,
      invoicePorts({
        loadCurrent: () => Effect.succeed(guestInvoiceCurrent),
        loadDefaultBillingAddress: () => {
          profileAddressReads += 1;
          return Effect.succeed({ kind: 'NONE' });
        },
        loadSavedAddress: () => {
          profileAddressReads += 1;
          return Effect.succeed(notFound());
        },
      }),
    );
    expect(resolution).toMatchObject({
      decisionBundle: {
        recipient: {
          identity: { guestEvidenceRef: guestSubject.guestEvidenceRef, kind: 'GUEST_SNAPSHOT' },
          subject: guestSubject,
        },
      },
      kind: 'INVOICE_RECIPIENT_RESOLVED',
    });
    expect(profileAddressReads).toBe(0);
  }),
);

it.effect('fails closed when claimed guest evidence differs from the trusted current actor', () =>
  Effect.gen(function* mismatchedGuestEvidence() {
    const resolution = yield* resolveInvoiceRecipient(
      {
        explicitChoice: {
          choiceEvidenceRef: 'checkout-guest-address-evidence-1',
          kind: 'ONE_TIME',
          postalAddress: postal,
        },
        purchasingContext,
        subject: { ...guestSubject, guestEvidenceRef: 'forged-guest-evidence' },
      },
      trustedScope,
      invoicePorts({ loadCurrent: () => Effect.succeed(guestInvoiceCurrent) }),
    );
    expect(resolution.kind).toBe('INCONSISTENT_CONFIGURATION');
  }),
);

it.effect('resolves guest delivery without reading saved addresses or defaults', () =>
  Effect.gen(function* guestDelivery() {
    let addressBookReads = 0;
    const resolution = yield* resolveDeliveryDestination(
      {
        explicitChoice: {
          choiceEvidenceRef: 'checkout-guest-delivery-address-1',
          kind: 'ONE_TIME',
          postalAddress: postal,
        },
        purchasingContext,
        subject: guestSubject,
      },
      trustedScope,
      deliveryPorts({
        loadCurrent: () => Effect.succeed(guestDeliveryCurrent),
        loadDefaultDeliveryAddress: () => {
          addressBookReads += 1;
          return Effect.succeed({ kind: 'NONE' });
        },
        loadSavedAddress: () => {
          addressBookReads += 1;
          return Effect.succeed(notFound());
        },
      }),
    );
    expect(resolution).toMatchObject({
      decisionBundle: { subject: guestSubject },
      kind: 'DELIVERY_DESTINATION_RESOLVED',
      source: 'EXPLICIT',
    });
    expect(addressBookReads).toBe(0);
  }),
);

it.effect('rejects delivery facts returned for a different trusted principal', () =>
  Effect.gen(function* crossActorDelivery() {
    let availabilityReads = 0;
    const resolution = yield* resolveDeliveryDestination(
      {
        explicitChoice: {
          choiceEvidenceRef: 'checkout-delivery-address-1',
          kind: 'ONE_TIME',
          postalAddress: postal,
        },
        purchasingContext,
        subject: { kind: 'PROFILE', profile },
      },
      trustedScope,
      deliveryPorts({
        loadCurrent: () =>
          Effect.succeed({
            ...deliveryCurrent,
            purchasingContext: {
              ...currentPurchasingContext,
              actor: { kind: 'PRINCIPAL', principalId: 'another-principal' },
            },
          }),
        validatePostalAvailability: () => {
          availabilityReads += 1;
          return Effect.succeed({
            deliveryEvidence: evidence('DELIVERY_AVAILABILITY'),
            fulfillmentEvidence: evidence('FULFILLMENT'),
            kind: 'ACCEPTED',
          });
        },
      }),
    );
    expect(resolution.kind).toBe('INCONSISTENT_CONFIGURATION');
    expect(availabilityReads).toBe(0);
  }),
);

it.effect('rejects delivery facts returned for a different profile', () =>
  Effect.gen(function* crossProfileDelivery() {
    const resolution = yield* resolveDeliveryDestination(
      {
        explicitChoice: {
          choiceEvidenceRef: 'checkout-delivery-address-1',
          kind: 'ONE_TIME',
          postalAddress: postal,
        },
        purchasingContext,
        subject: { kind: 'PROFILE', profile },
      },
      trustedScope,
      deliveryPorts({
        loadCurrent: () =>
          Effect.succeed({
            ...deliveryCurrent,
            subject: {
              kind: 'PROFILE',
              profile: {
                ...profile,
                profileRef: { ...profile.profileRef, resourceId: 'different-profile' },
              },
            },
          }),
      }),
    );
    expect(resolution.kind).toBe('INCONSISTENT_CONFIGURATION');
  }),
);

it.effect('rejects a stale delivery proposal before address or availability fallback', () =>
  Effect.gen(function* staleDeliveryProposal() {
    let availabilityReads = 0;
    const resolution = yield* resolveDeliveryDestination(
      {
        explicitChoice: {
          choiceEvidenceRef: 'checkout-one-time-address-1',
          kind: 'ONE_TIME',
          postalAddress: postal,
        },
        purchasingContext: { ...purchasingContext, expectedProposalRevision: 3 },
        subject: { kind: 'PROFILE', profile },
      },
      trustedScope,
      deliveryPorts({
        validatePostalAvailability: () => {
          availabilityReads += 1;
          return Effect.succeed({
            deliveryEvidence: evidence('DELIVERY_AVAILABILITY'),
            fulfillmentEvidence: evidence('FULFILLMENT'),
            kind: 'ACCEPTED',
          });
        },
      }),
    );
    expect(resolution.kind).toBe('INCONSISTENT_CONFIGURATION');
    expect(availabilityReads).toBe(0);
  }),
);
