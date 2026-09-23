import type { OperationalScope } from '@app/core-runtime';
import { ReadHandlerNotFound, ReadHandlerUnavailable, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { CurrentMarketCatalogRequestSchema } from '../../shared/apis/current-market-catalog.ts';
import { MarketHistoryRequestSchema } from '../../shared/apis/market-history.ts';
import { handleCurrentMarketCatalog } from '../../src/api/current-market-catalog.read.ts';
import { handleMarketHistory } from '../../src/api/market-history.read.ts';
import {
  MarketCatalogReadPersistenceUnavailable,
  marketCatalogReadPersistenceForScope,
} from '../../src/persistence/market-catalog-read-persistence.ts';
import type { MarketCatalogReadPersistence } from '../../src/persistence/market-catalog-read-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const foreignTenantId = '22222222-2222-4222-8222-222222222222';
const sellerId = '33333333-3333-4333-8333-333333333333';
const principalId = '44444444-4444-4444-8444-444444444444';
const marketId = '55555555-5555-4555-8555-555555555555';
const definitionRevisionOneId = '66666666-6666-4666-8666-666666666666';
const definitionRevisionTwoId = '77777777-7777-4777-8777-777777777777';
const associationId = '88888888-8888-4888-8888-888888888888';
const january = '2030-01-01T00:00:00.000Z';
const february = '2030-02-01T00:00:00.000Z';
const march = '2030-03-01T00:00:00.000Z';

const scope: OperationalScope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authBindingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    authContextRef: 'session:market-catalog-owner-reads',
    authMethod: 'session',
    legalEntityId: sellerId,
    principalId,
    tenantId,
  }),
  correlationId: 'market-catalog-owner-reads-test',
};

const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: marketId,
  resourceType: 'commerce.market-catalog.market',
  tenantId,
} as const;
const sellerRef = {
  moduleId: 'core.identity',
  resourceId: sellerId,
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;
const definitionRef = (resourceId: string) => ({
  moduleId: 'commerce.market-catalog' as const,
  resourceId,
  resourceType: 'commerce.market-catalog.market-definition-revision' as const,
  tenantId,
});
const associationRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: associationId,
  resourceType: 'commerce.market-catalog.storefront-association',
  tenantId,
} as const;
const storefrontRef = { appId: 'czech-storefront', tenantId } as const;

const definitionOne = {
  channels: ['B2C'],
  definitionRevisionRef: definitionRef(definitionRevisionOneId),
  effectivePeriod: { startsAt: january },
  jurisdictions: [{ code: 'CZ', kind: 'COUNTRY' }],
  lifecycle: 'ACTIVE',
  marketCode: 'CZ_MAIN',
  marketRef,
  purpose: 'Initial Czech commerce',
  revision: 1,
  sellingLegalEntityRef: sellerRef,
  supportedLocales: ['cs-CZ'],
} as const;
const definitionTwo = {
  ...definitionOne,
  channels: ['B2C', 'B2B'],
  definitionRevisionRef: definitionRef(definitionRevisionTwoId),
  effectivePeriod: { startsAt: february },
  previousDefinitionRevisionRef: definitionRef(definitionRevisionOneId),
  purpose: 'Czech retail and business commerce',
  revision: 2,
  supportedLocales: ['cs-CZ', 'en-CZ'],
} as const;
const associationOne = {
  associationRef,
  channel: 'B2C',
  effectivePeriod: { startsAt: january },
  marketDefinitionRevisionRef: definitionRef(definitionRevisionOneId),
  marketRef,
  provenance: { kind: 'CONFIGURATION_ACTION', reference: 'fixture:v1' },
  revision: 1,
  sellingLegalEntityRef: sellerRef,
  storefrontRef,
} as const;
const associationTwo = {
  ...associationOne,
  channel: 'B2B',
  effectivePeriod: { startsAt: february },
  marketDefinitionRevisionRef: definitionRef(definitionRevisionTwoId),
  previousAssociationRevision: 1,
  provenance: { kind: 'CONFIGURATION_ACTION', reference: 'fixture:v2' },
  revision: 2,
} as const;

const currentPayload = {
  associations: [associationTwo],
  completenessEvidence: {
    observedAt: march,
    ownerRevision: 'commerce.market-catalog.current:v1:generation:7',
    scope: {
      kind: 'EXACT_PREDICATE',
      predicateRef: `commerce.market-catalog.current:v1:${tenantId}:${sellerId}:${march}`,
    },
  },
  markets: [definitionTwo],
  observedAt: march,
} as const;
const historyPayload = {
  associations: [associationOne, associationTwo],
  definitions: [definitionOne, definitionTwo],
  marketRef,
} as const;

interface RoutineStub {
  readonly routineKey: string;
}

