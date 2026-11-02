import { randomUUID } from 'node:crypto';

import type { OutboxWorkerHandlerContext } from '@app/core-runtime';
import type {
  MarketAffectedUseAssessmentResponse,
  MarketAffectedUseSourceEvidence,
} from '@app/customer-market-retirement-contracts/market-affected-use-assessment';
import {
  MarketAffectedUseAssessmentResponseSchema,
  MarketAffectedUseSourceEvidenceSchema,
} from '@app/customer-market-retirement-contracts/market-affected-use-assessment';
import { ReserveMarketRetirementPayloadSchema } from '@app/customer-market-retirement-contracts/reserve-market-retirement';
import { ApiKeyGatewayContextRequestSchema } from '@app/shared-contracts';
import { describe, expect, it } from 'effect-rstest';
import { ConfigProvider, DateTime, Effect, Match, Option, Predicate, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { MarketCommandRejected } from '../../shared/action-contracts.ts';
import type { MarketRetirementFailureReason } from '../../shared/domain/market-retirement-intent.ts';
import { OutboxPayloadSchema } from '../../shared/outbox/commerce-market-catalog-market-retirement-requested-v1.ts';
import { MarketRetirementImpactAssessmentRejected } from '../../src/actions/market-retirement-impact-assessment-rejected.ts';
import { MarketRetirementImpactAssessmentStale } from '../../src/actions/market-retirement-impact-assessment-stale.ts';
import { MarketRetirementImpactAssessmentUnavailable } from '../../src/actions/market-retirement-impact-assessment-unavailable.ts';
import {
  marketRetirementIdempotencyKey,
  marketRetirementOutcome,
  nextMarketRetirementStep,
  terminalFailureReason,
} from '../../src/domain/market-retirement-workflow.ts';
import { makeMarketRetirementImpactAuthorityFromPublishedClient } from '../../src/integrations/market-retirement-impact.ts';
import { MarketAdministrationPersistenceUnavailable } from '../../src/persistence/market-administration-persistence.ts';
import { MarketRetirementIntentSnapshotSchema } from '../../src/persistence/market-retirement-intent-persistence.ts';
import type {
  MarketRetirementAdvanceCommand,
  MarketRetirementAdvanceOutcome,
  MarketRetirementIntentSnapshot,
} from '../../src/persistence/market-retirement-intent-persistence.ts';
import { MarketRetirementImpactAuthorityService } from '../../src/services/market-retirement-impact-authority.ts';
import {
  completeMarketRetirement,
  MarketRetirementIntentStoreService,
} from '../../src/services/market-retirement-worker.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const marketId = '22222222-2222-4222-8222-222222222222';
const definitionRevisionId = '33333333-3333-4333-8333-333333333333';
const sellerId = '44444444-4444-4444-8444-444444444444';
const principalId = '55555555-5555-4555-8555-555555555555';
const actionInvocationId = '66666666-6666-4666-8666-666666666666';
const intentId = '77777777-7777-4777-8777-777777777777';
const reservationToken = '88888888-8888-4888-8888-888888888888';
const ownerResourceId = '99999999-9999-4999-8999-999999999999';
const effectiveAt = '2026-12-01T00:00:00.000Z';
const observedAt = '2026-11-30T23:59:59.000Z';
const nextApplicabilityBoundary = '2027-01-01T00:00:00.000Z';
const compositionRevision = '9'.repeat(64);
const admittedApiBaseUrl = '/module-api/commerce.customer-context/release-a';
const shellGatewayBaseUrl = 'https://shell.example.test/shell-super-app-api';
const digest = 'a'.repeat(64);
const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: marketId,
  resourceType: 'commerce.market-catalog.market',
  tenantId,
} as const;
const reserveKey = `market-retirement:${intentId}:reserve`;
const commitKey = `market-retirement:${intentId}:commit`;

