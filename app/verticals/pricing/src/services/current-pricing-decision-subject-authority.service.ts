import type { TrustedPrincipalContext } from '@app/core-runtime';
import type { PricingPurchaseContextVerificationEvidence } from '@app/commerce-customer-context/api/pricing-purchase-context-verification';
import type { CurrentPricingDecisionRequest } from '@app/pricing-contracts/current-pricing-decision';
import { Context, Data, Effect } from 'effect';
import type { Redacted } from 'effect';

export interface CurrentPricingDecisionSubjectAuthorityScope {
  /** Exact trusted caller context received by Pricing; used to mint a fresh CCC-audience assertion. */
  readonly principal: TrustedPrincipalContext;
  readonly sellingLegalEntityId: string;
}

export interface CurrentPricingDecisionSubjectAuthorityInput {
  /**
   * The complete request is one indivisible authority binding. In particular, the owner verifies
   * the exact subject, Purchase Context revision, operation time, and Pricing Decision rather than
   * accepting independently reusable references.
   */
  readonly request: CurrentPricingDecisionRequest;
  readonly scope: CurrentPricingDecisionSubjectAuthorityScope;
}

export interface CurrentPricingDecisionSubjectAuthorityVerified {
  readonly evidence: CurrentPricingDecisionSubjectAuthorityEvidence;
  readonly input: CurrentPricingDecisionSubjectAuthorityInput;
  readonly kind: 'CURRENT_PRICING_DECISION_SUBJECT_AUTHORITY_VERIFIED';
}

export type CurrentPricingDecisionSubjectAuthorityEvidence = PricingPurchaseContextVerificationEvidence;

export const CurrentPricingDecisionSubjectAuthorityRejected = Data.TaggedError(
  'CurrentPricingDecisionSubjectAuthorityRejected',
)<{
  readonly reason: 'SUBJECT_NOT_AUTHORIZED';
}>;
export type CurrentPricingDecisionSubjectAuthorityRejectedError = InstanceType<
  typeof CurrentPricingDecisionSubjectAuthorityRejected
>;

export const CurrentPricingDecisionSubjectAuthorityUnavailable = Data.TaggedError(
  'CurrentPricingDecisionSubjectAuthorityUnavailable',
)<{
  readonly reason: 'OWNER_VERIFICATION_UNAVAILABLE';
  readonly retryable: true;
}>;
export type CurrentPricingDecisionSubjectAuthorityUnavailableError = InstanceType<
  typeof CurrentPricingDecisionSubjectAuthorityUnavailable
>;

export const CurrentPricingDecisionSubjectAuthorityUnverifiable = Data.TaggedError(
  'CurrentPricingDecisionSubjectAuthorityUnverifiable',
)<{
  readonly reason: 'OWNER_EVIDENCE_UNVERIFIABLE';
  readonly retryable: true;
}>;
export type CurrentPricingDecisionSubjectAuthorityUnverifiableError = InstanceType<
  typeof CurrentPricingDecisionSubjectAuthorityUnverifiable
>;

export type CurrentPricingDecisionSubjectAuthorityFailure =
  | CurrentPricingDecisionSubjectAuthorityRejectedError
  | CurrentPricingDecisionSubjectAuthorityUnavailableError
  | CurrentPricingDecisionSubjectAuthorityUnverifiableError;

export interface CurrentPricingDecisionCustomerContextGatewayConnection {
  readonly baseUrl: URL;
  readonly credential: Redacted.Redacted;
}

export const CurrentPricingDecisionCustomerContextGatewayUnavailable = Data.TaggedError(
  'CurrentPricingDecisionCustomerContextGatewayUnavailable',
)<{
  readonly reason: 'GATEWAY_ISSUER_UNAVAILABLE' | 'SAME_PRINCIPAL_ASSERTION_UNAVAILABLE';
}>;
export type CurrentPricingDecisionCustomerContextGatewayUnavailableError = InstanceType<
  typeof CurrentPricingDecisionCustomerContextGatewayUnavailable
>;

export interface CurrentPricingDecisionCustomerContextGatewayIssuerService {
  readonly issue: (input: {
    readonly audience: 'commerce-customer-context';
    readonly principal: TrustedPrincipalContext;
    readonly requestCorrelation: string;
  }) => Effect.Effect<
    CurrentPricingDecisionCustomerContextGatewayConnection,
    CurrentPricingDecisionCustomerContextGatewayUnavailableError
  >;
}

/** Installed by the application composition that owns fresh same-principal assertion issuance. */
export class CurrentPricingDecisionCustomerContextGatewayIssuer extends Context.Service<
  CurrentPricingDecisionCustomerContextGatewayIssuer,
  CurrentPricingDecisionCustomerContextGatewayIssuerService
>()(
  '@app/pricing/services/current-pricing-decision-subject-authority.service/CurrentPricingDecisionCustomerContextGatewayIssuer',
) {}

export const unavailableCurrentPricingDecisionCustomerContextGatewayIssuer: CurrentPricingDecisionCustomerContextGatewayIssuerService =
  Object.freeze({
    issue: () =>
      Effect.fail(
        new CurrentPricingDecisionCustomerContextGatewayUnavailable({
          reason: 'GATEWAY_ISSUER_UNAVAILABLE',
        }),
      ),
  });

export interface CurrentPricingDecisionSubjectAuthorityService {
  readonly verify: (
    input: CurrentPricingDecisionSubjectAuthorityInput,
  ) => Effect.Effect<CurrentPricingDecisionSubjectAuthorityVerified, CurrentPricingDecisionSubjectAuthorityFailure>;
}

/** Customer Context supplies this verifier; Pricing never derives subject authority from claims. */
export class CurrentPricingDecisionSubjectAuthority extends Context.Service<
  CurrentPricingDecisionSubjectAuthority,
  CurrentPricingDecisionSubjectAuthorityService
>()(
  '@app/pricing/services/current-pricing-decision-subject-authority.service/CurrentPricingDecisionSubjectAuthority',
) {}
