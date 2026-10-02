import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { PrincipalIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { PricingPurchaseContextVerificationResponseSchema } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import type { PricingPurchaseContextVerificationRequest } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import { CurrentPricingDecisionRequestSchema } from '@app/pricing-contracts/current-pricing-decision';
import type { CurrentPricingDecisionRequest } from '@app/pricing-contracts/current-pricing-decision';
import { Effect, Match, Redacted, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { currentPricingDecisionCustomerContextSubjectAuthorityFromEnvironment } from '../../src/integrations/customer-context-subject-authority.ts';
import { CurrentPricingDecisionCustomerContextGatewayIssuer } from '../../src/services/current-pricing-decision-subject-authority.service.ts';
import type { CurrentPricingDecisionCustomerContextGatewayIssuerService } from '../../src/services/current-pricing-decision-subject-authority.service.ts';
import {
  unitPriceCalculationAttempt,
  unitPriceFixtureEffectiveAt,
  unitPriceFixtureTenantId,
} from './support/unit-price-calculation.fixture.ts';

const compositionRevision = 'a'.repeat(64);

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const principalId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const foreignPrincipalId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const foreignEvidencePrincipalId = Schema.decodeSync(PrincipalIdSchema)(foreignPrincipalId);
const legalEntityId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const foreignLegalEntityId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const requestCorrelation = 'correlation:customer-context-authority:790';

const principal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  authBindingId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  authContextRef: 'session:customer-context-authority:790',
  authMethod: 'session',
  legalEntityId,
  principalId,
  tenantId: unitPriceFixtureTenantId,
});

const foreignPrincipal = Schema.decodeSync(TrustedPrincipalContextSchema)({
  ...principal,
  legalEntityId: foreignLegalEntityId,
  principalId: foreignPrincipalId,
});

const guestRequest = Effect.gen(function* guestPricingDecisionRequest() {
  const attempt = yield* unitPriceCalculationAttempt({ groupPath: true });
  const { path } = attempt.exactPrice;
  if (!('usedPrice' in path)) {
    return yield* Effect.die('The subject-authority fixture requires a resolved exact Price');
  }
  return yield* Schema.decodeEffect(CurrentPricingDecisionRequestSchema, { onExcessProperty: 'error' })({
    decision: {
      commercialScope: { ...path.usedPrice.request.exactKey.commercialScope, sellingLegalEntityId: legalEntityId },
      currencyCode: 'CZK',
      lines: [attempt.line],
      monetaryBoundary: 'PRE_TAX',
      operationTime: unitPriceFixtureEffectiveAt,
      purchasingContext: {
        accessDecision: { decisionRef: 'access-decision:790', decisionRevision: '1' },
        actor: {
          guestEvidenceRef: 'guest-evidence:790',
          guestSessionRef: 'guest-session:790',
          kind: 'GUEST',
        },
        commercialSettingsDecision: { decisionRef: 'commercial-settings:790', decisionRevision: '1' },
        contextRef: 'purchase-context:790',
        contextRevision: 'purchase-context:790:1',
        currencyResolution: {
          currencyCode: 'CZK',
          resolutionRef: 'currency-resolution:790',
          resolutionRevision: '1',
        },
        subject: {
          guestEvidenceRef: 'guest-evidence:790',
          guestSessionRef: 'guest-session:790',
          kind: 'GUEST',
        },
      },
      tenantId: unitPriceFixtureTenantId,
    },
    subject: {
      guestEvidenceRef: 'guest-evidence:790',
      guestSessionRef: 'guest-session:790',
      kind: 'GUEST',
    },
  });
});

const profileRequest = (request: CurrentPricingDecisionRequest) => {
  const subject = {
    authorizationSubject: { kind: 'RETAIL' as const },
    kind: 'PROFILE' as const,
    profileRef: {
      moduleId: 'commerce.customer-context',
      resourceId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      resourceType: 'commerce.customer-context.retail-customer-profile',
      tenantId: unitPriceFixtureTenantId,
    },
  };
  return Schema.decodeSync(CurrentPricingDecisionRequestSchema)({
    ...request,
    decision: {
      ...request.decision,
      purchasingContext: {
        ...request.decision.purchasingContext,
        actor: { kind: 'PRINCIPAL', principalId },
        subject,
      },
    },
    subject,
  });
};

