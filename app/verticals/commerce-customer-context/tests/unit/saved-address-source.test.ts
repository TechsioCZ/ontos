import { NodeCrypto } from '@effect/platform-node';
import { CommerceSourceProcessingEligibility } from '../../src/integrations/source-processing-eligibility.ts';
import { ReadPermissionDenied } from '@app/core-runtime';
import { createActionCollector, getActionHandler } from '@app/core-runtime/testing/actions';
import { Effect, Match, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  AddSavedAddressPayloadSchema,
  UpdateSavedAddressPayloadSchema,
  RemoveSavedAddressPayloadSchema,
} from '../../shared/domain/address-actions.ts';
import { AddressBookUnavailable } from '../../shared/domain/address-errors.ts';
import {
  SavedAddressSourceReceiptSchema,
  SavedAddressSourceRejected,
} from '../../shared/domain/saved-address-source.ts';
import { SavedAddressSourceReceiptRequestSchema } from '../../shared/apis/saved-address-source-receipt.ts';
import { addSavedAddressAction } from '../../src/actions/add-saved-address.action.ts';
import { updateSavedAddressAction } from '../../src/actions/update-saved-address.action.ts';
import { removeSavedAddressAction } from '../../src/actions/remove-saved-address.action.ts';
import {
  savedAddressSourceReadService,
  savedAddressSourceService,
} from '../../src/services/saved-address-source.service.ts';
import { addressActionPersistenceForTransaction } from '../../src/persistence/address-persistence.ts';
import type { CustomerContextAddressRoutineInvoker } from '../../src/persistence/address-persistence.ts';

const tenantId = 'aa000000-0000-4000-8000-000000000001';
const profile = {
  kind: 'RETAIL',
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: 'aa000000-0000-4000-8000-000000000002',
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId,
  },
} as const;
const savedAddressRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'aa000000-0000-4000-8000-000000000003',
  resourceType: 'commerce.customer-context.saved-address',
  tenantId,
} as const;
const source = {
  effectId: 'address-effect-1',
  identity: {
    issuer: 'internal-ebs',
    namespace: 'addresses',
    occurrenceId: 'address-17-r1',
    recordId: 'address-17',
    recordType: 'postal-address',
    routeRef: 'internal-address-route',
  },
  mappingRevision: 'mapping-1',
  order: 1,
  purposes: ['BILLING'],
  revision: 'r1',
  routeRevision: 'route-1',
} as const;
const add = {
  origin: {
    kind: 'COMMERCE_ONLY',
    postalAddress: { addressLine1: '1 Main Street', city: 'Prague', countryCode: 'CZ', postalCode: '11000' },
  },
  profile,
  purposes: ['BILLING'],
  reason: 'Apply explicit internal billing address',
  source,
} as const;
const scope = {
  authContextRef: 'gateway:internal-writer',
  authMethod: 'system',
  correlationId: 'address-source-test',
  legalEntityId: 'aa000000-0000-4000-8000-000000000004',
  principalId: 'aa000000-0000-4000-8000-000000000005',
  tenantId,
} as const;
const invocation = 'aa000000-0000-4000-8000-000000000006';