const sourceEvidence: MarketAffectedUseSourceEvidence = {
  completenessEvidence: {
    nextApplicabilityBoundary: DateTime.makeUnsafe(nextApplicabilityBoundary),
    observedAt: DateTime.makeUnsafe(observedAt),
    ownerRevision: 'owner:aaaa',
    scope: { kind: 'EXACT_PREDICATE', predicateRef: `market-retirement:${tenantId}:${marketId}:3` },
  },
  currentness: 'CURRENT',
  digest,
  generation: 'owner:aaaa',
  ownerRevision: 'owner:aaaa',
  sourceId: 'commerce.customer-context.market-bootstrap-policy',
};

const verified = (
  options: { readonly bootstrap?: boolean } = {},
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
              ownerResourceRef: {
                moduleId: 'commerce.customer-context',
                resourceId: ownerResourceId,
                resourceType: 'commerce.customer-context.market-bootstrap-policy',
                tenantId,
              },
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
  retainedHistoryReferences: [],
  sourceEvidence: [sourceEvidence],
  tenantId,
});

const requestedIntent = Schema.decodeUnknownSync(MarketRetirementIntentSnapshotSchema)({
  actingPrincipalId: principalId,
  actionInvocationId,
  effectiveAt,
  expectedDefinitionRevisionId: definitionRevisionId,
  expectedRevision: 3,
  intentId,
  legalEntityId: sellerId,
  marketId,
  reason: 'Retire replaced Market.',
  stage: 'REQUESTED',
  tenantId,
});

const payload = Schema.decodeUnknownSync(OutboxPayloadSchema)({
  legalEntityId: sellerId,
  marketRef,
  retirementIntentId: intentId,
});

const context: OutboxWorkerHandlerContext = {
  attemptNumber: 1,
  claimId: randomUUID(),
  compositionRevision,
  consumerModuleKey: 'commerce.market-catalog',
  correlationId: 'market-retirement-worker',
  deliveryId: randomUUID(),
  domainEventId: randomUUID(),
  legalEntityScope: 'required',
  messageId: randomUUID(),
  producerModuleKey: 'commerce.market-catalog',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'commerce.market-catalog.market-retirement-requested.v1',
  workerKey: 'commerce.market-catalog.complete-market-retirement',
};

const LocalTransitionSchema = Schema.Literals(['invalid_lifecycle_transition', 'revision_conflict', 'transitioned']);
type LocalTransition = typeof LocalTransitionSchema.Type;

const crash = () =>
  new MarketAdministrationPersistenceUnavailable({
    code: 'market_administration_persistence_unavailable',
    reason: 'Injected owner process stop',
  });

/**
 * In-memory owner store with the routine's compare-and-set semantics. `crashOn` makes the named stage change
 * fail once after the previous remote call succeeded, as a process stopping between remote and local commit.
 */
