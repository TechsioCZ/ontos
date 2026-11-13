import { normalizePhone, PartyContactPointsResponseSchema, PartyDetailResponseSchema } from '@app/party-registry/api';
import { Array as EffectArray, Effect, Option, Redacted, Result, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { commercePortalAuthPlatformCryptoLive } from '../../api/portal-auth/deployment.ts';
import {
  projectCustomerOwnProfile,
  customerPersonalNameFields,
  selectProfileContact,
  updateCustomerPartyProfile,
} from '../../api/portal-auth/profile/party-profile.ts';
import { CustomerOwnProfileSchema, UpdateCustomerOwnProfileSchema } from '../../shared/portal-auth/profile-api.ts';
import {
  CustomerOwnPortalReadInputSchema,
  UpdateOwnCustomerProfilePayloadSchema,
} from '../../shared/portal-auth/own-session.ts';
import { changeOwnCustomerPasswordAction } from '../../src/actions/change-own-customer-password.action.ts';
import { updateOwnCustomerConsentAction } from '../../src/actions/update-own-customer-consent.action.ts';
import { updateOwnCustomerProfileAction } from '../../src/actions/update-own-customer-profile.action.ts';
import { customerOwnConsentRead } from '../../src/api/customer-own-consent.read.ts';
import { customerOwnProfileRead } from '../../src/api/customer-own-profile.read.ts';
import {
  makeCustomerOwnProfileClientLayer,
  readCustomerOwnProfileWithAuthorization,
  updateCustomerOwnProfileWithAuthorization,
} from '../../src/api/customer-profile-self-service-client.ts';
import { commercePortalAuthAuditRecord } from '../../src/portal-auth/audit/audit-mapping.ts';

const tenantId = '7eb07e30-95be-498a-aefd-feb06fb54f24';
const partyRef = {
  moduleId: 'party.registry',
  resourceId: '6a5aaa8a-2222-4222-8222-222222222222',
  resourceType: 'party.registry.party',
  tenantId,
};
const at = '2026-10-23T12:00:00.000Z';
const detail = Schema.decodeUnknownEffect(PartyDetailResponseSchema)({
  currentFactAssertions: [],
  factHistory: [],
  party: {
    archivedAt: null,
    businessName: null,
    createdAt: at,
    displayName: 'Customer Name',
    firstName: 'Customer',
    lastName: 'Name',
    partyRef,
    partyType: 'PERSON',
    revision: 3,
    updatedAt: at,
  },
  resolution: { aliasChain: [], canonicalPartyRef: partyRef, kind: 'DIRECT', requestedPartyRef: partyRef },
});
it.effect('sends canonical personal-name fields and never mistakes omission for surname removal', () =>
  Effect.gen(function* canonicalProfileNames() {
    expect(yield* customerPersonalNameFields('New Customer', Option.some('Name'))).toEqual({
      firstName: 'New',
      lastName: 'Customer',
    });
    expect(yield* customerPersonalNameFields('Mononym', Option.none())).toEqual({ firstName: 'Mononym' });
    expect((yield* customerPersonalNameFields('Mononym', Option.some('Name')).pipe(Effect.flip)).status).toBe(400);
  }),
);
const contact = (id: string, preferred: boolean, revision = 1, current = true) => ({
  contactPointRef: {
    moduleId: 'party.registry',
    resourceId: id,
    resourceType: 'party.registry.party-contact-point',
    tenantId,
  },
  current,
  end: null,
  partyRef,
  privacyClassification: 'PERSONAL',
  provenance: { authoritative: false, method: 'DECLARED_BY_PARTY', source: 'PARTY_DECLARATION' },
  recordedAt: at,
  revision,
  state: current ? 'ACTIVE' : 'SUPERSEDED',
  storedPartyRef: partyRef,
  validFrom: at,
  validTo: null,
  value: {
    displayValue: `${id.slice(0, 8)}@example.test`,
    lookupValue: `${id.slice(0, 8)}@example.test`,
    preferred,
    type: 'EMAIL',
  },
});
const firstId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
const request = {
  contactEmail: 'customer@example.test',
  displayName: 'Customer Name',
  phone: '+420777123456',
  version: 'a'.repeat(64),
};

it.effect('preserves the exact owner destination, authorization, cookie and request headers in the native client', () =>
  Effect.gen(function* nativeProfileClientTransport() {
    const context = {
      baseUrl: 'https://commerce.example.test/commerce-customer-context-api',
      compositionRevision: 'b'.repeat(64),
      cookie: Redacted.make('commerce-session=opaque-session'),
      credential: Redacted.make('Bearer opaque-assertion'),
      origin: 'https://storefront.example.test',
      requestCorrelation: 'profile-client-correlation',
    };
    const requests: Request[] = [];
    const fakeFetch: typeof fetch = (input, init) => {
      requests.push(new Request(input, init));
      return Promise.resolve(Response.json(request));
    };
    yield* Effect.gen(function* useNativeProfileClients() {
      expect(yield* readCustomerOwnProfileWithAuthorization()).toEqual(request);
      expect(yield* updateCustomerOwnProfileWithAuthorization(request)).toEqual(request);
    }).pipe(
      Effect.provide(makeCustomerOwnProfileClientLayer(context)),
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
    );
    expect(requests.map((sent) => sent.method)).toEqual(['GET', 'POST']);
    for (const sent of requests) {
      expect(sent.url).toBe(
        'https://commerce.example.test/commerce-customer-context-api/api/portal-auth/customer-profile',
      );
      expect(sent.headers.get('authorization')).toBe('Bearer opaque-assertion');
      expect(sent.headers.get('cookie')).toBe('commerce-session=opaque-session');
      expect(sent.headers.get('origin')).toBe(context.origin);
      expect(sent.headers.get('x-correlation-id')).toBe(context.requestCorrelation);
      expect(sent.headers.get('x-ontos-composition-revision')).toBe(context.compositionRevision);
    }
    const [, update] = requests;
    if (update === undefined) {
      return yield* Effect.die('The native client did not send the profile update');
    }
    expect(yield* Effect.promise(update.json.bind(update))).toEqual(request);
    return yield* Effect.void;
  }),
);

it('accepts editable profile data but rejects every browser identity and credential field', () => {
  const decode = Schema.decodeUnknownResult(UpdateCustomerOwnProfileSchema, { onExcessProperty: 'error' });
  expect(Result.isSuccess(decode(request))).toBe(true);
  for (const key of [
    'partyId',
    'tenantId',
    'legalEntityId',
    'contactPointRef',
    'providerSubjectId',
    'email',
    'password',
  ]) {
    expect(Result.isFailure(decode({ ...request, [key]: 'forged-other-customer' }))).toBe(true);
  }
  for (const input of [
    { ...request, phone: 'not-a-phone' },
    { ...request, displayName: '' },
    { ...request, displayName: 'x'.repeat(301) },
    { ...request, contactEmail: 'invalid' },
    { ...request, version: '' },
  ]) {
    expect(Result.isFailure(decode(input))).toBe(true);
  }
});

it('reads absent native names without inventing a value and permits the full native editable name length', () => {
  const read = Schema.decodeUnknownResult(CustomerOwnProfileSchema);
  const update = Schema.decodeUnknownResult(UpdateCustomerOwnProfileSchema);
  expect(Result.isSuccess(read({ ...request, displayName: '' }))).toBe(true);
  expect(Result.isSuccess(read({ ...request, displayName: 'x'.repeat(300) }))).toBe(true);
  expect(Result.isSuccess(update({ ...request, displayName: 'x'.repeat(300) }))).toBe(true);
});

it.effect('selects only live contacts, prefers the owner preference, and resolves ties deterministically', () =>
  Effect.gen(function* assertContactSelection() {
    const contacts = yield* Schema.decodeUnknownEffect(PartyContactPointsResponseSchema)({
      items: [contact(secondId, true), contact(firstId, false)],
    });
    expect(selectProfileContact(contacts.items, 'EMAIL')?.contactPointRef.resourceId).toBe(secondId);
    expect(selectProfileContact(contacts.items, 'PHONE')).toBeUndefined();
    const ties = yield* Schema.decodeUnknownEffect(PartyContactPointsResponseSchema)({
      items: [contact(secondId, true), contact(firstId, true)],
    });
    expect(selectProfileContact(ties.items, 'EMAIL')?.contactPointRef.resourceId).toBe(firstId);
    const ended = yield* Schema.decodeUnknownEffect(PartyContactPointsResponseSchema)({
      items: [contact(firstId, true, 2, false), contact(secondId, false)],
    });
    expect(selectProfileContact(ended.items, 'EMAIL')?.contactPointRef.resourceId).toBe(secondId);
  }),
);

it.effect(
  'projects native owner values, never login email, and versions all contact revisions independent of order',
  () =>
    Effect.gen(function* assertProfileProjection() {
      const party = yield* detail;
      const contacts = yield* Schema.decodeUnknownEffect(PartyContactPointsResponseSchema)({
        items: [contact(firstId, true), contact(secondId, false)],
      });
      const profile = yield* Effect.fromResult(projectCustomerOwnProfile(party, contacts));
      expect(profile.displayName).toBe('Customer Name');
      expect(profile.phone).toBe('');
      expect(profile.contactEmail).toBe('11111111@example.test');
      expect(profile.version).toMatch(/^[a-f0-9]{64}$/u);
      expect(profile.version).toBe('c7d43d14cf9b662ab6c8030b0be5ee593378001dbead5f085408fdb470deda5d');
      expect(
        (yield* Effect.fromResult(projectCustomerOwnProfile(party, { items: EffectArray.reverse(contacts.items) })))
          .version,
      ).toBe(profile.version);
      const changed = yield* Schema.decodeUnknownEffect(PartyContactPointsResponseSchema)({
        items: [contact(firstId, true), contact(secondId, false, 2)],
      });
      expect((yield* Effect.fromResult(projectCustomerOwnProfile(party, changed))).version).not.toBe(profile.version);
    }),
);

it('uses the public Party normalization for Czech national and international phones', () => {
  expect(normalizePhone('777 123 456', 'CZ').lookupValue).toBe('+420777123456');
  expect(normalizePhone('+49 151 23456789').lookupValue).toBe('+4915123456789');
});

it.effect('rejects a changed name plus an invalid phone before acquiring any native write credential', () =>
  Effect.gen(function* rejectInvalidPhoneBeforeCommands() {
    const party = yield* detail;
    const contacts = yield* Schema.decodeUnknownEffect(PartyContactPointsResponseSchema)({ items: [] });
    const profile = yield* Effect.fromResult(projectCustomerOwnProfile(party, contacts));
    for (const phone of ['123456', 'not-a-phone', '---', '+000123456']) {
      // Run the real updater without a gateway service/configuration or command doubles. A name
      // command attempted first would fail as 503; invalid phone intent must instead fail as 400.
      const problem = yield* Effect.flip(
        updateCustomerPartyProfile(
          {
            compositionRevision: 'c'.repeat(64),
            legalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            partyId: party.party.partyRef.resourceId,
            requestCorrelation: 'invalid-profile-phone',
            tenantId,
          },
          { ...profile, displayName: 'Must not be committed', phone },
          { contacts, detail: party, partyRef: party.party.partyRef, profile },
        ),
      );
      expect(problem.status).toBe(400);
      expect(problem.code).toBe('invalid_request');
      expect(Option.getOrUndefined(party.party.displayName ?? Option.none())).toBe('Customer Name');
    }
  }).pipe(Effect.provide(TestClock.layer()), Effect.provide(commercePortalAuthPlatformCryptoLive)),
);

it('serves the own profile as a storefront-client read and Action only, never a person, agent or Party parameter', () => {
  expect(customerOwnProfileRead.descriptor.entrypoint).toMatchObject({
    access: 'read',
    authorization: { kind: 'protected' },
    role: 'api',
  });
  expect(updateOwnCustomerProfileAction.descriptor.entrypoint).toMatchObject({
    access: 'write',
    authorization: { kind: 'protected' },
    role: 'action',
  });
  for (const descriptor of [
    customerOwnProfileRead.descriptor,
    customerOwnConsentRead.descriptor,
    updateOwnCustomerProfileAction.descriptor,
    updateOwnCustomerConsentAction.descriptor,
    changeOwnCustomerPasswordAction.descriptor,
  ]) {
    // A workload-only carrier: no capability a person's role could hold, so humans are refused `deny.workload_only`.
    expect(descriptor.accessDeclaration).toBeUndefined();
    expect(descriptor.accessWorkload?.workloads).toEqual(['commerce.storefront-client']);
    expect(descriptor.legalEntityScope).toBe('required');
  }
  // The only Party either names is the admitted session's own.
  expect(Object.keys(CustomerOwnPortalReadInputSchema.fields)).toEqual(['session']);
  expect(Object.keys(UpdateOwnCustomerProfilePayloadSchema.fields)).toEqual(['session', 'update']);
});

it('projects strict profile intent/completion evidence without editable PII', () => {
  const record = commercePortalAuthAuditRecord({
    correlationDigest: 'c'.repeat(64),
    eventType: 'commerce.portal-auth.profile-updated.v1',
    occurredAt: new Date(at),
    operation: 'customer-profile-update',
    outcome: 'success',
    providerSubjectId: 'opaque-subject',
  });
  expect(record.eventType).toBe('commerce.portal-auth.profile-updated.v1');
  expect(record.outcome).toBe('success');
  expect(JSON.stringify(record)).not.toContain(request.contactEmail);
  expect(Object.keys(record)).not.toContain('partyId');
});

it.effect('refuses redacted owner fields rather than projecting empty editable values', () =>
  Effect.gen(function* redactedProfile() {
    const party = yield* detail;
    const contacts = yield* Schema.decodeUnknownEffect(PartyContactPointsResponseSchema)({
      items: [contact(firstId, true)],
    });
    const { displayName: _redactedName, ...withoutName } = party.party;
    expect(Result.isFailure(projectCustomerOwnProfile({ ...party, party: withoutName }, contacts))).toBe(true);
    const { value: _redactedContact, ...withoutContactValue } = contact(firstId, true);
    const redactedContacts = yield* Schema.decodeUnknownEffect(PartyContactPointsResponseSchema)({
      items: [withoutContactValue],
    });
    expect(Result.isFailure(projectCustomerOwnProfile(party, redactedContacts))).toBe(true);
    const emptyKnown = projectCustomerOwnProfile(
      { ...party, party: { ...party.party, displayName: Option.none() } },
      { items: [] },
    );
    expect(Result.isSuccess(emptyKnown) && emptyKnown.success.displayName === '').toBe(true);
  }),
);
it.effect('does not overwrite an unknown surname or acquire a write credential for a redacted name', () =>
  Effect.gen(function* redactedSurname() {
    const party = yield* detail;
    const contacts = { items: [] };
    const profile = yield* Effect.fromResult(projectCustomerOwnProfile(party, contacts));
    const { lastName: _redactedSurname, ...withoutSurname } = party.party;
    const problem = yield* updateCustomerPartyProfile(
      {
        compositionRevision: 'c'.repeat(64),
        legalEntityId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        partyId: party.party.partyRef.resourceId,
        requestCorrelation: 'redacted-surname',
        tenantId,
      },
      { ...profile, displayName: 'Changed Name' },
      {
        contacts,
        detail: { ...party, party: withoutSurname },
        partyRef: party.party.partyRef,
        profile,
      },
    ).pipe(Effect.flip);
    expect(problem.status).toBe(503);
  }).pipe(Effect.provide(commercePortalAuthPlatformCryptoLive)),
);
