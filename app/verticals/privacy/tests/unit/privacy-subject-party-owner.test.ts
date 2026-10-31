import { PrivacyPartyRefSchema } from '../../shared/domain/party-reference.ts';
import { Effect, Layer, Option, Redacted, Result, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { expect, it } from 'effect-rstest';

import {
  privacySubjectPreparationScopeMatches,
  resolvePreparedSubjectParty,
  validatePreparedSubjectIntent,
  validateRetainedSubjectWriteIntent,
} from '../../src/persistence/privacy-subject-preparation.ts';
import type { PreparedPrivacySubject } from '../../src/persistence/privacy-subject-preparation.ts';
import { PrivacyOperationPersistenceError } from '../../src/persistence/privacy-operation-persistence-error.ts';
import { PrivacySubjectRecordSchema } from '../../shared/domain/privacy-subject.ts';
import { privacySubjectRefForParty } from '../../shared/domain/privacy-subject-identity.ts';
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

it('binds prepared Subject factories and Party evidence to the exact Legal Entity and operation scope', () => {
  const preparedScope = { ...scope, audience: 'privacy', traceId: 'subject-preparation-trace' };
  expect(privacySubjectPreparationScopeMatches(preparedScope, { ...preparedScope })).toBe(true);
  const { legalEntityId: _legalEntityId, ...withoutLegalEntity } = preparedScope;
  expect(privacySubjectPreparationScopeMatches(preparedScope, withoutLegalEntity)).toBe(false);
  expect(privacySubjectPreparationScopeMatches(withoutLegalEntity, withoutLegalEntity)).toBe(false);
  for (const changed of [
    { legalEntityId: '90000000-0000-4000-8000-000000000001' },
    { tenantId: '90000000-0000-4000-8000-000000000002' },
    { principalId: '90000000-0000-4000-8000-000000000003' },
    { trustedStorefrontId: '90000000-0000-4000-8000-000000000004' },
    { correlationId: 'another-invocation' },
    { audience: 'another-owner' },
    { traceId: 'another-trace' },
  ]) {
    expect(privacySubjectPreparationScopeMatches(preparedScope, { ...preparedScope, ...changed })).toBe(false);
  }
});

it.effect('preserves retained identity-conflict precedence without accepting a failed prepared Party observation', () =>
  Effect.gen(function* preparedOwnerFailurePrecedence() {
    const createdAt = '2026-10-20T12:00:00.000Z';
    const current = Schema.decodeSync(PrivacySubjectRecordSchema)({
      createdAt,
      subject: { kind: 'DATA_SUBJECT', partyRef },
      subjectRef: privacySubjectRefForParty(partyRef),
      updatedAt: createdAt,
    });
    const failure = new PrivacyOperationPersistenceError({
      code: 'privacy_operation_persistence_unavailable',
      reason: 'Actual owner refused the archived Party',
    });
    const cause = { ownerStatus: 404 };
    Object.defineProperty(failure, 'cause', { value: cause });
    const prepared: PreparedPrivacySubject = {
      actionInvocationId: '50000000-0000-4000-8000-000000000001',
      before: current,
      compositionRevision: 'a'.repeat(64),
      observation: Result.fail(failure),
      payload: { subject: current.subject, subjectRef: current.subjectRef },
      scope,
    };
    const proposed = { ...current, createdAt: '2026-10-20T12:00:01.000Z', updatedAt: '2026-10-20T12:00:01.000Z' };
    const conflict = yield* validatePreparedSubjectIntent(prepared, {
      actionInvocationId: prepared.actionInvocationId,
      current,
      subject: proposed,
    }).pipe(
      Effect.andThen(validateRetainedSubjectWriteIntent(current, proposed)),
      Effect.andThen(resolvePreparedSubjectParty(prepared, { partyRef, scope, write: false })),
      Effect.flip,
    );
    expect(conflict.code).toBe('privacy_operation_conflict');
    const unchangedOwnerFailure = yield* validateRetainedSubjectWriteIntent(current, current).pipe(
      Effect.andThen(resolvePreparedSubjectParty(prepared, { partyRef, scope, write: false })),
      Effect.flip,
    );
    expect(unchangedOwnerFailure).toBe(failure);
    expect(unchangedOwnerFailure).toHaveProperty('cause', cause);
    const newOwnerFailure = yield* resolvePreparedSubjectParty(
      { ...prepared, before: Option.getOrUndefined(Option.none()) },
      {
        partyRef,
        scope,
        write: true,
      },
    ).pipe(Effect.flip);
    expect(newOwnerFailure).toBe(failure);
    const changedSnapshot = yield* validatePreparedSubjectIntent(prepared, {
      actionInvocationId: prepared.actionInvocationId,
      current: proposed,
      subject: proposed,
    }).pipe(Effect.flip);
    expect(changedSnapshot.code).toBe('privacy_operation_persistence_unavailable');
    const otherInvocation = yield* validatePreparedSubjectIntent(prepared, {
      actionInvocationId: '60000000-0000-4000-8000-000000000001',
      current,
      subject: proposed,
    }).pipe(Effect.flip);
    expect(otherInvocation.code).toBe('privacy_operation_persistence_unavailable');
    const otherScope = yield* resolvePreparedSubjectParty(prepared, {
      partyRef,
      scope: { ...scope, legalEntityId: '70000000-0000-4000-8000-000000000001' },
      write: false,
    }).pipe(Effect.flip);
    expect(otherScope).not.toBe(failure);
  }),
);

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
  factHistory: null,
  party: {
    archivedAt: null,
    createdAt: '1960-01-01T00:00:00Z',
    displayName: null,
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
