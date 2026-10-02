import { TenantIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { Context, Effect, Layer, Match, Option, Schema } from 'effect';

import {
  PricingPurchaseContextLegalEntityIdSchema,
  PricingPurchaseContextSchema,
  PricingPurchaseContextVerificationEvidenceSchema,
  PricingPurchaseContextActorSchema,
  PricingPurchaseContextVerificationResponseSchema,
} from '../../shared/apis/pricing-purchase-context-verification.ts';
import type {
  PricingPurchaseContextVerificationEvidence,
  PricingPurchaseContextVerificationRequest,
  PricingPurchaseContextVerificationResponse,
} from '../../shared/apis/pricing-purchase-context-verification.ts';
import { PurchaseCurrencySubjectSchema } from '../../shared/domain/purchase-currency-resolution.ts';

export const PricingPurchaseContextOwnerUnavailable = Schema.TaggedError<Error>()(
  'PricingPurchaseContextOwnerUnavailable',
  { reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed()) },
);
export type PricingPurchaseContextOwnerUnavailableError = InstanceType<typeof PricingPurchaseContextOwnerUnavailable>;

export const PricingPurchaseContextOwnerUnverifiable = Schema.TaggedError<Error>()(
  'PricingPurchaseContextOwnerUnverifiable',
  { reason: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed()) },
);
export type PricingPurchaseContextOwnerUnverifiableError = InstanceType<typeof PricingPurchaseContextOwnerUnverifiable>;

export interface PricingPurchaseContextOwnerObservation {
  readonly actor: PricingPurchaseContextVerificationRequest['actor'];
  readonly evidence: PricingPurchaseContextVerificationEvidence;
  readonly legalEntityId: string;
  readonly purchasingContext: PricingPurchaseContextVerificationRequest['purchasingContext'];
  readonly subject: PricingPurchaseContextVerificationRequest['subject'];
  readonly tenantId: string;
}

export interface PricingPurchaseContextOwnerAuthorityPort {
  /**
   * Reads owner state for the exact claimed identity. Implementations must validate the durable
   * Profile/Guest session and Party authority; the request is a lookup selector, never proof.
   */
  readonly readCurrent: (input: {
    /** Authenticated application/service caller; never substituted for the customer actor. */
    readonly callingPrincipalId: string;
    readonly legalEntityId: string;
    readonly request: PricingPurchaseContextVerificationRequest;
    readonly trustedTenantId: string;
  }) => Effect.Effect<
    Option.Option<PricingPurchaseContextOwnerObservation>,
    PricingPurchaseContextOwnerUnavailableError | PricingPurchaseContextOwnerUnverifiableError
  >;
}

export class PricingPurchaseContextOwnerAuthority extends Context.Service<
  PricingPurchaseContextOwnerAuthority,
  PricingPurchaseContextOwnerAuthorityPort
>()(
  '@app/commerce-customer-context/services/pricing-purchase-context-owner-authority/PricingPurchaseContextOwnerAuthority',
) {}

const unavailablePricingPurchaseContextOwnerAuthority: PricingPurchaseContextOwnerAuthorityPort = Object.freeze({
  readCurrent: () =>
    Effect.fail(
      new PricingPurchaseContextOwnerUnavailable({
        reason: 'The owner-authoritative Profile, Guest session, Party, and Purchase Context reader is unavailable',
      }),
    ),
});

/**
 * Explicit deployment blocker until an approved owner writer/provider exists. This is intentionally
 * installed by production composition rather than selected as a hidden service fallback.
 */
export const pricingPurchaseContextOwnerAuthorityUnavailableLive = Layer.succeed(
  PricingPurchaseContextOwnerAuthority,
  unavailablePricingPurchaseContextOwnerAuthority,
);

export interface PricingPurchaseContextVerificationServices {
  readonly verify: (
    request: PricingPurchaseContextVerificationRequest,
    scope: {
      readonly callingPrincipalId: string;
      readonly legalEntityId: string;
      readonly tenantId: string;
    },
  ) => Effect.Effect<PricingPurchaseContextVerificationResponse>;
}

