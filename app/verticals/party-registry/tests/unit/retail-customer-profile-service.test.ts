import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import type { OperationalScope } from '@app/core-runtime/operations/context';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect, Layer, Predicate, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';
import { assert, expect, it } from 'effect-rstest';

import {
  RetailCustomerIdentityViewSchema,
  RetailCustomerProfileAttestationSchema,
  RetailCustomerProfileViewSchema,
} from '../../shared/apis/retail-customer-profile.ts';
import { PartyContactPointSchema } from '../../shared/domain/contact-point.ts';
import { PartyRefSchema } from '../../shared/resources/party.ts';
import { partyRelations } from '../../src/db/schema.ts';
import {
  retailCustomerProfileService,
  selectRetailProfileContact,
} from '../../src/services/retail-customer-profile.service.ts';

const uid = (value: number) => `85000000-0000-4000-8000-${value.toString().padStart(12, '0')}`;
const tenantId = uid(1);
const companyId = uid(2);
const partyId = uid(3);
const otherId = uid(99);
const timestamp = '2026-01-01T00:00:00.000Z';
const attestation = Schema.decodeUnknownSync(RetailCustomerProfileAttestationSchema)({
  authBindingId: uid(4),
  customerPrincipalId: uid(5),
  partyId,
  providerSubjectId: 'customer-profile-provider-subject',
  sellingLegalEntityId: companyId,
  sessionRefDigest: 'a'.repeat(64),
  tenantId,
});
const scope: OperationalScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: uid(6),
    authContextRef: 'verified-commerce-delegation',
    authMethod: 'api_key',
    legalEntityId: companyId,
    principalId: uid(7),
    tenantId,
  }),
  correlationId: 'retail-customer-profile-owner-service',
};
const partyRef = Schema.decodeUnknownSync(PartyRefSchema)({
  moduleId: 'party.registry',
  resourceId: partyId,
  resourceType: 'party.registry.party',
  tenantId,
});

interface StoreOptions {
  readonly alias?: boolean;
  readonly archived?: boolean;
  readonly contactsUnavailable?: boolean;
  readonly missing?: boolean;
  readonly partyType?: 'PERSON' | 'ORGANIZATION' | 'UNRESOLVED';
}

const materializedParty = (id: string, options: StoreOptions): Schema.JsonObject => ({
  archived_at: options.archived === true ? timestamp : null,
  business_name: null,
  created_at: timestamp,
  current_display_name: 'Profile Customer',
  current_type: options.partyType ?? 'PERSON',
  first_name: 'Profile',
  last_name: 'Customer',
  party_id: id,
  revision: 3,
  tenant_id: tenantId,
  updated_at: timestamp,
});