const makeStore = (
  options: {
    readonly crashOn?: MarketRetirementAdvanceCommand['operation'];
    readonly transition?: LocalTransition;
  } = {},
) => {
  let intent: MarketRetirementIntentSnapshot = requestedIntent;
  let crashOn: MarketRetirementAdvanceCommand['operation'] | null = options.crashOn ?? null;
  const operations: string[] = [];
  const transitioned = (): MarketRetirementIntentSnapshot => {
    const outcome = options.transition ?? 'transitioned';
    return outcome === 'transitioned'
      ? {
          ...intent,
          retiredDefinitionRevisionId: intent.expectedDefinitionRevisionId,
          retiredRevision: 4,
          stage: 'COMMIT_PENDING',
          transitionChanged: true,
        }
      : { ...intent, failureReason: outcome, stage: 'RELEASE_PENDING' };
  };
  const applied = (command: MarketRetirementAdvanceCommand): MarketRetirementIntentSnapshot =>
    Match.value(command).pipe(
      Match.discriminatorsExhaustive('operation')({
        RECORD_COMPLETED: (): MarketRetirementIntentSnapshot => ({ ...intent, stage: 'COMPLETED' }),
        RECORD_FAILED: ({ failureReason }): MarketRetirementIntentSnapshot => ({
          ...intent,
          failureReason: intent.failureReason ?? failureReason,
          stage: 'FAILED',
        }),
        RECORD_RELEASE_REQUIRED: ({ failureReason, retirementImpactAssessment }): MarketRetirementIntentSnapshot => ({
          ...intent,
          failureReason,
          retirementImpactAssessment,
          stage: 'RELEASE_PENDING',
        }),
        RECORD_RESERVATION: ({ retirementImpactAssessment }): MarketRetirementIntentSnapshot => ({
          ...intent,
          retirementImpactAssessment,
          stage: 'RESERVED',
        }),
        RECORD_RESERVATION_REQUEST: ({
          reservationRequest,
          retirementImpactAssessment,
        }): MarketRetirementIntentSnapshot => ({
          ...intent,
          reservationRequest,
          retirementImpactAssessment,
          stage: 'RESERVATION_REQUESTED',
        }),
        TRANSITION: transitioned,
      }),
    );
  const advance = (command: MarketRetirementAdvanceCommand): MarketRetirementAdvanceOutcome => {
    if (intent.stage !== command.expectedStage) {
      return { _tag: 'unchanged', intent };
    }
    operations.push(command.operation);
    intent = applied(command);
    return { _tag: 'advanced', intent };
  };
  const store = MarketRetirementIntentStoreService.of({
    advance: (_delivery, command) =>
      Effect.suspend(() => {
        if (crashOn === command.operation) {
          crashOn = null;
          return Effect.fail(crash());
        }
        return Effect.succeed(advance(command));
      }),
    read: () => Effect.sync(() => Option.some(intent)),
  });
  return { current: () => intent, operations, store };
};

const problem = (tag: string, status: number, code: string, invocationId?: string) =>
  Response.json(
    {
      _tag: tag,
      code,
      detail: tag,
      status,
      title: tag,
      type: 'about:blank',
      ...(invocationId === undefined
        ? { retryable: true }
        : { invocationId, resolution: 'REFRESH_GOVERNED_READS', retryCommand: false }),
    },
    { headers: { 'content-type': 'application/problem+json' }, status },
  );

interface FakeReservation {
  lifecycle: 'COMMITTED' | 'RELEASED' | 'RESERVED';
  version: number;
}

interface CustomerContextOptions {
  readonly assessment?: MarketAffectedUseAssessmentResponse;
  readonly commitUnavailable?: boolean;
  readonly gatewayCompositionRevision?: string;
}

/**
 * Customer Context behind its real published client, with Core's per-key Action idempotency: a replayed key
 * that already committed answers `action_already_committed` with the original invocation, never a new result.
 */
