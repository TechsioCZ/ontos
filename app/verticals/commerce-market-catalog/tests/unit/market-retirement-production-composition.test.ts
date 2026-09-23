import type {
  MarketAffectedUseAssessmentResponse,
  MarketAffectedUseSourceEvidence,
} from '@app/customer-market-retirement-contracts/market-affected-use-assessment';
import { ReserveMarketRetirementPayloadSchema } from '@app/customer-market-retirement-contracts/reserve-market-retirement';
import type {
  ReserveMarketRetirementPayload,
  ReserveMarketRetirementResult,
} from '@app/customer-market-retirement-contracts/reserve-market-retirement';
import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { describe, expect, it } from 'effect-rstest';
import { ConfigProvider, DateTime, Effect, Predicate, Schema } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';

import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import type { ActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionHandler, getActionServiceFactory } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { RetireMarketPayloadSchema, retireMarketAction } from '../../src/actions/retire-market.action.ts';
import { MarketRetirementImpactAuthorityLive } from '../../src/integrations/market-retirement-impact.ts';
import type { MarketAdministrationService } from '../../src/services/market-administration.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const marketId = '22222222-2222-4222-8222-222222222222';
const definitionRevisionId = '33333333-3333-4333-8333-333333333333';
const sellerId = '44444444-4444-4444-8444-444444444444';
const principalId = '55555555-5555-4555-8555-555555555555';
const actionInvocationId = '66666666-6666-4666-8666-666666666666';
const ownerResourceId = '77777777-7777-4777-8777-777777777777';
const reservationToken = '88888888-8888-4888-8888-888888888888';
const effectiveAt = '2026-12-01T00:00:00.000Z';
const observedAt = '2026-11-30T23:59:59.000Z';
const nextApplicabilityBoundary = '2027-01-01T00:00:00.000Z';
const customerContextBaseUrl = 'https://customer-context.example.test/commerce-customer-context-api';
const shellGatewayBaseUrl = 'https://shell.example.test/shell-super-app-api';
const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: marketId,
  resourceType: 'commerce.market-catalog.market',
  tenantId,
} as const;
const ownerResourceRef = {
  moduleId: 'commerce.customer-context',
  resourceId: ownerResourceId,
  resourceType: 'commerce.customer-context.purchase-proposal-revision',
  tenantId,
} as const;
const scope = {
  authMethod: 'system' as const,
  correlationId: 'market-retirement-production-composition',
  legalEntityId: sellerId,
  principalId,
  tenantId,
};
const payload = Schema.decodeUnknownSync(RetireMarketPayloadSchema)({
  effectiveAt,
  expectedCurrentDefinitionRevisionRef: {
    moduleId: 'commerce.market-catalog',
    resourceId: definitionRevisionId,
    resourceType: 'commerce.market-catalog.market-definition-revision',
    tenantId,
  },
  expectedRevision: 3,
  marketRef,
  reason: 'Retire replaced Market.',
});

const ownerSourceEvidence = (digest: string): MarketAffectedUseSourceEvidence => ({
  completenessEvidence: {
    nextApplicabilityBoundary: DateTime.makeUnsafe(nextApplicabilityBoundary),
    observedAt: DateTime.makeUnsafe(observedAt),
    ownerRevision: `customer-context:${digest}`,
    scope: {
      kind: 'EXACT_PREDICATE',
      predicateRef: `market-retirement:${tenantId}:${marketId}:3`,
    },
  },
  currentness: 'CURRENT',
  digest,
  generation: `customer-context:g-${digest.slice(0, 4)}`,
  ownerRevision: `customer-context:${digest}`,
  sourceId: 'commerce.customer-context.market-bootstrap-policy',
});

const absentOwnerSourceEvidence = (
  moduleId: 'commerce.cart' | 'commerce.order',
  digest: string,
): MarketAffectedUseSourceEvidence => ({
  completenessEvidence: {
    nextApplicabilityBoundary: DateTime.makeUnsafe(nextApplicabilityBoundary),
    observedAt: DateTime.makeUnsafe(observedAt),
    ownerRevision: 'composition-revision-17',
    scope: {
      declaredScopeRef: 'application-composition:composition-revision-17',
      kind: 'SAFELY_BROADER_SCOPE',
      predicateRef: `application-composition:module:${moduleId}:absent`,
    },
  },
  currentness: 'CURRENT',
  digest,
  generation: 'composition-revision-17',
  ownerRevision: 'composition-revision-17',
  sourceId: `application-composition:${moduleId}:UNIMPLEMENTED`,
});

