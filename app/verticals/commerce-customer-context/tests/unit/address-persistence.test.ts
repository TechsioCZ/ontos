import { ReadHandlerNotFound, ReadHandlerUnavailable, ScopedRoutineInvocationError } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  addSavedAddress,
  addressBookReconciliationOwnerVerifierForTransaction,
  addressActionPersistenceForTransaction,
  addressReadServicesForTransaction,
  addressRoutineAllowlist,
  clearAddressDefault,
  deliveryDestinationPortsForTransaction,
  failClosedAddressExternalResolutionPorts,
  invoiceRecipientPortsForTransaction,
  removeSavedAddress,
  setAddressDefault,
  updateSavedAddress,
} from '../../src/persistence/address-persistence.ts';
import type { CustomerContextAddressRoutineInvoker } from '../../src/persistence/address-persistence.ts';
import { ProfileReconciliationOwnerVerifiedSchema } from '../../shared/actions/resolve-profile-reconciliation.ts';
import {
  AddressBookDomainErrorSchema,
  AddressBookUnavailable,
  SavedAddressConflictSchema,
} from '../../shared/domain/address-errors.ts';

const { readFileSync } = process.getBuiltinModule('node:fs');

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000001';
const profileId = '30000000-0000-4000-8000-000000000001';
const addressId = '40000000-0000-4000-8000-000000000001';
const principalId = '50000000-0000-4000-8000-000000000001';
const actionInvocationId = '60000000-0000-4000-8000-000000000001';
const profile = {
  kind: 'RETAIL',
  profileRef: {
    moduleId: 'commerce.customer-context',
    resourceId: profileId,
    resourceType: 'commerce.customer-context.retail-customer-profile',
    tenantId,
  },
} as const;
const scope = {
  authContextRef: 'better-auth-session:test',
  authMethod: 'session',
  correlationId: 'correlation-1',
  legalEntityId,
  principalId,
  tenantId,
} as const;
const postal = {
  addressLine1: '1 Main Street',
  city: 'Prague',
  countryCode: 'CZ',
  postalCode: '11000',
} as const;
const commerceOnlyAddPayload = {
  label: 'Head office',
  origin: { kind: 'COMMERCE_ONLY', postalAddress: postal },
  profile,
  purposes: ['BILLING', 'DELIVERY'],
  reason: 'Add purchasing address',
} as const;

interface TestAddressRow {
  readonly address_line_1: string | null;
  readonly address_line_2: string | null;
  readonly administrative_area: string | null;
  readonly city: string | null;
  readonly cleared_purposes: readonly ('BILLING' | 'DELIVERY')[];
  readonly country_code: string | null;
  readonly label: string | null;
  readonly lifecycle: 'ACTIVE' | 'REMOVED' | null;
  readonly outcome: string;
  readonly party_contact_point_resource_id: string | null;
  readonly party_contact_point_revision: number | null;
  readonly party_resource_id: string | null;
  readonly postal_code: string | null;
  readonly purposes: readonly ('BILLING' | 'DELIVERY')[];
  readonly revision: number;
  readonly saved_address_id: string | null;
  readonly source_kind: 'COMMERCE_ONLY' | 'PARTY_BACKED' | null;
}

const addressRow = (overrides: Partial<TestAddressRow> = {}): TestAddressRow => ({
  address_line_1: postal.addressLine1,
  address_line_2: null,
  administrative_area: null,
  city: postal.city,
  cleared_purposes: [],
  country_code: postal.countryCode,
  label: 'Head office',
  lifecycle: 'ACTIVE',
  outcome: 'FOUND',
  party_contact_point_resource_id: null,
  party_contact_point_revision: null,
  party_resource_id: null,
  postal_code: postal.postalCode,
  purposes: ['BILLING', 'DELIVERY'],
  revision: 1,
  saved_address_id: addressId,
  source_kind: 'COMMERCE_ONLY',
  ...overrides,
});

const transactionReturning = (rows: readonly unknown[]): CustomerContextAddressRoutineInvoker => ({
  invoke: (routine) => Effect.succeed(Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))(rows)),
});