const makeCustomerContext = (options: CustomerContextOptions = {}) => {
  const committedKeys = new Map<string, string>();
  const requests: { readonly idempotencyKey: string; readonly operation: string }[] = [];
  const headers: { readonly authorization: string; readonly composition: string }[] = [];
  const gatewayAudiences: unknown[] = [];
  const reservation: FakeReservation = {
    lifecycle: 'RESERVED',
    version: 0,
  };
  const result = () =>
    Response.json({
      assessmentDigest: digest,
      lifecycle: reservation.lifecycle,
      marketRef,
      marketRevision: 3,
      reservationToken,
      reservationVersion: Math.max(reservation.version, 1),
      tenantId,
    });
  const ownerResponse = (url: URL, request: Request): Promise<Response> => {
    if (url.pathname.endsWith('/reads/market-affected-use-assessment')) {
      return Promise.resolve(
        Response.json(Schema.encodeSync(MarketAffectedUseAssessmentResponseSchema)(options.assessment ?? verified())),
      );
    }
    if (url.pathname.endsWith('/reads/market-retirement-reservation')) {
      requests.push({ idempotencyKey: '', operation: 'READ' });
      return Promise.resolve(result());
    }
    const idempotencyKey = request.headers.get('idempotency-key') ?? '';
    return request
      .json()
      .then(Schema.decodeUnknownSync(ReserveMarketRetirementPayloadSchema))
      .then((reservationPayload) => {
        requests.push({ idempotencyKey, operation: reservationPayload.operation });
        const committedInvocation = committedKeys.get(idempotencyKey);
        if (committedInvocation !== undefined) {
          return problem(
            'ReserveMarketRetirementActionAlreadyCommittedProblem',
            409,
            'action_already_committed',
            committedInvocation,
          );
        }
        if (reservationPayload.operation === 'COMMIT' && options.commitUnavailable === true) {
          return problem('ReserveMarketRetirementActionUnavailableProblem', 503, 'action_transaction_failed');
        }
        reservation.lifecycle = Match.value(reservationPayload.operation).pipe(
          Match.when('RESERVE', () => 'RESERVED' as const),
          Match.when('COMMIT', () => 'COMMITTED' as const),
          Match.when('RELEASE', () => 'RELEASED' as const),
          Match.exhaustive,
        );
        reservation.version += 1;
        committedKeys.set(idempotencyKey, randomUUID());
        return result();
      });
  };
  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname.endsWith('/auth/api-key/gateway-context')) {
      return request
        .json()
        .then(Schema.decodeUnknownSync(ApiKeyGatewayContextRequestSchema))
        .then((audience) => {
          gatewayAudiences.push(audience);
          return Response.json({
            apiBaseUrl: admittedApiBaseUrl,
            compositionRevision: options.gatewayCompositionRevision ?? compositionRevision,
            expiresAt: 2_000_000_000,
            token: 'production-gateway-token',
          });
        });
    }
    headers.push({
      authorization: request.headers.get('authorization') ?? '',
      composition: request.headers.get('x-ontos-composition-revision') ?? '',
    });
    return ownerResponse(url, request);
  };
  return {
    fetch,
    gatewayAudiences,
    headers,
    lifecycle: () => (reservation.version === 0 ? undefined : reservation.lifecycle),
    operations: () => requests.map(({ operation }) => operation),
    requests,
  };
};

const runWorker = (
  store: typeof MarketRetirementIntentStoreService.Service,
  fetch: typeof globalThis.fetch,
  finalAttempt = false,
) =>
  completeMarketRetirement({ delivery: { context, payload }, finalAttempt }).pipe(
    Effect.provideService(MarketRetirementIntentStoreService, store),
    Effect.provideService(
      MarketRetirementImpactAuthorityService,
      makeMarketRetirementImpactAuthorityFromPublishedClient(),
    ),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          ONTOS_COMMERCE_MARKET_CATALOG_GATEWAY_API_KEY: 'market-owner-api-key',
          ONTOS_SHELL_GATEWAY_BASE_URL: shellGatewayBaseUrl,
        }),
      ),
    ),
    Effect.provideService(FetchHttpClient.Fetch, fetch),
  );

const reservedIntent = Schema.decodeUnknownSync(MarketRetirementIntentSnapshotSchema)({
  ...Schema.encodeSync(MarketRetirementIntentSnapshotSchema)(requestedIntent),
  reservationRequest: {
    assessmentDigest: digest,
    evaluatedAt: effectiveAt,
    marketRef,
    marketRevision: 3,
    operation: 'RESERVE',
    reason: 'Retire replaced Market.',
    sourceEvidence: [Schema.encodeSync(MarketAffectedUseSourceEvidenceSchema)(sourceEvidence)],
    tenantId,
  },
  retirementImpactAssessment: {
    assessedMarketRef: marketRef,
    assessedMarketRevision: 3,
    assessmentDigest: digest,
    effectiveAt,
    providers: [],
    requiredProviderModuleKeys: ['commerce.customer-context'],
    reservation: { token: reservationToken, version: 1 },
  },
});