const compositionSourceIds = [
  'application-composition:commerce.cart:UNIMPLEMENTED',
  'application-composition:commerce.order:UNIMPLEMENTED',
] as const;
const reservationLifecycleByOperation = {
  COMMIT: 'COMMITTED',
  RELEASE: 'RELEASED',
  RESERVE: 'RESERVED',
} as const;

const verified = (
  digest: string,
  options: { readonly bootstrap?: boolean; readonly retained?: boolean } = {},
): Extract<MarketAffectedUseAssessmentResponse, { readonly outcome: 'VERIFIED' }> => ({
  assessmentDigest: digest,
  evaluatedAt: effectiveAt,
  liveBlockingReferences: {
    bootstrapDefaults:
      options.bootstrap === true
        ? [
            {
              kind: 'BOOTSTRAP_DEFAULT',
              marketRef,
              marketRevision: 3,
              ownerResourceRef,
              ownerResourceRevision: 'bootstrap:revision:9',
            },
          ]
        : [],
    currentProposals: [],
  },
  marketRef,
  marketRevision: 3,
  nextApplicabilityBoundary,
  observedAt,
  outcome: 'VERIFIED',
  retainedHistoryReferences:
    options.retained === true
      ? [
          {
            kind: 'RETAINED_HISTORY',
            marketRef,
            marketRevision: 3,
            ownerResourceRef,
            ownerResourceRevision: 'proposal:revision:4',
          },
        ]
      : [],
  sourceEvidence: [
    ownerSourceEvidence(digest),
    absentOwnerSourceEvidence('commerce.cart', '1'.repeat(64)),
    absentOwnerSourceEvidence('commerce.order', '2'.repeat(64)),
  ],
  tenantId,
});

type LifecycleTransition = Parameters<MarketAdministrationService['transitionLifecycle']>[0];
type RoutineDefinition = Parameters<ScopedTransactionExecutor['invoke']>[0];
interface ProductionRetirementTransaction {
  readonly invoke: (
    routine: RoutineDefinition,
    inputs: readonly LifecycleTransition[],
  ) => Effect.Effect<readonly { readonly payload: Readonly<Record<string, boolean | number | string>> }[]>;
}
type RetireMarketCollector = ActionCollector<typeof retireMarketAction.descriptor.domainEvents>;

const productionRetirementProgram = (transaction: ProductionRetirementTransaction, collector: RetireMarketCollector) =>
  Effect.gen(function* productionRetirement() {
    // @ts-expect-error Focused transaction mock implements only the Market lifecycle routine.
    const services = yield* getActionServiceFactory(retireMarketAction)(transaction, scope);
    return yield* getActionHandler(retireMarketAction)(payload, {
      actionInvocationId,
      addDomainEvent: collector.addDomainEvent,
      addOutboxMessage: collector.addOutboxMessage,
      recordAuditEvidence: collector.recordAuditEvidence,
      recordDataAccess: collector.recordDataAccess,
      scope,
      services,
    });
  });