it('publishes only immutable exact scoped-routine allowlist entries', () => {
  expect(addressRoutineAllowlist.map(({ name, routineKey }) => [name, routineKey])).toEqual([
    ['list_saved_addresses', 'address-book.list'],
    ['read_saved_address', 'address-book.read'],
    ['read_address_defaults', 'address-book.defaults.read'],
    ['add_saved_address', 'address-book.add'],
    ['update_saved_address', 'address-book.update'],
    ['remove_saved_address', 'address-book.remove'],
    ['change_address_default', 'address-book.defaults.change'],
    ['record_address_book_reconciliation_receipt', 'address-book.reconciliation.receipt-record'],
    ['verify_address_book_reconciliation', 'address-book.reconciliation.verify'],
  ]);
  for (const routine of addressRoutineAllowlist) {
    expect(Object.isFrozen(routine)).toBe(true);
    expect(routine.ownerModuleKey).toBe('commerce.customer-context');
    expect(routine.parameters.slice(0, 2)).toEqual([
      { source: 'tenantId', type: 'uuid' },
      { source: 'legalEntityId', type: 'uuid' },
    ]);
  }
});

it.effect('maps an added Commerce-only address and passes no caller-controlled operation scope', () =>
  Effect.gen(function* addAddress() {
    let values: readonly unknown[] = [];
    const transaction: CustomerContextAddressRoutineInvoker = {
      invoke: (routine, input) => {
        values = input;
        return Effect.succeed(
          Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([addressRow({ outcome: 'ADDED' })]),
        );
      },
    };
    const result = yield* addSavedAddress(transaction, commerceOnlyAddPayload, {
      actionInvocationId,
      principalId,
    });
    expect(result).toMatchObject({
      address: {
        lifecycle: 'ACTIVE',
        origin: { kind: 'COMMERCE_ONLY', postalAddress: postal },
        profile,
        revision: 1,
      },
      outcome: 'ADDED',
    });
    expect(values.slice(0, 3)).toEqual([profileId, 'RETAIL', null]);
    expect(values).not.toContain(tenantId);
    expect(values).not.toContain(legalEntityId);
    expect(values.at(-3)).toBe('Add purchasing address');
    expect(values.slice(-2)).toEqual([principalId, actionInvocationId]);
  }),
);

it.effect('returns a non-material REUSED outcome for an exact add replay', () =>
  Effect.gen(function* reuseAddress() {
    const result = yield* addSavedAddress(
      transactionReturning([addressRow({ outcome: 'REUSED' })]),
      commerceOnlyAddPayload,
      { actionInvocationId, principalId },
    );
    expect(result).toMatchObject({
      address: { savedAddressRef: { resourceId: addressId } },
      outcome: 'REUSED',
    });
  }),
);

it.effect('maps ambiguous add and ordinary source transition to explicit typed failures', () =>
  Effect.gen(function* explicitReconciliation() {
    const duplicate = yield* Effect.flip(
      addSavedAddress(
        transactionReturning([addressRow({ outcome: 'RECONCILIATION_REQUIRED' })]),
        commerceOnlyAddPayload,
        { actionInvocationId, principalId },
      ),
    );
    const transition = yield* Effect.flip(
      updateSavedAddress(
        transactionReturning([addressRow({ outcome: 'SOURCE_TRANSITION_REQUIRED' })]),
        {
          expectedRevision: 1,
          origin: {
            contactPointRef: {
              moduleId: 'party.registry',
              resourceId: '70000000-0000-4000-8000-000000000001',
              resourceType: 'party.registry.party-contact-point',
              tenantId,
            },
            kind: 'PARTY_BACKED',
            partyRef: {
              moduleId: 'party.registry',
              resourceId: '80000000-0000-4000-8000-000000000001',
              resourceType: 'party.registry.party',
              tenantId,
            },
            sourceRevision: 2,
          },
          profile,
          reason: 'Move to Party ownership',
          savedAddressRef: {
            moduleId: 'commerce.customer-context',
            resourceId: addressId,
            resourceType: 'commerce.customer-context.saved-address',
            tenantId,
          },
        },
        { actionInvocationId, principalId },
      ),
    );
    expect(duplicate.code).toBe('saved_address_reconciliation_required');
    expect(transition.code).toBe('saved_address_source_transition_required');
  }),
);

