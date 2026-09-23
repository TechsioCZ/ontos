import { Effect, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/unstable/http';

import {
  PriceGroupDefinitionRequestSchema,
  PriceGroupDefinitionResponseSchema,
  PriceGroupCurrentEvidenceSchema,
  executePriceGroupDefinition,
  executePriceGroupDefinitionWithAuthorization,
  executeValidatePriceGroupCompatibility,
  executeValidatePriceGroupCompatibilityWithAuthorization,
} from '../../src/index.ts';
import {
  executePriceGroupDefinition as directExecutePriceGroupDefinition,
  executePriceGroupDefinitionWithAuthorization as directExecutePriceGroupDefinitionWithAuthorization,
} from '../../src/api/price-group-definition-client.ts';
import {
  executeValidatePriceGroupCompatibility as directExecuteValidatePriceGroupCompatibility,
  executeValidatePriceGroupCompatibilityWithAuthorization as directExecuteValidatePriceGroupCompatibilityWithAuthorization,
} from '../../src/api/validate-price-group-compatibility-client.ts';
import { makeOperationGateway } from '../../src/api/action-gateway.ts';
import {
  ValidatePriceGroupCompatibilityDomainUnavailableProblem,
  ValidatePriceGroupCompatibilityDomainUnavailableProblemSchema,
  ValidatePriceGroupCompatibilityRequestSchema,
  ValidatePriceGroupCompatibilityResponseSchema,
} from '../../src/apis/validate-price-group-compatibility.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const priceGroupRef = {
  moduleId: 'pricing.price-group-catalog' as const,
  resourceId: '22222222-2222-4222-8222-222222222222',
  resourceType: 'pricing.price-group-catalog.price-group' as const,
  tenantId,
};
const definitionRevisionId = '33333333-3333-4333-8333-333333333333';
const requiredContract = { contractId: 'commerce.customer-price-group-assignment', version: 1 };
const meaningFingerprint = 'a'.repeat(64);
const effectivePeriod = {
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  effectiveTo: '2027-01-01T00:00:00.000Z',
};
const expectedCurrent = {
  catalogRevision: 7,
  definitionRevisionId,
  definitionRevisionNumber: 1,
  meaningFingerprint,
  priceGroupRef,
};
const definition = {
  acceptedCatalogRevision: 7,
  classificationPurpose: 'Classifies customers eligible for the dealer pricing path.',
  compatibilityContracts: [requiredContract],
  created: {
    actionInvocationId: '44444444-4444-4444-8444-444444444444',
    actorPrincipalId: '55555555-5555-4555-8555-555555555555',
    reason: 'Approved dealer classification.',
    trustedAt: '2026-09-01T00:00:00.000Z',
  },
  definitionRevisionId,
  description: 'Dealer classification for approved resellers.',
  displayName: 'Dealer',
  effectivePeriod,
  meaningFingerprint,
  previousDefinitionRevisionId: null,
  priceGroupRef,
  revisionNumber: 1,
};
const identity = {
  businessCode: 'DEALER',
  classificationPurpose: definition.classificationPurpose,
  created: definition.created,
  createdAtCatalogRevision: 1,
  lifecycle: {
    activeFrom: effectivePeriod.effectiveFrom,
    retiredAt: null,
    state: 'ACTIVE' as const,
  },
  meaningFingerprint,
  priceGroupRef,
};
const definitionRequest = {
  priceGroupRef,
  trustedOperationAt: '2026-10-01T00:00:00.000Z',
};
const definitionResponse = {
  currentEvidence: {
    ...expectedCurrent,
    definitionEffectivePeriod: effectivePeriod,
    observedAt: definitionRequest.trustedOperationAt,
  },
  definition,
  identity,
  observedAt: '2026-10-01T00:00:01.000Z',
  selection: 'CURRENT' as const,
};
const retiredAt = '2027-01-01T00:00:00.000Z';
const retiredDefinitionResponse = {
  currentEvidence: {
    ...definitionResponse.currentEvidence,
    observedAt: retiredAt,
  },
  definition,
  identity: {
    ...identity,
    lifecycle: {
      activeFrom: identity.lifecycle.activeFrom,
      retiredAt,
      state: 'RETIRED' as const,
    },
  },
  observedAt: '2027-01-01T00:00:01.000Z',
  selection: 'CURRENT' as const,
};
const compatibilityRequest = {
  expectedCurrent,
  priceGroupRef,
  requiredContract,
  trustedOperationAt: definitionRequest.trustedOperationAt,
};
const compatibilityResponse = {
  evidence: {
    ...expectedCurrent,
    definitionEffectivePeriod: effectivePeriod,
    requiredContract,
    trustedOperationAt: compatibilityRequest.trustedOperationAt,
    verifiedAt: '2026-10-01T00:00:01.000Z',
  },
  kind: 'USABLE' as const,
};

