import {
  ActionAlreadyCommitted,
  ActionRuntime,
  ActionIdempotencyKeyRequired,
  ActionInvocationPersistenceError,
  ActionPermissionDenied,
  TrustedPrincipalContextSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import type { ActionAuthorizationPreflightInput } from '@app/core-runtime';
import type { ReservedMarketRetirementImpactAssessment } from '../../shared/domain/market-retirement-impact.ts';
import {
  ManageMarketRetirementAdmissionResultSchema,
  MarketRetirementReserveBasisSchema,
  mapMarketRetirementImpactRejectedProblem,
  mapMarketRetirementImpactStaleProblem,
} from '../../shared/market-retirement-admission.ts';
import type { MarketRetirementAdmissionEvidence } from '../../shared/market-retirement-admission.ts';
import type { MarketRetirementReservationRecoveryResponse } from '@app/customer-market-retirement-contracts/market-retirement-reservation-recovery';
import type { MarketAffectedUseAssessmentResponse } from '@app/customer-market-retirement-contracts/market-affected-use-assessment';
import { MarketAffectedUseAssessmentRequestSchema } from '@app/customer-market-retirement-contracts/market-affected-use-assessment';
import {
  ReserveMarketRetirementConflictProblemSchema,
  ReserveMarketRetirementForbiddenProblemSchema,
  ReserveMarketRetirementPayloadSchema,
} from '@app/customer-market-retirement-contracts/reserve-market-retirement';
import {
  ConfigProvider,
  Context,
  Crypto,
  DateTime,
  Effect,
  Layer,
  Match,
  Predicate,
  Redacted,
  Result,
  Schema,
} from 'effect';
import { FetchHttpClient } from 'effect/http';
import { describe, expect, it } from 'effect-rstest';
import { MarketRetirementActionRuntimeLive, MarketRetirementRuntimeBindings } from '../../api/index.ts';
import { retireMarketAction } from '../../src/actions/retire-market.action.ts';
import { MarketRetirementImpactAssessmentRejected } from '../../src/actions/market-retirement-impact-assessment-rejected.ts';
import {
  MarketRetirementPostAttempt,
  settleMarketRetirementAttempt,
} from '../../src/services/market-retirement-post-attempt.ts';
import { MarketRetirementImpactAssessmentUnavailable } from '../../src/actions/market-retirement-impact-assessment-unavailable.ts';
import { MarketRetirementImpactAssessmentStale } from '../../src/actions/market-retirement-impact-assessment-stale.ts';
import { MarketCommandRejected, RetireMarketPayloadSchema } from '../../shared/action-contracts.ts';
import {
  MarketRetirementImpactAuthorityLive,
  makeMarketRetirementImpactAuthority,
  makeMarketRetirementImpactAuthorityFromPublishedClient,
} from '../../src/integrations/market-retirement-impact.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const marketId = '22222222-2222-4222-8222-222222222222';
const sourceActionInvocationId = '33333333-3333-4333-8333-333333333333';
const legalEntityId = '44444444-4444-4444-8444-444444444444';
const principalId = '55555555-5555-4555-8555-555555555555';
const originalCompositionRevision = 'a'.repeat(64);
const compositionRevision = 'b'.repeat(64);
const releaseGuardHash = 'c'.repeat(64);
const releaseProof = '66666666-6666-4666-8666-666666666666';
const reservationToken = '77777777-7777-4777-8777-777777777777';
const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: marketId,
  resourceType: 'commerce.market-catalog.market',
  tenantId,
} as const;
const effectiveAt = '2026-12-01T00:00:00.000Z';
const payload = Schema.decodeUnknownSync(RetireMarketPayloadSchema)({
  effectiveAt,
  expectedCurrentDefinitionRevisionRef: {
    ...marketRef,
    resourceType: 'commerce.market-catalog.market-definition-revision',
  },
  expectedRevision: 3,
  marketRef,
  reason: 'Retire replaced Market.',
});
// Modeled carrier exercises pure adapter data flow only; it proves neither Core trust nor issuer acceptance.
const scope = trustVerifiedGatewayPrincipalContext(
  {
    ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
      authBindingId: releaseProof,
      authContextRef: 'session:original-actor',
      authMethod: 'session',
      legalEntityId,
      principalId,
      tenantId,
    }),
    correlationId: 'retirement-settlement-unit',
  },
  compositionRevision,
  { assertion: Redacted.make('fresh-original-actor-assertion'), audience: 'commerce-market-catalog' },
);
let sequence = 0;
const crypto = Crypto.make({
  digest: () => Effect.succeed(new Uint8Array()),
  randomBytes: (size) => {
    sequence += 1;
    return new Uint8Array(size).fill(sequence);
  },
});
const configuration = ConfigProvider.fromUnknown({
  ONTOS_GATEWAY_RELAY_API_KEY: 'relay-key',
  ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.example.test/shell-super-app-api',
});
const assessment = {
  assessedMarketRef: payload.marketRef,
  assessedMarketRevision: 3,
  assessmentDigest: 'd'.repeat(64),
  effectiveAt,
  providers: [],
  requiredProviderModuleKeys: [],
  reservation: { token: reservationToken, version: 1 },
};
// Immutable full owner response for the scripted protocol model, not live owner evidence.
const originalAssessment: Extract<MarketAffectedUseAssessmentResponse, { readonly outcome: 'VERIFIED' }> = {
  assessmentDigest: assessment.assessmentDigest,
  evaluatedAt: effectiveAt,
  liveBlockingReferences: { bootstrapDefaults: [], currentProposals: [] },
  marketRef,
  marketRevision: 3,
  observedAt: '2026-11-30T23:59:59.000Z',
  outcome: 'VERIFIED',
  retainedHistoryReferences: [],
  sourceEvidence: [
    {
      completenessEvidence: {
        observedAt: DateTime.makeUnsafe('2026-11-30T23:59:59.000Z'),
        ownerRevision: 'owner:17',
        scope: { kind: 'EXACT_PREDICATE', predicateRef: 'market:exact' },
      },
      currentness: 'CURRENT',
      digest: 'e'.repeat(64),
      generation: 'owner:g17',
      ownerRevision: 'owner:17',
      sourceId: 'commerce.customer-context.market-bootstrap-policy',
    },
  ],
  tenantId,
};
const found = (
  lifecycle: 'RESERVED' | 'COMMITTED' | 'RELEASED',
  actor = principalId,
): Extract<MarketRetirementReservationRecoveryResponse, { readonly outcome: 'FOUND' }> => ({
  actionInvocationId: '88888888-8888-4888-8888-888888888888',
  assessmentDigest: assessment.assessmentDigest,
  compositionRevision: originalCompositionRevision,
  evaluatedAt: effectiveAt,
  lifecycle,
  marketRef,
  marketRevision: 3,
  originalActorPrincipalId: actor,
  originalAssessment,
  originalLifecycle: 'RESERVED',
  originalReason: payload.reason,
  originalReservationVersion: 1,
  outcome: 'FOUND',
  releaseGuardHash,
  reservationToken,
  reservationVersion: lifecycle === 'RESERVED' ? 1 : 2,
  sourceActionInvocationId,
  sourceEvidence: originalAssessment.sourceEvidence,
  tenantId,
});
const authority = () =>
  makeMarketRetirementImpactAuthorityFromPublishedClient({
    compositionRevision,
    crypto,
    originalCompositionRevision,
    releaseGuardHash,
    retirement: payload,
    scope,
    sourceActionInvocationId,
  });
