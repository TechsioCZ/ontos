import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import {
  getActionHandler,
  getActionServiceFactory,
} from '../../../../packages/core-runtime/src/actions/definition.ts';
import { getReadServiceFactory } from '../../../../packages/core-runtime/src/reads/definition.ts';
import { OutboxPayloadSchema as AddedSchema } from '../../shared/outbox/commerce-customer-context-saved-address-added-v1.ts';
import {
  OutboxPayloadSchema as UpdatedSchema,
  outboxTopic as updatedTopic,
} from '../../shared/outbox/commerce-customer-context-saved-address-updated-v1.ts';
import { OutboxPayloadSchema as RemovedSchema } from '../../shared/outbox/commerce-customer-context-saved-address-removed-v1.ts';
import { OutboxPayloadSchema as BillingSetSchema } from '../../shared/outbox/commerce-customer-context-default-billing-address-set-v1.ts';
import { OutboxPayloadSchema as BillingClearedSchema } from '../../shared/outbox/commerce-customer-context-default-billing-address-cleared-v1.ts';
import { OutboxPayloadSchema as DeliverySetSchema } from '../../shared/outbox/commerce-customer-context-default-delivery-destination-set-v1.ts';
import { OutboxPayloadSchema as DeliveryClearedSchema } from '../../shared/outbox/commerce-customer-context-default-delivery-destination-cleared-v1.ts';
import { updateSavedAddressAction } from '../../src/actions/update-saved-address.action.ts';
import { addSavedAddressAction } from '../../src/actions/add-saved-address.action.ts';
import { clearDefaultBillingAddressAction } from '../../src/actions/clear-default-billing-address.action.ts';
import { clearDefaultDeliveryDestinationAction } from '../../src/actions/clear-default-delivery-destination.action.ts';
import { removeSavedAddressAction } from '../../src/actions/remove-saved-address.action.ts';
import { setDefaultBillingAddressAction } from '../../src/actions/set-default-billing-address.action.ts';
import { setDefaultDeliveryDestinationAction } from '../../src/actions/set-default-delivery-destination.action.ts';
import {
  deliveryDestinationReadServiceFactory,
  invoiceRecipientReadServiceFactory,
} from '../../src/api/address-read-support.ts';
import { deliveryDestinationResolutionRead } from '../../src/api/delivery-destination-resolution.read.ts';
import { invoiceRecipientResolutionRead } from '../../src/api/invoice-recipient-resolution.read.ts';
import { savedAddressDefaultsRead } from '../../src/api/saved-address-defaults.read.ts';
import { savedAddressDetailRead } from '../../src/api/saved-address-detail.read.ts';
import { savedAddressListRead } from '../../src/api/saved-address-list.read.ts';

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
const savedAddressRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'address-1',
  resourceType: 'commerce.customer-context.saved-address',
  tenantId,
} as const;
const address = {
  lifecycle: 'ACTIVE',
  origin: {
    kind: 'COMMERCE_ONLY',
    postalAddress: {
      addressLine1: '1 Main Street',
      city: 'Prague',
      countryCode: 'CZ',
      postalCode: '11000',
    },
  },
  profile,
  purposes: ['BILLING'] as const,
  revision: 2,
  savedAddressRef,
} as const;
const partyOrigin = {
  contactPointRef: {
    moduleId: 'party.registry',
    resourceId: 'party-contact-point-1',
    resourceType: 'party.registry.party-contact-point',
    tenantId,
  },
  kind: 'PARTY_BACKED',
  partyRef: {
    moduleId: 'party.registry',
    resourceId: 'party-1',
    resourceType: 'party.registry.party',
    tenantId,
  },
  sourceRevision: 7,
} as const;
const partyAddress = { ...address, origin: partyOrigin } as const;

