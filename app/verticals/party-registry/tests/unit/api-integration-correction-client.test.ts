import { DateTime, Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient, HttpRouter, HttpServerRequest, HttpServerResponse } from 'effect/http';

import { CorrectPartyFactPayloadSchema } from '../../shared/command-api.ts';
import { executePartyContactPointDetailWithAuthorization } from '../../src/api/party-contact-point-detail-client.ts';
import { executePartyContactPointsWithAuthorization } from '../../src/api/party-contact-points-client.ts';
import { executePartyOfficialIdentifierDetailWithAuthorization } from '../../src/api/party-official-identifier-detail-client.ts';
import { executePartyOfficialIdentifierHistoryWithAuthorization } from '../../src/api/party-official-identifier-history-client.ts';

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
  factKind: 'BUSINESS_NAME' as const,
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

it.effect('public clients discover the first assertion and submit a governed correction with its ID', () =>
  Effect.gen(function* apiIntegrationCorrectionClientCase1() {
    let corrected = false;
    const requests: Request[] = [];
    const handleRequest = Effect.gen(function* handleCorrectionRequest() {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const pathname = request.url;
      if (pathname.endsWith('/actions/create-party')) {
        return HttpServerResponse.jsonUnsafe({
          decisionRef: {
            ...partyRef,
            resourceType: 'party.registry.party-match-decision',
          },
          outcome: 'CREATED',
          partyRef,
        });
      }
      if (pathname.endsWith('/actions/correct-party-fact')) {
        const payload = yield* Schema.decodeUnknownEffect(CorrectPartyFactPayloadSchema)(yield* request.json);
        if (payload.factKind === 'RELATIONSHIP') {
          throw new Error('Expected identity correction');
        }
        expect(payload.factKind).toBe('BUSINESS_NAME');
        expect(payload.targetAssertionId).toBe(originalAssertionId);
        expect(payload.partyId).toBe(partyRef.resourceId);
        corrected = true;
        return HttpServerResponse.jsonUnsafe({
          correctionRef: {
            ...partyRef,
            resourceType: 'party.registry.party-correction',
          },
          factKind: 'BUSINESS_NAME',
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
          businessName: currentAssertion.value,
          firstName: null,
          lastName: null,
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
            businessName: originalAssertion.value,
            evidenceRefs: ['document:original'],
            officialIdentifiers: [],
            partyType: 'ORGANIZATION',
            provenance: {
              method: 'MANUAL_REVIEW',
              source: 'document:original',
            },
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
      const target = before.currentFactAssertions.find(({ factKind }) => factKind === 'BUSINESS_NAME');
      expect(target).toBeDefined();
      if (target === undefined) {
        throw new Error('Expected target to be defined');
      }
      const correctionPayload = yield* Schema.decodeEffect(CorrectPartyFactPayloadSchema)({
        evidenceRefs: ['document:reviewed-error'],
        evidenceSource: 'DOCUMENT',
        factKind: 'BUSINESS_NAME',
        partyId: partyRef.resourceId,
        policyVersion: 'party-correction.v1',
        provenance: {
          method: 'MANUAL_REVIEW',
          source: 'document:reviewed-error',
        },
        reasonCode: 'WRONG_IDENTITY_VALUE',
        replacementValue: 'Corrected name',
        targetAssertionId: target.assertionId,
      });
      const correction = yield* correctPartyFactWithAuthorization(correctionPayload, 'Bearer test-assertion', {
        ...options,
        idempotencyKey: 'correct-first-assertion',
      });
      expect(correction.retractedAssertionId).toBe(target.assertionId);
      const after = yield* executePartyDetailWithAuthorization(
        { includeFactHistory: true, partyRef },
        'Bearer test-assertion',
        options.correlationId,
        options,
      );
      expect(after.currentFactAssertions[0]?.assertionId).toBe(replacementAssertionId);
      expect(
        (after.factHistory ?? []).some(
          ({ assertionId, state }) => assertionId === originalAssertionId && state === 'SUPERSEDED',
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
        businessName: originalAssertion.value,
        evidenceRefs: ['document:original'],
        officialIdentifiers: [],
        partyType: 'ORGANIZATION',
        provenance: { method: 'MANUAL_REVIEW', source: 'document:original' },
        validFrom: timestamp,
      },
    });
    expect(requests.every((request) => request.headers.get('authorization') === 'Bearer test-assertion')).toBe(true);
  }),
);

it.effect(
  'public identifier and contact clients roundtrip declared facts without verification or invented registry scope',
  () =>
    Effect.gen(function* verificationFreePublicReads() {
      const officialIdentifierRef = { ...partyRef, resourceType: 'party.registry.party-official-identifier' } as const;
      const contactPointRef = { ...partyRef, resourceType: 'party.registry.party-contact-point' } as const;
      const identifier = {
        identifierType: 'CZ_DIC',
        namespace: 'CZ:DIC',
        normalizedValue: 'CZ12345678',
        officialIdentifierRef,
        partyRef,
        recordedAt: timestamp,
        state: 'ENDED',
        validFrom: timestamp,
        validTo: '2026-10-01T00:00:00.000Z',
      };
      const provenance = { authoritative: false, method: 'DECLARED_BY_PARTY', source: 'PARTY_DECLARATION' };
      const contact = {
        contactPointRef,
        partyRef,
        storedPartyRef: partyRef,
        current: true,
        end: null,
        privacyClassification: 'PERSONAL',
        provenance,
        recordedAt: timestamp,
        revision: 1,
        state: 'ACTIVE',
        validFrom: timestamp,
        validTo: null,
        value: {
          type: 'ADDRESS',
          address: {
            addressLine1: 'Na Prikope 1',
            addressLine2: null,
            city: 'Praha',
            countryCode: 'CZ',
            postalCode: '11000',
            region: null,
          },
          purposes: [
            {
              preferred: true,
              purpose: 'REGISTERED',
              current: true,
              end: null,
              provenance,
              recordedAt: timestamp,
              revision: 1,
              state: 'ACTIVE',
              validFrom: timestamp,
              validTo: null,
            },
          ],
        },
      };
      const requestedPaths: string[] = [];
      const server = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpRouter.add(
              '*',
              '/*',
              Effect.gen(function* handlePublicRead() {
                const request = yield* HttpServerRequest.HttpServerRequest;
                requestedPaths.push(request.url);
                expect(request.headers['authorization']).toBe('Bearer public-read-test');
                if (request.url.endsWith('/reads/party-official-identifier-detail')) {
                  return HttpServerResponse.jsonUnsafe(identifier);
                }
                if (request.url.endsWith('/reads/party-official-identifier-history')) {
                  return HttpServerResponse.jsonUnsafe({ items: [identifier] });
                }
                if (request.url.endsWith('/reads/party-contact-point-detail')) {
                  return HttpServerResponse.jsonUnsafe(contact);
                }
                expect(request.url.endsWith('/reads/party-contact-points')).toBe(true);
                return HttpServerResponse.jsonUnsafe({ items: [contact] });
              }),
            ),
            { disableLogger: true },
          ),
        ),
        (resource) => Effect.promise(() => resource.dispose()),
      );
      const fakeFetch: typeof fetch = (input, init) => server.handler(new Request(input, init));
      const options = { baseUrl: 'https://party.example/party-registry-api' };
      yield* Effect.gen(function* assertPublicReadRoundtrip() {
        const detail = yield* executePartyOfficialIdentifierDetailWithAuthorization(
          { officialIdentifierRef },
          'Bearer public-read-test',
          'verification-free-read',
          options,
        );
        const history = yield* executePartyOfficialIdentifierHistoryWithAuthorization(
          { partyRef },
          'Bearer public-read-test',
          'verification-free-read',
          options,
        );
        expect(detail.normalizedValue).toBe('CZ12345678');
        expect(detail.state).toBe('ENDED');
        expect(history.items[0]).toEqual(detail);
        expect(detail).not.toHaveProperty('verification');
        const address = yield* executePartyContactPointDetailWithAuthorization(
          { contactPointRef },
          'Bearer public-read-test',
          'verification-free-read',
          options,
        );
        const contacts = yield* executePartyContactPointsWithAuthorization(
          { partyRef, includeHistorical: true },
          'Bearer public-read-test',
          'verification-free-read',
          options,
        );
        expect(contacts.items[0]).toEqual(address);
        expect(address.provenance).toEqual(provenance);
        expect(address).not.toHaveProperty('verification');
        expect(address.value?.type).toBe('ADDRESS');
        if (address.value?.type === 'ADDRESS') {
          expect(address.value.purposes[0]?.purpose).toBe('REGISTERED');
          expect(address.value.purposes[0]).not.toHaveProperty('registryContext');
          expect(address.value.purposes[0]).not.toHaveProperty('verification');
        }
      }).pipe(Effect.provideService(FetchHttpClient.Fetch, fakeFetch));
      expect(requestedPaths).toHaveLength(4);
    }),
);