const modeledSettlementUnavailable = () =>
  new MarketRetirementImpactAssessmentUnavailable({
    code: 'market_retirement_impact_assessment_unavailable',
    reason: 'The modeled original settlement receipt is unavailable',
  });
const ScriptedRetirementRequestSchema = Schema.Union([
  ReserveMarketRetirementPayloadSchema,
  MarketAffectedUseAssessmentRequestSchema,
]);
type ScriptedRetirementRequest = typeof ScriptedRetirementRequestSchema.Type;
type ScriptedReservationRefusal =
  | typeof ReserveMarketRetirementConflictProblemSchema.Type
  | typeof ReserveMarketRetirementForbiddenProblemSchema.Type;
const scripted = (
  recover: () => MarketRetirementReservationRecoveryResponse,
  finish?: (request: Request, body: ScriptedRetirementRequest) => Response,
) => {
  const requests: Request[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    return request
      .clone()
      .json()
      .then((body) => {
        const path = new URL(request.url).pathname;
        if (path.endsWith('/auth/relay/gateway-context')) {
          return Response.json({
            apiBaseUrl: '/module-api/commerce.customer-context',
            compositionRevision,
            expiresAt: 2_000_000_000,
            token: 'actor-preserving-owner-token',
          });
        }
        if (path.endsWith('/reads/market-retirement-reservation-recovery')) {
          return Response.json(recover());
        }
        if (finish !== undefined) {
          return finish(request, Schema.decodeUnknownSync(ScriptedRetirementRequestSchema)(body));
        }
        return Response.json({ reason: 'Unexpected mutation' }, { status: 500 });
      });
  };
  return { fetch, requests };
};

const buildOwnerRuntime = Effect.fn('MarketRetirementTest.buildOwnerRuntime')(function* buildOwnerRuntime(
  bindings: (typeof MarketRetirementRuntimeBindings)['Service'],
) {
  const context = yield* Layer.build(
    MarketRetirementActionRuntimeLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(MarketRetirementRuntimeBindings, bindings),
          MarketRetirementImpactAuthorityLive.pipe(Layer.provide(Layer.succeed(Crypto.Crypto, crypto))),
        ),
      ),
    ),
  );
  return Context.get(context, ActionRuntime);
});

