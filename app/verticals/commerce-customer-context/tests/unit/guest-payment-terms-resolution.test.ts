import { CallUnavailableSchema, RequestExecutionSchema, callOkSchema } from '@app/core-runtime/sdk';
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
import { GuestPaymentTermsResolutionRequestSchema } from '../../shared/apis/guest-payment-terms-resolution.ts';
import { CurrentPaymentTermPolicySetSchema } from '../../shared/domain/customer-commerce-policy-administration.ts';
import type { PaymentTermReference } from '../../shared/domain/payment-term-contracts.ts';
import { PaymentTermsDependencyUnavailable } from '../../shared/domain/payment-term-errors.ts';
import type { PaymentTermsPolicyResolution } from '../../shared/domain/payment-terms.ts';
import {
  guestPaymentTermsResolutionCalls,
  guestPaymentTermsResolutionEntrypoint,
  runGuestPaymentTermsResolution,
} from '../../src/api/guest-payment-terms-resolution.read.ts';
import type {
  GuestPaymentTermsPolicyDecision,
  GuestPaymentTermsResolutionRunContext,
} from '../../src/api/guest-payment-terms-resolution.read.ts';
import { customerCommercePaymentTermsPolicyResolver } from '../../src/integrations/customer-commerce-payment-terms-policy.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const paymentTermRef = {
  moduleId: 'payment.term-catalog' as const,
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'payment.term-catalog.payment-term' as const,
  tenantId,
};
const fallbackRef = {
  ...paymentTermRef,
  resourceId: '44444444-4444-4444-8444-444444444444',
};
const provenance = {
  actionInvocationId: '99999999-9999-4999-8999-999999999991',
  actorPrincipalId: '99999999-9999-4999-8999-999999999992',
  at: '2026-01-01T00:00:00.000Z',
  reason: 'Approved catalog definition',
};
/** The Catalog's definition of one reference, as its contract answers it. */
const catalogDefinition = (reference: PaymentTermReference) => ({
  code: 'IMMEDIATE',
  compatibilityId: 'immediate.v1',
  created: provenance,
  definitionRevisionId: '55555555-5555-4555-8555-555555555555',
  description: 'Payment is due immediately.',
  lifecycle: {
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    state: 'ACTIVE',
  },
  metadataRevision: 1,
  name: 'Immediate',
  paymentTermRef: reference,
  retired: null,
  semanticFingerprint: 'a'.repeat(64),
  semanticRevisionId: '66666666-6666-4666-8666-666666666666',
  semantics: {
    calculationRuleVersion: 2,
    calendarRule: 'NOT_APPLICABLE',
    kind: 'IMMEDIATE',
  },
  updated: provenance,
});
const request = {
  at: '2026-09-09T10:00:00.000Z',
  purchasingContext: {
    channelId: 'guest-web',
    contextRevision: 'context-7',
    marketId: 'cz',
    sellingLegalEntityId: legalEntityId,
    storefrontId: 'main',
  },
};
const scope = {
  authBindingId: '88888888-8888-4888-8888-888888888888',
  authContextRef: 'better-auth-session:guest-payment-terms',
  authMethod: 'session' as const,
  correlationId: 'guest-payment-terms',
  legalEntityId,
  principalId: '77777777-7777-4777-8777-777777777777',
  tenantId,
  trustedStorefrontId: request.purchasingContext.storefrontId,
};
const policy = (overrides: Partial<GuestPaymentTermsPolicyDecision> = {}): GuestPaymentTermsPolicyDecision => ({
  eligiblePaymentTermRefs: [paymentTermRef, fallbackRef],
  explicitlyPermittedPaymentTermRefs: [paymentTermRef],
  fallbackPaymentTermRefs: [fallbackRef],
  policyRevision: 'guest-policy-3',
  policySource: 'customer-commerce-policy',
  ...overrides,
});

type CatalogAnswer = (payload: CurrentPaymentTermsRequest) => Effect.Effect<CallOutcome<CurrentPaymentTermsResponse>>;

/** The Catalog answers every requested reference USABLE with its own definition. */
const usableCatalog: CatalogAnswer = (payload) =>
  Effect.succeed(
    callOkSchema(CurrentPaymentTermsResponseSchema).make({
      value: Schema.decodeUnknownSync(CurrentPaymentTermsResponseSchema)({
        current: payload.references.map(({ paymentTermRef: reference }) => catalogDefinition(reference)),
        effectiveAt: payload.at,
        observedAt: payload.at,
        referenceOutcomes: payload.references.map(({ paymentTermRef: reference }) => ({
          definition: catalogDefinition(reference),
          kind: 'USABLE',
          requestedPaymentTermRef: reference,
        })),
        truncated: false,
      }),
    }),
  );
