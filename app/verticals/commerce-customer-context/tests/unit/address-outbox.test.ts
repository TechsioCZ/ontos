import { defineRead, defineTenantModuleEntrypoint, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { getReadServiceFactory, makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { expect, it } from 'effect-rstest';
import { DateTime, Effect, Schema } from 'effect';
import { AddressBookUnavailable } from '../../shared/domain/address-errors.ts';
import { createActionCollector, getActionHandler, getActionServiceFactory } from '@app/core-runtime/testing/actions';
import type { ReadHandlerContext } from '@app/core-runtime';
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

const registeredFactories = {
  add: getActionServiceFactory(addSavedAddressAction),
  billing: getActionServiceFactory(setDefaultBillingAddressAction),
  clearBilling: getActionServiceFactory(clearDefaultBillingAddressAction),
  clearDelivery: getActionServiceFactory(clearDefaultDeliveryDestinationAction),
  defaults: getReadServiceFactory(savedAddressDefaultsRead),
  delivery: getActionServiceFactory(setDefaultDeliveryDestinationAction),
  destination: getReadServiceFactory(deliveryDestinationResolutionRead),
  detail: getReadServiceFactory(savedAddressDetailRead),
  invoice: getReadServiceFactory(invoiceRecipientResolutionRead),
  list: getReadServiceFactory(savedAddressListRead),
  remove: getActionServiceFactory(removeSavedAddressAction),
  update: getActionServiceFactory(updateSavedAddressAction),
};
type FactoryServices = {
  readonly [Key in keyof typeof registeredFactories]: Effect.Success<ReturnType<(typeof registeredFactories)[Key]>>;
};

// Scripted SQL unit proof: Core supplies the genuine branded transaction; no owner factory is replaced.
it.effect('executes the registered address factories against their scoped owner routines', () =>
  Effect.gen(function* productionFactoryWiring() {
    const scope = {
      ...Schema.decodeSync(TrustedPrincipalContextSchema)({
        authBindingId: '20000000-0000-4000-8000-000000000002',
        authContextRef: 'better-auth-session:address-factory-wiring',
        authMethod: 'session',
        legalEntityId: '30000000-0000-4000-8000-000000000003',
        principalId: '40000000-0000-4000-8000-000000000004',
        tenantId,
      }),
      correlationId: 'address-factory-wiring',
    };
    const attribution = {
      actionInvocationId: '50000000-0000-4000-8000-000000000005',
      principalId: scope.principalId,
    };
    const rawAddress = {
      address_line_1: address.origin.postalAddress.addressLine1,
      address_line_2: null,
      administrative_area: null,
      city: address.origin.postalAddress.city,
      cleared_purposes: [],
      country_code: 'CZ',
      label: null,
      lifecycle: 'ACTIVE',
      outcome: 'FOUND',
      party_contact_point_resource_id: null,
      party_contact_point_revision: null,
      party_resource_id: null,
      postal_code: address.origin.postalAddress.postalCode,
      purposes: ['BILLING'],
      revision: 2,
      saved_address_id: savedAddressRef.resourceId,
      source_kind: 'COMMERCE_ONLY',
    };
    const rawDefaults = {
      billing_saved_address_id: savedAddressRef.resourceId,
      cleared_saved_address_id: savedAddressRef.resourceId,
      delivery_saved_address_id: savedAddressRef.resourceId,
      outcome: 'PRESENT',
      revision: 4,
    };
    const script = [
      { name: 'add_saved_address', row: { ...rawAddress, outcome: 'ADDED' } },
      { name: 'update_saved_address', row: { ...rawAddress, outcome: 'UPDATED' } },
      { name: 'remove_saved_address', row: { ...rawAddress, lifecycle: 'REMOVED', outcome: 'REMOVED' } },
      { name: 'change_address_default', row: { ...rawDefaults, outcome: 'SET' } },
      { name: 'change_address_default', row: { ...rawDefaults, outcome: 'CLEARED' } },
      { name: 'change_address_default', row: { ...rawDefaults, outcome: 'SET' } },
      { name: 'change_address_default', row: { ...rawDefaults, outcome: 'CLEARED' } },
      { name: 'list_saved_addresses', row: rawAddress },
      { name: 'read_saved_address', row: rawAddress },
      { name: 'read_address_defaults', row: rawDefaults },
      { name: 'read_saved_address', row: rawAddress },
      { name: 'read_saved_address', row: rawAddress },
    ];
    let nextQuery = 0;
    const harness = yield* makeReadTestHarness({
      compositionRevision: 'a'.repeat(64),
      executeOwnerQuery: (query) => {
        const expected = script[nextQuery];
        nextQuery += 1;
        if (expected === undefined) {
          return Effect.die('Unexpected owner routine invocation');
        }
        expect(query.sql).toContain(`"commerce_customer_context"."${expected.name}"`);
        expect(query.scope).toEqual({ legalEntityId: scope.legalEntityId, tenantId });
        expect(query.params.slice(0, 2)).toEqual([tenantId, scope.legalEntityId]);
        return Effect.succeed([expected.row]);
      },
      operationTime: DateTime.toDateUtc(DateTime.makeUnsafe(1_800_000_000_000)),
      ownerAuthorizationDecision: 'allowed',
      permissionDecision: 'allowed',
      scope,
    });
    // This test-only Read composition obtains Core's scoped transaction for the actual factory contracts.
    // Invoking their ports proves wiring; it does not claim a native Action commit or provider HTTP proof.
    const factoryProbe = defineRead(
      {
        accessKind: 'list',
        entrypoint: defineTenantModuleEntrypoint({
          access: 'read',
          authorization: { kind: 'context_permission', permission: 'module.access' },
          entrypointKey: 'commerce.customer-context.api.saved-address-list',
          moduleKey: 'commerce.customer-context',
          role: 'api',
        }),
        evidencePolicy: savedAddressListRead.descriptor.evidencePolicy,
        inputSchema: Schema.Struct({}),
        legalEntityScope: 'required',
        owningModuleKey: 'commerce.customer-context',
        permissionTarget: 'module',
        policies: [],
        readKey: 'commerce.customer-context.api.saved-address-list',
        resultSchema: Schema.Struct({}),
        schemaVersion: '1',
      },
      Effect.fn('AddressFactoryProbe.handle')(function* probeFactories(
        _input,
        context: ReadHandlerContext<FactoryServices>,
      ) {
        const {
          add,
          billing,
          clearBilling,
          clearDelivery,
          defaults,
          delivery,
          destination,
          detail,
          invoice,
          list,
          remove,
          update,
        } = context.services;
        const addPayload = {
          origin: address.origin,
          profile,
          purposes: address.purposes,
          reason: 'Save local address',
        };
        yield* add.validatePartySource(addPayload);
        expect(yield* add.add(addPayload, attribution)).toMatchObject({ address, outcome: 'ADDED' });
        expect(
          yield* update.update(
            { expectedRevision: 1, label: 'Main', profile, reason: 'Update local address', savedAddressRef },
            attribution,
          ),
        ).toMatchObject({ address, outcome: 'UPDATED' });
        expect(
          yield* remove.remove(
            { expectedRevision: 2, profile, reason: 'Remove address', savedAddressRef },
            attribution,
          ),
        ).toMatchObject({ outcome: 'REMOVED' });
        const setPayload = { expectedDefaultsRevision: 3, profile, reason: 'Set local default', savedAddressRef };
        const clearPayload = { expectedDefaultsRevision: 3, profile, reason: 'Clear local default' };
        expect(yield* billing.set(setPayload, 'BILLING', attribution)).toMatchObject({ outcome: 'SET' });
        expect(yield* clearBilling.clear(clearPayload, 'BILLING', attribution)).toMatchObject({ outcome: 'CLEARED' });
        expect(yield* delivery.set(setPayload, 'DELIVERY', attribution)).toMatchObject({ outcome: 'SET' });
        expect(yield* clearDelivery.clear(clearPayload, 'DELIVERY', attribution)).toMatchObject({ outcome: 'CLEARED' });
        expect(yield* list.list({ profile }, tenantId)).toEqual({ addresses: [address] });
        expect(yield* detail.detail({ profile, savedAddressRef }, tenantId)).toEqual({ address });
        expect(yield* defaults.defaults({ profile }, tenantId)).toMatchObject({ defaults: { revision: 4 } });
        expect(yield* invoice.loadSavedAddress({ profile, resourceId: savedAddressRef.resourceId })).toEqual({
          kind: 'FOUND',
          value: address,
        });
        expect(yield* invoice.resolvePostalAddress(address)).toEqual({ kind: 'FOUND', value: address.origin });
        expect(yield* destination.loadSavedAddress({ profile, resourceId: savedAddressRef.resourceId })).toEqual({
          kind: 'FOUND',
          value: address,
        });
        expect(yield* destination.resolvePostalAddress(address)).toEqual({ kind: 'FOUND', value: address.origin });
        const partyPayload = { ...addPayload, origin: partyOrigin };
        expect(Schema.is(AddressBookUnavailable)(yield* Effect.flip(add.validatePartySource(partyPayload)))).toBe(true);
        expect(
          Schema.is(AddressBookUnavailable)(
            yield* Effect.flip(
              update.validatePartySource({
                expectedRevision: 2,
                origin: partyOrigin,
                profile,
                reason: 'Refresh Party source',
                savedAddressRef,
              }),
            ),
          ),
        ).toBe(true);
        expect(Schema.is(AddressBookUnavailable)(yield* Effect.flip(invoice.resolvePostalAddress(partyAddress)))).toBe(
          true,
        );
        expect(
          Schema.is(AddressBookUnavailable)(yield* Effect.flip(destination.resolvePostalAddress(partyAddress))),
        ).toBe(true);
        return { evidence: { resultCount: 0 }, result: {} };
      }),
      Effect.fn('AddressFactoryProbe.services')(
        function* collectRegisteredFactories(transaction, verifiedScope, revision) {
          return yield* Effect.all(
            {
              add: registeredFactories.add(transaction, verifiedScope, revision ?? ''),
              billing: registeredFactories.billing(transaction, verifiedScope, revision ?? ''),
              clearBilling: registeredFactories.clearBilling(transaction, verifiedScope, revision ?? ''),
              clearDelivery: registeredFactories.clearDelivery(transaction, verifiedScope, revision ?? ''),
              defaults: registeredFactories.defaults(transaction, verifiedScope, revision),
              delivery: registeredFactories.delivery(transaction, verifiedScope, revision ?? ''),
              destination: registeredFactories.destination(transaction, verifiedScope, revision),
              detail: registeredFactories.detail(transaction, verifiedScope, revision),
              invoice: registeredFactories.invoice(transaction, verifiedScope, revision),
              list: registeredFactories.list(transaction, verifiedScope, revision),
              remove: registeredFactories.remove(transaction, verifiedScope, revision ?? ''),
              update: registeredFactories.update(transaction, verifiedScope, revision ?? ''),
            },
            { concurrency: 1 },
          );
        },
      ),
      () => ({ kind: 'module', moduleId: 'commerce.customer-context' }),
    );
    yield* harness.runtime.runRead({
      input: {},
      principal: scope,
      registration: factoryProbe,
      transport: { correlationId: scope.correlationId },
    });
    expect(nextQuery).toBe(script.length);
    expect(harness.snapshot().evidenceWrites).toBe(1);
  }).pipe(Effect.scoped, Effect.provide(nodeCryptoLayer)),
);

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
      compositionRevision: 'a'.repeat(64),
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
    expect('outcome' in result).toBe(true);
    if ('outcome' in result) {
      expect(result.outcome).toBe('UPDATED');
    }
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
      compositionRevision: 'a'.repeat(64),
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
  }).pipe(Effect.provide(nodeCryptoLayer)),
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
      compositionRevision: 'a'.repeat(64),
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
    expect('outcome' in result).toBe(true);
    if ('outcome' in result) {
      expect(result.outcome).toBe('REUSED');
    }
    expect(forwardedAttribution).toEqual({
      actionInvocationId: '60000000-0000-4000-8000-000000000006',
      principalId: '40000000-0000-4000-8000-000000000004',
    });
    const evidence = collector.snapshot();
    expect(evidence.dataAccessEvents).toHaveLength(1);
    expect(evidence.domainEvents).toHaveLength(0);
    expect(evidence.outboxMessages).toHaveLength(0);
  }).pipe(Effect.provide(nodeCryptoLayer)),
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
        compositionRevision: 'a'.repeat(64),
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
        compositionRevision: 'a'.repeat(64),
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
          update: () => Effect.succeed({ address: partyAddress, clearedDefaults: [], outcome: 'UNCHANGED' }),
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
  }).pipe(Effect.provide(nodeCryptoLayer)),
);