it.effect('permits only an explicit, current-kind-bound source transition', () =>
  Effect.gen(function* explicitSourceTransition() {
    let values: readonly unknown[] = [];
    const transaction: CustomerContextAddressRoutineInvoker = {
      invoke: (routine, input) => {
        values = input;
        return Effect.succeed(
          Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([
            addressRow({
              address_line_1: null,
              city: null,
              country_code: null,
              outcome: 'UPDATED',
              party_contact_point_resource_id: '70000000-0000-4000-8000-000000000001',
              party_contact_point_revision: 2,
              party_resource_id: '80000000-0000-4000-8000-000000000001',
              postal_code: null,
              revision: 2,
              source_kind: 'PARTY_BACKED',
            }),
          ]),
        );
      },
    };
    const result = yield* updateSavedAddress(
      transaction,
      {
        expectedRevision: 1,
        origin: {
          contactPointRef: {
            moduleId: 'party.registry',
            resourceId: '70000000-0000-4000-8000-000000000001',
            resourceType: 'party.registry.party-contact-point',
            tenantId,
          },
          kind: 'PARTY_BACKED',
          partyRef: {
            moduleId: 'party.registry',
            resourceId: '80000000-0000-4000-8000-000000000001',
            resourceType: 'party.registry.party',
            tenantId,
          },
          sourceRevision: 2,
        },
        profile,
        reason: 'Customer approved moving ownership to Party Registry',
        savedAddressRef: {
          moduleId: 'commerce.customer-context',
          resourceId: addressId,
          resourceType: 'commerce.customer-context.saved-address',
          tenantId,
        },
        sourceTransition: {
          fromKind: 'COMMERCE_ONLY',
          toKind: 'PARTY_BACKED',
        },
      },
      { actionInvocationId, principalId },
    );
    expect(result).toMatchObject({
      address: { origin: { kind: 'PARTY_BACKED' }, revision: 2 },
      outcome: 'UPDATED',
    });
    expect(values.slice(-6)).toEqual([
      true,
      'COMMERCE_ONLY',
      'PARTY_BACKED',
      'Customer approved moving ownership to Party Registry',
      principalId,
      actionInvocationId,
    ]);
  }),
);

it.effect('returns atomic default-clear evidence from a purpose-losing update', () =>
  Effect.gen(function* updateAddress() {
    const result = yield* updateSavedAddress(
      transactionReturning([
        addressRow({
          cleared_purposes: ['DELIVERY'],
          outcome: 'UPDATED',
          purposes: ['BILLING'],
          revision: 2,
        }),
      ]),
      {
        expectedRevision: 1,
        profile,
        purposes: ['BILLING'],
        reason: 'No longer a delivery destination',
        savedAddressRef: {
          moduleId: 'commerce.customer-context',
          resourceId: addressId,
          resourceType: 'commerce.customer-context.saved-address',
          tenantId,
        },
      },
      { actionInvocationId, principalId },
    );
    expect(result).toMatchObject({
      address: { purposes: ['BILLING'], revision: 2 },
      clearedDefaults: ['DELIVERY'],
      outcome: 'UPDATED',
    });
  }),
);

it.effect('preserves a removed address while atomically clearing both defaults', () =>
  Effect.gen(function* removeAddress() {
    const result = yield* removeSavedAddress(
      transactionReturning([
        addressRow({
          cleared_purposes: ['BILLING', 'DELIVERY'],
          lifecycle: 'REMOVED',
          outcome: 'REMOVED',
          revision: 2,
        }),
      ]),
      {
        expectedRevision: 1,
        profile,
        reason: 'Address retired',
        savedAddressRef: {
          moduleId: 'commerce.customer-context',
          resourceId: addressId,
          resourceType: 'commerce.customer-context.saved-address',
          tenantId,
        },
      },
      { actionInvocationId, principalId },
    );
    expect(result).toMatchObject({
      address: { lifecycle: 'REMOVED', revision: 2 },
      clearedDefaults: ['BILLING', 'DELIVERY'],
      outcome: 'REMOVED',
    });
  }),
);