const noCatalog: CatalogAnswer = () => Effect.die('the Catalog must not be called');

/**
 * Drives the read's `run` with Core's capability stand-ins, which keep the kernel's rule: a call while
 * the owner transaction is open, or a nested transaction, dies.
 */
const harness = (
  resolvePolicy: (sequence: number) => Effect.Effect<PaymentTermsPolicyResolution, PaymentTermsDependencyUnavailable>,
  answer: CatalogAnswer = noCatalog,
  runScope: GuestPaymentTermsResolutionRunContext['scope'] = scope,
) => {
  const standIn = makeExecutionStandIn(guestPaymentTermsResolutionCalls, {
    answers: { currentPaymentTerms: answer },
    operationAt: DateTime.makeUnsafe(request.at),
    services: (sequence) => ({ resolvePolicy: () => resolvePolicy(sequence) }),
  });
  const context: GuestPaymentTermsResolutionRunContext = {
    access: {},
    call: standIn.call,
    execution: {
      compositionRevision: 'composition-revision-1',
      identity: RequestExecutionSchema.make({ via: 'person' }),
      operationKey: 'commerce.customer-context.api.guest-payment-terms-resolution',
      owningModuleKey: 'commerce.customer-context',
    },
    readKey: 'commerce.customer-context.api.guest-payment-terms-resolution',
    scope: runScope,
    transaction: standIn.transaction,
  };
  return {
    calledWith: () => standIn.steps.flatMap((step) => (step.kind === 'call' ? [step.input] : [])),
    context,
    steps: () => standIn.steps.map((step) => step.kind),
  };
};

const atRequestInstant = TestClock.setTime(Date.parse(request.at));

it('exposes an authenticated Guest-only contract without caller-authored policy inputs', () => {
  expect(guestPaymentTermsResolutionEntrypoint.authorization).toEqual({ kind: 'protected' });
  expect(Schema.is(GuestPaymentTermsResolutionRequestSchema)(request)).toBe(true);
  expect('eligiblePaymentTermRefs' in GuestPaymentTermsResolutionRequestSchema.fields).toBe(false);
  expect('policyFallbackRefs' in GuestPaymentTermsResolutionRequestSchema.fields).toBe(false);
  expect('profileRef' in GuestPaymentTermsResolutionRequestSchema.fields).toBe(false);
});

it.effect('fails closed before policy resolution without a trusted Storefront', () =>
  Effect.gen(function* missingTrustedStorefront() {
    const { trustedStorefrontId: _withoutStorefront, ...scopeWithoutStorefront } = scope;
    const fixture = harness(() => Effect.die('policy must not be resolved'), noCatalog, scopeWithoutStorefront);
    const failure = yield* runGuestPaymentTermsResolution(request, fixture.context).pipe(Effect.flip);

    expect(failure).toMatchObject({
      code: 'read_handler_unavailable',
      reason: 'Guest Payment Term resolution requires a trusted Storefront context',
    });
    expect(fixture.steps()).toEqual([]);
  }),
);

it.effect('loads Current owner-backed policy without environment JSON', () =>
  Effect.gen(function* currentPolicyResolution() {
    const resolution = yield* customerCommercePaymentTermsPolicyResolver(
      'GUEST',
      {
        tenantId,
        trustedStorefrontId: request.purchasingContext.storefrontId,
      },
      {
        readCurrentPaymentTermPolicy: () =>
          Effect.succeed(
            Schema.decodeUnknownSync(CurrentPaymentTermPolicySetSchema)({
              candidates: [
                {
                  effectiveFrom: '2026-01-01T00:00:00.000Z',
                  effectiveTo: null,
                  policyRevisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
                  scope: { kind: 'SELLER', sellingLegalEntityId: legalEntityId },
                  value: { kind: 'APPLICABLE_PAYMENT_TERM_CONSTRAINT', paymentTermRef },
                },
                {
                  effectiveFrom: '2026-01-01T00:00:00.000Z',
                  effectiveTo: null,
                  policyRevisionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2',
                  scope: { kind: 'SELLER', sellingLegalEntityId: legalEntityId },
                  value: { enabled: true, kind: 'EXPLICIT_PAYMENT_TERM_CHOICE_POLICY' },
                },
              ],
              completeness: {
                observedAt: request.at,
                ownerRevision: 'PAYMENT_TERM:7',
                scope: { kind: 'EXACT_PREDICATE', predicateRef: `payment-term-policy:${tenantId}:${legalEntityId}` },
              },
            }),
          ),
      },
    ).resolve(request);

    expect(resolution).toMatchObject({
      eligiblePaymentTermRefs: [paymentTermRef],
      explicitlyPermittedPaymentTermRefs: [paymentTermRef],
      fallbackPaymentTermRefs: [],
      policyRevision: 'PAYMENT_TERM:7',
    });
  }),
);