it('requires an actual qualified address identity and exact explicit purpose', () => {
  expect(Schema.is(AddSavedAddressPayloadSchema)(add)).toBe(true);
  expect(Schema.is(AddSavedAddressPayloadSchema)({ ...add, source: { ...source, identity: null } })).toBe(false);
  expect(
    Schema.is(AddSavedAddressPayloadSchema)({
      ...add,
      source: { ...source, identity: { ...source.identity, recordId: '' } },
    }),
  ).toBe(false);
  expect(Schema.is(AddSavedAddressPayloadSchema)({ ...add, source: { ...source, purposes: ['DELIVERY'] } })).toBe(
    false,
  );
  expect(
    Schema.is(AddSavedAddressPayloadSchema)({
      ...add,
      source: { ...source, nativeAddressId: savedAddressRef.resourceId },
    }),
  ).toBe(false);
});
it('pins Update and Remove to the actual source-bound native address', () => {
  const update = {
    expectedRevision: 1,
    label: 'Corrected label',
    profile,
    reason: add.reason,
    savedAddressRef,
    source: { ...source, nativeAddressId: savedAddressRef.resourceId },
  };
  expect(Schema.is(UpdateSavedAddressPayloadSchema)(update)).toBe(true);
  expect(Schema.is(UpdateSavedAddressPayloadSchema)({ ...update, source })).toBe(false);
  expect(Schema.is(UpdateSavedAddressPayloadSchema)({ ...update, purposes: ['DELIVERY'] })).toBe(false);
  const remove = {
    expectedRevision: 1,
    profile,
    reason: add.reason,
    savedAddressRef,
    source: { ...source, nativeAddressId: savedAddressRef.resourceId },
  };
  expect(Schema.is(RemoveSavedAddressPayloadSchema)(remove)).toBe(true);
  expect(
    Schema.is(RemoveSavedAddressPayloadSchema)({
      ...remove,
      source: { ...source, nativeAddressId: profile.profileRef.resourceId },
    }),
  ).toBe(false);
});
it.effect('rejects source workload manual paths before any native or Party service runs', () =>
  Effect.gen(function* machineManualDenied() {
    let calls = 0;
    const denied = () => {
      calls += 1;
      return Effect.fail(
        new AddressBookUnavailable({
          code: 'address_book_unavailable',
          dependency: 'unexpected-test-call',
          retryable: true,
        }),
      );
    };
    const collector = createActionCollector(
      {
        ...addSavedAddressAction.descriptor.domainEvents,
        ...updateSavedAddressAction.descriptor.domainEvents,
        ...removeSavedAddressAction.descriptor.domainEvents,
      },
      'commerce.customer-context',
      addSavedAddressAction.descriptor.accessEvidencePolicy,
      addSavedAddressAction.descriptor.auditEvidenceSchema,
    );
    const context = {
      actionInvocationId: invocation,
      addDomainEvent: collector.addDomainEvent,
      addOutboxMessage: collector.addOutboxMessage,
      compositionRevision: 'a'.repeat(64),
      recordAuditEvidence: collector.recordAuditEvidence,
      recordDataAccess: collector.recordDataAccess,
      scope,
      services: { add: denied, remove: denied, update: denied, validatePartySource: denied },
    };
    const { source: assertion, ...manual } = add;
    expect(assertion).toEqual(source);
    const addPayload = yield* Schema.decodeUnknownEffect(AddSavedAddressPayloadSchema)(manual);
    const updatePayload = yield* Schema.decodeUnknownEffect(UpdateSavedAddressPayloadSchema)({
      expectedRevision: 1,
      label: 'Updated',
      profile,
      reason: add.reason,
      savedAddressRef,
    });
    const removePayload = yield* Schema.decodeUnknownEffect(RemoveSavedAddressPayloadSchema)({
      expectedRevision: 1,
      profile,
      reason: add.reason,
      savedAddressRef,
    });
    const removeCollector = createActionCollector(
      removeSavedAddressAction.descriptor.domainEvents,
      'commerce.customer-context',
      removeSavedAddressAction.descriptor.accessEvidencePolicy,
      removeSavedAddressAction.descriptor.auditEvidenceSchema,
    );
    for (const failure of [
      yield* Effect.flip(getActionHandler(addSavedAddressAction)(addPayload, context)),
      yield* Effect.flip(getActionHandler(updateSavedAddressAction)(updatePayload, context)),
      yield* Effect.flip(
        getActionHandler(removeSavedAddressAction)(removePayload, {
          ...context,
          addDomainEvent: removeCollector.addDomainEvent,
          addOutboxMessage: removeCollector.addOutboxMessage,
          recordAuditEvidence: removeCollector.recordAuditEvidence,
        }),
      ),
    ]) {
      expect(failure).toBeInstanceOf(SavedAddressSourceRejected);
    }
    expect(calls).toBe(0);
    expect(collector.snapshot().domainEvents).toHaveLength(0);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);
it('rejects postal content in immutable minimal original receipts', () => {
  const receipt = {
    actionInvocationId: invocation,
    clearedDefaults: [],
    operation: 'ADD',
    outcome: 'ADDED',
    profile,
    requestHash: 'a'.repeat(64),
    revision: 1,
    savedAddressRef,
  };
  expect(Schema.is(SavedAddressSourceReceiptSchema)(receipt)).toBe(true);
  expect(() =>
    Schema.decodeUnknownSync(SavedAddressSourceReceiptSchema, { onExcessProperty: 'error' })({
      ...receipt,
      postalAddress: add.origin.postalAddress,
    }),
  ).toThrow();
  expect(Schema.is(SavedAddressSourceReceiptSchema)({ ...receipt, outcome: 'UPDATED' })).toBe(false);
});
it.effect('keeps unknown receipts indeterminate without inspecting current profile or Privacy', () =>
  Effect.gen(function* unknownReceiptIndeterminate() {
    let calls = 0;
    let checks = 0;
    const invoker: CustomerContextAddressRoutineInvoker = {
      invoke: (routine) => {
        calls += 1;
        expect(routine.name).toBe('read_saved_address_source_receipt');
        return Effect.succeed(
          Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([
            {
              outcome: 'NOT_FOUND',
              recorded_action_key: null,
              recorded_auth_context_ref: null,
              recorded_principal_id: null,
              result: null,
            },
          ]),
        );
      },
    };
    const input = yield* Schema.decodeUnknownEffect(SavedAddressSourceReceiptRequestSchema)({
      actionInvocationId: invocation,
      actionKey: 'commerce.customer-context.add-saved-address',
      mode: 'RECEIPT',
      profile,
      requestHash: 'a'.repeat(64),
      source,
    });
    const result = yield* savedAddressSourceReadService(invoker, scope)
      .read(input)
      .pipe(
        Effect.provideService(CommerceSourceProcessingEligibility, {
          check: () => {
            checks += 1;
            return Effect.void;
          },
        }),
      );
    expect(
      Match.value(result).pipe(
        Match.tag('INDETERMINATE', () => true),
        Match.orElse(() => false),
      ),
    ).toBe(true);
    expect(calls).toBe(1);
    expect(checks).toBe(0);
  }),
);
it.effect('refuses revoked receipt route authority before releasing original evidence', () =>
  Effect.gen(function* revokedRouteDenied() {
    const invoker: CustomerContextAddressRoutineInvoker = {
      invoke: (routine) =>
        Effect.succeed(
          Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([
            {
              outcome: 'SOURCE_AUTHORITY_DENIED',
              recorded_action_key: null,
              recorded_auth_context_ref: null,
              recorded_principal_id: null,
              result: null,
            },
          ]),
        ),
    };
    const input = yield* Schema.decodeUnknownEffect(SavedAddressSourceReceiptRequestSchema)({
      actionInvocationId: invocation,
      actionKey: 'commerce.customer-context.add-saved-address',
      mode: 'RECEIPT',
      profile,
      requestHash: 'a'.repeat(64),
      source,
    });
    expect(yield* Effect.flip(savedAddressSourceReadService(invoker, scope).read(input))).toBeInstanceOf(
      ReadPermissionDenied,
    );
  }),
);

it.effect('refuses caller-shaped API-key workload claims without an authentic active Core carrier', () =>
  Effect.gen(function* unsealedSourceCarrierDenied() {
    let calls = 0;
    const invoker: CustomerContextAddressRoutineInvoker = {
      invoke: (routine) => {
        calls += 1;
        return Effect.succeed(Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([]));
      },
    };
    const apiKeyScope = {
      ...scope,
      authMethod: 'api_key' as const,
      workloadKeys: ['commerce.customer-context.source-write'],
    };
    const services = savedAddressSourceService(
      invoker,
      apiKeyScope,
      addressActionPersistenceForTransaction(invoker, apiKeyScope),
    );
    const { source: assertion, ...manual } = add;
    expect(assertion).toEqual(source);
    const payload = yield* Schema.decodeUnknownEffect(AddSavedAddressPayloadSchema)(manual);
    expect(
      yield* Effect.flip(services.add(payload, { actionInvocationId: invocation, principalId: scope.principalId })),
    ).toBeInstanceOf(AddressBookUnavailable);
    expect(calls).toBe(0);
  }),
);
