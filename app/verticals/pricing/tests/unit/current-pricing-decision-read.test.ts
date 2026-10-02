import {
  OperationContextUnavailable,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  TrustedPrincipalContextSchema,
  scopedRoutineInvokerFromTransaction,
} from '@app/core-runtime';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { PricingPurchaseContextVerificationEvidenceSchema } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import {
  CurrentPricingDecisionRequestSchema,
  CurrentPricingDecisionResponseSchema,
  projectCurrentPricingDecisionResponse,
} from '@app/pricing-contracts/current-pricing-decision';
import type { CurrentPricingDecisionRequest } from '@app/pricing-contracts/current-pricing-decision';
import { Effect, Exit, Match, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import {
  currentPricingDecisionRead,
  makeCurrentPricingDecisionReadServiceFactory,
  resolveCurrentPricingDecision,
  resolveCurrentPricingDecisionTrustedScope,
} from '../../src/api/current-pricing-decision.read.ts';
import {
  CurrentPricingDecisionEvaluationFactory,
  CurrentPricingDecisionScopeViolation,
} from '../../src/services/current-pricing-decision-evaluation.service.ts';
import type { CurrentPricingDecisionWholeEvaluationPort } from '../../src/services/current-pricing-decision-evaluation.service.ts';
import {
  CurrentPricingDecisionSubjectAuthority,
  CurrentPricingDecisionSubjectAuthorityRejected,
} from '../../src/services/current-pricing-decision-subject-authority.service.ts';
import {
  PricingExternalOwnerEvidenceValidation,
  makePricingExternalOwnerEvidenceValidationService,
} from '../../src/services/external-owner-evidence-validation.service.ts';
import type {
  CurrentPricingDecisionSubjectAuthorityEvidence,
  CurrentPricingDecisionSubjectAuthorityInput,
  CurrentPricingDecisionSubjectAuthorityService,
} from '../../src/services/current-pricing-decision-subject-authority.service.ts';
import {
  unitPriceCalculationAttempt,
  unitPriceFixtureEffectiveAt,
  unitPriceFixtureTenantId,
} from './support/unit-price-calculation.fixture.ts';

const principalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const request = Effect.gen(function* currentPricingDecisionRequestFixture() {
  const attempt = yield* unitPriceCalculationAttempt({ groupPath: true });
  const { path } = attempt.exactPrice;
  if (!('usedPrice' in path)) {
    return yield* Effect.die('The governed-read fixture requires a resolved exact Price');
  }
  const decision = {
    commercialScope: path.usedPrice.request.exactKey.commercialScope,
    currencyCode: 'CZK' as const,
    lines: [attempt.line],
    monetaryBoundary: 'PRE_TAX' as const,
    operationTime: unitPriceFixtureEffectiveAt,
    purchasingContext: {
      accessDecision: { decisionRef: 'access-decision:790', decisionRevision: '1' },
      actor: {
        guestEvidenceRef: 'guest-evidence:790',
        guestSessionRef: 'guest-session:790',
        kind: 'GUEST' as const,
      },
      commercialSettingsDecision: { decisionRef: 'commercial-settings:790', decisionRevision: '1' },
      contextRef: 'purchase-context:790',
      contextRevision: 'purchase-context:790:1',
      currencyResolution: {
        currencyCode: 'CZK' as const,
        resolutionRef: 'currency-resolution:790',
        resolutionRevision: '1',
      },
      subject: {
        guestEvidenceRef: 'guest-evidence:790',
        guestSessionRef: 'guest-session:790',
        kind: 'GUEST' as const,
      },
    },
    tenantId: unitPriceFixtureTenantId,
  };
  return yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema, {
    onExcessProperty: 'error',
  })({
    decision,
    subject: {
      guestEvidenceRef: 'guest-evidence:790',
      guestSessionRef: 'guest-session:790',
      kind: 'GUEST',
    },
  });
});

const outcomeFor = (input: CurrentPricingDecisionRequest) => ({
  candidate: {
    candidateRef: input.decision.purchasingContext.contextRef,
    occurrenceIds: input.decision.lines.map(({ occurrenceId }) => occurrenceId),
  },
  outcome: 'PRICING_CONFIGURATION_ERROR' as const,
  reasonCode: 'UNSUPPORTED_CURRENCY' as const,
  retryable: false as const,
});

