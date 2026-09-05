// @effect-diagnostics asyncFunction:off
import assert from 'node:assert/strict';
import test from 'node:test';
import { Effect, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { CorrectPartyFactPayloadSchema } from '../../shared/command-api.ts';
import {
  correctPartyFactWithAuthorization,
  createPartyWithAuthorization,
  executePartyDetailWithAuthorization,
} from '../../src/api/party-registry-client.ts';

const partyRef = {
  moduleId: 'party.registry' as const,
  resourceId: '10000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party' as const,
  tenantId: '20000000-0000-4000-8000-000000000001',
};
const originalAssertionId = '30000000-0000-4000-8000-000000000001';
const replacementAssertionId = '30000000-0000-4000-8000-000000000002';
const timestamp = '2026-09-03T10:00:00.000Z';
const originalAssertion = {
  assertionId: originalAssertionId,
  factKind: 'DISPLAY_NAME' as const,
  isCurrent: true,
  partyRef,
  recordedAt: timestamp,
  retractsAssertionId: null,
  state: 'ACTIVE' as const,
  supersedesAssertionId: null,
  validFrom: timestamp,
  validTo: null,
  value: 'Incorrect recorded name',
};

test('public clients discover the first assertion and submit a governed correction with its ID', async () => {
  let corrected = false;
  const requests: Request[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const { pathname } = new URL(request.url);
    if (pathname.endsWith('/actions/create-party')) {
      return Response.json({
        decisionRef: { ...partyRef, resourceType: 'party.registry.party-match-decision' },
        outcome: 'CREATED',
        partyRef,
      });
    }
    if (pathname.endsWith('/actions/correct-party-fact')) {
      const payload = Schema.decodeUnknownSync(CorrectPartyFactPayloadSchema)(await request.json());
      if (payload.factKind === 'RELATIONSHIP') {
        throw new Error('Expected identity correction');
      }
      assert.equal(payload.factKind, 'DISPLAY_NAME');
      assert.equal(payload.targetAssertionId, originalAssertionId);
      assert.equal(payload.partyId, partyRef.resourceId);
      corrected = true;
      return Response.json({
        correctionRef: { ...partyRef, resourceType: 'party.registry.party-correction' },
        factKind: 'DISPLAY_NAME',
        followUp: 'ENRICHMENT_REVIEW',
        partyRef,
        relationshipRef: null,
        replacementAssertionId,
        replacementRelationshipRef: null,
        retractedAssertionId: originalAssertionId,
      });
    }
    assert.equal(pathname.endsWith('/reads/party-detail'), true);
    const currentAssertion = corrected
      ? {
          ...originalAssertion,
          assertionId: replacementAssertionId,
          supersedesAssertionId: originalAssertionId,
          value: 'Corrected name',
        }
      : originalAssertion;
    return Response.json({
      currentFactAssertions: [currentAssertion],
      factHistory: corrected
        ? [{ ...originalAssertion, isCurrent: false, state: 'SUPERSEDED' }, currentAssertion]
        : [originalAssertion],
      party: {
        archivedAt: null,
        createdAt: timestamp,
        displayName: currentAssertion.value,
        partyRef,
        partyType: 'ORGANIZATION',
        revision: corrected ? 2 : 1,
        updatedAt: timestamp,
      },
      resolution: {
        aliasChain: [],
        canonicalPartyRef: partyRef,
        kind: 'DIRECT',
        requestedPartyRef: partyRef,
      },
    });
  };
  const options = {
    baseUrl: 'https://party.example/party-registry-api',
    correlationId: 'correction-discovery',
    idempotencyKey: 'create-for-correction',
  };
  const program = Effect.gen(function* verifyPublicCorrectionWorkflow() {
    const created = yield* createPartyWithAuthorization(
      {
        candidate: {
          displayName: originalAssertion.value,
          evidenceRefs: ['document:original'],
          officialIdentifiers: [],
          partyType: 'ORGANIZATION',
          provenance: { method: 'MANUAL_REVIEW', source: 'document:original' },
          validFrom: timestamp,
        },
      },
      'Bearer test-assertion',
      options,
    );
    assert.equal(created.outcome, 'CREATED');
    const before = yield* executePartyDetailWithAuthorization(
      { includeFactHistory: true, partyRef },
      'Bearer test-assertion',
      options.correlationId,
      options,
    );
    const target = before.currentFactAssertions.find(({ factKind }) => factKind === 'DISPLAY_NAME');
    assert.ok(target);
    const correction = yield* correctPartyFactWithAuthorization(
      {
        evidenceRefs: ['document:reviewed-error'],
        evidenceSource: 'DOCUMENT',
        factKind: 'DISPLAY_NAME',
        partyId: partyRef.resourceId,
        policyVersion: 'party-correction.v1',
        provenance: { method: 'MANUAL_REVIEW', source: 'document:reviewed-error' },
        reasonCode: 'WRONG_IDENTITY_VALUE',
        replacementValue: 'Corrected name',
        targetAssertionId: target.assertionId,
      },
      'Bearer test-assertion',
      { ...options, idempotencyKey: 'correct-first-assertion' },
    );
    assert.equal(correction.retractedAssertionId, target.assertionId);
    const after = yield* executePartyDetailWithAuthorization(
      { includeFactHistory: true, partyRef },
      'Bearer test-assertion',
      options.correlationId,
      options,
    );
    assert.equal(after.currentFactAssertions[0]?.assertionId, replacementAssertionId);
    assert.equal(
      after.factHistory?.some(
        ({ assertionId, state }) => assertionId === originalAssertionId && state === 'SUPERSEDED',
      ),
      true,
    );
  });
  await Effect.runPromise(program.pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch)));
  assert.equal(requests.length, 4);
  assert.equal(
    requests.every((request) => request.headers.get('authorization') === 'Bearer test-assertion'),
    true,
  );
});
