import { PricingPurchaseContextVerificationRequestSchema } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import { executePricingPurchaseContextVerificationWithAuthorization } from '@app/commerce-customer-context/api/pricing-purchase-context-verification/client';
import {
  CurrentPricingDecisionRequestSchema,
  PricingDecisionSubjectSchema,
} from '@app/pricing-contracts/current-pricing-decision';
import { Effect, Match, Option, Redacted, Schema } from 'effect';

import {
  CurrentPricingDecisionCustomerContextGatewayIssuer,
  CurrentPricingDecisionSubjectAuthorityRejected,
  CurrentPricingDecisionSubjectAuthorityUnavailable,
  CurrentPricingDecisionSubjectAuthorityUnverifiable,
  unavailableCurrentPricingDecisionCustomerContextGatewayIssuer,
} from '../services/current-pricing-decision-subject-authority.service.ts';
import type {
  CurrentPricingDecisionCustomerContextGatewayIssuerService,
  CurrentPricingDecisionSubjectAuthorityFailure,
  CurrentPricingDecisionSubjectAuthorityInput,
  CurrentPricingDecisionSubjectAuthorityService,
  CurrentPricingDecisionSubjectAuthorityVerified,
} from '../services/current-pricing-decision-subject-authority.service.ts';

type VerificationRequest = Parameters<typeof executePricingPurchaseContextVerificationWithAuthorization>[0];
type VerificationEffect = ReturnType<typeof executePricingPurchaseContextVerificationWithAuthorization>;
type VerificationResponse = VerificationEffect extends Effect.Effect<infer Success, unknown, unknown> ? Success : never;
type VerificationFailure = VerificationEffect extends Effect.Effect<unknown, infer Failure, unknown> ? Failure : never;
type VerificationExecutor = (
  payload: VerificationRequest,
  credential: Redacted.Redacted,
  requestCorrelation: string,
  options: { readonly baseUrl: URL; readonly compositionRevision: string },
) => Effect.Effect<VerificationResponse, VerificationFailure>;

const executeVerification: VerificationExecutor = (payload, credential, requestCorrelation, options) =>
  executePricingPurchaseContextVerificationWithAuthorization(
    payload,
    Redacted.value(credential),
    requestCorrelation,
    options,
  );

const rejected = () => new CurrentPricingDecisionSubjectAuthorityRejected({ reason: 'SUBJECT_NOT_AUTHORIZED' });
const unavailable = (cause?: unknown) => {
  const failure = new CurrentPricingDecisionSubjectAuthorityUnavailable({
    reason: 'OWNER_VERIFICATION_UNAVAILABLE',
    retryable: true,
  });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};
const unverifiable = (cause?: unknown) => {
  const failure = new CurrentPricingDecisionSubjectAuthorityUnverifiable({
    reason: 'OWNER_EVIDENCE_UNVERIFIABLE',
    retryable: true,
  });
  return cause === undefined ? failure : Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
};

const sameRequest = Schema.toEquivalence(PricingPurchaseContextVerificationRequestSchema);
const sameSubject = Schema.toEquivalence(CurrentPricingDecisionRequestSchema.fields.subject);

const requestPayload = (input: CurrentPricingDecisionSubjectAuthorityInput) => {
  const { commercialScope, operationTime, purchasingContext, tenantId } = input.request.decision;
  const { principal, sellingLegalEntityId } = input.scope;
  if (
    tenantId !== principal.tenantId ||
    commercialScope.sellingLegalEntityId !== sellingLegalEntityId ||
    principal.legalEntityId !== sellingLegalEntityId
  ) {
    return Effect.fail(unverifiable());
  }
  return Schema.decodeUnknownEffect(PricingPurchaseContextVerificationRequestSchema, {
    onExcessProperty: 'error',
  })({
    actor:
      input.request.subject.kind === 'PROFILE'
        ? { kind: 'AUTHENTICATED_CUSTOMER', principalId: principal.principalId }
        : { kind: 'GUEST' },
    operationTime,
    purchasingContext: {
      channelId: commercialScope.channelId,
      contextRef: purchasingContext.contextRef,
      contextRevision: purchasingContext.contextRevision,
      marketId: commercialScope.marketId,
      sellingLegalEntityId: commercialScope.sellingLegalEntityId,
    },
    subject: input.request.subject,
    tenantId,
  }).pipe(Effect.mapError((cause) => unverifiable(cause)));
};