it.effect('maps atomic delivery set and billing clear default transitions', () =>
  Effect.gen(function* changeDefaults() {
    const setResult = yield* setAddressDefault(
      transactionReturning([
        {
          billing_saved_address_id: null,
          cleared_saved_address_id: null,
          delivery_saved_address_id: addressId,
          outcome: 'SET',
          revision: 3,
        },
      ]),
      {
        expectedDefaultsRevision: 2,
        profile,
        reason: 'Preferred delivery address',
        savedAddressRef: {
          moduleId: 'commerce.customer-context',
          resourceId: addressId,
          resourceType: 'commerce.customer-context.saved-address',
          tenantId,
        },
      },
      'DELIVERY',
      { actionInvocationId, principalId },
    );
    const clearResult = yield* clearAddressDefault(
      transactionReturning([
        {
          billing_saved_address_id: null,
          cleared_saved_address_id: addressId,
          delivery_saved_address_id: addressId,
          outcome: 'CLEARED',
          revision: 4,
        },
      ]),
      {
        expectedDefaultsRevision: 3,
        profile,
        reason: 'Billing preference cleared',
      },
      'BILLING',
      { actionInvocationId, principalId },
    );
    expect(setResult).toMatchObject({
      defaults: { delivery: { resourceId: addressId }, revision: 3 },
      outcome: 'SET',
    });
    expect(clearResult).toMatchObject({
      clearedSavedAddressRef: { resourceId: addressId },
      defaults: { delivery: { resourceId: addressId }, revision: 4 },
      outcome: 'CLEARED',
    });
  }),
);

it.effect('maps a serialized CAS miss to a typed conflict without SQL details', () =>
  Effect.gen(function* conflict() {
    const error = yield* Effect.flip(
      updateSavedAddress(
        transactionReturning([addressRow({ outcome: 'REVISION_CONFLICT', revision: 4 })]),
        {
          expectedRevision: 3,
          label: 'Warehouse',
          profile,
          reason: 'Rename address',
          savedAddressRef: {
            moduleId: 'commerce.customer-context',
            resourceId: addressId,
            resourceType: 'commerce.customer-context.saved-address',
            tenantId,
          },
        },
        { actionInvocationId, principalId },
      ),
    );
    expect(Schema.is(AddressBookDomainErrorSchema)(error)).toBe(true);
    if (Schema.is(SavedAddressConflictSchema)(error)) {
      expect(error.code).toBe('saved_address_conflict');
      expect(error.reason).toContain('revision 4');
      expect(error.reason).not.toContain('SQL');
    }
  }),
);

it.effect('rejects a caller-supplied cross-Tenant nested reference before invoking a routine', () =>
  Effect.gen(function* rejectScopeMismatch() {
    let invoked = false;
    const transaction: CustomerContextAddressRoutineInvoker = {
      invoke: (routine) => {
        invoked = true;
        return Effect.succeed(Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([]));
      },
    };
    const services = addressActionPersistenceForTransaction(transaction, scope);
    const error = yield* Effect.flip(
      services.remove(
        {
          expectedRevision: 1,
          profile,
          reason: 'Address retired',
          savedAddressRef: {
            moduleId: 'commerce.customer-context',
            resourceId: addressId,
            resourceType: 'commerce.customer-context.saved-address',
            tenantId: 'another-tenant',
          },
        },
        { actionInvocationId, principalId },
      ),
    );
    const partyError = yield* Effect.flip(
      services.add(
        {
          origin: {
            contactPointRef: {
              moduleId: 'party.registry',
              resourceId: '70000000-0000-4000-8000-000000000001',
              resourceType: 'party.registry.party-contact-point',
              tenantId: 'another-tenant',
            },
            kind: 'PARTY_BACKED',
            partyRef: {
              moduleId: 'party.registry',
              resourceId: '80000000-0000-4000-8000-000000000001',
              resourceType: 'party.registry.party',
              tenantId,
            },
            sourceRevision: 1,
          },
          profile,
          purposes: ['BILLING'],
          reason: 'Add Party address',
        },
        { actionInvocationId, principalId },
      ),
    );
    expect(Schema.is(AddressBookDomainErrorSchema)(error)).toBe(true);
    expect(Schema.is(AddressBookDomainErrorSchema)(partyError)).toBe(true);
    expect(invoked).toBe(false);
  }),
);

