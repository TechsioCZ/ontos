import { PrivacyPartyRefSchema } from '../../shared/domain/party-reference.ts';
import { Effect, Layer, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import {
  PrivacySubjectPartyCredentials,
  PrivacySubjectPartyOwner,
  PrivacySubjectPartyOwnerLive,
} from '../../src/persistence/privacy-subject-party-owner.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyRef = Schema.decodeUnknownSync(PrivacyPartyRefSchema)({
  moduleId: 'party.registry' as const,
  resourceId: '20000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party' as const,
  tenantId,
});
const scope = {
  authMethod: 'session' as const,
  correlationId: 'owner-unit',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '40000000-0000-4000-8000-000000000001',
  tenantId,
};
const valid = {
  currentFactAssertions: [
    {
      assertionId: '50000000-0000-4000-8000-000000000001',
      factKind: 'PARTY_TYPE',
      isCurrent: true,
      partyRef,
      recordedAt: '1960-01-01T00:00:00Z',
      retractsAssertionId: null,
      state: 'ACTIVE',
      supersedesAssertionId: null,
      validFrom: '1960-01-01T00:00:00Z',
      validTo: null,
      value: 'PERSON',
    },
  ],
  party: {
    archivedAt: null,
    businessName: null,
    createdAt: '1960-01-01T00:00:00Z',
    displayName: null,
    firstName: null,
    lastName: null,
    partyRef,
    partyType: 'PERSON',
    revision: 3,
    updatedAt: '1960-01-01T00:00:00Z',
  },
  resolution: { aliasChain: [], canonicalPartyRef: partyRef, kind: 'DIRECT', requestedPartyRef: partyRef },
};

it.effect('requires coherent current PERSON owner facts rather than a structurally valid Party reference', () =>
  Effect.gen(function* ownerEvidenceCases() {
    let response = JSON.stringify(valid);
    let status = 200;
    let attempts = 0;
    const fakeFetch: typeof globalThis.fetch = (input, init) => {
      attempts += 1;
      const request = new Request(input, init);
      expect(request.headers.get('authorization')).toBe(`Bearer unit-${attempts}`);
      return Promise.resolve(new Response(response, { headers: { 'content-type': 'application/json' }, status }));
    };
    let issued = 0;
    const credentials = Layer.succeed(PrivacySubjectPartyCredentials, {
      acquire: () =>
        Effect.sync(() => {
          issued += 1;
          return {
            authorization: Redacted.make(`Bearer unit-${issued}`),
            baseUrl: 'https://party.example.test',
            compositionRevision: 'a'.repeat(64),
          };
        }),
    });
    const owner = yield* PrivacySubjectPartyOwner.pipe(
      Effect.provide(PrivacySubjectPartyOwnerLive.pipe(Layer.provide(credentials))),
    );
    const resolve: typeof owner.resolve = (...args) =>
      owner.resolve(...args).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
    const proof = yield* resolve(partyRef, scope, true);
    expect(proof).toMatchObject({
      ownerRevision: 3,
      partyRef,
      typeAssertions: [{ assertionId: valid.currentFactAssertions[0]?.assertionId }],
    });
    // Multiple coherent owner assertions do not invent a new universal cardinality threshold.
    response = JSON.stringify({
      ...valid,
      currentFactAssertions: [
        ...valid.currentFactAssertions,
        { ...valid.currentFactAssertions[0], assertionId: '50000000-0000-4000-8000-000000000002' },
      ],
    });
    expect((yield* resolve(partyRef, scope, true)).typeAssertions).toHaveLength(2);
    for (const invalid of [
      { ...valid, party: { ...valid.party, partyType: 'ORGANIZATION' } },
      { ...valid, party: { ...valid.party, partyType: 'UNRESOLVED' } },
      { ...valid, party: { ...valid.party, archivedAt: '1969-01-01T00:00:00Z' } },
      { ...valid, currentFactAssertions: [] },
      ...[
        { value: 'ORGANIZATION' },
        { state: 'DISPUTED' },
        { isCurrent: false },
        { validFrom: '2999-01-01T00:00:00Z' },
        { validTo: '1970-01-01T00:00:00Z' },
        { partyRef: { ...partyRef, tenantId: '90000000-0000-4000-8000-000000000001' } },
      ].map((change) => ({ ...valid, currentFactAssertions: [{ ...valid.currentFactAssertions[0], ...change }] })),
      { ...valid, resolution: { ...valid.resolution, requestedPartyRef: { ...partyRef, resourceId: 'foreign' } } },
      { ...valid, resolution: { ...valid.resolution, aliasChain: [partyRef] } },
      { ...valid, party: { ...valid.party, partyRef: { ...partyRef, resourceId: 'foreign' } } },
      { ...valid, party: { ...valid.party, revision: 0 } },
    ]) {
      response = JSON.stringify(invalid);
      const error = yield* Effect.flip(resolve(partyRef, scope, true));
      expect(error.code).toBe('privacy_operation_persistence_unavailable');
    }
    response = JSON.stringify({
      ...valid,
      resolution: {
        ...valid.resolution,
        aliasChain: [{ ...partyRef, resourceId: 'alias' }],
        kind: 'ALIAS',
        requestedPartyRef: { ...partyRef, resourceId: 'alias' },
      },
    });
    const aliasRef = Schema.decodeUnknownSync(PrivacyPartyRefSchema)({ ...partyRef, resourceId: 'alias' });
    expect((yield* Effect.flip(resolve(aliasRef, scope, true))).code).toBe('privacy_operation_persistence_unavailable');
    expect((yield* resolve(aliasRef, scope, false)).partyRef).toEqual(partyRef);
    for (const failureStatus of [403, 404, 503]) {
      status = failureStatus;
      response = JSON.stringify({ detail: 'Owner proof unavailable', status });
      expect((yield* Effect.flip(resolve(partyRef, scope, true))).code).toBe(
        'privacy_operation_persistence_unavailable',
      );
    }
    const before = attempts;
    yield* Effect.flip(
      resolve(
        Schema.decodeUnknownSync(PrivacyPartyRefSchema)({
          ...partyRef,
          tenantId: '90000000-0000-4000-8000-000000000001',
        }),
        scope,
        true,
      ),
    );
    expect(attempts).toBe(before);
    expect(issued).toBe(attempts);
  }),
);