interface TransactionOptions {
  readonly malformedCurrent?: boolean;
  readonly missingHistory?: boolean;
  readonly unavailable?: boolean;
}

const transactionFor = (options: TransactionOptions = {}) => ({
  invoke: (routine: RoutineStub) => {
    if (options.unavailable === true) {
      return Effect.fail({ _tag: 'ScopedRoutineInvocationError' });
    }
    if (routine.routineKey === 'market-catalog-read.current') {
      return Effect.succeed([{ payload: options.malformedCurrent === true ? { markets: [] } : currentPayload }]);
    }
    return Effect.succeed(options.missingHistory === true ? [] : [{ payload: historyPayload }]);
  },
});

const persistenceFor = (options: TransactionOptions = {}) =>
  // @ts-expect-error Only the exercised owner-local governed routine invocation is mocked.
  marketCatalogReadPersistenceForScope(transactionFor(options), scope);

const currentInput = Schema.decodeUnknownSync(CurrentMarketCatalogRequestSchema)({ at: march });
const historyInput = Schema.decodeUnknownSync(MarketHistoryRequestSchema)({ marketRef });

describe('Commerce Market Catalog owner reads', () => {
  it.effect('decodes the governed Current owner snapshot with generation-backed completeness', () =>
    Effect.gen(function* currentOwnerFacts() {
      const persistence = yield* persistenceFor();
      const result = yield* persistence.current(currentInput);

      expect(result.markets).toHaveLength(1);
      expect(result.markets[0]).toMatchObject({
        definitionRevisionRef: { resourceId: definitionRevisionTwoId },
        lifecycle: 'ACTIVE',
        previousDefinitionRevisionRef: { resourceId: definitionRevisionOneId },
        revision: 2,
      });
      expect(result.associations[0]).toMatchObject({
        channel: 'B2B',
        marketDefinitionRevisionRef: { resourceId: definitionRevisionTwoId },
        previousAssociationRevision: 1,
        revision: 2,
      });
      expect(result.completenessEvidence.ownerRevision).toBe('commerce.market-catalog.current:v1:generation:7');
      expect(result.completenessEvidence.scope.predicateRef).toContain(sellerId);
    }),
  );

  it.effect('decodes immutable definition and association revisions from the governed history routine', () =>
    Effect.gen(function* retainedHistory() {
      const persistence = yield* persistenceFor();
      const result = yield* persistence.history(marketId);

      expect(Option.isSome(result)).toBe(true);
      if (Option.isNone(result)) {
        return;
      }
      expect(result.value.definitions.map(({ revision }) => revision)).toEqual([1, 2]);
      expect(result.value.definitions[1]?.previousDefinitionRevisionRef?.resourceId).toBe(definitionRevisionOneId);
      expect(result.value.associations.map(({ revision }) => revision)).toEqual([1, 2]);
      expect(result.value.marketRef.resourceId).toBe(marketId);
    }),
  );

  it.effect('fails closed for malformed routine payloads and invocation failures', () =>
    Effect.gen(function* failClosed() {
      const malformed = yield* persistenceFor({ malformedCurrent: true });
      const malformedError = yield* malformed.current(currentInput).pipe(Effect.flip);
      expect(Schema.is(MarketCatalogReadPersistenceUnavailable)(malformedError)).toBe(true);

      const unavailable = yield* persistenceFor({ unavailable: true });
      const unavailableError = yield* unavailable.current(currentInput).pipe(Effect.flip);
      expect(Schema.is(MarketCatalogReadPersistenceUnavailable)(unavailableError)).toBe(true);
    }),
  );

  it.effect('maps missing and cross-Tenant history to governed not-found failures', () =>
    Effect.gen(function* governedFailures() {
      const persistence = yield* persistenceFor({ missingHistory: true });
      const missing = yield* persistence.history(marketId);
      expect(Option.isNone(missing)).toBe(true);

      const unavailableServices: MarketCatalogReadPersistence = {
        current: () =>
          Effect.fail(
            new MarketCatalogReadPersistenceUnavailable({
              code: 'market_catalog_read_persistence_unavailable',
              reason: 'fixture unavailable',
            }),
          ),
        history: () => Effect.succeed(Option.none()),
      };
      const context = { readKey: 'market-catalog-owner-reads', scope, services: unavailableServices };
      const currentError = yield* handleCurrentMarketCatalog(currentInput, context).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerUnavailable)(currentError)).toBe(true);

      const foreignHistory = Schema.decodeUnknownSync(MarketHistoryRequestSchema)({
        marketRef: { ...historyInput.marketRef, tenantId: foreignTenantId },
      });
      const historyError = yield* handleMarketHistory(foreignHistory, context).pipe(Effect.flip);
      expect(Schema.is(ReadHandlerNotFound)(historyError)).toBe(true);
    }),
  );
});
