import { expect, it } from 'effect-rstest';

import { DateTime, Effect, Option, Schema } from 'effect';
import {
  FetchHttpClient,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from 'effect/unstable/http';
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

it.effect(
  'public clients discover the first assertion and submit a governed correction with its ID',
  () =>
    Effect.gen(function* apiIntegrationCorrectionClientCase1() {
      let corrected = false;
      const requests: Request[] = [];
      const handleRequest = Effect.gen(function* handleCorrectionRequest() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const pathname = request.url;
        if (pathname.endsWith('/actions/create-party')) {
          return HttpServerResponse.jsonUnsafe({
            decisionRef: { ...partyRef, resourceType: 'party.registry.party-match-decision' },
            outcome: 'CREATED',
            partyRef,
          });
        }
        if (pathname.endsWith('/actions/correct-party-fact')) {
          const payload = yield* Schema.decodeUnknownEffect(CorrectPartyFactPayloadSchema)(
            yield* request.json,
          );
          if (payload.factKind === 'RELATIONSHIP') {
            throw new Error('Expected identity correction');
          }
          expect(payload.factKind).toBe('DISPLAY_NAME');
          expect(payload.targetAssertionId).toBe(originalAssertionId);
          expect(payload.partyId).toBe(partyRef.resourceId);
          corrected = true;
          return HttpServerResponse.jsonUnsafe({
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
        expect(pathname.endsWith('/reads/party-detail')).toBe(true);
        const currentAssertion = corrected
          ? {
              ...originalAssertion,
              assertionId: replacementAssertionId,
              supersedesAssertionId: originalAssertionId,
              value: 'Corrected name',
            }
          : originalAssertion;
        return HttpServerResponse.jsonUnsafe({
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
      });
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(HttpRouter.add('*', '/*', handleRequest), {
            disableLogger: true,
          }),
        ),
        (resource) => Effect.promise(() => resource.dispose()),
      );
      const fakeFetch: typeof fetch = (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return server.handler(request);
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
              validFrom: DateTime.makeUnsafe(timestamp),
            },
          },
          'Bearer test-assertion',
          options,
        );
        expect(created.outcome).toBe('CREATED');
        const before = yield* executePartyDetailWithAuthorization(
          { includeFactHistory: true, partyRef },
          'Bearer test-assertion',
          options.correlationId,
          options,
        );
        const target = before.currentFactAssertions.find(
          ({ factKind }) => factKind === 'DISPLAY_NAME',
        );
        expect(target).toBeDefined();
        if (target === undefined) {
          throw new Error('Expected target to be defined');
        }
        const correctionPayload = yield* Schema.decodeUnknownEffect(CorrectPartyFactPayloadSchema)({
          evidenceRefs: ['document:reviewed-error'],
          evidenceSource: 'DOCUMENT',
          factKind: 'DISPLAY_NAME',
          partyId: partyRef.resourceId,
          policyVersion: 'party-correction.v1',
          provenance: { method: 'MANUAL_REVIEW', source: 'document:reviewed-error' },
          reasonCode: 'WRONG_IDENTITY_VALUE',
          replacementValue: 'Corrected name',
          targetAssertionId: target.assertionId,
        });
        const correction = yield* correctPartyFactWithAuthorization(
          correctionPayload,
          'Bearer test-assertion',
          { ...options, idempotencyKey: 'correct-first-assertion' },
        );
        expect(correction.retractedAssertionId).toBe(target.assertionId);
        const after = yield* executePartyDetailWithAuthorization(
          { includeFactHistory: true, partyRef },
          'Bearer test-assertion',
          options.correlationId,
          options,
        );
        expect(after.currentFactAssertions[0]?.assertionId).toBe(replacementAssertionId);
        expect(
          Option.getOrElse(after.factHistory, () => []).some(
            ({ assertionId, state }) =>
              assertionId === originalAssertionId && state === 'SUPERSEDED',
          ),
        ).toBe(true);
      });
      yield* program.pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
      expect(requests.length).toBe(4);
      const createRequest = requests.find(({ url }) => url.endsWith('/actions/create-party'));
      expect(createRequest).toBeDefined();
      if (createRequest === undefined) {
        throw new Error('Expected createRequest to be defined');
      }
      expect(yield* Effect.promise(() => createRequest.json())).toEqual({
        candidate: {
          displayName: originalAssertion.value,
          evidenceRefs: ['document:original'],
          officialIdentifiers: [],
          partyType: 'ORGANIZATION',
          provenance: { method: 'MANUAL_REVIEW', source: 'document:original' },
          validFrom: timestamp,
        },
      });
      expect(
        requests.every(
          (request) => request.headers.get('authorization') === 'Bearer test-assertion',
        ),
      ).toBe(true);
    }),
);
