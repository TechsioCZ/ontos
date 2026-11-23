import { defineDatabaseIdentityEnrollment, ReadHandlerUnavailable, ReadPermissionDenied } from '@app/core-runtime';
import { installOperationalScope } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { Effect, Layer, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { AddressBookProfileSchema, ActiveSavedAddressSchema } from '../../shared/domain/address-book.ts';
import { SavedAddressSourceReceiptResponseSchema } from '../../shared/apis/saved-address-source-receipt.ts';
import { CustomerProfileSourceItemSchema } from '../../shared/apis/customer-profile-source.ts';
import { projectSourceProfileAddresses, readSourceProfileAddresses } from '../../src/persistence/source-profile-addresses.ts';

const tenantId = 'aa000000-0000-4000-8000-000000000001';
const profile = Schema.decodeUnknownSync(AddressBookProfileSchema)({
  kind: 'RETAIL',
  profileRef: {
    moduleId: 'commerce.customer-context', resourceType: 'commerce.customer-context.retail-customer-profile',
    resourceId: 'aa000000-0000-4000-8000-000000000002', tenantId,
  },
});
const savedAddressRef = {
  moduleId: 'commerce.customer-context', resourceType: 'commerce.customer-context.saved-address',
  resourceId: 'aa000000-0000-4000-8000-000000000003', tenantId,
};
const source = {
  effectId: 'address-effect-1',
  identity: {
    issuer: 'source-erp', namespace: 'customers', occurrenceId: 'address-1-r1',
    recordId: 'address-1', recordType: 'CUSTOMER_ADDRESS', routeRef: 'customer-route',
  },
  mappingRevision: 'v1', order: 0, purposes: ['BILLING', 'DELIVERY'], revision: '1', routeRevision: 'v1',
};
const candidate = { savedAddressId: savedAddressRef.resourceId, source };
const address = Schema.decodeUnknownSync(ActiveSavedAddressSchema)({
  label: 'Source address', lifecycle: 'ACTIVE', profile, purposes: ['BILLING', 'DELIVERY'],
  revision: 1, savedAddressRef,
  origin: {
    kind: 'COMMERCE_ONLY',
    postalAddress: { addressLine1: 'Source 1', city: 'Test City', postalCode: '11000', countryCode: 'CZ' },
  },
});
const state = (overrides: Readonly<Record<string, unknown>> = {}) =>
  Schema.decodeUnknownSync(SavedAddressSourceReceiptResponseSchema)({
    _tag: 'CURRENT', profile, lifecycle: 'ACTIVE', purposes: ['BILLING', 'DELIVERY'],
    revision: 1, savedAddressRef, ...overrides,
  });

it.effect('reads current source authority before materializing exact current native values', () =>
  Effect.gen(function* sourceBeforeValues() {
    const events: string[] = [];
    const result = yield* projectSourceProfileAddresses([candidate, candidate], profile, tenantId, {
      read: (input) => {
        expect(input).toEqual({ mode: 'CURRENT', source, profile });
        events.push('native-source-current');
        return Effect.succeed(state());
      },
    }, {
      detail: (input, tenant) => {
        expect(input).toEqual({ profile, savedAddressRef });
        expect(tenant).toBe(tenantId);
        events.push('native-address-values');
        return Effect.succeed({ address });
      },
    });
    expect(events).toEqual(['native-source-current', 'native-address-values']);
    expect(result).toEqual([address]);
  }),
);

it.effect('never reads values after revoked source authority or unavailable current Privacy', () =>
  Effect.gen(function* refusedAuthority() {
    for (const failure of [
      new ReadPermissionDenied({ code: 'read_permission_denied', reason: 'Source reader revoked' }),
      new ReadHandlerUnavailable({ code: 'read_handler_unavailable', reason: 'Current Privacy unavailable' }),
    ]) {
      let values = 0;
      const result = yield* projectSourceProfileAddresses([candidate], profile, tenantId, {
        read: () => Effect.fail(failure),
      }, {
        detail: () => { values++; return Effect.succeed({ address }); },
      }).pipe(Effect.flip);
      expect(result).toBe(failure);
      expect(values).toBe(0);
    }
  }),
);

it.effect('refuses absent, foreign-address and foreign-profile current evidence before reading values', () =>
  Effect.gen(function* mismatchedSourceEvidence() {
    const foreignProfile = Schema.decodeUnknownSync(AddressBookProfileSchema)({
      ...profile, profileRef: { ...profile.profileRef, resourceId: 'aa000000-0000-4000-8000-000000000004' },
    });
    for (const reply of [
      Schema.decodeUnknownSync(SavedAddressSourceReceiptResponseSchema)({ _tag: 'ABSENT' }),
      state({ savedAddressRef: { ...savedAddressRef, resourceId: 'aa000000-0000-4000-8000-000000000005' } }),
      state({ savedAddressRef: { ...savedAddressRef, tenantId: 'bb000000-0000-4000-8000-000000000001' } }),
      state({ profile: foreignProfile }),
    ]) {
      let values = 0;
      const failure = yield* projectSourceProfileAddresses([candidate], profile, tenantId, {
        read: () => Effect.succeed(reply),
      }, {
        detail: () => { values++; return Effect.succeed({ address }); },
      }).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(ReadHandlerUnavailable);
      expect(values).toBe(0);
    }
  }),
);

it.effect('refuses a changed revision or foreign native value and omits removed addresses', () =>
  Effect.gen(function* currentNativeSnapshot() {
    for (const changed of [
      { ...address, revision: 2 },
      { ...address, purposes: ['BILLING'] satisfies typeof address.purposes },
      { ...address, savedAddressRef: { ...savedAddressRef, resourceId: 'aa000000-0000-4000-8000-000000000005' } },
    ]) {
      const failure = yield* projectSourceProfileAddresses([candidate], profile, tenantId, {
        read: () => Effect.succeed(state()),
      }, {
        detail: () => Effect.succeed({ address: changed }),
      }).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(ReadHandlerUnavailable);
    }
    const removed = yield* projectSourceProfileAddresses([candidate], profile, tenantId, {
      read: () => Effect.succeed(state({ lifecycle: 'REMOVED' })),
    }, {
      detail: () => Effect.die('Removed values must never be read'),
    });
    expect(removed).toEqual([]);
  }),
);

it.effect('refuses malformed source metadata and over-budget pages without materializing values', () =>
  Effect.gen(function* boundedSourceRead() {
    for (const candidates of [
      [{ ...candidate, source: {} }],
      Array.from({ length: 257 }, () => candidate),
    ]) {
      const result = yield* projectSourceProfileAddresses(candidates, profile, tenantId, {
        read: () => Effect.die('Malformed source metadata must not reach the owner'),
      }, {
        detail: () => Effect.die('Malformed source metadata must not release values'),
      }).pipe(Effect.flip);
      expect(result).toBeInstanceOf(ReadHandlerUnavailable);
    }
  }),
);

it.effect('scopes the real metadata query and selects only the newest receipt per source address', () =>
  Effect.scoped(Effect.gen(function* scopedMetadataQuery() {
    const legalEntityId = 'aa000000-0000-4000-8000-000000000006';
    const scope = {
      authMethod: 'system' satisfies 'system',
      correlationId: 'source-address-query', tenantId, legalEntityId,
      principalId: 'aa000000-0000-4000-8000-000000000007',
    };
    const partyRef = { moduleId: 'party.registry', resourceType: 'party.registry.party', resourceId: legalEntityId, tenantId };
    const item = Schema.decodeUnknownSync(CustomerProfileSourceItemSchema)({
      partyRef,
      partySourceReference: { source: source.identity, recordId: 'customer-1', occurrenceId: 'customer-1-r1' },
      profile: {
        profileRef: { ...profile.profileRef, kind: 'RETAIL' }, revision: 1, state: 'ACTIVE',
        subject: {
          kind: 'RETAIL', partyRef,
          sellingLegalEntityRef: { moduleId: 'core.identity', resourceType: 'core.identity.legal-entity', resourceId: legalEntityId, tenantId },
        },
      },
      source: {
        effectId: 'profile-effect-1', issuer: 'source-erp', namespace: 'customers', mappingRevision: 'v1',
        occurrenceId: 'customer-1-r1', order: 0, recordId: 'customer-1', recordType: 'CUSTOMER', revision: '1',
        route: { id: 'customer-route', revision: 'v1' },
      },
      sourceProcessingMode: 'SOURCE_SYNC',
    });
    let metadataQueries = 0;
    const connection = testSqlConnection((query, params) => Effect.sync(() => {
      if (query.includes('current_user::text as role')) {
        return [{ role: 'ontos_runtime', tenant_id: tenantId, legal_entity_id: legalEntityId }];
      }
      if (query.includes('set_config') || /^(?:BEGIN|COMMIT|ROLLBACK)/u.test(query)) return [];
      expect(query).toContain('saved_address_source_bindings');
      expect(query).toContain('not exists');
      expect(query).toContain('newer_source_address_receipt');
      expect(query).toContain('{identity,routeRef}');
      for (const value of [tenantId, legalEntityId, profile.profileRef.resourceId, 'source-erp', 'customers', 'customer-route', 257]) {
        expect(params).toContain(value);
      }
      metadataQueries++;
      return [];
    }));
    const database = yield* testCoreDatabase.pipe(Effect.provide(
      scriptedPgClientLayer(Effect.succeed(connection)).pipe(Layer.provide(Reactivity.layer)),
    ));
    const result = yield* database.transaction((transaction) =>
      installOperationalScope(transaction, scope, defineDatabaseIdentityEnrollment([])).pipe(
        Effect.flatMap((scoped) => readSourceProfileAddresses(scoped, scope, item, 'unused-empty-source-read')),
      ),
    );
    expect(result).toEqual([]);
    expect(metadataQueries).toBe(1);
  })),
);
