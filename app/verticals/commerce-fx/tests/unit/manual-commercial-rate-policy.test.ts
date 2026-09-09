import { ScopedRoutineInvocationError } from '@app/core-runtime';
import type { ScopedRoutineDefinition, ScopedRoutineParameter } from '@app/core-runtime';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { getActionResourcePermissionTargetResolver } from '../../../../packages/core-runtime/src/actions/definition.ts';
import { expect, it } from 'effect-rstest';
import { DateTime, Effect, Option, Predicate, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { HttpClient } from 'effect/unstable/http';
import {
  convertCommercialFx,
  FxConversionResolvedSchema,
} from '../../shared/domain/commercial-fx-conversion.ts';
import { OutboxPayloadSchema } from '../../shared/outbox/commerce-fx-manual-commercial-rate-policy-changed-v1.ts';
import {
  ChangeManualCommercialRatePolicyPayloadSchema,
  ChangeManualCommercialRatePolicyResultSchema,
} from '../../shared/actions/change-manual-commercial-rate-policy.ts';
import {
  ManualFxPolicyRevisionSchema,
  ManualFxRatePolicyInvalid,
  validateManualFxRatePolicyCommand,
} from '../../shared/domain/manual-commercial-rate-policy.ts';
import type {
  ChangeManualFxRatePolicyCommand,
  ManualFxPolicyRevision,
} from '../../shared/domain/manual-commercial-rate-policy.ts';
import {
  changeManualCommercialRatePolicyAction,
  handleChangeManualCommercialRatePolicy,
} from '../../src/actions/change-manual-commercial-rate-policy.action.ts';
import {
  CommercialFxProviderQuoteRateNotConfigured,
  CommercialFxProviderQuoteRateService,
  CommercialFxProviderQuoteRateServiceLive,
} from '../../src/integrations/commercial-fx-provider/commercial-fx-provider-quote-rate.service.ts';
import {
  makeManualCommercialFxPorts,
  makeManualFxRatePolicyPersistence,
} from '../../src/persistence/manual-rate-policy-persistence.ts';
import type { CommerceFxScopedRoutineInvoker } from '../../src/persistence/manual-rate-policy-persistence.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '40000000-0000-4000-8000-000000000001';
const principalId = '50000000-0000-4000-8000-000000000001';
const actionInvocationId = '60000000-0000-4000-8000-000000000001';
const policyRevisionId = '70000000-0000-4000-8000-000000000001';

const command = {
  change: {
    arithmeticVersion: 'commercial-fx-arithmetic.v1',
    direction: 'SOURCE_TO_TARGET',
    effectiveFrom: '2024-09-09T00:00:00.000Z',
    effectiveTo: '2024-09-10T00:00:00.000Z',
    inverseRatePermitted: false,
    maximumRateAgeSeconds: 86_400,
    operation: 'SET',
    rate: '0.040000000000000001',
    rateObservedAt: '2024-09-09T08:00:00.000Z',
    rateSourceId: 'manual-contract-rate',
    roundingIncrement: '0.01',
    roundingMode: 'half-even',
    roundingRuleRevision: 'commercial-rounding-r1',
    sourceRevision: 'contract-2026-09-09-r1',
    targetMinorUnits: 2,
  },
  context: {
    channelId: 'web',
    marketId: 'cz',
    purpose: 'PURCHASE_LIMIT_COMPARISON',
    sourceCurrencyCode: 'CZK',
    storefrontId: 'akros-cz',
    targetCurrencyCode: 'EUR',
  },
  expectedRevision: 0,
  reason: 'Approved commercial conversion contract',
} satisfies ChangeManualFxRatePolicyCommand;

const revision: ManualFxPolicyRevision = {
  change: command.change,
  context: command.context,
  policyRevisionId,
  recordedAt: '2024-09-09T08:01:00.000Z',
  revision: 1,
  sellingLegalEntityId: legalEntityId,
  tenantId,
};

const scope = {
  authMethod: 'system' as const,
  correlationId: 'manual-fx-policy-test',
  legalEntityId,
  principalId,
  tenantId,
};

const routineFailure = (routineKey: string) =>
  new ScopedRoutineInvocationError({
    code: 'scoped_routine_result_invalid',
    constraint: Option.none(),
    ownerModuleKey: 'commerce.fx',
    postgresCode: Option.none(),
    reason: 'The test routine row did not satisfy its declared result schema',
    routineKey,
  });

const decodeRoutineRows = <
  RowSchema extends Schema.ConstraintDecoder<object>,
  const Parameters extends readonly ScopedRoutineParameter[],
>(
  routine: ScopedRoutineDefinition<RowSchema, Parameters>,
  rows: readonly object[],
): Effect.Effect<readonly RowSchema['Type'][], ScopedRoutineInvocationError> =>
  Schema.decodeUnknownEffect(Schema.Array(Schema.toType(routine.resultSchema)))(rows).pipe(
    Effect.mapError(() => routineFailure(routine.routineKey)),
  );

const TestRoutinePayloadSchema = Schema.Union([
  Schema.TaggedStruct('ACTION_INVOCATION_REUSED', { currentRevision: Schema.Int }),
  Schema.TaggedStruct('REVISION_CONFLICT', { currentRevision: Schema.Int }),
  Schema.TaggedStruct('SOURCE_REVISION_REUSED', { currentRevision: Schema.Int }),
  Schema.TaggedStruct('RESOLVED', { current: ManualFxPolicyRevisionSchema }),
  Schema.TaggedStruct('STALE', {}),
]);
type TestRoutinePayload = typeof TestRoutinePayloadSchema.Type;

const routineInvoker = (payload: TestRoutinePayload): CommerceFxScopedRoutineInvoker => ({
  invoke: (routine) => decodeRoutineRows(routine, [{ payload }]),
});

it('accepts only exact positive decimal rates and canonical bounded policy facts', () => {
  expect(Schema.decodeUnknownSync(ChangeManualCommercialRatePolicyPayloadSchema)(command)).toEqual(
    command,
  );
  for (const rate of ['0', '-1', '1e-3', '1.1234567890123456789']) {
    expect(
      Schema.is(ChangeManualCommercialRatePolicyPayloadSchema)({
        ...command,
        change: { ...command.change, rate },
      }),
    ).toBe(false);
  }
  expect(
    Schema.is(ChangeManualCommercialRatePolicyPayloadSchema)({
      ...command,
      context: { ...command.context, sourceCurrencyCode: 'czk' },
    }),
  ).toBe(false);
});

it('rejects future source evidence, invalid periods, and unapproved inverse facts', () => {
  const recordedAt = DateTime.makeUnsafe('2026-09-09T09:00:00.000Z');
  const future = validateManualFxRatePolicyCommand(
    {
      ...command,
      change: { ...command.change, rateObservedAt: '2026-09-09T09:00:00.001Z' },
    },
    recordedAt,
  );
  expect(Schema.is(ManualFxRatePolicyInvalid)(future)).toBe(true);
  expect(
    validateManualFxRatePolicyCommand(
      {
        ...command,
        change: {
          ...command.change,
          effectiveFrom: command.change.effectiveTo,
          effectiveTo: command.change.effectiveFrom,
        },
      },
      recordedAt,
    ),
  ).toBeDefined();
  expect(
    validateManualFxRatePolicyCommand(
      {
        ...command,
        change: {
          ...command.change,
          direction: 'TARGET_TO_SOURCE',
          inverseRatePermitted: false,
        },
      },
      recordedAt,
    ),
  ).toBeDefined();
  const overPrecisionIncrement = {
    ...command,
    change: { ...command.change, roundingIncrement: '0.001' },
  };
  expect(Schema.is(ChangeManualCommercialRatePolicyPayloadSchema)(overPrecisionIncrement)).toBe(
    false,
  );
  expect(
    Schema.is(ManualFxRatePolicyInvalid)(
      validateManualFxRatePolicyCommand(overPrecisionIncrement, recordedAt),
    ),
  ).toBe(true);
});

it('requires exact Action execution and Selling Legal Entity policy write authority', () => {
  expect(changeManualCommercialRatePolicyAction.descriptor).toMatchObject({
    actionKey: 'commerce.fx.change-manual-commercial-rate-policy',
    idempotency: 'required',
    legalEntityScope: 'required',
  });
  expect(
    getActionResourcePermissionTargetResolver(changeManualCommercialRatePolicyAction)?.(
      command,
      scope,
    ),
  ).toEqual({
    permission: 'write',
    resource: {
      moduleId: 'commerce.fx',
      resourceId: legalEntityId,
      resourceType: 'commerce.fx.manual-commercial-rate-policy',
    },
  });
});

it.effect('publishes one typed message only for a changed manual policy fact', () =>
  Effect.gen(function* changedOnlyOutbox() {
    yield* TestClock.setTime(Date.parse('2024-09-09T09:00:00.000Z'));
    const run = (changed: boolean) => {
      const collector = createActionCollector(
        changeManualCommercialRatePolicyAction.descriptor.domainEvents,
        'commerce.fx',
        changeManualCommercialRatePolicyAction.descriptor.accessEvidencePolicy,
        changeManualCommercialRatePolicyAction.descriptor.auditEvidenceSchema,
      );
      return handleChangeManualCommercialRatePolicy(command, {
        actionInvocationId,
        addDomainEvent: collector.addDomainEvent,
        addOutboxMessage: collector.addOutboxMessage,
        recordAuditEvidence: collector.recordAuditEvidence,
        recordDataAccess: collector.recordDataAccess,
        scope,
        services: { change: () => Effect.succeed({ changed, current: revision }) },
      }).pipe(Effect.as(collector));
    };

    const changedCollector = yield* run(true);
    expect(changedCollector.snapshot()).toMatchObject({
      auditEvidence: {
        operation: 'SET',
        reason: command.reason,
        sourceRevision: command.change.sourceRevision,
      },
    });
    expect(changedCollector.snapshot().domainEvents).toHaveLength(1);
    expect(changedCollector.snapshot().outboxMessages).toHaveLength(1);
    expect(changedCollector.snapshot().outboxMessages[0]?.message).toMatchObject({
      payloadJson: { changed: true, current: revision },
      topic: 'commerce.fx.manual-commercial-rate-policy-changed.v1',
    });

    const unchangedCollector = yield* run(false);
    expect(unchangedCollector.snapshot().domainEvents).toHaveLength(0);
    expect(unchangedCollector.snapshot().outboxMessages).toHaveLength(0);
  }),
);

it('keeps the public outbox exact, versioned, changed-only, and secret-free', () => {
  const payload = { changed: true as const, current: revision };
  expect(Schema.decodeUnknownSync(OutboxPayloadSchema)(payload)).toEqual(payload);
  expect(Schema.is(OutboxPayloadSchema)({ data: payload })).toBe(false);
  expect(Schema.is(OutboxPayloadSchema)({ changed: false, current: revision })).toBe(false);
  expect(JSON.stringify(payload)).not.toMatch(/credential|password|secret|token/iu);
});

it.effect('maps stale CAS and source revisions to explicit typed conflicts', () =>
  Effect.gen(function* typedConcurrencyConflicts() {
    for (const [tag, conflict] of [
      ['REVISION_CONFLICT', 'REVISION'],
      ['SOURCE_REVISION_REUSED', 'SOURCE_REVISION_REUSED'],
      ['ACTION_INVOCATION_REUSED', 'ACTION_INVOCATION_REUSED'],
    ] as const) {
      const persistence = yield* makeManualFxRatePolicyPersistence(
        routineInvoker({ _tag: tag, currentRevision: 4 }),
        scope,
      );
      const failure = yield* persistence
        .change(command, { actingPrincipalId: principalId, actionInvocationId })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ conflict, currentRevision: 4, expectedRevision: 0 });
    }
  }),
);

