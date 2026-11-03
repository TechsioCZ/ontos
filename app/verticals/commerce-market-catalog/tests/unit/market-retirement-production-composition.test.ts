import {
  ActionAlreadyCommitted,
  ActionAuthorizationPreflight,
  ActionRuntime,
  ActionIdempotencyKeyRequired,
  ActionInvocationPersistenceError,
  ActionResultValidationError,
  ReadResultValidationError,
  ActionTransportMetadataSchema,
  ActionPermissionDenied,
  TrustedPrincipalContextSchema,
  trustVerifiedGatewayPrincipalContext,
} from '@app/core-runtime';
import type { ActionRuntimeService, ReadRuntimeService } from '@app/core-runtime';
import type { ReservedMarketRetirementImpactAssessment } from '../../shared/domain/market-retirement-impact.ts';
import { PreparedMarketRetirementImpact } from '../../src/services/market-retirement-admission.service.ts';
import {
  ManageMarketRetirementAdmissionPayloadSchema,
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
import { ConfigProvider, Context, Crypto, DateTime, Effect, Layer, Option, Predicate, Redacted, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { describe, expect, it } from 'effect-rstest';
import { MarketRetirementActionRuntimeLive, MarketRetirementRuntimeBindings } from '../../api/index.ts';
import { retireMarketAction } from '../../src/actions/retire-market.action.ts';
import { MarketRetirementImpactAssessmentRejected } from '../../src/actions/market-retirement-impact-assessment-rejected.ts';
import { MarketRetirementImpactAssessmentStale } from '../../src/actions/market-retirement-impact-assessment-stale.ts';
import { RetireMarketPayloadSchema } from '../../shared/action-contracts.ts';
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
// Verified-carrier fixture exercises the adapter only; it is not native issuer acceptance.
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

// Protocol model: real owner wrapper/clients, scripted persistence and receiver; no native DB claim.
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
  const sourceKeys: (string | undefined)[] = [];
  const managementKeys: (string | undefined)[] = [];
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
  const base: ActionRuntimeService = {
    resolveActionCommit: () => Effect.die('Commit resolution must not run in the scripted management model'),
    runAction: (request) =>
      Effect.gen(function* managementModel() {
        const command = yield* Schema.decodeUnknownEffect(ManageMarketRetirementAdmissionPayloadSchema)(
          request.payload,
        ).pipe(
          Effect.mapError(
            () => new ActionResultValidationError({ code: 'action_result_invalid', reason: 'Fixture command invalid' }),
          ),
        );
        managementKeys.push(Schema.decodeUnknownSync(ActionTransportMetadataSchema)(request.transport).idempotencyKey);
        operations.push(command.operation);
        if (command.operation === 'ABORT' && ownerStatus === 'PENDING') {
          ownerStatus = 'ABORTED';
        }
        const schema = Schema.make<Schema.ConstraintDecoder<typeof request.registration.descriptor.resultSchema.Type>>(
          request.registration.descriptor.resultSchema.ast,
        );
        return yield* Schema.decodeUnknownEffect(schema)(evidence(command.operation === 'ABORT')).pipe(
          Effect.mapError(
            () => new ActionResultValidationError({ code: 'action_result_invalid', reason: 'Fixture receipt invalid' }),
          ),
        );
      }),
  };
  const reads: ReadRuntimeService = {
    runRead: (request) => {
      const schema = Schema.make<Schema.ConstraintDecoder<typeof request.registration.descriptor.resultSchema.Type>>(
        request.registration.descriptor.resultSchema.ast,
      );
      return Schema.decodeUnknownEffect(schema)(evidence()).pipe(
        Effect.mapError(
          () => new ReadResultValidationError({ code: 'read_result_invalid', reason: 'Fixture receipt invalid' }),
        ),
      );
    },
  };
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
  const runtime = yield* buildOwnerRuntime({
    base,
    coreFactory: Layer.effect(
      ActionRuntime,
      ActionAuthorizationPreflight.pipe(
        Effect.map((preflight) => ({
          resolveActionCommit: () => Effect.die('Commit resolution must not run in the scripted parent model'),
          runAction: (request) =>
            Effect.gen(function* parentModel() {
              sourceKeys.push(
                Schema.decodeUnknownSync(ActionTransportMetadataSchema)(request.transport).idempotencyKey,
              );
              const admission = yield* preflight.prepare({
                actionInvocationId: sourceActionInvocationId,
                actionKey: retireMarketAction.descriptor.actionKey,
                correlationId: scope.correlationId,
                payload,
                principal: scope,
                scope,
              });
              if (admission.outcome !== 'allowed') {
                return yield* Effect.die('Fixture requires the exact owner permit');
              }
              yield* admission.permit.consume;
              const capability = yield* Effect.serviceOption(PreparedMarketRetirementImpact);
              if (Option.isNone(capability)) {
                return yield* Effect.die('The owner permit must install its prepared capability');
              }
              const prepared = yield* capability.value.take;
              if (phase === 'unknown') {
                return yield* new ActionInvocationPersistenceError({
                  code: 'action_invocation_persistence_failed',
                  reason: 'Unknown original transaction outcome',
                });
              }
              committedAssessment = prepared.assessment;
              ownerStatus = 'COMMITTED';
              return yield* new ActionAlreadyCommitted({
                code: 'action_already_committed',
                invocationId: sourceActionInvocationId,
                reason: 'Original result acknowledgement lost',
              });
            }),
        })),
      ),
    ),
    crypto,
    readRuntime: reads,
    scopeResolver: { resolve: () => Effect.succeed(scope) },
  });
  return {
    managementKeys,
    mismatchRecoveryAfterReserve: () => {
      mismatchRecoveryAfterReserve = true;
    },
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
      runtime
        .runAction({
          audience: 'commerce-market-catalog',
          payload: Schema.encodeSync(RetireMarketPayloadSchema)(payload),
          principal: scope,
          registration: retireMarketAction,
          transport: { correlationId: scope.correlationId, idempotencyKey: 'same-original-retirement' },
        })
        .pipe(
          Effect.provideService(FetchHttpClient.Fetch, transport.fetch),
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provide(ConfigProvider.layer(configuration)),
        ),
    sourceKeys,
    status: () => ownerStatus,
  };
});