const runProductionRetirement = (assessmentResponses: readonly MarketAffectedUseAssessmentResponse[]) => {
  const assessmentAuthorizationHeaders: string[] = [];
  const assessmentRequests: string[] = [];
  const gatewayRequests: string[] = [];
  const persistenceQueries: LifecycleTransition[] = [];
  const reservationAuthorizationHeaders: string[] = [];
  const reservationIdempotencyKeys: string[] = [];
  const reservationRequests: ReserveMarketRetirementPayload[] = [];
  let assessmentResponseIndex = 0;
  let reservedDigest: string | undefined;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith('/auth/gateway-context')) {
      gatewayRequests.push(url.toString());
      return Response.json({ expiresAt: 2_000_000_000, token: 'production-gateway-token' });
    }
    if (url.pathname.endsWith('/reads/market-affected-use-assessment')) {
      assessmentRequests.push(url.toString());
      assessmentAuthorizationHeaders.push(request.headers.get('authorization') ?? '');
      const response = assessmentResponses[Math.min(assessmentResponseIndex, assessmentResponses.length - 1)];
      assessmentResponseIndex += 1;
      return Response.json(response, { status: 200 });
    }
    if (url.pathname.endsWith('/commerce-customer-context/actions/reserve-market-retirement')) {
      reservationAuthorizationHeaders.push(request.headers.get('authorization') ?? '');
      reservationIdempotencyKeys.push(request.headers.get('idempotency-key') ?? '');
      const reservationPayload = Schema.decodeUnknownSync(ReserveMarketRetirementPayloadSchema)(await request.json());
      reservationRequests.push(reservationPayload);
      if (reservationPayload.operation === 'RESERVE') {
        reservedDigest = reservationPayload.assessmentDigest;
      }
      const result: ReserveMarketRetirementResult = {
        assessmentDigest: reservedDigest ?? '0'.repeat(64),
        lifecycle: reservationLifecycleByOperation[reservationPayload.operation],
        marketRef: reservationPayload.marketRef,
        marketRevision: reservationPayload.marketRevision,
        reservationToken,
        reservationVersion: reservationPayload.operation === 'RESERVE' ? 7 : 8,
        tenantId: reservationPayload.tenantId,
      };
      return Response.json(result, { status: 200 });
    }
    throw new Error(`Unexpected production client request: ${url.toString()}`);
  };
  const transaction: ProductionRetirementTransaction = {
    invoke: (_routine: RoutineDefinition, [input]: readonly LifecycleTransition[]) => {
      persistenceQueries.push(input);
      return Effect.succeed([
        {
          payload: {
            _tag: 'transitioned',
            changed: true,
            definitionRevisionId,
            generation: 4,
            lifecycle: 'RETIRED',
            revision: 4,
          },
        },
      ]);
    },
  };
  const collector = createActionCollector(
    retireMarketAction.descriptor.domainEvents,
    'commerce.market-catalog',
    retireMarketAction.descriptor.accessEvidencePolicy,
    retireMarketAction.descriptor.auditEvidenceSchema,
  );
  const program = productionRetirementProgram(transaction, collector).pipe(
    Effect.provide(MarketRetirementImpactAuthorityLive),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ONTOS_COMMERCE_CUSTOMER_CONTEXT_BASE_URL: customerContextBaseUrl,
          ONTOS_SHELL_GATEWAY_BASE_URL: shellGatewayBaseUrl,
        }),
      ),
    ),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );
  return {
    assessmentAuthorizationHeaders,
    assessmentRequests,
    collector,
    gatewayRequests,
    persistenceQueries,
    program,
    reservationAuthorizationHeaders,
    reservationIdempotencyKeys,
    reservationRequests,
  };
};