it.effect(
  'resolves the exact context and pins the exact immutable manual revision for quoting',
  () =>
    Effect.gen(function* exactManualPorts() {
      const trustedDecisionAt = DateTime.makeUnsafe('2024-09-09T08:30:00.000Z');
      const operationalRevision: ManualFxPolicyRevision = {
        ...revision,
        change: { ...command.change, rate: '0.04' },
      };
      const ports = makeManualCommercialFxPorts(
        routineInvoker({ _tag: 'RESOLVED', current: operationalRevision }),
        { legalEntityId, tenantId, trustedStorefrontId: 'akros-cz' },
        {
          resolveCurrent: (currentRequest) =>
            Effect.succeed({
              contextRevision: currentRequest.contextRevision,
              observedAt: trustedDecisionAt,
              purchasingContext: currentRequest.purchasingContext,
            }),
        },
      );
      const request = {
        contextRevision: 'context-r1',
        purchasingContext: {
          channelId: 'web',
          marketId: 'cz',
          sellingLegalEntityId: legalEntityId,
          storefrontId: 'akros-cz',
          tenantId,
        },
        purpose: 'PURCHASE_LIMIT_COMPARISON' as const,
        requestedAt: DateTime.makeUnsafe('2024-09-09T09:00:00.000Z'),
        sourceAmount: { amount: '100.00', currencyCode: 'CZK' },
        targetCurrencyCode: 'EUR',
      };
      const conversion = yield* convertCommercialFx(request, ports);
      const resolved = Schema.decodeUnknownSync(Schema.toType(FxConversionResolvedSchema))(
        conversion,
      );
      expect(resolved).toMatchObject({
        arithmeticVersion: 'commercial-fx-arithmetic.v1',
        decidedAt: trustedDecisionAt,
        normalizedRate: '0.04',
        policyRevision: policyRevisionId,
        providerCorrelationRef: `manual:${policyRevisionId}:contract-2026-09-09-r1`,
        purpose: 'PURCHASE_LIMIT_COMPARISON',
        quotedRate: '0.04',
        rateSourceId: 'manual-contract-rate',
        resultAmount: { amount: '4', currencyCode: 'EUR' },
        retrievedAt: trustedDecisionAt,
        roundingIncrement: '0.01',
        roundingMode: 'half-even',
        roundingRule: 'QUANTIZE_TO_INCREMENT',
        roundingRuleRevision: 'commercial-rounding-r1',
        targetMinorUnits: 2,
        validTo: DateTime.makeUnsafe('2024-09-10T00:00:00.000Z'),
      });

      const outside = makeManualCommercialFxPorts(
        routineInvoker({ _tag: 'RESOLVED', current: operationalRevision }),
        {
          legalEntityId,
          tenantId: '99999999-9999-4999-8999-999999999999',
          trustedStorefrontId: 'akros-cz',
        },
        {
          resolveCurrent: (currentRequest) =>
            Effect.succeed({
              contextRevision: currentRequest.contextRevision,
              observedAt: currentRequest.requestedAt,
              purchasingContext: currentRequest.purchasingContext,
            }),
        },
      );
      const denied = yield* outside.policy.resolve(request).pipe(Effect.flip);
      expect(Predicate.isTagged(denied, 'SOURCE_RESULT_INDETERMINATE')).toBe(true);

      const stale = makeManualCommercialFxPorts(
        routineInvoker({ _tag: 'STALE' }),
        { legalEntityId, tenantId, trustedStorefrontId: 'akros-cz' },
        {
          resolveCurrent: (currentRequest) =>
            Effect.succeed({
              contextRevision: currentRequest.contextRevision,
              observedAt: currentRequest.requestedAt,
              purchasingContext: currentRequest.purchasingContext,
            }),
        },
      );
      const staleFailure = yield* stale.policy.resolve(request).pipe(Effect.flip);
      expect(Predicate.isTagged(staleFailure, 'RATE_EXPIRED_OR_STALE')).toBe(true);
    }),
);

