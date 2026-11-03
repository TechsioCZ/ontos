import { DateTime, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  PartyContactPointsForbiddenProblemSchema,
  PartyContactPointsResponseSchema,
  PartyContactPointsUnavailableProblemSchema,
} from '../../shared/apis/party-contact-points.ts';
import type { PartyContactPointsResponse } from '../../shared/apis/party-contact-points.ts';
import {
  PartyDetailForbiddenProblemSchema,
  PartyDetailNotFoundProblemSchema,
  PartyDetailResponseSchema,
} from '../../shared/apis/party-detail.ts';
import type { PartyDetailResponse } from '../../shared/apis/party-detail.ts';
import {
  PartyOfficialIdentifierHistoryNotFoundProblemSchema,
  PartyOfficialIdentifierHistoryResponseSchema,
} from '../../shared/apis/party-official-identifier-history.ts';
import type { PartyOfficialIdentifierHistoryResponse } from '../../shared/apis/party-official-identifier-history.ts';
import type { PartyRef } from '../../shared/resources/party.ts';
import {
  PARTY_IDENTITY_KEY,
  loadPartyIdentitySection,
  loadPartyIdentityWithReaders,
  partyIdentityInput,
  partyIdentityKey,
  partyIdentityView,
} from '../../src/routes/[lang]/prodej/strany/[partyId]/party-identity-data.ts';
import type {
  PartyIdentityRefCandidate,
  PartyIdentityReaders,
  PartyIdentitySection,
} from '../../src/routes/[lang]/prodej/strany/[partyId]/party-identity-data.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '10000000-0000-4000-8000-000000000002';
const partyId = '40000000-0000-4000-8000-000000000001';
const canonicalPartyId = '40000000-0000-4000-8000-000000000002';
const contactPointId = '50000000-0000-4000-8000-000000000001';
const identifierId = '60000000-0000-4000-8000-000000000001';
const assertionId = '33333333-3333-4333-8333-333333333333';
const instant = '2026-10-15T10:00:00.000Z';