it.effect('exposes no removed-history flag through the ordinary address-book list', () =>
  Effect.gen(function* activeOnlyList() {
    let values: readonly unknown[] = [];
    const transaction: CustomerContextAddressRoutineInvoker = {
      invoke: (routine, input) => {
        values = input;
        return Effect.succeed(
          Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([addressRow({ lifecycle: 'REMOVED' })]),
        );
      },
    };
    const result = yield* addressReadServicesForTransaction(transaction, scope).list({ profile }, tenantId);
    expect(values).toEqual([profileId, 'RETAIL', null]);
    expect(result.addresses).toEqual([]);
  }),
);

it.effect('distinguishes absent defaults from dangling defaults and hides removed addresses', () =>
  Effect.gen(function* defaultLookupEvidence() {
    const transaction: CustomerContextAddressRoutineInvoker = {
      invoke: (routine) => {
        const rows =
          routine.name === 'read_address_defaults'
            ? [
                {
                  billing_saved_address_id: addressId,
                  cleared_saved_address_id: null,
                  delivery_saved_address_id: null,
                  outcome: 'PRESENT',
                  revision: 2,
                },
              ]
            : [addressRow({ lifecycle: 'REMOVED' })];
        return Effect.succeed(Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))(rows));
      },
    };
    const invoice = invoiceRecipientPortsForTransaction(transaction, scope);
    const delivery = deliveryDestinationPortsForTransaction(transaction, scope);
    const billing = yield* invoice.loadDefaultBillingAddress(profile);
    const deliveryDefault = yield* delivery.loadDefaultDeliveryAddress(profile);
    const explicitRemoved = yield* invoice.loadSavedAddress({
      profile,
      resourceId: addressId,
    });
    const detailFailure = yield* Effect.flip(
      addressReadServicesForTransaction(transaction, scope).detail(
        {
          profile,
          savedAddressRef: {
            moduleId: 'commerce.customer-context',
            resourceId: addressId,
            resourceType: 'commerce.customer-context.saved-address',
            tenantId,
          },
        },
        tenantId,
      ),
    );
    expect(billing.kind).toBe('INVALID');
    expect(deliveryDefault.kind).toBe('NONE');
    expect(explicitRemoved.kind).toBe('NOT_FOUND');
    expect(Schema.is(ReadHandlerNotFound)(detailFailure)).toBe(true);
  }),
);

it.effect('serves owner-local address reads and fails closed for unbound external decisions', () =>
  Effect.gen(function* readsAndExternalPorts() {
    const reads = addressReadServicesForTransaction(transactionReturning([addressRow()]), scope);
    const detail = yield* reads.detail(
      {
        profile,
        savedAddressRef: {
          moduleId: 'commerce.customer-context',
          resourceId: addressId,
          resourceType: 'commerce.customer-context.saved-address',
          tenantId,
        },
      },
      tenantId,
    );
    expect(detail.address.origin).toEqual({
      kind: 'COMMERCE_ONLY',
      postalAddress: postal,
    });

    const dependency = yield* Effect.flip(
      failClosedAddressExternalResolutionPorts.resolvePartyPostalAddress(detail.address),
    );
    expect(Schema.is(AddressBookUnavailable)(dependency)).toBe(true);
    if (Schema.is(AddressBookUnavailable)(dependency)) {
      expect(dependency.dependency).toBe('party-registry');
      expect(dependency.retryable).toBe(true);
    }
  }),
);