const principalFor = (tenantId: string, candidatePrincipalId = principalId) =>
  Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    authContextRef: 'session:790',
    authMethod: 'session',
    principalId: candidatePrincipalId,
    tenantId,
  });

const trustedScopeFor = (input: CurrentPricingDecisionRequest) => ({
  legalEntityId: input.decision.commercialScope.sellingLegalEntityId,
  principal: principalFor(input.decision.tenantId),
});

const nonResolvedEvaluationFor = (input: CurrentPricingDecisionRequest) => ({
  kind: 'NON_RESOLVED' as const,
  outcome: outcomeFor(input),
});

const subjectAuthorityEvidenceFor = (
  input: CurrentPricingDecisionSubjectAuthorityInput,
): CurrentPricingDecisionSubjectAuthorityEvidence => {
  const verifiedRequest = input.request;
  return Schema.decodeUnknownSync(PricingPurchaseContextVerificationEvidenceSchema)({
    currentness: {
      evaluatedAt: verifiedRequest.decision.operationTime,
      observedAt: verifiedRequest.decision.operationTime,
      validFrom: verifiedRequest.decision.operationTime,
      validTo: null,
    },
    ownerRef: verifiedRequest.decision.purchasingContext.contextRef,
    ownerRevisionRef: verifiedRequest.decision.purchasingContext.contextRevision,
    subjectAuthority:
      verifiedRequest.subject.kind === 'GUEST'
        ? {
            guestEvidenceAuthorityRef: 'guest-evidence-authority:790',
            guestSessionAuthorityRef: 'guest-session-authority:790',
            kind: 'GUEST' as const,
            subject: verifiedRequest.subject,
            subjectAuthorityRevisionRef: 'guest-authority-revision:790',
          }
        : {
            actorPrincipalId: input.scope.principal.principalId,
            kind: 'PROFILE' as const,
            partyAuthorityRef: 'party-authority:790',
            partyAuthorityRevisionRef: 'party-authority-revision:790',
            subject: verifiedRequest.subject,
            subjectAuthorityRef: 'profile-authority:790',
            subjectAuthorityRevisionRef: 'profile-authority-revision:790',
          },
    verificationRef: 'purchase-context-verification:790',
    verifiedScope: {
      channelId: verifiedRequest.decision.commercialScope.channelId,
      legalEntityId: input.scope.sellingLegalEntityId,
      marketId: verifiedRequest.decision.commercialScope.marketId,
      tenantId: input.scope.principal.tenantId,
    },
  });
};

const verifyExactSubjectAuthority: CurrentPricingDecisionSubjectAuthorityService['verify'] = (input) =>
  Effect.succeed({
    evidence: subjectAuthorityEvidenceFor(input),
    input,
    kind: 'CURRENT_PRICING_DECISION_SUBJECT_AUTHORITY_VERIFIED',
  });

const retailProfileRequest = (input: CurrentPricingDecisionRequest, profileId: string): CurrentPricingDecisionRequest =>
  (() => {
    const subject = {
      authorizationSubject: { kind: 'RETAIL' },
      kind: 'PROFILE',
      profileRef: {
        moduleId: 'commerce.customer-context',
        resourceId: profileId,
        resourceType: 'commerce.customer-context.retail-customer-profile',
        tenantId: input.decision.tenantId,
      },
    } as const;
    return Schema.decodeSync(CurrentPricingDecisionRequestSchema)({
      ...input,
      decision: {
        ...input.decision,
        purchasingContext: {
          ...input.decision.purchasingContext,
          actor: { kind: 'PRINCIPAL', principalId },
          subject,
        },
      },
      subject,
    });
  })();

