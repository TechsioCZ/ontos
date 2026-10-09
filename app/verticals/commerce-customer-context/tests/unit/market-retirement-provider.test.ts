import type { OperationalScope, ReadHandlerContext } from '@app/core-runtime';
import {
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  ScopedRoutineInvocationError,
  getVerticalRuntimeEntrypoints,
} from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import type {
  MarketAffectedUseAssessmentRequest,
  MarketAffectedUseAssessmentResponse,
  ReserveMarketRetirementPayload,
} from '@app/customer-market-retirement-contracts';
import {
  MarketAffectedUseAssessmentResponseSchema,
  MarketAffectedUseSourceEvidenceSchema,
} from '@app/customer-market-retirement-contracts';
import { DateTime, Effect, Match, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { reserveMarketRetirementAction } from '../../src/actions/reserve-market-retirement.action.ts';
import {
  handleMarketAffectedUseAssessment,
  makeMarketAffectedUseAssessmentServices,
} from '../../src/api/market-affected-use-assessment.read.ts';
import type {
  MarketAffectedUseAssessmentServices,
  MarketReferenceOwnerDeploymentStateAuthority,
} from '../../src/api/market-affected-use-assessment.read.ts';
import {
  MarketRetirementReservationConflictError,
  marketAffectedUseAssessmentRepositoryForInvoker,
  marketRetirementReservationForTransaction,
  marketRetirementRoutineAllowlist,
} from '../../src/persistence/market-retirement-persistence.ts';
import type {
  MarketAffectedUseAssessmentRepository as MarketAffectedUseAssessmentRepositoryContract,
  MarketRetirementScopedRoutineInvoker,
} from '../../src/persistence/market-retirement-persistence.ts';
import {
  MarketRetirementAssessmentStaleError,
  MarketRetirementAssessmentUnavailableError,
  MarketRetirementLiveReferenceConflictError,
  marketRetirementReservationServiceFromAuthorities,
} from '../../src/services/market-retirement-reservation.service.ts';
import type { MarketRetirementReservationService } from '../../src/services/market-retirement-reservation.service.ts';
import { commerceCustomerContextManifest } from '../../vertical.manifest.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const principalId = '33333333-3333-4333-8333-333333333333';
const marketRef = {
  moduleId: 'commerce.market-catalog',
  resourceId: 'market-cz',
  resourceType: 'commerce.market-catalog.market',
  tenantId,
} as const;
const evaluatedAt = '2026-09-22T10:00:00.000Z';
const observedAt = '2026-09-22T09:59:59.000Z';
const digest = 'a'.repeat(64);

const request: MarketAffectedUseAssessmentRequest = {
  evaluatedAt,
  marketRef,
  marketRevision: 7,
  tenantId,
};

const sourceEvidence = (sourceId: string, ownerRevision = 'revision-7') => ({
  completenessEvidence: {
    observedAt,
    ownerRevision,
    scope: {
      declaredScopeRef: `${sourceId}:all:${tenantId}`,
      kind: 'SAFELY_BROADER_SCOPE' as const,
      predicateRef: `${sourceId}:market:${marketRef.resourceId}`,
    },
  },
  currentness: 'CURRENT' as const,
  digest,
  generation: 'generation-7',
  ownerRevision,
  sourceId,
});

const decodedSourceEvidence = (sourceId: string, ownerRevision = 'revision-7') => {
  const encoded = sourceEvidence(sourceId, ownerRevision);
  return {
    ...encoded,
    completenessEvidence: Schema.decodeSync(MarketAffectedUseSourceEvidenceSchema)(encoded).completenessEvidence,
  };
};

const reservationAttribution = {
  actionInvocationId: '99999999-9999-4999-8999-999999999999',
  actorPrincipalId: principalId,
} as const;

const reservePayload: Extract<ReserveMarketRetirementPayload, { readonly operation: 'RESERVE' }> = {
  assessmentDigest: digest,
  evaluatedAt,
  marketRef,
  marketRevision: 7,
  operation: 'RESERVE',
  reason: 'Retire unused Czech Market',
  sourceEvidence: [decodedSourceEvidence('commerce.customer-context.market-bootstrap-policy')],
  tenantId,
};

const reservableAssessment: Extract<MarketAffectedUseAssessmentResponse, { readonly outcome: 'VERIFIED' }> = {
  assessmentDigest: digest,
  evaluatedAt,
  liveBlockingReferences: { bootstrapDefaults: [], currentProposals: [] },
  marketRef,
  marketRevision: 7,
  observedAt,
  outcome: 'VERIFIED',
  retainedHistoryReferences: [],
  sourceEvidence: reservePayload.sourceEvidence,
  tenantId,
};

const localAssessment: MarketAffectedUseAssessmentResponse = {
  assessmentDigest: digest,
  evaluatedAt,
  liveBlockingReferences: {
    bootstrapDefaults: [
      {
        kind: 'BOOTSTRAP_DEFAULT',
        marketRef,
        marketRevision: 7,
        ownerResourceRef: {
          moduleId: 'commerce.customer-context',
          resourceId: '44444444-4444-4444-8444-444444444444',
          resourceType: 'commerce.customer-context.market-bootstrap-policy',
          tenantId,
        },
        ownerResourceRevision: 'policy-revision-3',
      },
    ],
    currentProposals: [],
  },
  marketRef,
  marketRevision: 7,
  observedAt,
  outcome: 'VERIFIED',
  retainedHistoryReferences: [
    {
      kind: 'RETAINED_HISTORY',
      marketRef,
      marketRevision: 7,
      ownerResourceRef: {
        moduleId: 'commerce.customer-context',
        resourceId: '55555555-5555-4555-8555-555555555555',
        resourceType: 'commerce.customer-context.purchase-proposal-revision',
        tenantId,
      },
      ownerResourceRevision: 'proposal-revision-2',
    },
  ],
  sourceEvidence: [decodedSourceEvidence('commerce.customer-context.market-bootstrap-policy')],
  tenantId,
};

const scope = {
  authBindingId: '66666666-6666-4666-8666-666666666666',
  authContextRef: 'better-auth-session:market-retirement-test',
  authMethod: 'session',
  correlationId: 'market-retirement-correlation',
  legalEntityId,
  principalId,
  tenantId,
} satisfies OperationalScope & { readonly legalEntityId: string };

const context = (
  services: MarketAffectedUseAssessmentServices,
): ReadHandlerContext<MarketAffectedUseAssessmentServices> => ({
  readKey: 'commerce.customer-context.api.market-affected-use-assessment',
  scope,
  services,
});

const invokerReturning = (...results: readonly object[]): MarketRetirementScopedRoutineInvoker => ({
  invoke: (routine) =>
    Effect.forEach(results, (result) => Schema.decodeUnknownEffect(routine.resultSchema)(result), {
      concurrency: 1,
    }).pipe(Effect.orDie),
});

const invokerFailing = (failure: ScopedRoutineInvocationError): MarketRetirementScopedRoutineInvoker => ({
  invoke: () => Effect.fail(failure),
});

const reservationResult = {
  assessmentDigest: digest,
  lifecycle: 'RESERVED' as const,
  marketRef,
  marketRevision: 7,
  reservationToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  reservationVersion: 1,
  tenantId,
};

const reservationOperations = (calls: string[]) =>
  marketRetirementReservationForTransaction({
    invoke: (routine, values) => {
      calls.push(routine.routineKey);
      return invokerReturning({ result: reservationResult }).invoke(routine, values);
    },
  });

const assessmentServices = (
  repository: MarketAffectedUseAssessmentRepositoryContract,
  deploymentState: MarketReferenceOwnerDeploymentStateAuthority,
) => makeMarketAffectedUseAssessmentServices(repository.assess, deploymentState.proveReferenceOwnerStates);

it.effect('publishes the Market affected-use provider through the owner module contract', () =>
  Effect.gen(function* publishedProvider() {
    expect(commerceCustomerContextManifest.publicSurface.api).toHaveProperty('market-affected-use-assessment');
    const loadClient = getVerticalRuntimeEntrypoints(commerceCustomerContextRegistration).api[
      'market-affected-use-assessment'
    ];
    expect(loadClient).toBeTypeOf('function');
    const client = yield* Effect.promise(loadClient);
    expect('executeMarketAffectedUseAssessment' in client).toBe(true);
  }),
);

it('declares only the scoped affected-use and reservation routines', () => {
  expect(marketRetirementRoutineAllowlist.map(({ name, routineKey }) => [name, routineKey])).toEqual([
    ['assess_market_retirement_affected_use', 'market-retirement.assess-affected-use'],
    ['reserve_market_retirement', 'market-retirement.reserve'],
  ]);
  for (const routine of marketRetirementRoutineAllowlist) {
    expect(Object.isFrozen(routine)).toBe(true);
    expect(routine.ownerModuleKey).toBe('commerce.customer-context');
    expect(routine.parameters.slice(0, 2)).toEqual([
      { source: 'tenantId', type: 'uuid' },
      { source: 'legalEntityId', type: 'uuid' },
    ]);
  }
});

it.effect('returns owner-classified live and retained references with authoritative absent-owner proofs', () =>
  Effect.gen(function* assessedReferences() {
    expect(Schema.is(MarketAffectedUseAssessmentResponseSchema)(localAssessment)).toBe(true);
    const encodedLocalAssessment = yield* Schema.encodeEffect(MarketAffectedUseAssessmentResponseSchema)(
      localAssessment,
    );
    const calls: unknown[] = [];
    const repository = marketAffectedUseAssessmentRepositoryForInvoker({
      invoke: (routine, values) => {
        calls.push([routine.routineKey, values]);
        return invokerReturning({ result: encodedLocalAssessment }).invoke(routine, values);
      },
    });
    const cartProof = decodedSourceEvidence('application-composition:commerce.cart:UNIMPLEMENTED', 'composition-19');
    const orderProof = decodedSourceEvidence('application-composition:commerce.order:UNIMPLEMENTED', 'composition-19');
    const services = assessmentServices(repository, {
      proveReferenceOwnerStates: () => Effect.succeed({ sourceEvidence: [cartProof, orderProof] }),
    });

    const result = yield* services.assess(request);

    expect(result.outcome).toBe('VERIFIED');
    if (result.outcome !== 'VERIFIED') {
      return;
    }
    expect(result.assessmentDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.assessmentDigest).not.toBe(localAssessment.assessmentDigest);
    expect(result.liveBlockingReferences).toEqual(localAssessment.liveBlockingReferences);
    expect(result.retainedHistoryReferences).toEqual(localAssessment.retainedHistoryReferences);
    expect(result.sourceEvidence.map(({ sourceId }) => sourceId)).toEqual([
      'application-composition:commerce.cart:UNIMPLEMENTED',
      'application-composition:commerce.order:UNIMPLEMENTED',
      'commerce.customer-context.market-bootstrap-policy',
    ]);
    expect(calls).toEqual([['market-retirement.assess-affected-use', [marketRef.resourceId, 7n, evaluatedAt]]]);
  }),
);

it.effect('fails closed when authoritative deployment state cannot be proven', () =>
  Effect.gen(function* unavailableDeploymentState() {
    const services = assessmentServices(
      { assess: () => Effect.succeed(localAssessment) },
      {
        proveReferenceOwnerStates: () =>
          Effect.fail(
            new ReadHandlerUnavailable({
              code: 'read_handler_unavailable',
              reason: 'Application Composition evidence is unavailable',
            }),
          ),
      },
    );

    const failure = yield* services.assess(request).pipe(Effect.flip);

    expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
    expect(failure.reason).toContain('Application Composition');
  }),
);

it.effect('preserves typed rejected, unavailable, and stale owner outcomes without fabricating deployment proof', () =>
  Effect.gen(function* preservesOwnerOutcomes() {
    const outcomes: readonly MarketAffectedUseAssessmentResponse[] = [
      { ...request, code: 'live-reference', outcome: 'REJECTED', reason: 'A live Market reference exists' },
      {
        ...request,
        code: 'owner-unavailable',
        outcome: 'UNAVAILABLE',
        reason: 'Owner evidence is unavailable',
        retryable: true,
      },
      {
        ...request,
        code: 'stale-owner-evidence',
        observedAt,
        outcome: 'STALE',
        reason: 'Owner evidence changed',
        staleSourceIds: ['commerce.customer-context.purchase-proposals'],
      },
    ];
    let deploymentStateCalls = 0;
    yield* Effect.all(
      outcomes.map((outcome) =>
        Effect.gen(function* preservesOwnerOutcome() {
          const services = assessmentServices(
            { assess: () => Effect.succeed(outcome) },
            {
              proveReferenceOwnerStates: () => {
                deploymentStateCalls += 1;
                return Effect.succeed({ sourceEvidence: [] });
              },
            },
          );
          expect(yield* services.assess(request)).toEqual(outcome);
        }),
      ),
    );
    expect(deploymentStateCalls).toBe(0);
  }),
);

it.effect('rejects a cross-tenant affected-use read before owner persistence runs', () =>
  Effect.gen(function* rejectsCrossTenantRead() {
    let calls = 0;
    const failure = yield* handleMarketAffectedUseAssessment(
      {
        ...request,
        marketRef: { ...marketRef, tenantId: '88888888-8888-4888-8888-888888888888' },
        tenantId: '88888888-8888-4888-8888-888888888888',
      },
      context({
        assess: () => {
          calls += 1;
          return Effect.succeed(localAssessment);
        },
      }),
    ).pipe(Effect.flip);

    expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
    expect(calls).toBe(0);
  }),
);

it.effect('reassesses exact current affected-use evidence before reserving', () =>
  Effect.gen(function* reassessesBeforeReserve() {
    const persistenceCalls: string[] = [];
    const assessmentInputs: MarketAffectedUseAssessmentRequest[] = [];
    const service = marketRetirementReservationServiceFromAuthorities(
      {
        assess: (input) => {
          assessmentInputs.push(input);
          return Effect.succeed(reservableAssessment);
        },
      },
      reservationOperations(persistenceCalls),
      Effect.succeed(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-22T10:00:01.000Z'))),
    );

    expect(yield* service.execute(reservePayload, reservationAttribution)).toEqual(reservationResult);
    expect(assessmentInputs).toEqual([request]);
    expect(persistenceCalls).toEqual(['market-retirement.reserve']);
  }),
);

it.effect('rejects changed digest or source evidence before reservation persistence', () =>
  Effect.gen(function* rejectsChangedClaims() {
    const changedEvidence = decodedSourceEvidence('commerce.customer-context.market-bootstrap-policy', 'revision-8');
    const scenarios = [
      { ...reservableAssessment, assessmentDigest: 'b'.repeat(64) },
      { ...reservableAssessment, sourceEvidence: [changedEvidence] },
    ] satisfies readonly MarketAffectedUseAssessmentResponse[];

    for (const assessment of scenarios) {
      const persistenceCalls: string[] = [];
      const service = marketRetirementReservationServiceFromAuthorities(
        { assess: () => Effect.succeed(assessment) },
        reservationOperations(persistenceCalls),
        Effect.succeed(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-22T10:00:01.000Z'))),
      );

      const failure = yield* service.execute(reservePayload, reservationAttribution).pipe(Effect.flip);
      expect(Schema.is(MarketRetirementAssessmentStaleError)(failure)).toBe(true);
      expect(persistenceCalls).toHaveLength(0);
    }
  }),
);

it.effect('rejects a proof that expired after assessment but before reservation', () =>
  Effect.gen(function* rejectsExpiredProof() {
    const evidence = decodedSourceEvidence('commerce.customer-context.market-bootstrap-policy');
    const expiringEvidence = {
      ...evidence,
      completenessEvidence: {
        ...evidence.completenessEvidence,
        nextApplicabilityBoundary: DateTime.makeUnsafe('2026-09-22T10:00:00.500Z'),
      },
    };
    const expiringPayload = { ...reservePayload, sourceEvidence: [expiringEvidence] };
    const persistenceCalls: string[] = [];
    const service = marketRetirementReservationServiceFromAuthorities(
      { assess: () => Effect.succeed({ ...reservableAssessment, sourceEvidence: [expiringEvidence] }) },
      reservationOperations(persistenceCalls),
      Effect.succeed(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-22T10:00:01.000Z'))),
    );

    const failure = yield* service.execute(expiringPayload, reservationAttribution).pipe(Effect.flip);
    expect(Schema.is(MarketRetirementAssessmentStaleError)(failure)).toBe(true);
    expect(persistenceCalls).toHaveLength(0);
  }),
);

it.effect('maps rejected and unavailable reassessments to typed reservation failures', () =>
  Effect.gen(function* mapsReassessmentFailures() {
    const outcomes: readonly MarketAffectedUseAssessmentResponse[] = [
      { ...request, code: 'live-reference', outcome: 'REJECTED', reason: 'A live Market reference exists' },
      {
        ...request,
        code: 'owner-unavailable',
        outcome: 'UNAVAILABLE',
        reason: 'Owner evidence is unavailable',
        retryable: true,
      },
    ];
    const expectedTags = ['MarketRetirementLiveReferenceConflict', 'MarketRetirementAssessmentUnavailable'] as const;

    for (const [index, outcome] of outcomes.entries()) {
      const persistenceCalls: string[] = [];
      const service = marketRetirementReservationServiceFromAuthorities(
        { assess: () => Effect.succeed(outcome) },
        reservationOperations(persistenceCalls),
      );
      const failure = yield* service.execute(reservePayload, reservationAttribution).pipe(Effect.flip);
      const failureTag = Match.value(failure).pipe(
        Match.tag('MarketRetirementLiveReferenceConflict', () => 'MarketRetirementLiveReferenceConflict' as const),
        Match.tag('MarketRetirementAssessmentUnavailable', () => 'MarketRetirementAssessmentUnavailable' as const),
        Match.orElse(() => 'unexpected' as const),
      );
      expect(failureTag).toBe(expectedTags[index]);
      expect(persistenceCalls).toHaveLength(0);
    }
  }),
);

it.effect('does not reassess COMMIT or RELEASE operations', () =>
  Effect.gen(function* finishesWithoutReassessment() {
    const persistenceCalls: string[] = [];
    let assessmentCalls = 0;
    const service = marketRetirementReservationServiceFromAuthorities(
      {
        assess: () => {
          assessmentCalls += 1;
          return Effect.die('finish operation reached affected-use reassessment');
        },
      },
      reservationOperations(persistenceCalls),
    );
    const finishPayloads: readonly ReserveMarketRetirementPayload[] = [
      {
        marketRef,
        marketRevision: 7,
        operation: 'COMMIT',
        reason: 'Market retirement committed',
        reservationToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        reservationVersion: 1,
        tenantId,
      },
      {
        marketRef,
        marketRevision: 7,
        operation: 'RELEASE',
        reason: 'Market retirement released',
        reservationToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        reservationVersion: 1,
        tenantId,
      },
    ];

    yield* Effect.forEach(finishPayloads, (payload) => service.execute(payload, reservationAttribution), {
      concurrency: 1,
    });
    expect(assessmentCalls).toBe(0);
    expect(persistenceCalls).toEqual(['market-retirement.reserve', 'market-retirement.reserve']);
  }),
);

it.effect('maps concurrent affected-use change to a retryable reservation conflict', () =>
  Effect.gen(function* reservationConflict() {
    const payload: ReserveMarketRetirementPayload = {
      assessmentDigest: digest,
      evaluatedAt,
      marketRef,
      marketRevision: 7,
      operation: 'RESERVE',
      reason: 'Retire unused Czech Market',
      sourceEvidence: [decodedSourceEvidence('commerce.customer-context.market-bootstrap-policy')],
      tenantId,
    };
    const service = marketRetirementReservationForTransaction(
      invokerFailing(
        new ScopedRoutineInvocationError({
          code: 'scoped_routine_invocation_failed',
          constraint: Schema.decodeUnknownSync(Schema.OptionFromNullOr(Schema.String))(
            'market_retirement_reservation_conflict',
          ),
          ownerModuleKey: 'commerce.customer-context',
          postgresCode: Schema.decodeUnknownSync(Schema.OptionFromNullOr(Schema.String))('P0001'),
          reason: 'sanitized',
          routineKey: 'market-retirement.reserve',
        }),
      ),
    );

    const failure = yield* service
      .execute(payload, {
        actionInvocationId: '99999999-9999-4999-8999-999999999999',
        actorPrincipalId: principalId,
      })
      .pipe(Effect.flip);

    expect(Schema.is(MarketRetirementReservationConflictError)(failure)).toBe(true);
  }),
);

it.effect('binds a reservation to exact Market revision, assessment evidence, and Action attribution', () =>
  Effect.gen(function* exactReservationBinding() {
    const payload: ReserveMarketRetirementPayload = {
      assessmentDigest: digest,
      evaluatedAt,
      marketRef,
      marketRevision: 7,
      operation: 'RESERVE',
      reason: 'Retire unused Czech Market',
      sourceEvidence: [decodedSourceEvidence('commerce.customer-context.market-bootstrap-policy')],
      tenantId,
    };
    const result = {
      assessmentDigest: digest,
      lifecycle: 'RESERVED' as const,
      marketRef,
      marketRevision: 7,
      reservationToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      reservationVersion: 1,
      tenantId,
    };
    const invocations: unknown[] = [];
    const service = marketRetirementReservationForTransaction({
      invoke: (routine, values) => {
        invocations.push([routine.routineKey, values]);
        return invokerReturning({ result }).invoke(routine, values);
      },
    });

    expect(
      yield* service.execute(payload, {
        actionInvocationId: '99999999-9999-4999-8999-999999999999',
        actorPrincipalId: principalId,
      }),
    ).toEqual(result);
    expect(invocations).toEqual([
      [
        'market-retirement.reserve',
        [
          {
            ...payload,
            actionInvocationId: '99999999-9999-4999-8999-999999999999',
            actorPrincipalId: principalId,
            sourceEvidence: [sourceEvidence('commerce.customer-context.market-bootstrap-policy')],
          },
        ],
      ],
    ]);
  }),
);

it.effect('maps reassessment failures to governed Action conflict and unavailable codes', () =>
  Effect.gen(function* mapsGovernedFailureCodes() {
    const scenarios = [
      {
        code: 'ASSESSMENT_STALE',
        failure: new MarketRetirementAssessmentStaleError({ reason: 'Affected-use evidence changed' }),
        retryable: false,
      },
      {
        code: 'LIVE_REFERENCE_CONFLICT',
        failure: new MarketRetirementLiveReferenceConflictError({ reason: 'A live Market reference exists' }),
        retryable: false,
      },
      {
        code: 'ASSESSMENT_UNAVAILABLE',
        failure: new MarketRetirementAssessmentUnavailableError({ reason: 'Owner proof unavailable' }),
        retryable: true,
      },
    ] as const;
    const actionPrincipal = {
      authBindingId: scope.authBindingId,
      authContextRef: scope.authContextRef,
      authMethod: scope.authMethod,
      legalEntityId,
      principalId,
      tenantId,
    } as const;

    for (const [index, scenario] of scenarios.entries()) {
      const service: MarketRetirementReservationService = {
        execute: () => Effect.fail(scenario.failure),
      };
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        services: [bindActionTestServices(reserveMarketRetirementAction, service)],
      });
      const failure = yield* harness.runtime
        .runAction({
          payload: {
            ...reservePayload,
            sourceEvidence: [sourceEvidence('commerce.customer-context.market-bootstrap-policy')],
          },
          principal: actionPrincipal,
          registration: reserveMarketRetirementAction,
          transport: {
            correlationId: `market-retirement-reassessment-${index}`,
            idempotencyKey: `market-retirement-reassessment-${index}`,
          },
        })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ code: scenario.code, retryable: scenario.retryable });
      expect(harness.snapshot().committed).toHaveLength(0);
    }
  }),
);