// These controls use generated HTTP clients with a scripted receiver. Real DB/native proof is separate.
describe('Market original-effect settlement transport', () => {
  it.effect('uses fresh verified transport R while recovering immutable original R and the original result', () =>
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

  it.effect(
    'preserves the management Action explicit grant denial without attempting a receipt or foreign effect',
    () =>
      Effect.gen(function* managementGrantDenied() {
        const denied = new ActionPermissionDenied({
          code: 'action_permission_denied',
          reason: 'Management executor is absent',
        });
        let managementCalls = 0;
        const runtime = yield* buildOwnerRuntime({
          base: {
            resolveActionCommit: () => Effect.die('Commit resolution must not run in this denial fixture'),
            runAction: () => {
              managementCalls += 1;
              return Effect.fail(denied);
            },
          },
          coreFactory: Layer.effect(
            ActionRuntime,
            ActionAuthorizationPreflight.pipe(
              Effect.map((preflight) => ({
                resolveActionCommit: () => Effect.die('Commit resolution must not run in this denial fixture'),
                runAction: () =>
                  Effect.gen(function* ownerPreflight() {
                    const admission = yield* preflight.prepare({
                      actionInvocationId: sourceActionInvocationId,
                      actionKey: retireMarketAction.descriptor.actionKey,
                      correlationId: scope.correlationId,
                      payload,
                      principal: scope,
                      scope,
                    });
                    if (admission.outcome !== 'allowed') {
                      return yield* Effect.die('Expected the exact retirement permit');
                    }
                    yield* admission.permit.consume;
                    return yield* Effect.die('Management denial must prevent handler execution');
                  }),
              })),
            ),
          ),
          crypto,
          readRuntime: { runRead: () => Effect.die('Receipt must not be read after management denial') },
          scopeResolver: { resolve: () => Effect.succeed(scope) },
        });
        const failure = yield* runtime
          .runAction({
            audience: 'commerce-market-catalog',
            payload: Schema.encodeSync(RetireMarketPayloadSchema)(payload),
            principal: scope,
            registration: retireMarketAction,
            transport: { correlationId: scope.correlationId, idempotencyKey: 'original-retirement' },
          })
          .pipe(Effect.flip, Effect.provideService(Crypto.Crypto, crypto));
        expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
        expect(managementCalls).toBe(1);
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
      expect(new Set(fixture.sourceKeys)).toEqual(new Set(['same-original-retirement']));
      expect(new Set(fixture.managementKeys)).toEqual(new Set([`${sourceActionInvocationId}:admission:prepare`]));
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
        expect(fixture.sourceKeys).toEqual(['same-original-retirement']);
        expect(fixture.managementKeys).toEqual([
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
        expect(fixture.sourceKeys).toEqual(['same-original-retirement']);
        expect(fixture.managementKeys).toEqual([`${sourceActionInvocationId}:admission:prepare`]);
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
      expect(fixture.managementKeys).toEqual([`${sourceActionInvocationId}:admission:prepare`]);
      expect(fixture.sourceKeys).toEqual(['same-original-retirement']);
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
      expect(fixture.sourceKeys).toEqual(['same-original-retirement']);
    }),
  );

  for (const boundary of ['payload', 'idempotency'] as const) {
    it.effect(`preserves Core ${boundary} failure without management or provider effects`, () =>
      Effect.gen(function* coreBoundary() {
        let managementCalls = 0;
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
          .pipe(Effect.flip, Effect.provideService(Crypto.Crypto, crypto));
        expect(
          Predicate.isTagged(
            failure,
            boundary === 'payload' ? 'ActionPayloadValidationError' : 'ActionIdempotencyKeyRequired',
          ),
        ).toBe(true);
        expect(managementCalls).toBe(0);
      }),
    );
  }

  it('retains the exact original effective instant', () =>
    expect(DateTime.formatIso(payload.effectiveAt)).toBe(effectiveAt));
});