describe('Market retirement state machine', () => {
  it('maps every durable stage to exactly one next worker step', () => {
    expect(nextMarketRetirementStep(requestedIntent).kind).toBe('prepare_reservation');
    expect(nextMarketRetirementStep({ ...reservedIntent, stage: 'RESERVATION_REQUESTED' }).kind).toBe('reserve');
    expect(nextMarketRetirementStep({ ...reservedIntent, stage: 'RESERVED' }).kind).toBe('transition');
    expect(nextMarketRetirementStep({ ...reservedIntent, stage: 'COMMIT_PENDING' }).kind).toBe('commit');
    expect(
      nextMarketRetirementStep({ ...reservedIntent, failureReason: 'revision_conflict', stage: 'RELEASE_PENDING' })
        .kind,
    ).toBe('release');
    expect(nextMarketRetirementStep({ ...reservedIntent, stage: 'COMPLETED' }).kind).toBe('done');
    expect(nextMarketRetirementStep({ ...requestedIntent, stage: 'RESERVATION_REQUESTED' }).kind).toBe('invalid');
    expect(nextMarketRetirementStep({ ...requestedIntent, stage: 'COMMIT_PENDING' }).kind).toBe('invalid');
  });

  it('uses one stable idempotency key per intent and remote operation', () => {
    expect(marketRetirementIdempotencyKey(intentId, 'reserve')).toBe(reserveKey);
    expect(marketRetirementIdempotencyKey(intentId, 'commit')).toBe(commitKey);
    expect(marketRetirementIdempotencyKey(intentId, 'release')).toBe(`market-retirement:${intentId}:release`);
  });

  it('turns only definite owner outcomes into terminal reasons', () => {
    const cases: readonly [Parameters<typeof terminalFailureReason>[0], MarketRetirementFailureReason | null][] = [
      [
        new MarketCommandRejected({ code: 'replacement_impact_unresolved', reason: 'live' }),
        'replacement_impact_unresolved',
      ],
      [
        new MarketRetirementImpactAssessmentRejected({
          code: 'market_retirement_impact_assessment_rejected',
          reason: 'rejected',
        }),
        'impact_assessment_rejected',
      ],
      [
        new MarketRetirementImpactAssessmentStale({
          code: 'market_retirement_impact_assessment_stale',
          reason: 'stale',
        }),
        'impact_assessment_stale',
      ],
      [
        new MarketRetirementImpactAssessmentUnavailable({
          code: 'market_retirement_impact_assessment_unavailable',
          reason: 'unavailable',
        }),
        null,
      ],
    ];
    for (const [failure, reason] of cases) {
      expect(terminalFailureReason(failure) ?? null).toBe(reason);
    }
  });

  it('projects pending, completed, and failed public outcomes', () => {
    expect(marketRetirementOutcome(requestedIntent, marketRef)).toEqual({
      marketRef,
      outcome: 'pending',
      retirementIntentId: intentId,
      stage: 'REQUESTED',
    });
    expect(
      marketRetirementOutcome(
        {
          ...requestedIntent,
          retiredDefinitionRevisionId: requestedIntent.expectedDefinitionRevisionId,
          retiredRevision: 4,
          stage: 'COMPLETED',
          transitionChanged: true,
        },
        marketRef,
      ),
    ).toMatchObject({ changed: true, outcome: 'completed', revision: 4 });
    expect(
      marketRetirementOutcome({ ...requestedIntent, failureReason: 'revision_conflict', stage: 'FAILED' }, marketRef),
    ).toEqual({ marketRef, outcome: 'failed', reason: 'revision_conflict', retirementIntentId: intentId });
  });
});