it.effect('uses the authoritative Guest fallback with exact policy and context provenance', () =>
  Effect.gen(function* resolvesFallback() {
    yield* atRequestInstant;
    const fixture = harness(() => Effect.succeed(policy()), usableCatalog);
    const handled = yield* runGuestPaymentTermsResolution(request, fixture.context);
    expect(Predicate.isTagged(handled.result, 'POLICY_FALLBACK')).toBe(true);
    if (Predicate.isTagged(handled.result, 'POLICY_FALLBACK')) {
      expect(handled.result.customerPaymentTermsRevision).toBeNull();
      expect(handled.result.definition.paymentTermRef).toEqual(fallbackRef);
      expect(handled.result.policyRevision).toBe('guest-policy-3');
      expect(handled.result.purchasingContextRevision).toBe('context-7');
    }
    expect(handled.evidence).toEqual({ resultCount: 1 });
  }),
);

it.effect('calls the Catalog only between the policy transaction and its recheck, never inside one', () =>
  Effect.gen(function* callOutsideTransaction() {
    yield* atRequestInstant;
    const fixture = harness(() => Effect.succeed(policy()), usableCatalog);
    yield* runGuestPaymentTermsResolution(request, fixture.context);
    expect(fixture.steps()).toEqual(['begin', 'end', 'call', 'begin', 'end']);
    expect(fixture.calledWith()).toEqual([
      {
        at: request.at,
        limit: 2,
        references: [{ paymentTermRef }, { paymentTermRef: fallbackRef }],
      },
    ]);
  }),
);

it.effect('never falls back after an invalid explicit Guest choice', () =>
  Effect.gen(function* rejectsExplicitChoice() {
    yield* atRequestInstant;
    const fixture = harness(() => Effect.succeed(policy()), usableCatalog);
    const handled = yield* runGuestPaymentTermsResolution({ ...request, explicitChoice: fallbackRef }, fixture.context);
    expect(Predicate.isTagged(handled.result, 'EXPLICIT_CHOICE_INVALID')).toBe(true);
  }),
);

it.effect('answers an unresolved Guest policy without calling the Catalog', () =>
  Effect.gen(function* unresolvedPolicy() {
    const outcome = { _tag: 'MISSING_PAYMENT_TERM_POLICY', reason: 'No policy applies' } as const;
    const fixture = harness(() => Effect.succeed(outcome));
    const handled = yield* runGuestPaymentTermsResolution(request, fixture.context);
    // The policy's own outcome is the answer, unchanged.
    expect(Equal.equals(handled.result, outcome)).toBe(true);
    expect(fixture.steps()).toEqual(['begin', 'end']);
  }),
);

it.effect('fails closed when the authoritative Guest policy is unavailable', () =>
  Effect.gen(function* unavailablePolicy() {
    const fixture = harness(() =>
      Effect.fail(
        new PaymentTermsDependencyUnavailable({
          code: 'payment_terms_dependency_unavailable',
          dependency: 'CUSTOMER_COMMERCE_POLICY',
          reason: 'Guest policy unavailable',
        }),
      ),
    );
    const failure = yield* runGuestPaymentTermsResolution(request, fixture.context).pipe(Effect.flip);
    expect(failure.reason).toBe('Guest policy unavailable');
    expect(fixture.steps()).toEqual(['begin', 'end']);
  }),
);

it.effect('answers unavailable, never a fallback, when the Catalog gives no answer or the policy changed', () =>
  Effect.gen(function* unavailableCatalogOrChangedPolicy() {
    yield* atRequestInstant;
    const unanswered = harness(
      () => Effect.succeed(policy()),
      () => Effect.succeed(CallUnavailableSchema.make({ reason: 'Catalog down', retryable: true })),
    );
    const catalogFailure = yield* runGuestPaymentTermsResolution(request, unanswered.context).pipe(Effect.flip);
    expect(catalogFailure).toMatchObject({
      code: 'read_handler_unavailable',
      reason: 'The Current Payment Term catalog could not be resolved',
    });
    expect(unanswered.steps()).toEqual(['begin', 'end', 'call']);

    // The policy changed while the Catalog answered: the recheck refuses to release the answer.
    const changed = harness(
      (sequence) => Effect.succeed(policy(sequence === 1 ? {} : { policyRevision: 'guest-policy-4' })),
      usableCatalog,
    );
    const changedFailure = yield* runGuestPaymentTermsResolution(request, changed.context).pipe(Effect.flip);
    expect(changedFailure).toMatchObject({ code: 'read_handler_unavailable' });
    expect(changed.steps()).toEqual(['begin', 'end', 'call', 'begin', 'end']);
  }),
);