it('decodes the complete Action result and rejects invented fields', () => {
  const result = { changed: true, current: revision };
  expect(Schema.decodeUnknownSync(ChangeManualCommercialRatePolicyResultSchema)(result)).toEqual(
    result,
  );
  expect(() =>
    Schema.decodeUnknownSync(ChangeManualCommercialRatePolicyResultSchema, {
      onExcessProperty: 'error',
    })({ ...result, providerCredential: 'must-not-exist' }),
  ).toThrow();
});

it.effect('keeps the generated external provider explicit, typed, and fail-closed', () => {
  let providerRequests = 0;
  const httpClient = HttpClient.make(() => {
    providerRequests += 1;
    return Effect.die('An unconfigured provider must not receive an HTTP request');
  });
  const program = Effect.gen(function* unconfiguredExternalProvider() {
    const service = yield* CommercialFxProviderQuoteRateService;
    const failure = yield* service
      .quoteRate({
        policy: {
          arithmeticVersion: 'commercial-fx-arithmetic.v1',
          inverseRatePermitted: false,
          maximumRateAgeSeconds: 86_400,
          policyRevision: policyRevisionId,
          purpose: 'PURCHASE_LIMIT_COMPARISON',
          rateSourceId: 'external-provider',
          roundingIncrement: '0.01',
          roundingMode: 'half-even',
          roundingRule: 'QUANTIZE_TO_INCREMENT',
          roundingRuleRevision: 'commercial-rounding-r1',
          targetMinorUnits: 2,
        },
        request: {
          contextRevision: 'context-r1',
          purchasingContext: {
            channelId: 'web',
            marketId: 'cz',
            sellingLegalEntityId: legalEntityId,
            storefrontId: 'akros-cz',
            tenantId,
          },
          purpose: 'PURCHASE_LIMIT_COMPARISON',
          requestedAt: DateTime.makeUnsafe('2024-09-09T09:00:00.000Z'),
          sourceAmount: { amount: '100.00', currencyCode: 'CZK' },
          targetCurrencyCode: 'EUR',
        },
      })
      .pipe(Effect.flip);
    expect(Schema.is(CommercialFxProviderQuoteRateNotConfigured)(failure)).toBe(true);
    expect(failure).toMatchObject({
      code: 'external_fx_provider_not_configured',
      reason: 'No external Commercial FX provider route is configured',
    });
    expect(JSON.stringify(failure)).not.toMatch(/credential|password|secret|token/iu);
    expect(providerRequests).toBe(0);
  });
  return program.pipe(
    Effect.provide(CommercialFxProviderQuoteRateServiceLive),
    Effect.provideService(HttpClient.HttpClient, httpClient),
  );
});
