import { CurrentMarketCatalogResponseSchema } from '@app/commerce-market-catalog/api/client';
import { DateTime, Effect, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CommercialContextGatewayCredentialService } from '../../shared/domain/commercial-context-gateway-credential.ts';
import { commercialContextAssessmentPortFromEnvironment } from '../../src/integrations/commercial-context-evidence.ts';

const tenantId = '22222222-2222-4222-8222-222222222222';
const legalEntityId = '33333333-3333-4333-8333-333333333333';
const assessedAt = DateTime.makeUnsafe('2026-09-27T10:00:00.000Z');
const commercialScope = {
  channelId: 'B2C',
  marketId: 'cz-launch',
  sellingLegalEntityId: legalEntityId,
} as const;

const exactMarket = {
  channels: ['B2C'] as const,
  definitionRevisionRef: {
    moduleId: 'commerce.market-catalog' as const,
    resourceId: 'market-cz-revision-7',
    resourceType: 'commerce.market-catalog.market-definition-revision' as const,
    tenantId,
  },
  effectivePeriod: { startsAt: '2026-01-01T00:00:00.000Z' },
  jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' as const }],
  lifecycle: 'ACTIVE' as const,
  marketCode: 'CZ_LAUNCH',
  marketRef: {
    moduleId: 'commerce.market-catalog' as const,
    resourceId: commercialScope.marketId,
    resourceType: 'commerce.market-catalog.market' as const,
    tenantId,
  },
  purpose: 'Czech launch commerce',
  revision: 7,
  sellingLegalEntityRef: {
    moduleId: 'core.identity' as const,
    resourceId: legalEntityId,
    resourceType: 'core.identity.legal-entity' as const,
    tenantId,
  },
  supportedLocales: ['cs-CZ'],
};

const response = Schema.decodeSync(CurrentMarketCatalogResponseSchema)({
  associations: [],
  completenessEvidence: {
    observedAt: '2026-09-27T10:00:00.000Z',
    ownerRevision: 'market-catalog:revision-7',
    scope: { kind: 'EXACT_PREDICATE', predicateRef: 'tenant-current-markets' },
  },
  markets: [exactMarket],
  observedAt: '2026-09-27T10:00:00.000Z',
});

const gateway = {
  issue: () =>
    Effect.succeed({
      baseUrl: new URL('https://commerce-market.example.test'),
      credential: Redacted.make('Bearer market-owner-assertion'),
    }),
};

describe('Pricing commercial-context evidence integration', () => {
  it.effect('validates only the exact SLE, Channel, and Commerce Market without a Storefront selector', () =>
    Effect.gen(function* assessExactCommercialContext() {
      const requests: unknown[] = [];
      const port = yield* commercialContextAssessmentPortFromEnvironment(
        { legalEntityId, requestCorrelation: 'define-price-commercial-context' },
        (payload, credential, requestCorrelation, options) =>
          Effect.sync(() => {
            requests.push({ credential: Redacted.value(credential), options, payload, requestCorrelation });
            return response;
          }),
      );

      const result = yield* port.assess({ assessedAt, commercialScope, tenantId });

      expect(result).toMatchObject({
        commercialScope,
        marketDefinitionRevisionRef: exactMarket.definitionRevisionRef,
        status: 'VALID',
      });
      expect(requests).toEqual([
        {
          credential: 'Bearer market-owner-assertion',
          options: { baseUrl: new URL('https://commerce-market.example.test') },
          payload: { at: assessedAt },
          requestCorrelation: 'define-price-commercial-context',
        },
      ]);
      expect(requests[0]).not.toHaveProperty('storefrontId');
      expect(requests[0]).not.toHaveProperty('storefrontRef');
    }).pipe(Effect.provideService(CommercialContextGatewayCredentialService, gateway)),
  );

  it.effect('returns definite invalidity for a complete snapshot without the exact tuple', () =>
    Effect.gen(function* rejectUnconfiguredTuple() {
      const port = yield* commercialContextAssessmentPortFromEnvironment(
        { legalEntityId, requestCorrelation: 'define-price-commercial-context' },
        () => Effect.succeed(response),
      );

      const result = yield* port.assess({
        assessedAt,
        commercialScope: { ...commercialScope, channelId: 'B2B' },
        tenantId,
      });

      expect(result).toEqual({
        reason: 'Commerce Market did not validate the exact Selling Legal Entity, Channel, and Market tuple',
        status: 'INVALID',
      });
    }).pipe(Effect.provideService(CommercialContextGatewayCredentialService, gateway)),
  );

  it.effect('fails retryably on competing exact definitions or internally inconsistent completeness evidence', () =>
    Effect.gen(function* rejectUnverifiableEvidence() {
      for (const ownerResponse of [
        { ...response, markets: [...response.markets, ...response.markets] },
        {
          ...response,
          completenessEvidence: {
            ...response.completenessEvidence,
            observedAt: DateTime.makeUnsafe('2026-09-27T09:59:59.000Z'),
          },
        },
      ]) {
        const port = yield* commercialContextAssessmentPortFromEnvironment(
          { legalEntityId, requestCorrelation: 'define-price-commercial-context' },
          () => Effect.succeed(ownerResponse),
        );
        const failure = yield* port.assess({ assessedAt, commercialScope, tenantId }).pipe(Effect.flip);
        expect(failure).toMatchObject({ code: 'pricing_commercial_context_unavailable', retryable: true });
      }
    }).pipe(Effect.provideService(CommercialContextGatewayCredentialService, gateway)),
  );

  it.effect('rejects a caller-substituted Selling Legal Entity before issuing an owner credential', () => {
    let credentialCalls = 0;
    return Effect.gen(function* rejectSubstitutedSeller() {
      const port = yield* commercialContextAssessmentPortFromEnvironment(
        { legalEntityId, requestCorrelation: 'define-price-commercial-context' },
        () => Effect.die('must not call the Commerce Market owner'),
      );
      const result = yield* port.assess({
        assessedAt,
        commercialScope: {
          ...commercialScope,
          sellingLegalEntityId: '44444444-4444-4444-8444-444444444444',
        },
        tenantId,
      });

      expect(result.status).toBe('INVALID');
      expect(credentialCalls).toBe(0);
    }).pipe(
      Effect.provideService(CommercialContextGatewayCredentialService, {
        issue: () => {
          credentialCalls += 1;
          return Effect.die('must not issue a credential');
        },
      }),
    );
  });
});