it.effect('runs RESERVE, COMMIT, and RELEASE through the governed owner Action runtime', () =>
  Effect.gen(function* governedReservationLifecycle() {
    const reservationToken = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const governedReservePayload = {
      assessmentDigest: digest,
      evaluatedAt,
      marketRef,
      marketRevision: 7,
      operation: 'RESERVE' as const,
      reason: 'Retire unused Czech Market',
      sourceEvidence: [sourceEvidence('commerce.customer-context.market-bootstrap-policy')],
      tenantId,
    };
    const finishPayloads: readonly ReserveMarketRetirementPayload[] = [
      {
        marketRef,
        marketRevision: 7,
        operation: 'COMMIT',
        reason: 'Market retirement committed',
        reservationToken,
        reservationVersion: 1,
        tenantId,
      },
      {
        marketRef,
        marketRevision: 7,
        operation: 'RELEASE',
        reason: 'Market retirement released',
        reservationToken,
        reservationVersion: 1,
        tenantId,
      },
    ];
    const calls: {
      readonly attribution: { readonly actionInvocationId: string; readonly actorPrincipalId: string };
      readonly operation: ReserveMarketRetirementPayload['operation'];
    }[] = [];
    const service: MarketRetirementReservationService = {
      execute: (payload, attribution) => {
        calls.push({ attribution, operation: payload.operation });
        const lifecycle = Match.value(payload.operation).pipe(
          Match.when('RESERVE', () => 'RESERVED' as const),
          Match.when('COMMIT', () => 'COMMITTED' as const),
          Match.when('RELEASE', () => 'RELEASED' as const),
          Match.exhaustive,
        );
        return Effect.succeed({
          assessmentDigest: digest,
          lifecycle,
          marketRef,
          marketRevision: 7,
          reservationToken,
          reservationVersion: 1,
          tenantId,
        });
      },
    };
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      services: [bindActionTestServices(reserveMarketRetirementAction, service)],
    });
    const actionPrincipal = {
      authBindingId: scope.authBindingId,
      authContextRef: scope.authContextRef,
      authMethod: scope.authMethod,
      legalEntityId,
      principalId,
      tenantId,
    } as const;
    const payloads = [governedReservePayload, ...finishPayloads];
    const results = yield* Effect.forEach(
      payloads,
      (payload, index) =>
        harness.runtime.runAction({
          payload,
          principal: actionPrincipal,
          registration: reserveMarketRetirementAction,
          transport: {
            correlationId: `market-retirement-${payload.operation.toLowerCase()}`,
            idempotencyKey: `market-retirement-${index + 1}`,
          },
        }),
      { concurrency: 1 },
    );

    expect(results.map(({ lifecycle }) => lifecycle)).toEqual(['RESERVED', 'COMMITTED', 'RELEASED']);
    expect(calls.map(({ operation }) => operation)).toEqual(['RESERVE', 'COMMIT', 'RELEASE']);
    expect(calls.every(({ attribution }) => attribution.actorPrincipalId === principalId)).toBe(true);
    expect(
      calls.every(({ attribution }) => Schema.is(Schema.String.check(Schema.isUUID()))(attribution.actionInvocationId)),
    ).toBe(true);
    expect(harness.snapshot().committed).toHaveLength(3);
  }),
);