const mapOwnerResponse = (
  input: CurrentPricingDecisionSubjectAuthorityInput,
  payload: VerificationRequest,
  response: VerificationResponse,
): Effect.Effect<CurrentPricingDecisionSubjectAuthorityVerified, CurrentPricingDecisionSubjectAuthorityFailure> => {
  if (!sameRequest(response.request, payload)) {
    return Effect.fail(unverifiable());
  }
  return Match.value(response).pipe(
    Match.when({ outcome: 'PURCHASE_CONTEXT_VERIFIED' as const }, (verified) => {
      if (
        verified.evidence.ownerRef !== payload.purchasingContext.contextRef ||
        verified.evidence.ownerRevisionRef !== payload.purchasingContext.contextRevision ||
        verified.evidence.currentness.evaluatedAt !== payload.operationTime ||
        verified.evidence.verifiedScope.tenantId !== payload.tenantId ||
        verified.evidence.verifiedScope.legalEntityId !== payload.purchasingContext.sellingLegalEntityId ||
        verified.evidence.verifiedScope.channelId !== payload.purchasingContext.channelId ||
        verified.evidence.verifiedScope.marketId !== payload.purchasingContext.marketId ||
        verified.evidence.subjectAuthority.kind !== payload.subject.kind ||
        !Schema.is(PricingDecisionSubjectSchema)(verified.evidence.subjectAuthority.subject) ||
        !sameSubject(verified.evidence.subjectAuthority.subject, input.request.subject) ||
        (payload.actor.kind === 'AUTHENTICATED_CUSTOMER' &&
          verified.evidence.subjectAuthority.kind === 'PROFILE' &&
          verified.evidence.subjectAuthority.actorPrincipalId !== payload.actor.principalId)
      ) {
        return Effect.fail(unverifiable());
      }
      return Effect.succeed({
        evidence: verified.evidence,
        input,
        kind: 'CURRENT_PRICING_DECISION_SUBJECT_AUTHORITY_VERIFIED' as const,
      });
    }),
    Match.when({ outcome: 'PURCHASE_CONTEXT_MISMATCH' as const }, () => Effect.fail(rejected())),
    Match.when({ outcome: 'PURCHASE_CONTEXT_STALE' as const }, () => Effect.fail(unavailable())),
    Match.when({ outcome: 'PURCHASE_CONTEXT_UNAVAILABLE' as const }, () => Effect.fail(unavailable())),
    Match.when({ outcome: 'PURCHASE_CONTEXT_UNVERIFIABLE' as const }, () => Effect.fail(unverifiable())),
    Match.exhaustive,
  );
};

const makeCustomerContextSubjectAuthority = (dependencies: {
  readonly compositionRevision: string;
  readonly execute: VerificationExecutor;
  readonly issuer: CurrentPricingDecisionCustomerContextGatewayIssuerService;
  readonly requestCorrelation: string;
}): CurrentPricingDecisionSubjectAuthorityService => ({
  verify: (input) =>
    requestPayload(input).pipe(
      Effect.flatMap((payload) =>
        dependencies.issuer
          .issue({
            audience: 'commerce-customer-context',
            compositionRevision: dependencies.compositionRevision,
            principal: input.scope.principal,
            requestCorrelation: dependencies.requestCorrelation,
          })
          .pipe(
            Effect.flatMap(({ baseUrl, credential }) =>
              dependencies.execute(payload, credential, dependencies.requestCorrelation, {
                baseUrl,
                compositionRevision: dependencies.compositionRevision,
              }),
            ),
            Effect.mapError((cause) => unavailable(cause)),
            Effect.flatMap((response) => mapOwnerResponse(input, payload, response)),
          ),
      ),
    ),
});

export const currentPricingDecisionCustomerContextSubjectAuthorityFromEnvironment = (
  requestCorrelation: string,
  compositionRevision: string,
  execute: VerificationExecutor = executeVerification,
): Effect.Effect<CurrentPricingDecisionSubjectAuthorityService> =>
  Effect.serviceOption(CurrentPricingDecisionCustomerContextGatewayIssuer).pipe(
    Effect.map((issuerOption) =>
      makeCustomerContextSubjectAuthority({
        compositionRevision,
        execute,
        issuer: Option.isSome(issuerOption)
          ? issuerOption.value
          : unavailableCurrentPricingDecisionCustomerContextGatewayIssuer,
        requestCorrelation,
      }),
    ),
  );