describe('public Price Group governed read contracts', () => {
  it('publishes one canonical API and client implementation from the package root', () => {
    expect(executePriceGroupDefinition).toBe(directExecutePriceGroupDefinition);
    expect(executePriceGroupDefinitionWithAuthorization).toBe(directExecutePriceGroupDefinitionWithAuthorization);
    expect(executeValidatePriceGroupCompatibility).toBe(directExecuteValidatePriceGroupCompatibility);
    expect(executeValidatePriceGroupCompatibilityWithAuthorization).toBe(
      directExecuteValidatePriceGroupCompatibilityWithAuthorization,
    );
  });

  it('decodes bounded current and exact historical definition requests and responses', () => {
    expect(Schema.decodeSync(PriceGroupDefinitionRequestSchema)(definitionRequest)).toEqual(definitionRequest);
    expect(Schema.decodeSync(PriceGroupDefinitionResponseSchema)(definitionResponse)).toMatchObject({
      selection: 'CURRENT',
    });
    const historical = {
      definitionRevisionId,
      priceGroupRef,
      trustedOperationAt: definitionRequest.trustedOperationAt,
    };
    expect(Schema.decodeSync(PriceGroupDefinitionRequestSchema)(historical)).toEqual(historical);
    expect(
      Schema.decodeSync(PriceGroupDefinitionResponseSchema)({
        definition,
        identity: {
          ...identity,
          lifecycle: {
            activeFrom: identity.lifecycle.activeFrom,
            retiredAt: '2026-12-01T00:00:00.000Z',
            state: 'RETIRED',
          },
        },
        observedAt: definitionResponse.observedAt,
        selection: 'HISTORICAL',
      }),
    ).toMatchObject({ selection: 'HISTORICAL' });
    const currentWithoutEvidence = {
      definition,
      identity,
      observedAt: definitionResponse.observedAt,
      selection: 'CURRENT',
    };
    expect(() => Schema.decodeUnknownSync(PriceGroupDefinitionResponseSchema)(currentWithoutEvidence)).toThrow();
    const expandedResponse = {
      ...definitionResponse,
      customerAssignments: ['must-not-cross-owner-boundary'],
    };
    expect(() =>
      Schema.decodeSync(PriceGroupDefinitionResponseSchema, { onExcessProperty: 'error' })(expandedResponse),
    ).toThrow();
  });

  it('keeps active evidence half-open while accepting only exact retired terminal Current evidence', () => {
    expect(Schema.is(PriceGroupCurrentEvidenceSchema)(retiredDefinitionResponse.currentEvidence)).toBe(false);
    expect(Schema.decodeSync(PriceGroupDefinitionResponseSchema)(retiredDefinitionResponse)).toMatchObject({
      currentEvidence: { observedAt: retiredAt },
      identity: { lifecycle: { retiredAt, state: 'RETIRED' } },
      selection: 'CURRENT',
    });
    expect(() =>
      Schema.decodeSync(PriceGroupDefinitionResponseSchema)({
        ...retiredDefinitionResponse,
        identity: {
          ...retiredDefinitionResponse.identity,
          lifecycle: {
            ...retiredDefinitionResponse.identity.lifecycle,
            retiredAt: '2026-12-31T23:59:59.999Z',
          },
        },
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeSync(PriceGroupDefinitionResponseSchema)({
        ...definitionResponse,
        currentEvidence: {
          ...definitionResponse.currentEvidence,
          observedAt: effectivePeriod.effectiveTo,
        },
      }),
    ).toThrow();
  });

  it('requires exact expected-evidence identity while allowing the owner to derive it', () => {
    expect(Schema.decodeSync(ValidatePriceGroupCompatibilityRequestSchema)(compatibilityRequest)).toEqual(
      compatibilityRequest,
    );
    const { expectedCurrent: _omitted, ...withoutExpected } = compatibilityRequest;
    expect(Schema.decodeSync(ValidatePriceGroupCompatibilityRequestSchema)(withoutExpected)).toEqual(withoutExpected);
    expect(() =>
      Schema.decodeSync(ValidatePriceGroupCompatibilityRequestSchema)({
        ...compatibilityRequest,
        expectedCurrent: {
          ...expectedCurrent,
          priceGroupRef: { ...priceGroupRef, resourceId: '99999999-9999-4999-8999-999999999999' },
        },
      }),
    ).toThrow();
    expect(Schema.decodeSync(ValidatePriceGroupCompatibilityResponseSchema)(compatibilityResponse)).toMatchObject({
      kind: 'USABLE',
    });
  });
});

describe('public Price Group governed read clients', () => {
  it.effect('constructs fresh audience credentials for each invocation attempt', () =>
    Effect.gen(function* freshGatewayCredentials() {
      const observations: string[] = [];
      let issued = 0;
      const gateway = makeOperationGateway(({ audience }) =>
        Effect.sync(() => {
          issued += 1;
          observations.push(audience);
          return { expiresAt: 1_791_166_700, token: `token-${issued}` };
        }),
      );
      const first = yield* gateway.invoke((authorization) => Effect.succeed(authorization));
      const second = yield* gateway.invoke((authorization) => Effect.succeed(authorization));

      expect(first).toBe('Bearer token-1');
      expect(second).toBe('Bearer token-2');
      expect(observations).toEqual(['price-group-catalog', 'price-group-catalog']);
    }),
  );

  it.effect('sends exact credentials, correlations, payloads and preserves typed backend failures', () =>
    Effect.gen(function* governedTransport() {
      const requests: Request[] = [];
      const fetch: typeof globalThis.fetch = (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        const response = request.url.endsWith('/reads/price-group-definition')
          ? definitionResponse
          : compatibilityResponse;
        return Promise.resolve(Response.json(response));
      };
      const baseUrl = 'https://pricing.example/owner';
      yield* executePriceGroupDefinitionWithAuthorization(
        definitionRequest,
        'Bearer definition',
        'definition-correlation',
        { baseUrl },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));
      yield* executeValidatePriceGroupCompatibilityWithAuthorization(
        compatibilityRequest,
        'Bearer compatibility',
        'compatibility-correlation',
        { baseUrl },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, fetch));

      expect(
        requests.map((request) => [
          request.url,
          request.headers.get('authorization'),
          request.headers.get('x-correlation-id'),
        ]),
      ).toEqual([
        [`${baseUrl}/reads/price-group-definition`, 'Bearer definition', 'definition-correlation'],
        [`${baseUrl}/reads/validate-price-group-compatibility`, 'Bearer compatibility', 'compatibility-correlation'],
      ]);

      const unavailable = new ValidatePriceGroupCompatibilityDomainUnavailableProblem({
        detail: 'The owner cannot prove authoritative current state.',
        reasonCode: 'OWNER_UNAVAILABLE',
        retryable: true,
        status: 503,
        title: 'Price Group compatibility unavailable',
        type: 'https://ontos.dev/problems/price-group-compatibility-unavailable',
      });
      const unavailableFetch: typeof globalThis.fetch = () =>
        Promise.resolve(
          Response.json(unavailable, {
            headers: { 'content-type': 'application/problem+json' },
            status: 503,
          }),
        );
      const failure = yield* executeValidatePriceGroupCompatibilityWithAuthorization(
        compatibilityRequest,
        'Bearer proof',
        'failure-correlation',
        { baseUrl },
      ).pipe(Effect.provideService(FetchHttpClient.Fetch, unavailableFetch), Effect.flip);
      expect(Schema.is(ValidatePriceGroupCompatibilityDomainUnavailableProblemSchema)(failure)).toBe(true);
    }),
  );
});