// Pure owner settlement model: scripted receipts/outcomes plus real published-client transport logic.
// No Core dispatch, admission, grant, execution lease, durable DB, or original-effect verification is proven.
const makeWorkflowFixture = Effect.fn('MarketRetirementTest.makeWorkflowFixture')(function* makeWorkflowFixture(
  initial: 'PENDING' | 'ABORTED' = 'PENDING',
) {
  const basisAssessment = yield* makeMarketRetirementImpactAuthority(() =>
    Effect.succeed(originalAssessment),
  ).assessRetirementImpact({
    actionInvocationId: sourceActionInvocationId,
    compositionRevision,
    effectiveAt,
    expectedMarketRevision: 3,
    legalEntityId,
    marketRef,
  });
  const basis = {
    assessment: basisAssessment,
    reserve: Schema.encodeSync(MarketRetirementReserveBasisSchema)({
      assessmentDigest: originalAssessment.assessmentDigest,
      evaluatedAt: originalAssessment.evaluatedAt,
      sourceEvidence: originalAssessment.sourceEvidence,
    }),
  };
  let ownerStatus: 'PENDING' | 'COMMITTED' | 'ABORTED' = initial;
  let remoteStatus: 'NOT_FOUND' | 'RESERVED' | 'COMMITTED' | 'RELEASED' = 'NOT_FOUND';
  let committedAssessment: ReservedMarketRetirementImpactAssessment = {
    ...assessment,
    requiredProviderModuleKeys: ['commerce.customer-context'],
  };
  let phase: 'outage' | 'unknown' | 'success' = 'outage';
  const operations: string[] = [];
  const modeledSourceKeys: (string | undefined)[] = [];
  const modeledManagementKeys: (string | undefined)[] = [];
  const reserveBodies: ScriptedRetirementRequest[] = [];
  const reserveKeys: (string | null)[] = [];
  let receivedReserveBody: string | undefined;
  let receivedReserveKey: string | null | undefined;
  let refusal: ScriptedReservationRefusal | undefined;
  let mismatchRecoveryAfterReserve = false;
  const recoveryObservations: {
    readonly outcome: MarketRetirementReservationRecoveryResponse['outcome'];
    readonly ownerState: MarketRetirementAdmissionEvidence['outcome'];
    readonly reservationAttempts: number;
    readonly sourceActionInvocationId: string;
  }[] = [];
  const originalResult = {
    changed: true,
    definitionRevisionRef: payload.expectedCurrentDefinitionRevisionRef,
    lifecycle: 'RETIRED' as const,
    marketRef: payload.marketRef,
    revision: 4,
  };
  const evidence = (revealAbortProof = true) => {
    const identity = {
      basis,
      compositionRevision,
      marketRef,
      releaseGuardHash,
      retirement: Schema.encodeSync(RetireMarketPayloadSchema)(payload),
      sourceActionInvocationId,
    };
    if (ownerStatus === 'COMMITTED') {
      return { ...identity, assessment: committedAssessment, outcome: 'COMMITTED', result: originalResult };
    }
    if (ownerStatus === 'ABORTED') {
      return revealAbortProof
        ? { ...identity, abortProof: releaseProof, outcome: 'ABORTED' }
        : { ...identity, outcome: 'ABORTED' };
    }
    return { ...identity, outcome: 'PENDING' };
  };
  const source: ActionAuthorizationPreflightInput = {
    actionInvocationId: sourceActionInvocationId,
    actionKey: retireMarketAction.descriptor.actionKey,
    correlationId: scope.correlationId,
    payload,
    principal: scope,
    scope,
  };
  type ModeledFailure = Parameters<(typeof MarketRetirementPostAttempt.Service)['decodeFailure']>[0];
  type ModeledOutcome = Parameters<typeof settleMarketRetirementAttempt>[0]['outcome'];
  const readReceipt = Effect.fn('PureRetirementTest.readReceipt')(function* readReceipt() {
    return yield* Schema.decodeUnknownEffect(ManageMarketRetirementAdmissionResultSchema)(evidence()).pipe(
      Effect.mapError(modeledSettlementUnavailable),
    );
  });
  const abort = Effect.fn('PureRetirementTest.abort')(function* abort() {
    modeledManagementKeys.push(`${sourceActionInvocationId}:admission:abort`);
    operations.push('ABORT');
    if (ownerStatus === 'PENDING') {
      ownerStatus = 'ABORTED';
    }
    return yield* readReceipt();
  });
  const authorityFor: typeof MarketRetirementPostAttempt.Service.authorityFor = (originalSource, receipt, retirement) =>
    makeMarketRetirementImpactAuthorityFromPublishedClient({
      basis: receipt.basis,
      compositionRevision,
      crypto,
      originalCompositionRevision: receipt.compositionRevision,
      releaseGuardHash: receipt.releaseGuardHash,
      retirement,
      scope: originalSource.scope,
      sourceActionInvocationId: originalSource.actionInvocationId,
    });
  const transport = scripted(
    () => {
      const recovered: MarketRetirementReservationRecoveryResponse =
        remoteStatus === 'NOT_FOUND'
          ? {
              marketRef,
              outcome: 'NOT_FOUND',
              sourceActionInvocationId:
                mismatchRecoveryAfterReserve && reserveBodies.length > 0 ? releaseProof : sourceActionInvocationId,
              tenantId,
            }
          : { ...found(remoteStatus), compositionRevision };
      recoveryObservations.push({
        outcome: recovered.outcome,
        ownerState: ownerStatus,
        reservationAttempts: reserveBodies.length,
        sourceActionInvocationId: recovered.sourceActionInvocationId,
      });
      return recovered;
    },
    (request, body) => {
      if (request.url.endsWith('/reads/market-affected-use-assessment')) {
        operations.push('ASSESS');
        return Response.json({
          assessmentDigest: assessment.assessmentDigest,
          evaluatedAt: effectiveAt,
          liveBlockingReferences: { bootstrapDefaults: [], currentProposals: [] },
          marketRef,
          marketRevision: 3,
          observedAt: '2026-11-30T23:59:59.000Z',
          outcome: 'VERIFIED',
          retainedHistoryReferences: [],
          sourceEvidence: found('RESERVED').sourceEvidence,
          tenantId,
        });
      }
      const parsed = Schema.decodeUnknownSync(
        Schema.Struct({ operation: Schema.Literals(['RESERVE', 'COMMIT', 'RELEASE']) }),
      )(body);
      operations.push(parsed.operation);
      if (parsed.operation === 'RESERVE') {
        reserveBodies.push(body);
        const key = request.headers.get('idempotency-key');
        reserveKeys.push(key);
        const encodedBody = JSON.stringify(Schema.encodeSync(ScriptedRetirementRequestSchema)(body));
        // Unit receiver retains the first received tuple even when the reservation rolls back.
        if (receivedReserveBody === undefined) {
          receivedReserveBody = encodedBody;
          receivedReserveKey = key;
        } else if (receivedReserveBody !== encodedBody || receivedReserveKey !== key) {
          return Response.json(
            { code: 'action_request_hash_conflict', reason: 'Original received tuple differs' },
            { status: 409 },
          );
        }
        if (refusal !== undefined) {
          return Response.json(refusal, {
            headers: { 'content-type': 'application/problem+json' },
            status: refusal.status,
          });
        }
        if (phase === 'outage') {
          return Response.json(
            { reason: 'Reservation rolled back after its invocation was received' },
            { status: 503 },
          );
        }
        remoteStatus = 'RESERVED';
      } else if (parsed.operation === 'COMMIT') {
        remoteStatus = 'COMMITTED';
      } else {
        remoteStatus = 'RELEASED';
      }
      return Response.json({ ...found(remoteStatus), compositionRevision });
    },
  );
  const run = Effect.fn('PureRetirementTest.runModeledAttempt')(function* run() {
    modeledSourceKeys.push('same-original-retirement');
    modeledManagementKeys.push(`${sourceActionInvocationId}:admission:prepare`);
    operations.push('PREPARE');
    let ownerFailure: ModeledFailure | undefined;
    const admission = yield* readReceipt();
    let outcome: ModeledOutcome;
    let originalFailure: ModeledFailure;
    if (admission.outcome === 'ABORTED') {
      const rejection = new MarketCommandRejected({
        code: 'invalid_lifecycle_transition',
        reason: 'The modeled original retirement is already aborted',
      });
      ownerFailure = rejection;
      originalFailure = rejection;
      outcome = { _tag: 'DefinitelyUncommitted', rejection };
    } else {
      const reservation = yield* authorityFor(source, admission, payload)
        .reserveRetirementImpact({
          actionInvocationId: sourceActionInvocationId,
          compositionRevision,
          effectiveAt,
          expectedMarketRevision: 3,
          legalEntityId,
          marketRef,
          reason: payload.reason,
        })
        .pipe(Effect.result);
      if (Result.isFailure(reservation)) {
        ownerFailure = reservation.failure;
        originalFailure = reservation.failure;
        outcome = { _tag: 'DefinitelyUncommitted', rejection: reservation.failure };
      } else if (phase === 'unknown') {
        originalFailure = new ActionInvocationPersistenceError({
          code: 'action_invocation_persistence_failed',
          reason: 'Modeled unknown original transaction outcome',
        });
        outcome = { _tag: 'Indeterminate' };
      } else {
        committedAssessment = reservation.success;
        ownerStatus = 'COMMITTED';
        originalFailure = new ActionAlreadyCommitted({
          code: 'action_already_committed',
          invocationId: sourceActionInvocationId,
          reason: 'Modeled original result acknowledgement lost',
        });
        outcome = { _tag: 'AlreadyCommitted' };
      }
    }
    const settlement = yield* settleMarketRetirementAttempt({
      actionInvocationId: sourceActionInvocationId,
      compositionRevision,
      outcome,
      payload,
      scope,
    }).pipe(
      Effect.provideService(MarketRetirementPostAttempt, {
        abort,
        authorityFor,
        decodeFailure: Effect.fail,
        readState: Effect.sync(() => ({ admission, admitted: source, ownerFailure })),
        recover: readReceipt,
        resolveOriginalSource: () => Effect.succeed(source),
        unavailable: modeledSettlementUnavailable,
      }),
    );
    return yield* Match.value(settlement).pipe(
      Match.tag('Recovered', ({ result }) => Effect.succeed(result)),
      Match.tag('Settled', () => Effect.fail(originalFailure)),
      Match.exhaustive,
    );
  });
  return {
    mismatchRecoveryAfterReserve: () => {
      mismatchRecoveryAfterReserve = true;
    },
    modeledManagementKeys,
    modeledSourceKeys,
    operations,
    phase: (next: typeof phase) => {
      phase = next;
    },
    recoveryObservations,
    refuse: (problem: ScriptedReservationRefusal) => {
      refusal = problem;
    },
    reserveBodies,
    reserveKeys,
    run: () =>
      run().pipe(
        Effect.provideService(FetchHttpClient.Fetch, transport.fetch),
        Effect.provide(ConfigProvider.layer(configuration)),
      ),
    status: () => ownerStatus,
  };
});