it('publishes seven minimal reference-only outbox payload contracts', () => {
  const addressAdded = {
    originKind: 'COMMERCE_ONLY',
    profile,
    purposes: ['BILLING'],
    revision: 2,
    savedAddressRef,
  };
  const addressUpdated = { ...addressAdded, clearedDefaults: ['DELIVERY'] };
  const addressRemoved = { clearedDefaults: ['BILLING'], profile, revision: 3, savedAddressRef };
  const defaultSet = { profile, revision: 3, savedAddressRef };
  const defaultCleared = { clearedSavedAddressRef: savedAddressRef, profile, revision: 4 };
  expect(Schema.is(AddedSchema)(addressAdded)).toBe(true);
  expect(Schema.is(UpdatedSchema)(addressUpdated)).toBe(true);
  expect(Schema.is(RemovedSchema)(addressRemoved)).toBe(true);
  expect(Schema.is(BillingSetSchema)(defaultSet)).toBe(true);
  expect(Schema.is(DeliverySetSchema)(defaultSet)).toBe(true);
  expect(Schema.is(BillingClearedSchema)(defaultCleared)).toBe(true);
  expect(Schema.is(DeliveryClearedSchema)(defaultCleared)).toBe(true);
  expect('data' in addressAdded).toBe(false);
  expect('postalAddress' in addressAdded).toBe(false);
});

it('attaches every address Action and Read registration to its production persistence factory', () => {
  const addFactory = getActionServiceFactory(addSavedAddressAction).toString();
  const updateFactory = getActionServiceFactory(updateSavedAddressAction).toString();
  expect(addFactory).toContain('addressActionPersistenceForTransaction');
  expect(addFactory).toContain('partyBackedAddressSourceValidator');
  expect(updateFactory).toContain('addressActionPersistenceForTransaction');
  expect(updateFactory).toContain('partyBackedAddressSourceValidator');
  expect(getActionServiceFactory(removeSavedAddressAction).toString()).toContain(
    'addressActionPersistenceForTransaction',
  );
  expect(getActionServiceFactory(setDefaultBillingAddressAction).toString()).toContain(
    'addressActionPersistenceForTransaction',
  );
  expect(getActionServiceFactory(clearDefaultBillingAddressAction).toString()).toContain(
    'addressActionPersistenceForTransaction',
  );
  expect(getActionServiceFactory(setDefaultDeliveryDestinationAction).toString()).toContain(
    'addressActionPersistenceForTransaction',
  );
  expect(getActionServiceFactory(clearDefaultDeliveryDestinationAction).toString()).toContain(
    'addressActionPersistenceForTransaction',
  );
  expect(getReadServiceFactory(savedAddressListRead).toString()).toContain(
    'addressReadServicesForTransaction',
  );
  expect(getReadServiceFactory(savedAddressDetailRead).toString()).toContain(
    'addressReadServicesForTransaction',
  );
  expect(getReadServiceFactory(savedAddressDefaultsRead).toString()).toContain(
    'addressReadServicesForTransaction',
  );
  expect(getReadServiceFactory(invoiceRecipientResolutionRead)).toBe(
    invoiceRecipientReadServiceFactory,
  );
  expect(getReadServiceFactory(deliveryDestinationResolutionRead)).toBe(
    deliveryDestinationReadServiceFactory,
  );
  expect(invoiceRecipientReadServiceFactory.toString()).toContain(
    'invoiceRecipientPortsForTransaction',
  );
  expect(deliveryDestinationReadServiceFactory.toString()).toContain(
    'deliveryDestinationPortsForTransaction',
  );
});