it.effect('maps routine failures to sanitized owner dependency errors', () =>
  Effect.gen(function* sanitizedFailure() {
    const transaction: CustomerContextAddressRoutineInvoker = {
      invoke: () =>
        Effect.fail(
          new ScopedRoutineInvocationError({
            code: 'scoped_routine_invocation_failed',
            constraint: Option.none(),
            ownerModuleKey: 'commerce.customer-context',
            postgresCode: Option.none(),
            reason: 'private SQL and values',
            routineKey: 'address-book.read',
          }),
        ),
    };
    const error = yield* Effect.flip(
      addressReadServicesForTransaction(transaction, scope).detail(
        {
          profile,
          savedAddressRef: {
            moduleId: 'commerce.customer-context',
            resourceId: addressId,
            resourceType: 'commerce.customer-context.saved-address',
            tenantId,
          },
        },
        tenantId,
      ),
    );
    expect(Schema.is(ReadHandlerUnavailable)(error)).toBe(true);
    if (Schema.is(ReadHandlerUnavailable)(error)) {
      expect(error.code).toBe('read_handler_unavailable');
      expect(error.reason).not.toContain('private SQL');
    }
  }),
);

it.effect('derives ADDRESS_BOOK reconciliation evidence without accepting caller proof', () =>
  Effect.gen(function* verifyAddressReconciliation() {
    let values: readonly unknown[] = [];
    const transaction: CustomerContextAddressRoutineInvoker = {
      invoke: (routine, input) => {
        values = input;
        return Effect.succeed(
          Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([
            {
              correlation_ref: 'address-book-owner:case:2:fingerprint',
              evidence_ref: 'address-book-reconciliation:case:fingerprint',
              outcome: 'VERIFIED',
              status: 'RESOLVED',
            },
          ]),
        );
      },
    };
    const verifier = addressBookReconciliationOwnerVerifierForTransaction(transaction, scope);
    const result = yield* verifier.verify(
      {
        caseRef: {
          moduleId: 'commerce.customer-context',
          resourceId: '90000000-0000-4000-8000-000000000001',
          resourceType: 'commerce.customer-context.profile-reconciliation-case',
          tenantId,
        },
        desiredOutcome: {
          owner: 'ADDRESS_BOOK',
          status: 'RESOLVED',
        },
        effectiveAt: '2026-09-09T12:00:00.000Z',
        expectedCaseRevision: 2,
        expectedEventVersion: 3n,
        reason: 'Complete the profile reconciliation',
        resultingState: 'ACTIVE',
        survivorProfileRef: { ...profile.profileRef, kind: 'RETAIL' },
      },
      {
        actionInvocationId,
        actorPrincipalId: principalId,
        legalEntityId,
        tenantId,
      },
    );
    expect(Schema.is(ProfileReconciliationOwnerVerifiedSchema)(result)).toBe(true);
    if (Schema.is(ProfileReconciliationOwnerVerifiedSchema)(result)) {
      expect(result.correlationRef).toBe('address-book-owner:case:2:fingerprint');
      expect(result.durableOutcome).toEqual({
        evidenceRef: 'address-book-reconciliation:case:fingerprint',
        owner: 'ADDRESS_BOOK',
        status: 'RESOLVED',
      });
    }
    expect(values).toEqual([
      '90000000-0000-4000-8000-000000000001',
      profileId,
      2,
      3n,
      '2026-09-09T12:00:00.000Z',
      'ACTIVE',
      'Complete the profile reconciliation',
      principalId,
      actionInvocationId,
      'address-book-reconciliation.v2',
    ]);
  }),
);