// These pure controls use generated HTTP clients with a scripted receiver. Modeled keys/receipts/outcomes
// are not Core idempotency, permissions, admission, immutable-effect verification, or native DB evidence.
describe('Market pure owner settlement and scripted transport (not Core authorization)', () => {
  it.effect('uses current transport R while retaining modeled original R and the original result', () =>
    Effect.gen(function* freshTransport() {
      const transport = scripted(() => found('COMMITTED'));
      yield* authority()
        .commitRetirementImpact({
          actionInvocationId: sourceActionInvocationId,
          assessment,
          compositionRevision,
          legalEntityId,
          reason: payload.reason,
        })
        .pipe(
          Effect.provideService(FetchHttpClient.Fetch, transport.fetch),
          Effect.provide(ConfigProvider.layer(configuration)),
        );
      expect(transport.requests).toHaveLength(2);
      const issuer = yield* Effect.fromNullishOr(transport.requests[0]);
      expect(yield* Effect.promise(() => issuer.json())).toMatchObject({
        compositionRevision,
        sourceAssertion: 'fresh-original-actor-assertion',
      });
      const recovery = yield* Effect.fromNullishOr(transport.requests[1]);
      expect(recovery.headers.get('x-ontos-composition-revision')).toBe(compositionRevision);
      expect(recovery.headers.get('authorization')).toBe('Bearer actor-preserving-owner-token');
      expect(yield* Effect.promise(() => recovery.json())).toEqual({ marketRef, sourceActionInvocationId, tenantId });
    }),
  );

  it.effect('rejects another original actor before any settlement mutation', () =>
    Effect.gen(function* rejectOtherActor() {
      const transport = scripted(() => found('RESERVED', releaseProof));
      const failure = yield* authority()
        .cleanupOriginal(releaseProof)
        .pipe(
          Effect.provideService(FetchHttpClient.Fetch, transport.fetch),
          Effect.provide(ConfigProvider.layer(configuration)),
          Effect.flip,
        );
      expect(Predicate.isTagged(failure, 'MarketRetirementImpactAssessmentUnavailable')).toBe(true);
      expect(transport.requests).toHaveLength(2);
    }),
  );

  it.effect(
    'keeps NOT_FOUND pending after ABORT and cleans a late original reservation with the same source correlation',
    () =>
      Effect.gen(function* lateReservation() {
        let late = false;
        let released = false;
        const transport = scripted(
          () =>
            late
              ? found(released ? 'RELEASED' : 'RESERVED')
              : { marketRef, outcome: 'NOT_FOUND', sourceActionInvocationId, tenantId },
          (request, body) => {
            expect(body).toMatchObject({
              operation: 'RELEASE',
              releaseProof,
              reservationToken,
              reservationVersion: 1,
            });
            expect(request.headers.get('idempotency-key')).toBe(`${sourceActionInvocationId}:release`);
            released = true;
            return Response.json({ reason: 'Lost original acknowledgement' }, { status: 503 });
          },
        );
        const first = yield* authority()
          .cleanupOriginal(releaseProof)
          .pipe(
            Effect.provideService(FetchHttpClient.Fetch, transport.fetch),
            Effect.provide(ConfigProvider.layer(configuration)),
            Effect.flip,
          );
        expect(Predicate.isTagged(first, 'MarketRetirementImpactAssessmentUnavailable')).toBe(true);
        expect(transport.requests.every((request) => !request.url.endsWith('/actions/reserve-market-retirement'))).toBe(
          true,
        );
        late = true;
        yield* authority()
          .cleanupOriginal(releaseProof)
          .pipe(
            Effect.provideService(FetchHttpClient.Fetch, transport.fetch),
            Effect.provide(ConfigProvider.layer(configuration)),
          );
        expect(released).toBe(true);
      }),
  );

  it.effect('retains the fence when the receiver denies RELEASE and recovery remains RESERVED', () =>
    Effect.gen(function* deniedReceiver() {
      const transport = scripted(
        () => found('RESERVED'),
        () => Response.json({ reason: 'Receiver denies current actor' }, { status: 403 }),
      );
      const failure = yield* authority()
        .cleanupOriginal(releaseProof)
        .pipe(
          Effect.provideService(FetchHttpClient.Fetch, transport.fetch),
          Effect.provide(ConfigProvider.layer(configuration)),
          Effect.flip,
        );
      expect(Predicate.isTagged(failure, 'MarketRetirementImpactAssessmentUnavailable')).toBe(true);
      expect(
        transport.requests.filter((request) => request.url.endsWith('/actions/reserve-market-retirement')),
      ).toHaveLength(1);
    }),
  );

  it.effect('propagates a modeled management denial without subsequent owner or provider effects', () =>
    Effect.gen(function* modeledManagementDenied() {
      const denied = new ActionPermissionDenied({
        code: 'action_permission_denied',
        reason: 'Modeled management executor denial; not a native grant check',
      });
      let subsequentEffects = 0;
      const source: ActionAuthorizationPreflightInput = {
        actionInvocationId: sourceActionInvocationId,
        actionKey: retireMarketAction.descriptor.actionKey,
        correlationId: scope.correlationId,
        payload,
        principal: scope,
        scope,
      };
      const unexpected = Effect.sync(() => {
        subsequentEffects += 1;
      }).pipe(Effect.andThen(Effect.die('A modeled management denial must prevent subsequent effects')));
      const failure = yield* settleMarketRetirementAttempt({
        actionInvocationId: sourceActionInvocationId,
        compositionRevision,
        outcome: { _tag: 'DefinitelyUncommitted' },
        payload,
        scope,
      }).pipe(
        Effect.provideService(MarketRetirementPostAttempt, {
          abort: () => unexpected,
          authorityFor: () => {
            subsequentEffects += 1;
            return authority();
          },
          decodeFailure: Effect.fail,
          readState: Effect.succeed({ admitted: source, ownerFailure: denied }),
          recover: () => unexpected,
          resolveOriginalSource: () => unexpected,
          unavailable: modeledSettlementUnavailable,
        }),
        Effect.flip,
      );
      expect(failure).toBe(denied);
      expect(subsequentEffects).toBe(0);
    }),
  );

  it.effect('recovers outage and unknown effects with the same original key while retaining the PENDING fence', () =>
    Effect.gen(function* originalRetry() {
      const fixture = yield* makeWorkflowFixture();
      const outage = yield* fixture.run().pipe(Effect.flip, Effect.provideService(Crypto.Crypto, crypto));
      expect(Predicate.isTagged(outage, 'MarketRetirementImpactAssessmentUnavailable')).toBe(true);
      expect(fixture.status()).toBe('PENDING');
      fixture.phase('unknown');
      const unknown = yield* fixture.run().pipe(Effect.flip, Effect.provideService(Crypto.Crypto, crypto));
      expect(Predicate.isTagged(unknown, 'ActionInvocationPersistenceError')).toBe(true);
      expect(fixture.status()).toBe('PENDING');
      expect(fixture.operations).not.toContain('ABORT');
      expect(fixture.operations).not.toContain('RELEASE');
      fixture.phase('success');
      const result = yield* fixture.run();
      expect(result).toMatchObject({ lifecycle: 'RETIRED', revision: 4 });
      expect(fixture.status()).toBe('COMMITTED');
      expect(new Set(fixture.modeledSourceKeys)).toEqual(new Set(['same-original-retirement']));
      expect(new Set(fixture.modeledManagementKeys)).toEqual(
        new Set([`${sourceActionInvocationId}:admission:prepare`]),
      );
      expect(fixture.operations).not.toContain('ASSESS');
      expect(fixture.reserveBodies).toHaveLength(2);
      expect(fixture.reserveBodies[1]).toEqual(fixture.reserveBodies[0]);
      expect(fixture.reserveKeys).toEqual([
        `${sourceActionInvocationId}:reserve`,
        `${sourceActionInvocationId}:reserve`,
      ]);
    }),
  );

  for (const code of [
    'ASSESSMENT_STALE',
    'LIVE_REFERENCE_CONFLICT',
    'RESERVATION_STATE_CONFLICT',
    'RETIREMENT_RESERVATION_CONFLICT',
  ] as const) {
    it.effect(`preserves definite ${code} after NOT_FOUND and fences ABORT with pending cleanup`, () =>
      Effect.gen(function* definiteReservationRejection() {
        const fixture = yield* makeWorkflowFixture();
        const refusal = ReserveMarketRetirementConflictProblemSchema.make({
          code,
          detail: `Customer Context rejected the original reservation: ${code}`,
          status: ReserveMarketRetirementConflictProblemSchema.fields.status.literal,
          title: 'Original reservation rejected',
          type: 'https://ontos.dev/problems/retirement-reservation-conflict',
        });
        fixture.refuse(refusal);

        const failure = yield* fixture.run().pipe(Effect.flip);
        const retirementSettlement = {
          pendingCleanup: true,
          resolution: 'RECOVER_ORIGINAL_EFFECT',
          retryCommand: false,
          sourceActionInvocationId,
          state: 'ABORTED',
        };
        if (code === 'ASSESSMENT_STALE') {
          const stale = yield* Schema.decodeUnknownEffect(MarketRetirementImpactAssessmentStale)(failure);
          expect(mapMarketRetirementImpactStaleProblem(stale)).toMatchObject({
            detail: stale.reason,
            retirementSettlement,
            status: 409,
          });
        } else {
          const rejected = yield* Schema.decodeUnknownEffect(MarketRetirementImpactAssessmentRejected)(failure);
          expect(mapMarketRetirementImpactRejectedProblem(rejected)).toMatchObject({
            detail: rejected.reason,
            retirementSettlement,
            status: 422,
          });
        }
        expect(fixture.status()).toBe('ABORTED');
        expect(fixture.operations).toEqual(['PREPARE', 'RESERVE', 'ABORT']);
        expect(fixture.recoveryObservations).toContainEqual({
          outcome: 'NOT_FOUND',
          ownerState: 'PENDING',
          reservationAttempts: 1,
          sourceActionInvocationId,
        });
        expect(fixture.recoveryObservations).toContainEqual({
          outcome: 'NOT_FOUND',
          ownerState: 'ABORTED',
          reservationAttempts: 1,
          sourceActionInvocationId,
        });
        expect(fixture.modeledSourceKeys).toEqual(['same-original-retirement']);
        expect(fixture.modeledManagementKeys).toEqual([
          `${sourceActionInvocationId}:admission:prepare`,
          `${sourceActionInvocationId}:admission:abort`,
        ]);
        expect(fixture.reserveKeys).toEqual([`${sourceActionInvocationId}:reserve`]);
      }),
    );
  }

  for (const refusal of [
    ReserveMarketRetirementForbiddenProblemSchema.make({
      code: 'action_permission_denied',
      detail: 'The original actor cannot prove the reservation effect',
      status: ReserveMarketRetirementForbiddenProblemSchema.fields.status.literal,
      title: 'Reservation permission denied',
      type: 'https://ontos.dev/problems/retirement-reservation-forbidden',
    }),
    ReserveMarketRetirementConflictProblemSchema.make({
      code: 'action_request_hash_conflict',
      detail: 'The original key belongs to another request hash',
      status: ReserveMarketRetirementConflictProblemSchema.fields.status.literal,
      title: 'Original request hash conflict',
      type: 'https://ontos.dev/problems/retirement-request-hash-conflict',
    }),
  ]) {
    it.effect(`keeps ${refusal.code} nonterminal after exact NOT_FOUND`, () =>
      Effect.gen(function* ambiguousReservationRefusal() {
        const fixture = yield* makeWorkflowFixture();
        fixture.refuse(refusal);
        const failure = yield* fixture.run().pipe(Effect.flip);

        expect(Predicate.isTagged(failure, 'MarketRetirementImpactAssessmentUnavailable')).toBe(true);
        expect(fixture.status()).toBe('PENDING');
        expect(fixture.operations).toEqual(['PREPARE', 'RESERVE']);
        expect(fixture.recoveryObservations).toContainEqual({
          outcome: 'NOT_FOUND',
          ownerState: 'PENDING',
          reservationAttempts: 1,
          sourceActionInvocationId,
        });
        expect(fixture.modeledSourceKeys).toEqual(['same-original-retirement']);
        expect(fixture.modeledManagementKeys).toEqual([`${sourceActionInvocationId}:admission:prepare`]);
      }),
    );
  }

  it.effect('keeps a mismatched NOT_FOUND nonterminal after a declared reservation rejection', () =>
    Effect.gen(function* wrongNegativeIdentity() {
      const fixture = yield* makeWorkflowFixture();
      fixture.refuse(
        ReserveMarketRetirementConflictProblemSchema.make({
          code: 'LIVE_REFERENCE_CONFLICT',
          detail: 'A current reference prevents this original reservation',
          status: ReserveMarketRetirementConflictProblemSchema.fields.status.literal,
          title: 'Original reservation rejected',
          type: 'https://ontos.dev/problems/retirement-reservation-conflict',
        }),
      );
      fixture.mismatchRecoveryAfterReserve();

      const failure = yield* fixture.run().pipe(Effect.flip);

      expect(Predicate.isTagged(failure, 'MarketRetirementImpactAssessmentUnavailable')).toBe(true);
      expect(fixture.status()).toBe('PENDING');
      expect(fixture.operations).toEqual(['PREPARE', 'RESERVE']);
      expect(fixture.recoveryObservations).toContainEqual({
        outcome: 'NOT_FOUND',
        ownerState: 'PENDING',
        reservationAttempts: 1,
        sourceActionInvocationId: releaseProof,
      });
      expect(fixture.modeledManagementKeys).toEqual([`${sourceActionInvocationId}:admission:prepare`]);
      expect(fixture.modeledSourceKeys).toEqual(['same-original-retirement']);
    }),
  );

  it.effect('never reopens or creates a new command for an irrevocably ABORTED original admission', () =>
    Effect.gen(function* abortedOriginal() {
      const fixture = yield* makeWorkflowFixture('ABORTED');
      const failure = yield* fixture.run().pipe(Effect.flip, Effect.provideService(Crypto.Crypto, crypto));
      expect(Predicate.isTagged(failure, 'MarketCommandRejected')).toBe(true);
      expect(failure).toMatchObject({
        retirementSettlement: { pendingCleanup: true, retryCommand: false, sourceActionInvocationId, state: 'ABORTED' },
      });
      expect(fixture.status()).toBe('ABORTED');
      expect(fixture.operations).toEqual(['PREPARE']);
      expect(fixture.modeledSourceKeys).toEqual(['same-original-retirement']);
    }),
  );

  for (const boundary of ['payload', 'idempotency'] as const) {
    it.effect(`preserves wrapper ${boundary} failure with a modeled runtime and no subsequent effects`, () =>
      Effect.gen(function* coreBoundary() {
        let managementCalls = 0;
        let continuationEffects = 0;
        const unexpectedContinuation = Effect.sync(() => {
          continuationEffects += 1;
        }).pipe(Effect.andThen(Effect.die('Early wrapper failure must not run settlement collaborators')));
        const runtime = yield* buildOwnerRuntime({
          base: {
            resolveActionCommit: () => Effect.die('Commit resolution must not run in this denial fixture'),
            runAction: () => {
              managementCalls += 1;
              return Effect.die('Management must not run');
            },
          },
          coreFactory: Layer.succeed(ActionRuntime, {
            resolveActionCommit: () => Effect.die('Commit resolution must not run in this denial fixture'),
            runAction: () =>
              Effect.fail(
                new ActionIdempotencyKeyRequired({
                  code: 'action_idempotency_key_required',
                  reason: 'Original key required',
                }),
              ),
          }),
          crypto,
          readRuntime: { runRead: () => Effect.die('Read must not run') },
          scopeResolver: { resolve: () => Effect.succeed(scope) },
        });
        const failure = yield* runtime
          .runAction({
            audience: 'commerce-market-catalog',
            payload: boundary === 'payload' ? {} : Schema.encodeSync(RetireMarketPayloadSchema)(payload),
            principal: scope,
            registration: retireMarketAction,
            transport: { correlationId: scope.correlationId },
          })
          .pipe(
            Effect.flip,
            Effect.provideService(Crypto.Crypto, crypto),
            // Generic ActionRuntimeService retains registration R. The wrapper binds its own
            // request-local value; these negative fault-injection ports must never be consumed.
            Effect.provideService(MarketRetirementPostAttempt, {
              abort: () => unexpectedContinuation,
              authorityFor: () => {
                continuationEffects += 1;
                return {
                  assessRetirementImpact: () => unexpectedContinuation,
                  cleanupOriginal: () => unexpectedContinuation,
                  commitRetirementImpact: () => unexpectedContinuation,
                  releaseRetirementImpact: () => unexpectedContinuation,
                  reserveRetirementImpact: () => unexpectedContinuation,
                };
              },
              decodeFailure: () => unexpectedContinuation,
              readState: unexpectedContinuation,
              recover: () => unexpectedContinuation,
              resolveOriginalSource: () => unexpectedContinuation,
              unavailable: () => {
                continuationEffects += 1;
                return modeledSettlementUnavailable();
              },
            }),
          );
        expect(
          Predicate.isTagged(
            failure,
            boundary === 'payload' ? 'ActionPayloadValidationError' : 'ActionIdempotencyKeyRequired',
          ),
        ).toBe(true);
        expect(managementCalls).toBe(0);
        expect(continuationEffects).toBe(0);
      }),
    );
  }

  it('retains the exact original effective instant', () =>
    expect(DateTime.formatIso(payload.effectiveAt)).toBe(effectiveAt));
});