const verifiedOwnerResponse = (request: PricingPurchaseContextVerificationRequest) =>
  Schema.decodeSync(PricingPurchaseContextVerificationResponseSchema)({
    evidence: {
      currentness: {
        evaluatedAt: request.operationTime,
        observedAt: request.operationTime,
        validFrom: request.operationTime,
        validTo: null,
      },
      ownerRef: request.purchasingContext.contextRef,
      ownerRevisionRef: request.purchasingContext.contextRevision,
      subjectAuthority:
        request.subject.kind === 'PROFILE' && request.actor.kind === 'AUTHENTICATED_CUSTOMER'
          ? {
              actorPrincipalId: request.actor.principalId,
              kind: 'PROFILE',
              partyAuthorityRef: 'party.registry.party:790',
              partyAuthorityRevisionRef: 'party.registry.party:790:4',
              subject: request.subject,
              subjectAuthorityRef: 'commerce.customer-context.profile:790',
              subjectAuthorityRevisionRef: 'commerce.customer-context.profile:790:12',
            }
          : {
              guestEvidenceAuthorityRef: 'commerce.customer-context.guest-evidence:790',
              guestSessionAuthorityRef: 'commerce.customer-context.guest-session:790',
              kind: 'GUEST',
              subject: request.subject,
              subjectAuthorityRevisionRef: 'commerce.customer-context.guest-session:790:3',
            },
      verificationRef: 'commerce.customer-context.purchase-context-verification:790',
      verifiedScope: {
        channelId: request.purchasingContext.channelId,
        legalEntityId: request.purchasingContext.sellingLegalEntityId,
        marketId: request.purchasingContext.marketId,
        tenantId: request.tenantId,
      },
    },
    outcome: 'PURCHASE_CONTEXT_VERIFIED',
    request,
  });