describe('Market retirement deployed production composition', () => {
  it.effect(
    'reserves through the published Customer Context client and persists its exact token, version, and digest',
    () => {
      const digest = 'a'.repeat(64);
      const execution = runProductionRetirement([verified(digest)]);
      return Effect.gen(function* safeRetirement() {
        const result = yield* execution.program;
        expect(result).toMatchObject({ changed: true, lifecycle: 'RETIRED', revision: 4 });
        expect(execution.gatewayRequests).toHaveLength(4);
        expect(execution.assessmentRequests).toHaveLength(2);
        expect(execution.assessmentAuthorizationHeaders).toEqual([
          'Bearer production-gateway-token',
          'Bearer production-gateway-token',
        ]);
        expect(execution.reservationAuthorizationHeaders).toEqual([
          'Bearer production-gateway-token',
          'Bearer production-gateway-token',
        ]);
        expect(execution.reservationIdempotencyKeys).toEqual([
          `${actionInvocationId}:reserve`,
          `${actionInvocationId}:commit`,
        ]);
        expect(execution.reservationRequests.map(({ operation }) => operation)).toEqual(['RESERVE', 'COMMIT']);
        const [reserveRequest, commitRequest] = execution.reservationRequests;
        expect(reserveRequest).toMatchObject({
          assessmentDigest: digest,
          marketRef,
          marketRevision: 3,
          operation: 'RESERVE',
          tenantId,
        });
        expect(
          reserveRequest?.operation === 'RESERVE' ? reserveRequest.sourceEvidence.map(({ sourceId }) => sourceId) : [],
        ).toEqual(['commerce.customer-context.market-bootstrap-policy', ...compositionSourceIds]);
        expect(commitRequest).toMatchObject({
          marketRef,
          marketRevision: 3,
          operation: 'COMMIT',
          reservationToken,
          reservationVersion: 7,
          tenantId,
        });
        expect(execution.persistenceQueries).toHaveLength(1);
        const [transition] = execution.persistenceQueries;
        expect(transition?.retirementImpactAssessment).toMatchObject({
          assessedMarketRevision: 3,
          assessmentDigest: digest,
          providers: [
            {
              liveBlockingReferences: { count: 0 },
              ownerRevision: digest,
              retainedHistoryEvidence: { count: 0 },
              versionToken: digest,
            },
          ],
          reservation: { token: reservationToken, version: 7 },
        });
        expect(execution.collector.snapshot().auditEvidence).toMatchObject({
          retirementImpactAssessment: transition?.retirementImpactAssessment,
        });
      });
    },
  );

  it.effect('rejects a live bootstrap reference before reserving or persisting', () => {
    const execution = runProductionRetirement([verified('b'.repeat(64), { bootstrap: true })]);
    return Effect.gen(function* liveReference() {
      const failure = yield* execution.program.pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'MarketCommandRejected')).toBe(true);
      expect(failure).toMatchObject({ code: 'replacement_impact_unresolved' });
      expect(execution.assessmentRequests).toHaveLength(1);
      expect(execution.reservationRequests).toHaveLength(0);
      expect(execution.persistenceQueries).toHaveLength(0);
    });
  });

  it.effect('keeps provider unavailability distinct and fails before reserving or persisting', () => {
    const execution = runProductionRetirement([
      {
        code: 'owner-unavailable',
        evaluatedAt: effectiveAt,
        marketRef,
        marketRevision: 3,
        outcome: 'UNAVAILABLE',
        reason: 'Customer Context is unavailable',
        retryable: true,
        tenantId,
      },
    ]);
    return Effect.gen(function* unavailableProvider() {
      const failure = yield* execution.program.pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'MarketRetirementImpactAssessmentUnavailable')).toBe(true);
      expect(execution.reservationRequests).toHaveLength(0);
      expect(execution.persistenceQueries).toHaveLength(0);
    });
  });

  it.effect('rejects stale owner evidence before reserving or persisting', () => {
    const execution = runProductionRetirement([
      {
        code: 'stale-owner-evidence',
        evaluatedAt: effectiveAt,
        marketRef,
        marketRevision: 3,
        observedAt,
        outcome: 'STALE',
        reason: 'Owner evidence changed',
        staleSourceIds: ['commerce.customer-context.market-bootstrap-policy'],
        tenantId,
      },
    ]);
    return Effect.gen(function* staleEvidence() {
      const failure = yield* execution.program.pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'MarketRetirementImpactAssessmentStale')).toBe(true);
      expect(execution.reservationRequests).toHaveLength(0);
      expect(execution.persistenceQueries).toHaveLength(0);
    });
  });

  it.effect('releases the owner reservation when a concurrent material reference appears', () => {
    const execution = runProductionRetirement([
      verified('c'.repeat(64)),
      verified('d'.repeat(64), { bootstrap: true }),
    ]);
    return Effect.gen(function* concurrentReference() {
      const failure = yield* execution.program.pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'MarketCommandRejected')).toBe(true);
      expect(failure).toMatchObject({ code: 'replacement_impact_unresolved' });
      expect(execution.assessmentRequests).toHaveLength(2);
      expect(execution.reservationRequests.map(({ operation }) => operation)).toEqual(['RESERVE', 'RELEASE']);
      expect(execution.reservationIdempotencyKeys).toEqual([
        `${actionInvocationId}:reserve`,
        `${actionInvocationId}:release`,
      ]);
      expect(execution.reservationRequests[1]).toMatchObject({
        operation: 'RELEASE',
        reservationToken,
        reservationVersion: 7,
      });
      expect(execution.persistenceQueries).toHaveLength(0);
    });
  });

  it.effect('treats retained history as non-blocking while retaining authoritative absence evidence', () => {
    const digest = 'e'.repeat(64);
    const execution = runProductionRetirement([verified(digest, { retained: true })]);
    return Effect.gen(function* retainedHistory() {
      yield* execution.program;
      expect(execution.assessmentRequests).toHaveLength(2);
      expect(execution.reservationRequests.map(({ operation }) => operation)).toEqual(['RESERVE', 'COMMIT']);
      const [transition] = execution.persistenceQueries;
      expect(transition?.retirementImpactAssessment).toMatchObject({
        assessmentDigest: digest,
        providers: [
          {
            liveBlockingReferences: { count: 0 },
            retainedHistoryEvidence: { count: 1 },
          },
        ],
        reservation: { token: reservationToken, version: 7 },
      });
      const [reserveRequest] = execution.reservationRequests;
      expect(
        reserveRequest?.operation === 'RESERVE' ? reserveRequest.sourceEvidence.map(({ sourceId }) => sourceId) : [],
      ).toEqual(['commerce.customer-context.market-bootstrap-policy', ...compositionSourceIds]);
      expect(execution.collector.snapshot().dataAccessEvents).toContainEqual(
        expect.objectContaining({
          queryHash: `market-retirement-impact:${marketId}:commerce.customer-context:${digest}:${digest}`,
          resultCount: 1,
        }),
      );
    });
  });
});