it.effect('rejects a cross-Tenant reservation before invoking owner persistence', () =>
  Effect.gen(function* crossTenantReservation() {
    let ownerCalls = 0;
    const service: MarketRetirementReservationService = {
      execute: () => {
        ownerCalls += 1;
        return Effect.die('cross-Tenant reservation reached owner persistence');
      },
    };
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      services: [bindActionTestServices(reserveMarketRetirementAction, service)],
    });
    const failure = yield* harness.runtime
      .runAction({
        payload: {
          assessmentDigest: digest,
          evaluatedAt,
          marketRef: { ...marketRef, tenantId: '88888888-8888-4888-8888-888888888888' },
          marketRevision: 7,
          operation: 'RESERVE',
          reason: 'Retire cross-Tenant Market',
          sourceEvidence: [sourceEvidence('commerce.customer-context.market-bootstrap-policy')],
          tenantId: '88888888-8888-4888-8888-888888888888',
        },
        principal: {
          authBindingId: scope.authBindingId,
          authContextRef: scope.authContextRef,
          authMethod: scope.authMethod,
          legalEntityId,
          principalId,
          tenantId,
        },
        registration: reserveMarketRetirementAction,
        transport: {
          correlationId: 'market-retirement-cross-tenant',
          idempotencyKey: 'market-retirement-cross-tenant',
        },
      })
      .pipe(Effect.flip);

    expect(Schema.is(reserveMarketRetirementAction.descriptor.domainErrorSchema)(failure)).toBe(true);
    expect(failure).toMatchObject({ code: 'SCOPE_MISMATCH' });
    expect(ownerCalls).toBe(0);
    expect(harness.snapshot().committed).toHaveLength(0);
  }),
);