export class PricingPurchaseContextVerification extends Context.Service<
  PricingPurchaseContextVerification,
  PricingPurchaseContextVerificationServices
>()(
  '@app/commerce-customer-context/services/pricing-purchase-context-owner-authority/PricingPurchaseContextVerification',
) {}

const sameSubject = Schema.toEquivalence(PurchaseCurrencySubjectSchema);
const sameActor = Schema.toEquivalence(PricingPurchaseContextActorSchema);
const PricingPurchaseContextIdentitySchema = Schema.Struct({
  channelId: PricingPurchaseContextSchema.fields.channelId,
  contextRef: PricingPurchaseContextSchema.fields.contextRef,
  marketId: PricingPurchaseContextSchema.fields.marketId,
  sellingLegalEntityId: PricingPurchaseContextSchema.fields.sellingLegalEntityId,
});
const samePurchaseContextIdentity = Schema.toEquivalence(PricingPurchaseContextIdentitySchema);
const sameVerifiedScope = Schema.toEquivalence(PricingPurchaseContextVerificationEvidenceSchema.fields.verifiedScope);
const observationSchema = Schema.Struct({
  actor: PricingPurchaseContextActorSchema,
  evidence: PricingPurchaseContextVerificationEvidenceSchema,
  legalEntityId: PricingPurchaseContextLegalEntityIdSchema,
  purchasingContext: PricingPurchaseContextSchema,
  subject: PurchaseCurrencySubjectSchema,
  tenantId: TenantIdSchema,
});

const checkedResponse = (
  response: PricingPurchaseContextVerificationResponse,
): Effect.Effect<PricingPurchaseContextVerificationResponse> =>
  Schema.decodeEffect(PricingPurchaseContextVerificationResponseSchema, { onExcessProperty: 'error' })(response).pipe(
    Effect.orDie,
  );

const mismatch = (
  request: PricingPurchaseContextVerificationRequest,
  reason: Extract<
    PricingPurchaseContextVerificationResponse,
    { readonly outcome: 'PURCHASE_CONTEXT_MISMATCH' }
  >['reason'],
) => checkedResponse({ outcome: 'PURCHASE_CONTEXT_MISMATCH', reason, request });

const ownerFailure = (
  request: PricingPurchaseContextVerificationRequest,
  failure: PricingPurchaseContextOwnerUnavailableError | PricingPurchaseContextOwnerUnverifiableError,
) =>
  checkedResponse(
    Match.value(failure).pipe(
      Match.tag('PricingPurchaseContextOwnerUnavailable', ({ reason }) => ({
        outcome: 'PURCHASE_CONTEXT_UNAVAILABLE' as const,
        reason,
        request,
        retryable: true as const,
      })),
      Match.tag('PricingPurchaseContextOwnerUnverifiable', ({ reason }) => ({
        outcome: 'PURCHASE_CONTEXT_UNVERIFIABLE' as const,
        reason,
        request,
        retryable: true as const,
      })),
      Match.exhaustive,
    ),
  );