it.effect('uses a real source-person owner receipt without fabricating raw type assertions', () =>
  Effect.gen(function* sourcePersonOwnerEvidence() {
    const sourceReference = {
      occurrenceId: 'occurrence:source-person',
      recordId: 'record:source-person',
      source: {
        issuer: 'internal:ebs-fixture',
        namespace: 'clients',
        recordType: 'customer',
        routeRef: 'route:source-person',
      },
    };
    const receipt = {
      outcome: 'SOURCE_PERSON_CURRENT',
      partyRef,
      partyRevision: 7,
      sourceActionInvocationId: '50000000-0000-4000-8000-000000000002',
      sourceDecisionRef: {
        moduleId: 'party.registry',
        resourceId: '50000000-0000-4000-8000-000000000003',
        resourceType: 'party.registry.party-match-decision',
        tenantId,
      },
    };
    let response = receipt;
    let issued = 0;
    let calls = 0;
    const credentials = Layer.succeed(PrivacySubjectPartyCredentials, {
      acquire: (_scope, declarationKey) =>
        Effect.sync(() => {
          expect(declarationKey).toBe('party.registry.source-person-admission.read');
          issued += 1;
          return {
            authorization: Redacted.make(`Bearer source-person-${issued}`),
            baseUrl: 'https://party.example.test',
            compositionRevision: 'a'.repeat(64),
          };
        }),
    });
    const owner = yield* PrivacySubjectPartyOwner.pipe(
      Effect.provide(PrivacySubjectPartyOwnerLive.pipe(Layer.provide(credentials))),
    );
    const fakeFetch: typeof globalThis.fetch = (input, init) => {
      calls += 1;
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toContain('/reads/source-person-admission');
      expect(request.headers.get('authorization')).toBe(`Bearer source-person-${calls}`);
      return Promise.resolve(Response.json(response));
    };
    const resolve = () =>
      owner
        .resolve(partyRef, scope, true, sourceReference)
        .pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
    const proof = yield* resolve();
    expect(proof.ownerRevision).toBe(7);
    expect(proof.typeAssertions).toEqual([]);
    expect(proof.sourcePersonAdmission?.sourceDecisionRef).toEqual(receipt.sourceDecisionRef);
    response = {
      ...receipt,
      partyRef: Schema.decodeUnknownSync(PrivacyPartyRefSchema)({
        ...partyRef,
        resourceId: '20000000-0000-4000-8000-000000000002',
      }),
    };
    expect((yield* Effect.flip(resolve())).code).toBe('privacy_operation_persistence_unavailable');
    response = {
      ...receipt,
      sourceDecisionRef: { ...receipt.sourceDecisionRef, tenantId: '90000000-0000-4000-8000-000000000001' },
    };
    expect((yield* Effect.flip(resolve())).code).toBe('privacy_operation_persistence_unavailable');
    expect(issued).toBe(calls);
  }),
);