const partyRef = {
  moduleId: 'party.registry',
  resourceId: partyId,
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const canonicalPartyRef = { ...partyRef, resourceId: canonicalPartyId } as const;

const context = {
  displayName: 'Staff',
  legalEntityId: '70000000-0000-4000-8000-000000000001',
  principalId: '80000000-0000-4000-8000-000000000001',
  tenantId,
} as const;

const partyWire = {
  archivedAt: null,
  createdAt: instant,
  displayName: 'Eva Bílá',
  partyRef,
  partyType: 'PERSON',
  revision: 7,
  updatedAt: instant,
} as const;

const identityResponse = Schema.decodeSync(PartyDetailResponseSchema)({
  currentFactAssertions: [
    {
      assertionId,
      factKind: 'DISPLAY_NAME',
      isCurrent: true,
      partyRef,
      recordedAt: instant,
      retractsAssertionId: null,
      state: 'ACTIVE',
      supersedesAssertionId: null,
      validFrom: instant,
      validTo: null,
      value: 'Eva Bílá',
    },
  ],
  factHistory: null,
  party: partyWire,
  resolution: {
    aliasChain: [],
    canonicalPartyRef: partyRef,
    kind: 'DIRECT',
    requestedPartyRef: partyRef,
  },
});

const contactResponse = Schema.decodeSync(PartyContactPointsResponseSchema)({
  items: [
    {
      contactPointRef: {
        moduleId: 'party.registry',
        resourceId: contactPointId,
        resourceType: 'party.registry.party-contact-point',
        tenantId,
      },
      current: true,
      end: null,
      partyRef,
      privacyClassification: 'BUSINESS_SENSITIVE',
      provenance: {
        authoritative: true,
        method: 'MANUAL_CONFIRMATION',
        source: 'USER_ASSERTION',
      },
      recordedAt: instant,
      revision: 1,
      state: 'ACTIVE',
      storedPartyRef: partyRef,
      validFrom: instant,
      validTo: null,
      value: {
        displayValue: 'eva@example.cz',
        lookupValue: 'eva@example.cz',
        preferred: true,
        type: 'EMAIL',
      },
      verification: { state: 'VERIFIED' },
    },
  ],
});

const identifierResponse = Schema.decodeSync(PartyOfficialIdentifierHistoryResponseSchema)({
  items: [
    {
      identifierType: 'ICO',
      namespace: 'CZ:ICO',
      normalizedValue: '12345678',
      officialIdentifierRef: {
        moduleId: 'party.registry',
        resourceId: identifierId,
        resourceType: 'party.registry.party-official-identifier',
        tenantId,
      },
      partyRef,
      recordedAt: instant,
      state: 'ACTIVE',
      validFrom: instant,
      validTo: null,
      verification: 'VERIFIED',
    },
  ],
});

const forbiddenParty = Schema.decodeSync(PartyDetailForbiddenProblemSchema)({
  _tag: 'PartyDetailForbiddenProblem',
  detail: 'Denied',
  status: 403,
  title: 'Forbidden',
  type: 'urn:test:forbidden',
});
const missingParty = Schema.decodeSync(PartyDetailNotFoundProblemSchema)({
  _tag: 'PartyDetailNotFoundProblem',
  detail: 'Missing',
  status: 404,
  title: 'Not found',
  type: 'urn:test:not-found',
});
const forbiddenContacts = Schema.decodeSync(PartyContactPointsForbiddenProblemSchema)({
  _tag: 'PartyContactPointsForbiddenProblem',
  detail: 'Denied',
  status: 403,
  title: 'Forbidden',
  type: 'urn:test:forbidden',
});
const unavailableContacts = Schema.decodeSync(PartyContactPointsUnavailableProblemSchema)({
  _tag: 'PartyContactPointsUnavailableProblem',
  detail: 'Unavailable',
  retryable: true,
  status: 503,
  title: 'Unavailable',
  type: 'urn:test:unavailable',
});
const missingIdentifiers = Schema.decodeSync(PartyOfficialIdentifierHistoryNotFoundProblemSchema)({
  _tag: 'PartyOfficialIdentifierHistoryNotFoundProblem',
  detail: 'Not found',
  status: 404,
  title: 'Not found',
  type: 'urn:test:not-found',
});

const failedSection = <Value, Failure = unknown>(problem: Failure): Effect.Effect<PartyIdentitySection<Value>> =>
  loadPartyIdentitySection<Value, Failure>(Effect.fail(problem));

interface ReaderRecorder {
  readonly calls: {
    contacts: PartyRef[];
    identifiers: PartyRef[];
    identity: PartyRef[];
  };
  readonly readers: PartyIdentityReaders;
}

const recorder = (overrides: Partial<PartyIdentityReaders> = {}): ReaderRecorder => {
  const calls: ReaderRecorder['calls'] = { contacts: [], identifiers: [], identity: [] };
  return {
    calls,
    readers: {
      contacts: (ref) => {
        calls.contacts.push(ref);
        return overrides.contacts?.(ref) ?? Effect.succeed({ status: 'ready', value: contactResponse });
      },
      identifiers: (ref) => {
        calls.identifiers.push(ref);
        return overrides.identifiers?.(ref) ?? Effect.succeed({ status: 'ready', value: identifierResponse });
      },
      identity: (ref) => {
        calls.identity.push(ref);
        return overrides.identity?.(ref) ?? Effect.succeed({ status: 'ready', value: identityResponse });
      },
    },
  };
};

const load = (
  ref: PartyIdentityRefCandidate = partyRef,
  readers: PartyIdentityReaders = recorder().readers,
  tenant = tenantId,
) => loadPartyIdentityWithReaders(ref, tenant, readers);

const identityOf = (result: Effect.Success<ReturnType<typeof load>>) => {
  expect(result.status).toBe('identity');
  return result.status === 'identity' ? result : undefined;
};

it.effect(
  'loads one exact Party UUID, then its independently admitted identifiers and contacts without a list gate',
  () =>
    Effect.gen(function* loadExactParty() {
      const { calls, readers } = recorder();
      const result = identityOf(yield* load(partyRef, readers));

      expect(calls.identity).toEqual([partyRef]);
      expect(calls.identifiers).toEqual([partyRef]);
      expect(calls.contacts).toEqual([partyRef]);
      expect(result?.identity.status).toBe('ready');
      if (result?.identity.status !== 'ready') {
        return;
      }
      expect(result.identity.value.displayName).toBe('Eva Bílá');
      expect(result.identity.value.revision).toBe(7);
      expect(result.identity.value.facts).toHaveLength(1);
      expect(result.identifiers?.status).toBe('ready');
      expect(result.contacts?.status).toBe('ready');
      if (result.identifiers?.status === 'ready') {
        expect(result.identifiers.value[0]?.value).toBe('12345678');
        expect(result.identifiers.value[0]?.current).toBe(true);
      }
      if (result.contacts?.status === 'ready') {
        expect(result.contacts.value[0]?.displayValue).toBe('eva@example.cz');
        expect(result.contacts.value[0]?.preferred).toBe(true);
      }
    }),
);

it.effect('keeps a Party permission denial on the identity section and does not probe the other reads', () =>
  Effect.gen(function* denyParty() {
    const { calls, readers } = recorder({
      identity: () => failedSection<PartyDetailResponse>(forbiddenParty),
    });
    const result = identityOf(yield* load(partyRef, readers));

    expect(result?.identity).toEqual({ status: 'forbidden' });
    expect(calls.identity).toEqual([partyRef]);
    expect(calls.identifiers).toEqual([]);
    expect(calls.contacts).toEqual([]);
  }),
);

it.effect('keeps a contact denial separate from a ready identity and identifiers', () =>
  Effect.gen(function* denyContacts() {
    const { readers } = recorder({
      contacts: () => failedSection<PartyContactPointsResponse>(forbiddenContacts),
    });
    const result = identityOf(yield* load(partyRef, readers));

    expect(result?.identity.status).toBe('ready');
    expect(result?.contacts).toEqual({ status: 'forbidden' });
    expect(result?.identifiers?.status).toBe('ready');
  }),
);

it.effect('reports a missing Party as not found without inventing an identity revision', () =>
  Effect.gen(function* missingPartyDetail() {
    const { readers } = recorder({
      identity: () => failedSection<PartyDetailResponse>(missingParty),
    });
    const result = identityOf(yield* load(partyRef, readers));

    expect(result?.identity).toEqual({ status: 'not-found' });
  }),
);

it.effect('reports identifier and contact availability independently', () =>
  Effect.gen(function* independentSections() {
    const { readers } = recorder({
      contacts: () => failedSection<PartyContactPointsResponse>(unavailableContacts),
      identifiers: () => failedSection<PartyOfficialIdentifierHistoryResponse>(missingIdentifiers),
    });
    const result = identityOf(yield* load(partyRef, readers));

    expect(result?.identity.status).toBe('ready');
    expect(result?.contacts).toEqual({ status: 'unavailable' });
    expect(result?.identifiers).toEqual({ status: 'not-found' });
  }),
);

it.effect('refuses a foreign tenant, another module, another resource type or a non-UUID before any read', () =>
  Effect.gen(function* refuseForeignRefs() {
    const cases: PartyIdentityRefCandidate[] = [
      { ...partyRef, tenantId: otherTenantId },
      { ...partyRef, moduleId: 'demo.crm' },
      { ...partyRef, resourceType: 'party.registry.counterparty' },
      { ...partyRef, resourceId: 'not-a-uuid' },
    ];
    for (const candidate of cases) {
      const { calls, readers } = recorder();
      const result = yield* load(candidate, readers);
      expect(result).toEqual({ status: 'invalid-ref' });
      expect(calls.identity).toEqual([]);
      expect(calls.identifiers).toEqual([]);
      expect(calls.contacts).toEqual([]);
    }
  }),
);

it.effect('uses only the canonical Party ref returned by the exact detail read for the secondary reads', () =>
  Effect.gen(function* canonicalSecondaryReads() {
    const aliasResponse = yield* Schema.decodeEffect(PartyDetailResponseSchema)({
      currentFactAssertions: [],
      factHistory: null,
      party: { ...partyWire, partyRef: canonicalPartyRef },
      resolution: {
        aliasChain: [partyRef],
        canonicalPartyRef,
        kind: 'ALIAS',
        requestedPartyRef: partyRef,
      },
    });
    const { calls, readers } = recorder({
      identity: () => Effect.succeed({ status: 'ready', value: aliasResponse }),
    });
    const result = identityOf(yield* load(partyRef, readers));

    expect(calls.identity).toEqual([partyRef]);
    expect(calls.identifiers).toEqual([canonicalPartyRef]);
    expect(calls.contacts).toEqual([canonicalPartyRef]);
    expect(result?.identity.status).toBe('ready');
    if (result?.identity.status === 'ready') {
      expect(result.identity.value.aliasResolved).toBe(true);
    }
  }),
);

it.effect('refuses a canonical ref that escapes the session tenant without fabricating another identity', () =>
  Effect.gen(function* refuseEscapedCanonical() {
    const escapedResponse = yield* Schema.decodeEffect(PartyDetailResponseSchema)({
      currentFactAssertions: [],
      factHistory: null,
      party: partyWire,
      resolution: {
        aliasChain: [],
        canonicalPartyRef: { ...canonicalPartyRef, tenantId: otherTenantId },
        kind: 'ALIAS',
        requestedPartyRef: partyRef,
      },
    });
    const { calls, readers } = recorder({
      identity: () => Effect.succeed({ status: 'ready', value: escapedResponse }),
    });
    const result = identityOf(yield* load(partyRef, readers));

    expect(calls.identifiers).toEqual([]);
    expect(calls.contacts).toEqual([]);
    expect(result?.contacts).toEqual({ status: 'unavailable' });
    expect(result?.identifiers).toEqual({ status: 'unavailable' });
  }),
);

it('accepts only an exact Party UUID route input under the full Shell scope', () => {
  const input = partyIdentityInput(context, { partyId });
  expect(input.status).toBe('ready');
  if (input.status === 'ready') {
    expect(input.partyRef).toEqual(partyRef);
    expect(input.partyId).toBe(partyId);
  }
  expect(partyIdentityInput(undefined, { partyId })).toEqual({ status: 'scope-missing' });
  expect(partyIdentityInput({ ...context, principalId: '' }, { partyId })).toEqual({ status: 'scope-missing' });
  expect(partyIdentityInput(context, { partyId: 'not-a-uuid' })).toEqual({ status: 'invalid-ref' });
  expect(partyIdentityInput(context, {})).toEqual({ status: 'invalid-ref' });
  expect(partyIdentityKey(context, partyId)).toBe(
    `${tenantId}|${context.legalEntityId}|${context.principalId}|party.registry|${partyId}`,
  );
  expect(partyIdentityKey({ ...context, principalId: '80000000-0000-4000-8000-000000000002' }, partyId)).not.toBe(
    partyIdentityKey(context, partyId),
  );
  expect(partyIdentityKey({ ...context, legalEntityId: '70000000-0000-4000-8000-000000000002' }, partyId)).not.toBe(
    partyIdentityKey(context, partyId),
  );
  expect(partyIdentityKey({ ...context, tenantId: otherTenantId }, partyId)).not.toBe(
    partyIdentityKey(context, partyId),
  );
  expect(partyIdentityKey(context, canonicalPartyId)).not.toBe(partyIdentityKey(context, partyId));
  expect(partyIdentityKey(undefined, partyId)).toBeUndefined();
});

it('maps a ready Party detail to the display view without inventing optional values', () => {
  const view = partyIdentityView(identityResponse);
  expect(view).toMatchObject({
    aliasResolved: false,
    archived: false,
    displayName: 'Eva Bílá',
    partyType: 'PERSON',
    revision: 7,
  });
  expect(view.facts).toEqual([
    {
      factKind: 'DISPLAY_NAME',
      recordedAt: DateTime.makeUnsafe(instant),
      validFrom: DateTime.makeUnsafe(instant),
      value: 'Eva Bílá',
    },
  ]);
  const unnamed = partyIdentityView({
    ...identityResponse,
    party: {
      ...identityResponse.party,
      archivedAt: Option.some(DateTime.makeUnsafe(instant)),
      displayName: Option.none(),
      revision: 8,
    },
  });
  expect(unnamed.displayName).toBeUndefined();
  expect(unnamed.archived).toBe(true);
  expect(unnamed.revision).toBe(8);
  expect(PARTY_IDENTITY_KEY).toBe('party-registry.pages.partyIdentity');
});