it('hardens every address routine around scope, serialization, and EXECUTE-only access', () => {
  const migration = readFileSync(
    new URL('../../drizzle/20260909112245_address-routines/migration.sql', import.meta.url),
    'utf-8',
  );
  expect(migration.match(/SECURITY DEFINER/gu)).toHaveLength(8);
  expect(migration.match(/SET search_path = pg_catalog, commerce_customer_context/gu)).toHaveLength(8);
  expect(migration.match(/current_setting\('ontos\.tenant_id', true\)/gu)).toHaveLength(8);
  expect(migration.match(/current_setting\('ontos\.legal_entity_id', true\)/gu)).toHaveLength(8);
  expect(migration.match(/profile\.profile_kind = p_profile_kind/gu)).toHaveLength(7);
  expect(migration.match(/counterparty\.counterparty_resource_id = p_counterparty_resource_id/gu)).toHaveLength(7);
  expect(migration.match(/p_counterparty_resource_id IS NULL AND EXISTS/gu)).toHaveLength(3);
  expect(migration.match(/p_counterparty_resource_id IS NOT NULL OR NOT EXISTS/gu)).toHaveLength(4);
  expect(migration).toContain('FOR UPDATE;');
  expect(migration).toContain("setting_kind = 'ADDRESS_DEFAULTS'");
  expect(migration).not.toContain('p_include_removed');
  expect(migration).toContain("AND address.lifecycle = 'ACTIVE';");
  expect(migration).toContain("THEN 'REUSED'");
  expect(migration).toContain("ELSE 'RECONCILIATION_REQUIRED'");
  expect(migration).toContain("'SOURCE_TRANSITION_REQUIRED'::text");
  expect(migration).toContain('p_source_transition_from_kind IS DISTINCT FROM v_address.source_kind');
  expect(migration).toContain('p_source_transition_to_kind IS DISTINCT FROM v_target_source_kind');
  expect(migration).toContain('NOT (default_record.default_kind = ANY(v_purposes))');
  expect(migration).toContain("v_address.lifecycle = 'REMOVED'");
  expect(migration).toContain("p_change_kind = 'CLEAR'");
  expect(migration).toContain('v_address.last_action_invocation_id = p_action_invocation_id');
  expect(migration).toContain('last_reason = p_reason');
  expect(migration).toContain('reason = p_reason');
  expect(migration.match(/p_reason IS NULL/gu)).toHaveLength(4);
  expect(migration.match(/p_expected_revision IS NULL/gu)).toHaveLength(2);

  const listRoutine = migration.slice(
    migration.indexOf('CREATE FUNCTION "commerce_customer_context"."list_saved_addresses"'),
    migration.indexOf('CREATE FUNCTION "commerce_customer_context"."read_saved_address"'),
  );
  const detailRoutine = migration.slice(
    migration.indexOf('CREATE FUNCTION "commerce_customer_context"."read_saved_address"'),
    migration.indexOf('CREATE FUNCTION "commerce_customer_context"."read_address_defaults"'),
  );
  expect(listRoutine).toContain("AND address.lifecycle = 'ACTIVE'");
  expect(detailRoutine).toContain("AND address.lifecycle = 'ACTIVE'");

  const addRoutine = migration.slice(
    migration.indexOf('CREATE FUNCTION "commerce_customer_context"."add_saved_address"'),
    migration.indexOf('CREATE FUNCTION "commerce_customer_context"."update_saved_address"'),
  );
  const addInsert = addRoutine.indexOf('INSERT INTO commerce_customer_context.saved_addresses');
  expect(addRoutine.indexOf("THEN 'REUSED'")).toBeLessThan(addInsert);
  expect(addRoutine.indexOf("ELSE 'RECONCILIATION_REQUIRED'")).toBeLessThan(addInsert);
  expect(addRoutine.indexOf('address.last_action_invocation_id = p_action_invocation_id')).toBeLessThan(addInsert);

  const updateRoutine = migration.slice(
    migration.indexOf('CREATE FUNCTION "commerce_customer_context"."update_saved_address"'),
    migration.indexOf('CREATE FUNCTION "commerce_customer_context"."remove_saved_address"'),
  );
  const addressUpdate = updateRoutine.indexOf('UPDATE commerce_customer_context.saved_addresses AS address');
  expect(updateRoutine.indexOf("'SOURCE_TRANSITION_REQUIRED'::text")).toBeLessThan(addressUpdate);
  expect(updateRoutine.indexOf('v_address.last_action_invocation_id = p_action_invocation_id')).toBeLessThan(
    addressUpdate,
  );
  expect(updateRoutine).toContain("RETURN QUERY SELECT 'REVISION_CONFLICT'::text");
  const defaultRoutine = migration.slice(
    migration.indexOf('CREATE FUNCTION "commerce_customer_context"."change_address_default"'),
    migration.indexOf('CREATE FUNCTION "commerce_customer_context"."verify_address_book_reconciliation"'),
  );
  expect(defaultRoutine.indexOf('p_expected_defaults_revision <> v_current_revision')).toBeLessThan(
    defaultRoutine.indexOf("RETURN QUERY SELECT 'UNCHANGED'::text"),
  );
  expect(defaultRoutine.indexOf('p_expected_defaults_revision <> v_current_revision')).toBeLessThan(
    defaultRoutine.indexOf("RETURN QUERY SELECT 'ALREADY_CLEAR'::text"),
  );
  expect(migration.match(/REVOKE ALL ON FUNCTION/gu)).toHaveLength(8);
  expect(migration.match(/GRANT EXECUTE ON FUNCTION/gu)).toHaveLength(8);
  for (const signature of [
    '"list_saved_addresses"(uuid, uuid, text, text, text)',
    '"read_saved_address"(uuid, uuid, text, text, text, text)',
    '"read_address_defaults"(uuid, uuid, text, text, text)',
    '"add_saved_address"(uuid, uuid, text, text, text, text, text, text[], text, text, integer, jsonb, text, uuid, uuid)',
    '"update_saved_address"(uuid, uuid, text, text, text, text, integer, boolean, text, boolean, text, boolean, text[], text, text, integer, jsonb, boolean, text, text, text, uuid, uuid)',
    '"remove_saved_address"(uuid, uuid, text, text, text, text, integer, text, uuid, uuid)',
    '"change_address_default"(uuid, uuid, text, text, text, text, text, text, integer, text, uuid, uuid)',
    '"verify_address_book_reconciliation"(uuid, uuid, text, text, integer, bigint)',
  ]) {
    expect(migration).toContain(
      `GRANT EXECUTE ON FUNCTION "commerce_customer_context".${signature} TO "ontos_runtime";`,
    );
  }
  expect(migration).not.toMatch(/GRANT\s+(?:SELECT|INSERT|UPDATE|DELETE|ALL)\s+ON\s+(?:TABLE|ALL TABLES)/u);
});