const classifyObservation = (
  request: PricingPurchaseContextVerificationRequest,
  scope: {
    readonly callingPrincipalId: string;
    readonly legalEntityId: string;
    readonly tenantId: string;
  },
  observation: PricingPurchaseContextOwnerObservation,
): Effect.Effect<PricingPurchaseContextVerificationResponse> => {
  const expectedVerifiedScope = {
    channelId: request.purchasingContext.channelId,
    legalEntityId: request.purchasingContext.sellingLegalEntityId,
    marketId: request.purchasingContext.marketId,
    tenantId: request.tenantId,
  };
  if (
    observation.legalEntityId !== scope.legalEntityId ||
    !sameVerifiedScope(observation.evidence.verifiedScope, expectedVerifiedScope)
  ) {
    return mismatch(request, 'TRUSTED_SCOPE_MISMATCH');
  }
  if (observation.tenantId !== request.tenantId || !sameActor(observation.actor, request.actor)) {
    return mismatch(request, request.subject.kind === 'PROFILE' ? 'PROFILE_NOT_AUTHORIZED' : 'GUEST_NOT_AUTHORIZED');
  }
  if (!sameSubject(observation.subject, request.subject)) {
    return mismatch(request, request.subject.kind === 'PROFILE' ? 'PROFILE_NOT_AUTHORIZED' : 'GUEST_NOT_AUTHORIZED');
  }
  if (!samePurchaseContextIdentity(observation.purchasingContext, request.purchasingContext)) {
    return mismatch(request, 'PURCHASING_CONTEXT_MISMATCH');
  }
  if (
    observation.evidence.subjectAuthority.kind !== request.subject.kind ||
    !sameSubject(observation.evidence.subjectAuthority.subject, request.subject)
  ) {
    return mismatch(request, request.subject.kind === 'PROFILE' ? 'PARTY_AUTHORITY_MISMATCH' : 'GUEST_NOT_AUTHORIZED');
  }
  if (
    request.actor.kind === 'AUTHENTICATED_CUSTOMER' &&
    observation.evidence.subjectAuthority.kind === 'PROFILE' &&
    observation.evidence.subjectAuthority.actorPrincipalId !== request.actor.principalId
  ) {
    return mismatch(request, 'PROFILE_NOT_AUTHORIZED');
  }
  if (
    observation.purchasingContext.contextRevision !== request.purchasingContext.contextRevision ||
    observation.evidence.ownerRevisionRef !== request.purchasingContext.contextRevision
  ) {
    return checkedResponse({
      currentContextRevision: observation.purchasingContext.contextRevision,
      evidence: observation.evidence,
      outcome: 'PURCHASE_CONTEXT_STALE',
      request,
      retryable: true,
    });
  }
  if (
    observation.evidence.ownerRef !== request.purchasingContext.contextRef ||
    observation.evidence.currentness.evaluatedAt !== request.operationTime
  ) {
    return checkedResponse({
      outcome: 'PURCHASE_CONTEXT_UNVERIFIABLE',
      reason: 'Owner evidence does not bind the exact Purchase Context reference and operation time',
      request,
      retryable: true,
    });
  }
  return checkedResponse({
    evidence: observation.evidence,
    outcome: 'PURCHASE_CONTEXT_VERIFIED',
    request,
  });
};

export const makePricingPurchaseContextVerificationServices = (
  authority: PricingPurchaseContextOwnerAuthorityPort,
): PricingPurchaseContextVerificationServices => ({
  verify: (request, scope) => {
    if (
      request.tenantId !== scope.tenantId ||
      request.purchasingContext.sellingLegalEntityId !== scope.legalEntityId ||
      (request.actor.kind === 'AUTHENTICATED_CUSTOMER' && request.actor.principalId !== scope.callingPrincipalId)
    ) {
      return mismatch(request, 'TRUSTED_SCOPE_MISMATCH');
    }
    return authority
      .readCurrent({
        callingPrincipalId: scope.callingPrincipalId,
        legalEntityId: scope.legalEntityId,
        request,
        trustedTenantId: scope.tenantId,
      })
      .pipe(
        Effect.matchEffect({
          onFailure: (failure) => ownerFailure(request, failure),
          onSuccess: (observationOption) => {
            if (Option.isNone(observationOption)) {
              return mismatch(
                request,
                request.subject.kind === 'PROFILE' ? 'PROFILE_NOT_AUTHORIZED' : 'GUEST_NOT_AUTHORIZED',
              );
            }
            return Schema.decodeEffect(observationSchema, { onExcessProperty: 'error' })(observationOption.value).pipe(
              Effect.matchEffect({
                onFailure: () =>
                  checkedResponse({
                    outcome: 'PURCHASE_CONTEXT_UNVERIFIABLE',
                    reason: 'Owner returned malformed Purchase Context authority evidence',
                    request,
                    retryable: true,
                  }),
                onSuccess: (observation) => classifyObservation(request, scope, observation),
              }),
            );
          },
        }),
      );
  },
});

export const pricingPurchaseContextVerificationLive = Layer.effect(
  PricingPurchaseContextVerification,
  Effect.service(PricingPurchaseContextOwnerAuthority).pipe(Effect.map(makePricingPurchaseContextVerificationServices)),
);
