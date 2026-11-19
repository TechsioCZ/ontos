import type { OperationalScope } from '@app/core-runtime';
import {
  CallForbiddenSchema,
  CallNotFoundSchema,
  CallRejectedSchema,
  CallUnavailableSchema,
  RequestExecutionSchema,
  callOkSchema,
} from '@app/core-runtime/sdk';
import type { CallOutcome } from '@app/core-runtime/sdk';
import { makeExecutionStandIn } from '@app/core-runtime/testing/sdk';
import { CurrentPaymentTermsResponseSchema } from '@app/payment-term-catalog-contracts/current-payment-terms';
import type {
  CurrentPaymentTermsRequest,
  CurrentPaymentTermsResponse,
} from '@app/payment-term-catalog-contracts/current-payment-terms';
import { DateTime, Effect, Equal, Predicate, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import type { PaymentTermsResolutionRequest } from '../../shared/apis/payment-terms-resolution.ts';
import type { CustomerPaymentTermsState } from '../../shared/domain/payment-term-contracts.ts';
import type { PaymentTermsPolicyResolution } from '../../shared/domain/payment-terms.ts';
import { paymentTermsResolutionCalls, runPaymentTermsResolution } from '../../src/api/payment-terms-resolution.read.ts';
import type { PaymentTermsResolutionRunContext } from '../../src/api/payment-terms-resolution.read.ts';
import { paymentTermsResolutionSnapshotReader } from '../../src/persistence/payment-term-persistence.ts';
import type { CustomerPaymentTermsScopedRoutineInvoker } from '../../src/persistence/payment-term-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const at = '2026-10-01T00:00:00.000Z';
const profileRef = {
  moduleId: 'commerce.customer-context',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId,
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const paymentTermRef = {
  moduleId: 'payment.term-catalog',
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'payment.term-catalog.payment-term',
  tenantId,
} as const;
const provenance = {
  actionInvocationId: '88888888-8888-4888-8888-888888888888',
  actorPrincipalId: '99999999-9999-4999-8999-999999999999',
  at: '2026-01-01T00:00:00.000Z',
  reason: 'Catalog fixture',
} as const;
const catalogDefinition = {
  code: 'NET_30',
  compatibilityId: 'net-days.v1',
  created: provenance,
  definitionRevisionId: '77777777-7777-4777-8777-777777777777',
  description: 'Payment due 30 calendar days after invoice issue.',
  lifecycle: { effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveTo: null, state: 'ACTIVE' },
  metadataRevision: 1,
  name: 'Net 30',
  paymentTermRef,
  retired: null,
  semanticFingerprint: 'a'.repeat(64),
  semanticRevisionId: '77777777-7777-4777-8777-777777777778',
  semantics: {
    calculationRuleVersion: 2,
    calendarRule: 'CALENDAR_DAYS',
    days: 30,
    dueDateAnchor: 'INVOICE_ISSUE_DATE',
    kind: 'NET_DAYS',
  },
  updated: provenance,
} as const;
const request: PaymentTermsResolutionRequest = {
  at,
  authorizationSubject: { counterpartyRef, kind: 'COUNTERPARTY' },
  profileRef,
  purchasingContext: {
    channelId: 'b2b-web',
    contextRevision: 'context-1',
    marketId: 'cz',
    sellingLegalEntityId: legalEntityId,
    storefrontId: 'main',
  },
};
const scope = {
  authBindingId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  authContextRef: 'better-auth-session:payment-terms-run',
  authMethod: 'session',
  correlationId: 'payment-terms-run',
  legalEntityId,
  principalId: '55555555-5555-4555-8555-555555555555',
  tenantId,
  trustedStorefrontId: 'main',
} satisfies OperationalScope;
const state = (revision: number): CustomerPaymentTermsState => ({
  entitlements: [],
  preferences: [],
  profileRef,
  revision,
});
const resolvedPolicy: PaymentTermsPolicyResolution = {
  eligiblePaymentTermRefs: [paymentTermRef],
  explicitlyPermittedPaymentTermRefs: [],
  fallbackPaymentTermRefs: [paymentTermRef],
  policyRevision: 'PAYMENT_TERM:7',
  policySource: 'commerce.customer-context/payment-term-policy-current',
};

/** The owner routine answers the profile's Payment Terms state with the given revision. */
const invokerReturning = (revision: number): CustomerPaymentTermsScopedRoutineInvoker => ({
  invoke: (routine) =>
    Schema.decodeUnknownEffect(Schema.toType(routine.resultSchema))({
      current_revision: revision,
      outcome: 'PRESENT',
      payload: state(revision),
    }).pipe(
      Effect.map((row) => [row]),
      Effect.orDie,
    ),
});

type CatalogAnswer = (payload: CurrentPaymentTermsRequest) => Effect.Effect<CallOutcome<CurrentPaymentTermsResponse>>;
const usableCatalog: CatalogAnswer = (payload) =>
  Effect.succeed(
    callOkSchema(CurrentPaymentTermsResponseSchema).make({
      value: Schema.decodeUnknownSync(CurrentPaymentTermsResponseSchema)({
        current: [catalogDefinition],
        effectiveAt: payload.at,
        observedAt: payload.at,
        referenceOutcomes: [{ definition: catalogDefinition, kind: 'USABLE', requestedPaymentTermRef: paymentTermRef }],
        truncated: false,
      }),
    }),
  );
const noCatalog: CatalogAnswer = () => Effect.die('the Catalog must not be called');

/**
 * Drives the read's `run` with Core's capability stand-ins (a call while a transaction is open dies) and
 * the read's real snapshot reader over a scripted owner routine and policy, one per transaction.
 */
const harness = (input: {
  readonly answer?: CatalogAnswer;
  readonly policy?: (sequence: number) => PaymentTermsPolicyResolution;
  readonly revision?: (sequence: number) => number;
}) => {
  const standIn = makeExecutionStandIn(paymentTermsResolutionCalls, {
    answers: { currentPaymentTerms: input.answer ?? noCatalog },
    operationAt: DateTime.makeUnsafe(at),
    services: (sequence) => ({
      readSnapshot: paymentTermsResolutionSnapshotReader(
        { invoker: invokerReturning(input.revision?.(sequence) ?? 1), scope },
        { resolve: () => Effect.succeed(input.policy?.(sequence) ?? resolvedPolicy) },
      ),
    }),
  });
  const context: PaymentTermsResolutionRunContext = {
    access: {},
    call: standIn.call,
    execution: {
      compositionRevision: 'composition-revision-1',
      identity: RequestExecutionSchema.make({ via: 'person' }),
      operationKey: 'commerce.customer-context.api.payment-terms-resolution',
      owningModuleKey: 'commerce.customer-context',
    },
    readKey: 'commerce.customer-context.api.payment-terms-resolution',
    scope,
    transaction: standIn.transaction,
  };
  return {
    calledWith: () => standIn.steps.flatMap((step) => (step.kind === 'call' ? [step.input] : [])),
    context,
    steps: () => standIn.steps.map((step) => step.kind),
  };
};

const atResolutionInstant = TestClock.setTime(Date.parse(at));

it.effect('calls the Catalog only between the snapshot and the recheck transactions, never inside one', () =>
  Effect.gen(function* callOutsideTransaction() {
    yield* atResolutionInstant;
    const fixture = harness({ answer: usableCatalog });
    const handled = yield* runPaymentTermsResolution(request, fixture.context);

    expect(Predicate.isTagged(handled.result, 'POLICY_FALLBACK')).toBe(true);
    if (Predicate.isTagged(handled.result, 'POLICY_FALLBACK')) {
      expect(handled.result.definition.paymentTermRef).toEqual(paymentTermRef);
      expect(handled.result.policyRevision).toBe('PAYMENT_TERM:7');
      expect(handled.result.purchasingContextRevision).toBe('context-1');
    }
    expect(handled.evidence).toEqual({ resultCount: 1 });
    expect(fixture.steps()).toEqual(['begin', 'end', 'call', 'begin', 'end']);
    expect(fixture.calledWith()).toEqual([{ at, limit: 1, references: [{ paymentTermRef }] }]);
  }),
);

it.effect('answers an unresolved policy from the snapshot without calling the Catalog', () =>
  Effect.gen(function* unresolvedPolicy() {
    yield* atResolutionInstant;
    const outcome = { _tag: 'MISSING_PAYMENT_TERM_POLICY', reason: 'No policy applies' } as const;
    const fixture = harness({ policy: () => outcome });
    const handled = yield* runPaymentTermsResolution(request, fixture.context);
    // The policy's own outcome is the answer, unchanged.
    expect(Equal.equals(handled.result, outcome)).toBe(true);
    expect(fixture.steps()).toEqual(['begin', 'end']);
  }),
);

it.effect('answers unavailable, never a fallback, for every Catalog outcome other than its answer', () =>
  Effect.gen(function* catalogWithoutAnswer() {
    yield* atResolutionInstant;
    for (const outcome of [
      CallUnavailableSchema.make({ reason: 'Catalog down', retryable: true }),
      CallForbiddenSchema.make({ reason: 'Catalog refused the caller' }),
      CallNotFoundSchema.make({ reason: 'Catalog operation missing' }),
      CallRejectedSchema.make({ code: 'invalid', reason: 'Catalog rejected the request' }),
    ]) {
      const fixture = harness({ answer: () => Effect.succeed(outcome) });
      const failure = yield* runPaymentTermsResolution(request, fixture.context).pipe(Effect.flip);
      expect(failure).toMatchObject({
        code: 'read_handler_unavailable',
        reason: 'The Current Payment Term catalog could not be resolved',
      });
      expect(fixture.steps()).toEqual(['begin', 'end', 'call']);
    }
  }),
);

it.effect('refuses to release an answer when the state or the policy changed during the Catalog call', () =>
  Effect.gen(function* changedSnapshot() {
    yield* atResolutionInstant;
    for (const changed of [
      harness({ answer: usableCatalog, revision: (sequence) => sequence }),
      harness({
        answer: usableCatalog,
        policy: (sequence) => ({ ...resolvedPolicy, policyRevision: `PAYMENT_TERM:${String(6 + sequence)}` }),
      }),
    ]) {
      const failure = yield* runPaymentTermsResolution(request, changed.context).pipe(Effect.flip);
      expect(failure).toMatchObject({
        code: 'read_handler_unavailable',
        reason: 'The Payment Terms state or policy changed during Catalog resolution',
      });
      expect(changed.steps()).toEqual(['begin', 'end', 'call', 'begin', 'end']);
    }
  }),
);

it.effect('denies a purchasing context outside the trusted scope before any transaction or call', () =>
  Effect.gen(function* outsideScope() {
    const fixture = harness({});
    const failure = yield* runPaymentTermsResolution(
      { ...request, purchasingContext: { ...request.purchasingContext, storefrontId: 'another' } },
      fixture.context,
    ).pipe(Effect.flip);
    expect(Predicate.isTagged(failure, 'ReadPermissionDenied')).toBe(true);
    expect(fixture.steps()).toEqual([]);
  }),
);