describe('Market retirement owner worker', () => {
  it.effect('reserves, retires locally, and commits through the published client with stable keys', () =>
    Effect.gen(function* success() {
      const { current, operations, store } = makeStore();
      const customerContext = makeCustomerContext();
      const outcome = yield* runWorker(store, customerContext.fetch);
      expect(outcome).toMatchObject({ outcome: 'completed', retirementIntentId: intentId, revision: 4 });
      expect(operations).toEqual([
        'RECORD_RESERVATION_REQUEST',
        'RECORD_RESERVATION',
        'TRANSITION',
        'RECORD_COMPLETED',
      ]);
      expect(customerContext.requests).toEqual([
        { idempotencyKey: reserveKey, operation: 'RESERVE' },
        { idempotencyKey: commitKey, operation: 'COMMIT' },
      ]);
      expect(customerContext.lifecycle()).toBe('COMMITTED');
      // One fresh audience-scoped assertion per remote call, bound to the claimed composition revision.
      expect(customerContext.gatewayAudiences).toEqual(
        Array.from({ length: 3 }, () => ({
          audience: 'commerce-customer-context',
          compositionRevision,
          legalEntityId: sellerId,
        })),
      );
      expect(customerContext.headers).toEqual(
        Array.from({ length: 3 }, () => ({
          authorization: 'Bearer production-gateway-token',
          composition: compositionRevision,
        })),
      );
      expect(current().retirementImpactAssessment?.reservation).toEqual({ token: reservationToken, version: 1 });
    }),
  );

  it.effect('fails a retirement blocked by a live reference before any reservation', () =>
    Effect.gen(function* liveReference() {
      const { current, store } = makeStore();
      const customerContext = makeCustomerContext({ assessment: verified({ bootstrap: true }) });
      const outcome = yield* runWorker(store, customerContext.fetch);
      expect(outcome).toEqual({
        marketRef,
        outcome: 'failed',
        reason: 'replacement_impact_unresolved',
        retirementIntentId: intentId,
      });
      expect(customerContext.requests).toEqual([]);
      expect(current().stage).toBe('FAILED');
    }),
  );

  it.effect('fails stale owner evidence and retries unavailable evidence until the last attempt', () =>
    Effect.gen(function* assessmentFailures() {
      const stale = makeStore();
      const staleOutcome = yield* runWorker(
        stale.store,
        makeCustomerContext({
          assessment: {
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
        }).fetch,
      );
      expect(staleOutcome).toMatchObject({ outcome: 'failed', reason: 'impact_assessment_stale' });

      const unavailableAssessment: MarketAffectedUseAssessmentResponse = {
        code: 'owner-unavailable',
        evaluatedAt: effectiveAt,
        marketRef,
        marketRevision: 3,
        outcome: 'UNAVAILABLE',
        reason: 'Customer Context is unavailable',
        retryable: true,
        tenantId,
      };
      const unavailable = makeStore();
      const retried = yield* runWorker(
        unavailable.store,
        makeCustomerContext({ assessment: unavailableAssessment }).fetch,
      ).pipe(Effect.flip);
      expect(Predicate.isTagged(retried, 'MarketRetirementWorkerPending')).toBe(true);
      expect(unavailable.current().stage).toBe('REQUESTED');
      const exhausted = yield* runWorker(
        unavailable.store,
        makeCustomerContext({ assessment: unavailableAssessment }).fetch,
        true,
      );
      expect(exhausted).toMatchObject({ outcome: 'failed', reason: 'impact_assessment_unavailable' });
    }),
  );

  it.effect('releases a never-committed reservation when the local retirement is rejected', () =>
    Effect.gen(function* localRejection() {
      const { current, operations, store } = makeStore({ transition: 'revision_conflict' });
      const customerContext = makeCustomerContext();
      const outcome = yield* runWorker(store, customerContext.fetch);
      expect(outcome).toMatchObject({ outcome: 'failed', reason: 'revision_conflict' });
      expect(operations).toEqual(['RECORD_RESERVATION_REQUEST', 'RECORD_RESERVATION', 'TRANSITION', 'RECORD_FAILED']);
      expect(customerContext.operations()).toEqual(['RESERVE', 'RELEASE']);
      expect(customerContext.lifecycle()).toBe('RELEASED');
      expect(current().failureReason).toBe('revision_conflict');
    }),
  );

  it.effect('completes a crash after COMMIT on retry with the same key and never releases', () =>
    Effect.gen(function* crashAfterCommit() {
      const { current, store } = makeStore({ crashOn: 'RECORD_COMPLETED' });
      const customerContext = makeCustomerContext();
      const crashed = yield* runWorker(store, customerContext.fetch).pipe(Effect.flip);
      expect(Predicate.isTagged(crashed, 'MarketAdministrationPersistenceUnavailable')).toBe(true);
      expect(current().stage).toBe('COMMIT_PENDING');
      expect(customerContext.lifecycle()).toBe('COMMITTED');

      const outcome = yield* runWorker(store, customerContext.fetch);
      expect(outcome).toMatchObject({ outcome: 'completed' });
      expect(customerContext.requests).toEqual([
        { idempotencyKey: reserveKey, operation: 'RESERVE' },
        { idempotencyKey: commitKey, operation: 'COMMIT' },
        { idempotencyKey: commitKey, operation: 'COMMIT' },
      ]);
    }),
  );

  it.effect('recovers a crash after RESERVE through the reservation read instead of reserving twice', () =>
    Effect.gen(function* crashAfterReserve() {
      const { store } = makeStore({ crashOn: 'RECORD_RESERVATION' });
      const customerContext = makeCustomerContext();
      const crashed = yield* runWorker(store, customerContext.fetch).pipe(Effect.flip);
      expect(Predicate.isTagged(crashed, 'MarketAdministrationPersistenceUnavailable')).toBe(true);
      const outcome = yield* runWorker(store, customerContext.fetch);
      expect(outcome).toMatchObject({ outcome: 'completed' });
      expect(customerContext.operations()).toEqual(['RESERVE', 'RESERVE', 'READ', 'COMMIT']);
    }),
  );

  it.effect('keeps a retired Market pending while COMMIT is unavailable and never releases it', () =>
    Effect.gen(function* commitUnavailable() {
      const { current, store } = makeStore();
      const customerContext = makeCustomerContext({ commitUnavailable: true });
      const failure = yield* runWorker(store, customerContext.fetch, true).pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'MarketRetirementWorkerPending')).toBe(true);
      expect(current().stage).toBe('COMMIT_PENDING');
      expect(customerContext.operations()).toEqual(['RESERVE', 'COMMIT']);
    }),
  );

  it.effect('treats a duplicate delivery of a terminal intent as a no-op', () =>
    Effect.gen(function* duplicateDelivery() {
      const { operations, store } = makeStore();
      const customerContext = makeCustomerContext();
      yield* runWorker(store, customerContext.fetch);
      const before = customerContext.requests.length;
      const replay = yield* runWorker(store, customerContext.fetch);
      expect(replay).toMatchObject({ outcome: 'completed' });
      expect(customerContext.requests).toHaveLength(before);
      expect(operations).toHaveLength(4);
    }),
  );

  it.effect('rejects a gateway assertion for another composition revision before contacting the owner', () =>
    Effect.gen(function* compositionMismatch() {
      const { current, store } = makeStore();
      const customerContext = makeCustomerContext({ gatewayCompositionRevision: '8'.repeat(64) });
      const failure = yield* runWorker(store, customerContext.fetch).pipe(Effect.flip);
      expect(Predicate.isTagged(failure, 'MarketRetirementWorkerPending')).toBe(true);
      expect(customerContext.headers).toEqual([]);
      expect(current().stage).toBe('REQUESTED');
    }),
  );
});