it.effect('forwards trusted attribution and attaches outbox only for a material update', () =>
  Effect.gen(function* materialAttachment() {
    let forwardedAttribution: unknown;
    const collector = createActionCollector(
      updateSavedAddressAction.descriptor.domainEvents,
      'commerce.customer-context',
      updateSavedAddressAction.descriptor.accessEvidencePolicy,
      updateSavedAddressAction.descriptor.auditEvidenceSchema,
    );
    const payload = {
      expectedRevision: 1,
      label: 'Main',
      profile,
      reason: 'Buyer corrected the delivery label',
      savedAddressRef,
    };
    const result = yield* getActionHandler(updateSavedAddressAction)(payload, {
      actionInvocationId: '20000000-0000-4000-8000-000000000002',
      addDomainEvent: collector.addDomainEvent,
      addOutboxMessage: collector.addOutboxMessage,
      recordAuditEvidence: collector.recordAuditEvidence,
      recordDataAccess: collector.recordDataAccess,
      scope: {
        authMethod: 'system',
        correlationId: 'address-update',
        legalEntityId: '30000000-0000-4000-8000-000000000003',
        principalId: '40000000-0000-4000-8000-000000000004',
        tenantId,
      },
      services: {
        update: (_payload, attribution) => {
          forwardedAttribution = attribution;
          return Effect.succeed({ address, clearedDefaults: [], outcome: 'UPDATED' });
        },
        validatePartySource: () => Effect.void,
      },
    });
    expect(result.outcome).toBe('UPDATED');
    expect(forwardedAttribution).toEqual({
      actionInvocationId: '20000000-0000-4000-8000-000000000002',
      principalId: '40000000-0000-4000-8000-000000000004',
    });
    const evidence = collector.snapshot();
    expect(evidence.domainEvents).toHaveLength(1);
    expect(evidence.dataAccessEvents).toHaveLength(1);
    expect(evidence.outboxMessages).toHaveLength(1);
    expect(evidence.outboxMessages[0]?.domainEventIndex).toBe(0);
    expect(evidence.outboxMessages[0]?.message.topic).toBe(updatedTopic);

    const unchangedCollector = createActionCollector(
      updateSavedAddressAction.descriptor.domainEvents,
      'commerce.customer-context',
      updateSavedAddressAction.descriptor.accessEvidencePolicy,
      updateSavedAddressAction.descriptor.auditEvidenceSchema,
    );
    yield* getActionHandler(updateSavedAddressAction)(payload, {
      actionInvocationId: '50000000-0000-4000-8000-000000000005',
      addDomainEvent: unchangedCollector.addDomainEvent,
      addOutboxMessage: unchangedCollector.addOutboxMessage,
      recordAuditEvidence: unchangedCollector.recordAuditEvidence,
      recordDataAccess: unchangedCollector.recordDataAccess,
      scope: {
        authMethod: 'system',
        correlationId: 'address-unchanged',
        legalEntityId: '30000000-0000-4000-8000-000000000003',
        principalId: '40000000-0000-4000-8000-000000000004',
        tenantId,
      },
      services: {
        update: () => Effect.succeed({ address, clearedDefaults: [], outcome: 'UNCHANGED' }),
        validatePartySource: () => Effect.void,
      },
    });
    expect(unchangedCollector.snapshot().domainEvents).toHaveLength(0);
    expect(unchangedCollector.snapshot().outboxMessages).toHaveLength(0);
  }),
);

it.effect('does not attach a duplicate add event when an exact business replay is reused', () =>
  Effect.gen(function* reusedAdd() {
    let forwardedAttribution: unknown;
    const collector = createActionCollector(
      addSavedAddressAction.descriptor.domainEvents,
      'commerce.customer-context',
      addSavedAddressAction.descriptor.accessEvidencePolicy,
      addSavedAddressAction.descriptor.auditEvidenceSchema,
    );
    const payload = {
      origin: address.origin,
      profile,
      purposes: address.purposes,
      reason: 'Save checkout billing address',
    };
    const result = yield* getActionHandler(addSavedAddressAction)(payload, {
      actionInvocationId: '60000000-0000-4000-8000-000000000006',
      addDomainEvent: collector.addDomainEvent,
      addOutboxMessage: collector.addOutboxMessage,
      recordAuditEvidence: collector.recordAuditEvidence,
      recordDataAccess: collector.recordDataAccess,
      scope: {
        authMethod: 'system',
        correlationId: 'address-reused',
        legalEntityId: '30000000-0000-4000-8000-000000000003',
        principalId: '40000000-0000-4000-8000-000000000004',
        tenantId,
      },
      services: {
        add: (_input, attribution) => {
          forwardedAttribution = attribution;
          return Effect.succeed({ address, outcome: 'REUSED' });
        },
        validatePartySource: () => Effect.void,
      },
    });
    expect(result.outcome).toBe('REUSED');
    expect(forwardedAttribution).toEqual({
      actionInvocationId: '60000000-0000-4000-8000-000000000006',
      principalId: '40000000-0000-4000-8000-000000000004',
    });
    const evidence = collector.snapshot();
    expect(evidence.dataAccessEvents).toHaveLength(1);
    expect(evidence.domainEvents).toHaveLength(0);
    expect(evidence.outboxMessages).toHaveLength(0);
  }),
);