const projectSelectedRows = (statement: string, params: readonly unknown[], rows: readonly Schema.JsonObject[]) => {
  const parsed = /^select (?<projection>.+?) from "[^"]+"\."(?<table>[^"]+)"/u.exec(statement);
  const projection = parsed?.groups?.['projection'];
  if (projection === undefined) {
    throw new Error('The profile fixture only supports bounded owner SELECTs');
  }
  const selected = projection
    .split(', ')
    .map((column) => [...column.matchAll(/"(?<column>[^"]+)"/gu)].at(-1)?.groups?.['column']);
  const conditions = [...statement.matchAll(/"(?<column>[^"]+)" = \$(?<index>\d+)/gu)];
  return rows
    .filter((row) =>
      conditions.every(({ groups }) => {
        const { column, index } = groups ?? {};
        return column !== undefined && index !== undefined && row[column] === params[Number(index) - 1];
      }),
    )
    .map((row) =>
      Object.fromEntries(
        selected.map((column, index) => [String(index), column === undefined ? undefined : row[column]]),
      ),
    );
};

/** Real owner queries and DTO mapping over a bounded driver seam; no profile result is scripted. */
const makeProfileStore = (options: StoreOptions = {}) =>
  Effect.gen(function* constructProfileDriver() {
    const parties =
      options.missing === true ? [] : [materializedParty(partyId, options), materializedParty(otherId, {})];
    const aliases =
      options.alias === true ? [{ alias_party_id: partyId, canonical_party_id: otherId, tenant_id: tenantId }] : [];
    const tables: ReadonlyMap<string, readonly Schema.JsonObject[]> = new Map([
      ['parties', parties],
      ['party_aliases', aliases],
      ['party_contact_points', []],
      ['party_contact_point_purposes', []],
    ]);
    const execute = (statement: string, params: readonly unknown[]) =>
      Effect.suspend(() => {
        const table = /from "[^"]+"\."(?<table>[^"]+)"/u.exec(statement)?.groups?.['table'];
        if (table === undefined) {
          return Effect.die('The profile fixture accepts no writes or unbounded SQL');
        }
        if (table === 'party_contact_points' && options.contactsUnavailable === true) {
          return Effect.fail(
            new SqlError({ reason: new ConnectionError({ cause: new Error('Isolated contact store failure') }) }),
          );
        }
        const rows = tables.get(table);
        if (rows === undefined) {
          return Effect.die(`Unexpected owner table in profile fixture: ${table}`);
        }
        return Effect.succeed(projectSelectedRows(statement, params, rows));
      });
    const services = yield* Layer.build(
      scriptedPgClientLayer(Effect.succeed(testSqlConnection(execute))).pipe(Layer.provideMerge(Reactivity.layer)),
    );
    const database = yield* makeWithDefaults({ relations: partyRelations }).pipe(Effect.provideContext(services));
    return yield* retailCustomerProfileService(database, scope);
  });

it.effect('IDENTITY proves a direct active person even while contacts are unavailable', () =>
  Effect.gen(function* identityWithoutContacts() {
    const service = yield* makeProfileStore({ contactsUnavailable: true });
    const expected = yield* Schema.decodeUnknownEffect(RetailCustomerIdentityViewSchema)({
      _tag: 'RetailCustomerIdentity',
      partyRef,
    });
    expect(yield* service.read({ attestation, view: 'IDENTITY' })).toEqual(expected);
    const failure = yield* service.read({ attestation, view: 'PROFILE' }).pipe(Effect.flip);
    expect(Predicate.isTagged(failure, 'RetailCustomerProfileUnavailable')).toBe(true);
  }),
);

it.effect('PROFILE has a fixed projection with empty declared contacts and a stable owner version', () =>
  Effect.gen(function* fixedProfileProjection() {
    const service = yield* makeProfileStore();
    const result = yield* service.read({ attestation, view: 'PROFILE' });
    assert.isOk(Schema.is(RetailCustomerProfileViewSchema)(result));
    const expected = yield* Schema.decodeUnknownEffect(RetailCustomerProfileViewSchema)({
      _tag: 'RetailCustomerProfile',
      partyRef,
      profile: {
        contactEmail: '',
        displayName: 'Profile Customer',
        phone: '',
        version: result.profile.version,
      },
    });
    expect(result.profile.version).toMatch(/^[a-f0-9]{64}$/u);
    expect(result).toEqual(expected);
    expect(yield* service.read({ attestation, view: 'PROFILE' })).toEqual(result);
  }),
);

it.effect.each([
  { label: 'Tenant', changed: { ...attestation, tenantId: otherId } },
  { label: 'selling company', changed: { ...attestation, sellingLegalEntityId: otherId } },
])('rejects an attestation outside the trusted $label', ({ changed }) =>
  Effect.gen(function* rejectForeignAttestation() {
    const service = yield* makeProfileStore();
    const failure = yield* service.read({ attestation: changed, view: 'IDENTITY' }).pipe(Effect.flip);
    expect(Predicate.isTagged(failure, 'RetailCustomerProfileConflict')).toBe(true);
  }),
);

interface InvalidTargetCase {
  readonly label: string;
  readonly options: StoreOptions;
}
it.effect.each<InvalidTargetCase>([
  { label: 'Alias', options: { alias: true } },
  { label: 'archived person', options: { archived: true } },
  { label: 'organization', options: { partyType: 'ORGANIZATION' } },
  { label: 'unresolved Party type', options: { partyType: 'UNRESOLVED' } },
  { label: 'missing Party', options: { missing: true } },
])('rejects the $label instead of following or exposing another identity', ({ options }) =>
  Effect.gen(function* rejectInvalidTarget() {
    const service = yield* makeProfileStore(options);
    const identityFailure = yield* service.read({ attestation, view: 'IDENTITY' }).pipe(Effect.flip);
    const profileFailure = yield* service.read({ attestation, view: 'PROFILE' }).pipe(Effect.flip);
    expect(Predicate.isTagged(identityFailure, 'RetailCustomerProfileConflict')).toBe(true);
    expect(Predicate.isTagged(profileFailure, 'RetailCustomerProfileConflict')).toBe(true);
  }),
);

interface ContactFixtureOptions {
  readonly current?: boolean;
  readonly preferred?: boolean;
  readonly state?: 'ACTIVE' | 'ENDED';
}
const emailContact = (id: number, options: ContactFixtureOptions = {}) =>
  Schema.decodeUnknownSync(PartyContactPointSchema)({
    contactPointRef: {
      moduleId: 'party.registry',
      resourceId: uid(id),
      resourceType: 'party.registry.party-contact-point',
      tenantId,
    },
    current: options.current ?? true,
    end: null,
    partyRef,
    privacyClassification: 'PERSONAL',
    provenance: { authoritative: false, method: 'DECLARED_BY_PARTY', source: 'PARTY_DECLARATION' },
    recordedAt: timestamp,
    revision: 1,
    state: options.state ?? 'ACTIVE',
    storedPartyRef: partyRef,
    validFrom: timestamp,
    validTo: null,
    value: {
      displayValue: `customer-${id}@example.test`,
      lookupValue: `customer-${id}@example.test`,
      preferred: options.preferred ?? false,
      type: 'EMAIL',
    },
  });

it('selects the preferred active contact and keeps a deterministic tie without changing inputs', () => {
  const fallback = emailContact(10);
  const preferredLater = emailContact(12, { preferred: true });
  const preferredFirst = emailContact(11, { preferred: true });
  const items = [fallback, preferredLater, preferredFirst];
  const before = items.map((item) => Schema.encodeSync(PartyContactPointSchema)(item));
  expect(selectRetailProfileContact(items, 'EMAIL')).toEqual(preferredFirst);
  expect(items.map((item) => Schema.encodeSync(PartyContactPointSchema)(item))).toEqual(before);
});

it('excludes historical and ended contacts from the current profile', () => {
  const current = emailContact(12);
  expect(
    selectRetailProfileContact(
      [
        emailContact(10, { current: false, preferred: true }),
        emailContact(11, { preferred: true, state: 'ENDED' }),
        current,
      ],
      'EMAIL',
    ),
  ).toEqual(current);
  expect(selectRetailProfileContact([current], 'PHONE')).toBeUndefined();
});