describe('Pricing Customer Context subject authority #790', () => {
  it.effect(
    'mints a fresh CCC assertion for the exact trusted principal and keeps Profile and Guest paths distinct',
    () =>
      Effect.gen(function* samePrincipalAuthority() {
        const guest = yield* guestRequest;
        const issued: unknown[] = [];
        const payloads: PricingPurchaseContextVerificationRequest[] = [];
        const issuer = {
          issue: (input: Parameters<CurrentPricingDecisionCustomerContextGatewayIssuerService['issue']>[0]) => {
            issued.push(input);
            return Effect.succeed({
              baseUrl: new URL('https://commerce-customer-context.example.test'),
              credential: Redacted.make('Bearer fresh-same-principal-assertion'),
            });
          },
        } satisfies CurrentPricingDecisionCustomerContextGatewayIssuerService;
        const authority = yield* currentPricingDecisionCustomerContextSubjectAuthorityFromEnvironment(
          requestCorrelation,
          compositionRevision,
          (payload) => {
            payloads.push(payload);
            return Effect.succeed(verifiedOwnerResponse(payload));
          },
        ).pipe(Effect.provideService(CurrentPricingDecisionCustomerContextGatewayIssuer, issuer));

        const scope = { principal, sellingLegalEntityId: legalEntityId };
        const guestVerified = yield* authority.verify({ request: guest, scope });
        const profileVerified = yield* authority.verify({ request: profileRequest(guest), scope });

        expect(issued).toEqual([
          { audience: 'commerce-customer-context', compositionRevision, principal, requestCorrelation },
          { audience: 'commerce-customer-context', compositionRevision, principal, requestCorrelation },
        ]);
        expect(payloads.map(({ actor }) => actor)).toEqual([
          { kind: 'GUEST' },
          { kind: 'AUTHENTICATED_CUSTOMER', principalId },
        ]);
        expect(payloads).toEqual([
          {
            actor: { kind: 'GUEST' },
            operationTime: guest.decision.operationTime,
            purchasingContext: {
              channelId: guest.decision.commercialScope.channelId,
              contextRef: guest.decision.purchasingContext.contextRef,
              contextRevision: guest.decision.purchasingContext.contextRevision,
              marketId: guest.decision.commercialScope.marketId,
              sellingLegalEntityId: guest.decision.commercialScope.sellingLegalEntityId,
            },
            subject: guest.subject,
            tenantId: unitPriceFixtureTenantId,
          },
          {
            actor: { kind: 'AUTHENTICATED_CUSTOMER', principalId },
            operationTime: guest.decision.operationTime,
            purchasingContext: {
              channelId: guest.decision.commercialScope.channelId,
              contextRef: guest.decision.purchasingContext.contextRef,
              contextRevision: guest.decision.purchasingContext.contextRevision,
              marketId: guest.decision.commercialScope.marketId,
              sellingLegalEntityId: guest.decision.commercialScope.sellingLegalEntityId,
            },
            subject: profileRequest(guest).subject,
            tenantId: unitPriceFixtureTenantId,
          },
        ]);
        expect(guestVerified.evidence.subjectAuthority.kind).toBe('GUEST');
        expect(profileVerified.evidence.subjectAuthority.kind).toBe('PROFILE');
        expect(yield* encodeJson({ evidence: guestVerified.evidence, payload: payloads[0] })).not.toContain(
          principalId,
        );
      }),
  );

  it.effect('fails closed before owner verification when Pricing trusted scope does not bind the request', () =>
    Effect.gen(function* rejectsUntrustedScope() {
      const request = yield* guestRequest;
      let issued = false;
      let executed = false;
      const issuer = {
        issue: () => {
          issued = true;
          return Effect.succeed({
            baseUrl: new URL('https://commerce-customer-context.example.test'),
            credential: Redacted.make('Bearer must-not-be-issued'),
          });
        },
      } satisfies CurrentPricingDecisionCustomerContextGatewayIssuerService;
      const authority = yield* currentPricingDecisionCustomerContextSubjectAuthorityFromEnvironment(
        requestCorrelation,
        compositionRevision,
        (payload) => {
          executed = true;
          return Effect.succeed(verifiedOwnerResponse(payload));
        },
      ).pipe(Effect.provideService(CurrentPricingDecisionCustomerContextGatewayIssuer, issuer));

      const failure = yield* authority
        .verify({ request, scope: { principal: foreignPrincipal, sellingLegalEntityId: foreignLegalEntityId } })
        .pipe(Effect.flip);

      expect(
        Match.value(failure).pipe(
          Match.tag(
            'CurrentPricingDecisionSubjectAuthorityUnverifiable',
            ({ reason, retryable }) => reason === 'OWNER_EVIDENCE_UNVERIFIABLE' && retryable,
          ),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      expect(issued).toBe(false);
      expect(executed).toBe(false);
    }),
  );

  it.effect('rejects Profile owner evidence that does not bind the authenticated customer principal', () =>
    Effect.gen(function* rejectsDifferentActingPrincipal() {
      const guest = yield* guestRequest;
      const request = profileRequest(guest);
      const issuer = {
        issue: () =>
          Effect.succeed({
            baseUrl: new URL('https://commerce-customer-context.example.test'),
            credential: Redacted.make('Bearer fresh-same-principal-assertion'),
          }),
      } satisfies CurrentPricingDecisionCustomerContextGatewayIssuerService;
      const authority = yield* currentPricingDecisionCustomerContextSubjectAuthorityFromEnvironment(
        requestCorrelation,
        compositionRevision,
        (payload) => {
          const response = verifiedOwnerResponse(payload);
          return Match.value(response).pipe(
            Match.when({ outcome: 'PURCHASE_CONTEXT_VERIFIED' }, (verified) =>
              Effect.succeed({
                ...verified,
                evidence: {
                  ...verified.evidence,
                  subjectAuthority: {
                    ...verified.evidence.subjectAuthority,
                    actorPrincipalId: foreignEvidencePrincipalId,
                  },
                },
              }),
            ),
            Match.orElse(() => Effect.die('The fixture must produce verified Customer Context evidence')),
          );
        },
      ).pipe(Effect.provideService(CurrentPricingDecisionCustomerContextGatewayIssuer, issuer));

      const failure = yield* authority
        .verify({ request, scope: { principal, sellingLegalEntityId: legalEntityId } })
        .pipe(Effect.flip);

      expect(
        Match.value(failure).pipe(
          Match.tag(
            'CurrentPricingDecisionSubjectAuthorityUnverifiable',
            ({ reason, retryable }) => reason === 'OWNER_EVIDENCE_UNVERIFIABLE' && retryable,
          ),
          Match.orElse(() => false),
        ),
      ).toBe(true);
    }),
  );
});