describe('Current Pricing Decision governed read', () => {
  it.effect('passes the exact request to the evaluator and returns only the customer-safe projection', () =>
    Effect.gen(function* preservesTypedOutcome() {
      const input = yield* request;
      const trustedScope = trustedScopeFor(input);
      const expected = outcomeFor(input);
      let observed: typeof input | undefined;

      const result = yield* resolveCurrentPricingDecision(
        input,
        trustedScope,
        verifyExactSubjectAuthority,
        (candidate) => {
          observed = candidate;
          return Effect.succeed(nonResolvedEvaluationFor(input));
        },
      );

      expect(observed).toEqual(input);
      expect(result).toEqual(projectCurrentPricingDecisionResponse(expected));
    }),
  );

  it.effect('rejects caller Tenant and Legal Entity assertions before evaluation', () =>
    Effect.gen(function* rejectsUntrustedScope() {
      const input = yield* request;
      let calls = 0;
      const evaluate = () => {
        calls += 1;
        return Effect.succeed(nonResolvedEvaluationFor(input));
      };
      const wrongTenant = yield* Effect.exit(
        resolveCurrentPricingDecision(
          input,
          {
            ...trustedScopeFor(input),
            principal: principalFor('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
          },
          verifyExactSubjectAuthority,
          evaluate,
        ),
      );
      const wrongLegalEntity = yield* Effect.exit(
        resolveCurrentPricingDecision(
          input,
          {
            ...trustedScopeFor(input),
            legalEntityId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
          },
          verifyExactSubjectAuthority,
          evaluate,
        ),
      );

      expect(Exit.isFailure(wrongTenant)).toBe(true);
      expect(Exit.isFailure(wrongLegalEntity)).toBe(true);
      expect(calls).toBe(0);
    }),
  );

  it.effect('maps an evaluator scope rejection into the governed read-permission failure', () =>
    Effect.gen(function* mapsScopeViolation() {
      const input = yield* request;
      const failure = yield* resolveCurrentPricingDecision(
        input,
        {
          ...trustedScopeFor(input),
        },
        verifyExactSubjectAuthority,
        () => Effect.fail(new CurrentPricingDecisionScopeViolation({ reason: 'TRUSTED_SCOPE_MISMATCH' })),
      ).pipe(Effect.flip);

      expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
      expect(failure.code).toBe('read_permission_denied');
    }),
  );

  it.effect('rejects an arbitrary Guest assertion before Pricing evaluation', () =>
    Effect.gen(function* rejectsArbitraryGuest() {
      const input = yield* request;
      let evaluations = 0;
      const failure = yield* resolveCurrentPricingDecision(
        input,
        {
          ...trustedScopeFor(input),
        },
        () => Effect.fail(new CurrentPricingDecisionSubjectAuthorityRejected({ reason: 'SUBJECT_NOT_AUTHORIZED' })),
        () => {
          evaluations += 1;
          return Effect.succeed(nonResolvedEvaluationFor(input));
        },
      ).pipe(Effect.flip);

      expect(Schema.is(ReadPermissionDenied)(failure)).toBe(true);
      expect(evaluations).toBe(0);
    }),
  );

  it.effect('fails closed when owner evidence echoes a different Profile binding', () =>
    Effect.gen(function* rejectsCrossProfileEvidence() {
      const guestInput = yield* request;
      const input = retailProfileRequest(guestInput, 'retail-profile:790:a');
      const ownerRequest = retailProfileRequest(guestInput, 'retail-profile:790:b');
      let evaluations = 0;
      const failure = yield* resolveCurrentPricingDecision(
        input,
        {
          ...trustedScopeFor(input),
        },
        (authorityInput) =>
          Effect.succeed({
            evidence: subjectAuthorityEvidenceFor(authorityInput),
            input: { ...authorityInput, request: ownerRequest } satisfies CurrentPricingDecisionSubjectAuthorityInput,
            kind: 'CURRENT_PRICING_DECISION_SUBJECT_AUTHORITY_VERIFIED' as const,
          }),
        () => {
          evaluations += 1;
          return Effect.succeed(nonResolvedEvaluationFor(input));
        },
      ).pipe(Effect.flip);

      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
      expect(evaluations).toBe(0);
    }),
  );

  it.effect('fails closed when owner evidence substitutes the Purchase Context source', () =>
    Effect.gen(function* rejectsSubstitutedOwnerSource() {
      const input = yield* request;
      let evaluations = 0;
      const failure = yield* resolveCurrentPricingDecision(
        input,
        trustedScopeFor(input),
        (authorityInput) =>
          Effect.succeed({
            evidence: {
              ...subjectAuthorityEvidenceFor(authorityInput),
              ownerRef: 'purchase-context:substituted',
            },
            input: authorityInput,
            kind: 'CURRENT_PRICING_DECISION_SUBJECT_AUTHORITY_VERIFIED' as const,
          }),
        () => {
          evaluations += 1;
          return Effect.succeed(nonResolvedEvaluationFor(input));
        },
      ).pipe(Effect.flip);

      expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
      expect(evaluations).toBe(0);
    }),
  );

  it.effect('fails closed when Profile authority substitutes the customer Principal or Market scope', () =>
    Effect.gen(function* rejectsSubstitutedTrustedScope() {
      const guestInput = yield* request;
      const input = retailProfileRequest(guestInput, 'retail-profile:790:a');
      const trustedScope = trustedScopeFor(input);
      let evaluations = 0;
      const evaluate = () => {
        evaluations += 1;
        return Effect.succeed(nonResolvedEvaluationFor(input));
      };
      const wrongPrincipal = yield* resolveCurrentPricingDecision(
        input,
        trustedScope,
        (authorityInput) =>
          Effect.gen(function* substitutesPrincipal() {
            const evidence = subjectAuthorityEvidenceFor(authorityInput);
            if (evidence.subjectAuthority.kind !== 'PROFILE') {
              return yield* Effect.die('The Profile authority fixture returned Guest evidence');
            }
            return {
              evidence: yield* Schema.decodeEffect(PricingPurchaseContextVerificationEvidenceSchema)({
                ...evidence,
                subjectAuthority: {
                  ...evidence.subjectAuthority,
                  actorPrincipalId: principalFor(input.decision.tenantId, 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')
                    .principalId,
                },
              }).pipe(Effect.orDie),
              input: authorityInput,
              kind: 'CURRENT_PRICING_DECISION_SUBJECT_AUTHORITY_VERIFIED' as const,
            };
          }),
        evaluate,
      ).pipe(Effect.flip);
      const wrongMarket = yield* resolveCurrentPricingDecision(
        input,
        trustedScope,
        (authorityInput) => {
          const evidence = subjectAuthorityEvidenceFor(authorityInput);
          return Effect.succeed({
            evidence: Schema.decodeSync(PricingPurchaseContextVerificationEvidenceSchema)({
              ...evidence,
              verifiedScope: { ...evidence.verifiedScope, marketId: 'substituted-market' },
            }),
            input: authorityInput,
            kind: 'CURRENT_PRICING_DECISION_SUBJECT_AUTHORITY_VERIFIED' as const,
          });
        },
        evaluate,
      ).pipe(Effect.flip);

      expect(Schema.is(ReadHandlerUnavailable)(wrongPrincipal)).toBe(true);
      expect(Schema.is(ReadHandlerUnavailable)(wrongMarket)).toBe(true);
      expect(evaluations).toBe(0);
    }),
  );

  it('retains the generated read gate and independent Tenant currency-support boundary', () => {
    expect(currentPricingDecisionRead.descriptor).toMatchObject({
      entrypoint: {
        access: 'read',
        authorization: { kind: 'authenticated_principal' },
        moduleKey: 'commerce.pricing',
        role: 'api',
      },
      legalEntityScope: 'required',
      permissionTarget: 'module',
      readKey: 'commerce.pricing.api.current-pricing-decision',
      schemaVersion: '1',
    });
    expect(currentPricingDecisionRead.descriptor.readKey).not.toBe('commerce.pricing.api.current-supported-currencies');
  });

  it('rejects private Pricing fields from resolved and non-resolved transport responses', () => {
    const decodeResponse = Schema.decodeUnknownSync(CurrentPricingDecisionResponseSchema, {
      onExcessProperty: 'error',
    });
    const candidate = { occurrenceIds: ['purchase-occurrence:790'] };
    const projectionVersion = 'CURRENT_PRICING_DECISION_CUSTOMER_V1' as const;
    expect(() =>
      decodeResponse({
        candidate: { ...candidate, candidateRef: 'private-candidate:790' },
        outcome: 'PRICING_INDETERMINATE',
        projectionVersion,
        reasonCode: 'OWNER_STATE_UNAVAILABLE',
        retryable: true,
      }),
    ).toThrow();
    expect(() =>
      decodeResponse({
        candidate,
        outcome: 'PRICE_RESOLVED',
        projectionVersion,
        result: {
          currencyCode: 'CZK',
          lines: [
            {
              lookup: { exactPriceRevision: 'private-price-revision:790' },
              occurrenceId: 'purchase-occurrence:790',
              publishedPreTaxAmount: { amount: '19.99', currencyCode: 'CZK' },
            },
          ],
          monetaryBoundary: 'PRE_TAX',
          total: { amount: '19.99', currencyCode: 'CZK' },
          totalMethod: 'EXACT_SUM_OF_ROUNDED_LINES',
        },
        retryable: false,
      }),
    ).toThrow();
  });

  it.effect('passes the owner transaction and verified trusted scope into the request-bound evaluator factory', () =>
    Effect.gen(function* preservesTransactionAndScope() {
      const input = yield* request;
      const legalEntityId = input.decision.commercialScope.sellingLegalEntityId;
      const scope = {
        ...(yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
          authBindingId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
          authContextRef: 'session:790',
          authMethod: 'session',
          legalEntityId,
          principalId,
          tenantId: input.decision.tenantId,
        })),
        correlationId: 'correlation:790',
      } satisfies OperationalScope;
      // SAFETY: This inert transaction identity is only compared by reference; no private capability is invoked.
      const transaction = scopedRoutineInvokerFromTransaction(() => Effect.succeed([]), {
        legalEntityId,
        tenantId: scope.tenantId,
      }) as unknown as ScopedTransactionExecutor;
      const source = {
        loadFresh: () => Effect.die('The factory composition test does not evaluate a request'),
      } satisfies CurrentPricingDecisionWholeEvaluationPort;
      let observedTransaction: ScopedTransactionExecutor | undefined;
      let observedScope: OperationalScope | undefined;
      let observedSource: CurrentPricingDecisionWholeEvaluationPort | undefined;
      const serviceFactory = makeCurrentPricingDecisionReadServiceFactory((candidateTransaction, candidateScope) => {
        observedTransaction = candidateTransaction;
        observedScope = candidateScope;
        return Effect.succeed(source);
      });
      const subjectAuthority = { verify: verifyExactSubjectAuthority };

      const services = yield* serviceFactory(transaction, scope, 'a'.repeat(64)).pipe(
        Effect.provideService(CurrentPricingDecisionSubjectAuthority, subjectAuthority),
        Effect.provideService(CurrentPricingDecisionEvaluationFactory, {
          make: (candidateSource) => {
            observedSource = candidateSource;
            return { evaluate: () => Effect.succeed(nonResolvedEvaluationFor(input)) };
          },
        }),
      );

      expect(observedTransaction).toBe(transaction);
      expect(observedScope).toEqual(scope);
      expect(observedSource).toBe(source);
      expect(services.verifySubjectAuthority).toBe(subjectAuthority.verify);
      expect(services.trustedScope).toEqual({
        legalEntityId: scope.legalEntityId,
        principal: yield* Schema.decodeEffect(TrustedPrincipalContextSchema)(scope),
      });

      const productionServices = yield* serviceFactory(transaction, scope, 'a'.repeat(64)).pipe(
        Effect.provideService(CurrentPricingDecisionEvaluationFactory, {
          make: () => ({ evaluate: () => Effect.succeed(nonResolvedEvaluationFor(input)) }),
        }),
      );
      const absentIssuerFailure = yield* productionServices
        .verifySubjectAuthority({
          request: input,
          scope: {
            principal: yield* Schema.decodeEffect(TrustedPrincipalContextSchema)(scope),
            sellingLegalEntityId: legalEntityId,
          },
        })
        .pipe(Effect.flip);
      expect(
        Match.value(absentIssuerFailure).pipe(
          Match.tag('CurrentPricingDecisionSubjectAuthorityUnavailable', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }).pipe(
      Effect.provideService(
        PricingExternalOwnerEvidenceValidation,
        makePricingExternalOwnerEvidenceValidationService(),
      ),
    ),
  );

  it.effect('fails closed before source construction when trusted SLE scope is absent', () =>
    Effect.gen(function* requiresScopedTransactionContext() {
      const principal = yield* Schema.decodeEffect(TrustedPrincipalContextSchema)({
        authBindingId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        authContextRef: 'session:790',
        authMethod: 'session',
        principalId,
        tenantId: unitPriceFixtureTenantId,
      });
      const scope = {
        ...principal,
        correlationId: 'correlation:790',
      } satisfies OperationalScope;

      const failure = yield* resolveCurrentPricingDecisionTrustedScope(scope).pipe(Effect.flip);
      expect(Schema.is(OperationContextUnavailable)(failure)).toBe(true);
      expect(failure.code).toBe('operation_context_unavailable');
    }),
  );
});