it.effect('records the contributing Party Contact Point read for add and update', () =>
  Effect.gen(function* partySourceEvidence() {
    const addCollector = createActionCollector(
      addSavedAddressAction.descriptor.domainEvents,
      'commerce.customer-context',
      addSavedAddressAction.descriptor.accessEvidencePolicy,
      addSavedAddressAction.descriptor.auditEvidenceSchema,
    );
    yield* getActionHandler(addSavedAddressAction)(
      {
        origin: partyOrigin,
        profile,
        purposes: ['BILLING'],
        reason: 'Save verified Party address',
      },
      {
        actionInvocationId: '70000000-0000-4000-8000-000000000007',
        addDomainEvent: addCollector.addDomainEvent,
        addOutboxMessage: addCollector.addOutboxMessage,
        recordAuditEvidence: addCollector.recordAuditEvidence,
        recordDataAccess: addCollector.recordDataAccess,
        scope: {
          authMethod: 'system',
          correlationId: 'party-address-add',
          legalEntityId: '30000000-0000-4000-8000-000000000003',
          principalId: '40000000-0000-4000-8000-000000000004',
          tenantId,
        },
        services: {
          add: () => Effect.succeed({ address: partyAddress, outcome: 'REUSED' }),
          validatePartySource: () => Effect.void,
        },
      },
    );

    const updateCollector = createActionCollector(
      updateSavedAddressAction.descriptor.domainEvents,
      'commerce.customer-context',
      updateSavedAddressAction.descriptor.accessEvidencePolicy,
      updateSavedAddressAction.descriptor.auditEvidenceSchema,
    );
    yield* getActionHandler(updateSavedAddressAction)(
      {
        expectedRevision: 2,
        origin: partyOrigin,
        profile,
        reason: 'Refresh verified Party source',
        savedAddressRef,
      },
      {
        actionInvocationId: '80000000-0000-4000-8000-000000000008',
        addDomainEvent: updateCollector.addDomainEvent,
        addOutboxMessage: updateCollector.addOutboxMessage,
        recordAuditEvidence: updateCollector.recordAuditEvidence,
        recordDataAccess: updateCollector.recordDataAccess,
        scope: {
          authMethod: 'system',
          correlationId: 'party-address-update',
          legalEntityId: '30000000-0000-4000-8000-000000000003',
          principalId: '40000000-0000-4000-8000-000000000004',
          tenantId,
        },
        services: {
          update: () =>
            Effect.succeed({ address: partyAddress, clearedDefaults: [], outcome: 'UNCHANGED' }),
          validatePartySource: () => Effect.void,
        },
      },
    );

    for (const evidence of [addCollector.snapshot(), updateCollector.snapshot()]) {
      expect(evidence.dataAccessEvents).toContainEqual(
        expect.objectContaining({
          accessKind: 'read',
          servingModuleKey: 'commerce.customer-context',
          targetModuleKey: 'party.registry',
          targetResourceId: partyOrigin.contactPointRef.resourceId,
          targetResourceType: 'party.registry.party-contact-point',
        }),
      );
    }
  }),
);