it('keeps ADDRESS_BOOK reconciliation proof append-only and postcondition-bound', () => {
  const migration = readFileSync(
    new URL('../../drizzle/20260909150806_address-book-reconciliation-receipt-routines/migration.sql', import.meta.url),
    'utf-8',
  );
  expect(migration).toContain(
    'DROP FUNCTION IF EXISTS "commerce_customer_context"."verify_address_book_reconciliation"',
  );
  expect(migration).toContain(
    'CREATE FUNCTION "commerce_customer_context"."record_address_book_reconciliation_receipt"',
  );
  expect(migration).toContain('CREATE FUNCTION "commerce_customer_context"."verify_address_book_reconciliation"');
  expect(migration).toContain("'EXPLICIT_RECONCILIATION', 'RESOLVED'");
  expect(migration).toContain("ELSE 'ALREADY_SATISFIED'");
  expect(migration).toContain("'NOT_APPLICABLE'");
  expect(migration).toContain('p_after_facts_sha256 IS DISTINCT FROM v_after_facts_sha256');
  expect(migration).toContain('p_postcondition_sha256 IS DISTINCT FROM v_postcondition_sha256');
  expect(migration).toContain('CREATE TRIGGER "ccc_address_reconciliation_receipts_append_only_trg"');
  expect(migration).toContain(
    'ALTER TABLE "commerce_customer_context"."address_book_reconciliation_receipts" FORCE ROW LEVEL SECURITY;',
  );
  expect(migration).toContain(
    'REVOKE ALL ON TABLE "commerce_customer_context"."address_book_reconciliation_receipts" FROM PUBLIC, "ontos_runtime";',
  );
});
