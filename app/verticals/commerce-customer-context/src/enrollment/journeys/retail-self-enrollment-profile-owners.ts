import type { PartyRef } from '@app/party-registry/resources/party';
import { DateTime, Effect, Redacted, Schema } from 'effect';
import type { Crypto } from 'effect';

import { BindRetailPortalProfilePayloadSchema } from '../../../shared/actions/bind-retail-portal-profile.ts';
import type { RetailPortalBindingResult } from '../../../shared/actions/bind-retail-portal-profile.ts';
import {
  EnsureRetailCustomerProfilePayloadSchema,
  EnsureRetailCustomerProfileResultSchema,
} from '../../../shared/actions/ensure-retail-customer-profile.ts';
import type { EnsureRetailCustomerProfileResult } from '../../../shared/actions/ensure-retail-customer-profile.ts';
import type { SellingLegalEntityRefSchema } from '../../../shared/domain/profile-contracts.ts';
import type { ReconcileEnrollmentResolution } from '../../../shared/enrollment-contracts.ts';
import type { RetailCustomerProfileRefSchema } from '../../../shared/resources/retail-customer-profile.ts';
import type { RetailPortalPrincipalRefSchema } from '../../../shared/resources/retail-portal-profile-binding.ts';
import { executeBindRetailPortalProfileWithAuthorization } from '../../api/bind-retail-portal-profile-action-client.ts';
import { executeEnsureRetailCustomerProfileWithAuthorization } from '../../api/ensure-retail-customer-profile-action-client.ts';
import {
  decodeOwnerOutcome,
  decodeOwnerResolution,
  ownerRejected,
  ownerUnavailable,
} from '../orchestration/owner-effect-codec.ts';
import type { OwnerOutcomeDraft, OwnerResolutionDraft } from '../orchestration/owner-effect-codec.ts';
import type {
  CommerceEnrollmentOwnerEffect,
  CommerceEnrollmentOwnerEffectOutcome,
  CommerceEnrollmentOwnerReconciliationInput,
  CommerceEnrollmentOwnerTransition,
} from '../orchestration/owner-transition-driver.ts';
import type { CommerceEnrollmentOwnerEffectError } from '../orchestration/owner-transition-errors.ts';
import {
  OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE,
  RETAIL_CUSTOMER_PROFILE_ENSURED_OUTCOME_CODE,
  RETAIL_PORTAL_GRANTS_INCOMPLETE_OUTCOME_CODE,
  RETAIL_PORTAL_PROFILE_BOUND_OUTCOME_CODE,
  retailSelfEnrollmentEvidenceReference,
} from './retail-self-enrollment-contracts.ts';
import { acquireRetailOwnerCredential } from './retail-owner-gateway-credential.ts';
import type { RetailEnrollmentOriginator } from './retail-owner-gateway-credential.ts';

/**
 * The two Commerce-owned Retail self-enrollment transitions: ensure the Retail Customer Profile,
 * then activate the Retail Portal Profile Binding.
 *
 * This vertical has no separate retail grant Action: the binding Action grants the reviewed
 * baseline in its own transaction. A binding whose baseline is not Current is recorded as
 * `retail_portal_grants_incomplete` so the journey halts rather than reporting portal access that
 * does not exist.
 *
 * Both dispatch under the immutable owner invocation as idempotency key; a timeout after commit
 * reconciles through the Action commit resolution port, never through a second dispatch.
 */

type EnsureProfilePayload = Parameters<typeof executeEnsureRetailCustomerProfileWithAuthorization>[0];
type EnsureProfileError =
  | Effect.Error<ReturnType<typeof executeEnsureRetailCustomerProfileWithAuthorization>>
  | CommerceEnrollmentOwnerEffectError;
type BindProfilePayload = Parameters<typeof executeBindRetailPortalProfileWithAuthorization>[0];
type BindProfileError =
  | Effect.Error<ReturnType<typeof executeBindRetailPortalProfileWithAuthorization>>
  | CommerceEnrollmentOwnerEffectError;

export class CommerceActionCommitResolutionFailed extends Schema.TaggedError<CommerceActionCommitResolutionFailed>()(
  'CommerceActionCommitResolutionFailed',
  {
    code: Schema.Literals(['commit_resolution_unavailable', 'commit_resolution_rejected']),
    reason: Schema.String.check(Schema.isTrimmed(), Schema.isMinLength(1), Schema.isMaxLength(500)),
  },
) {}

type CommerceActionCommitState<Result> =
  | { readonly result: Result; readonly state: 'COMMITTED' }
  | { readonly state: 'OPEN' };

/**
 * Exact read of one Commerce Action invocation's committed result.  It resolves commit state and
 * returns the durable result; it never dispatches the Action again.
 */
export type CommerceActionCommitResolution<Result> = (
  invocationId: string,
) => Effect.Effect<CommerceActionCommitState<Result>, CommerceActionCommitResolutionFailed>;

export interface RetailCustomerProfileOwnerInput {
  readonly compositionRevision: string;
  readonly crypto: Crypto.Crypto;
  /** Stable for the Attempt, so an equivalent retry produces an identical Action payload. */
  readonly effectiveAt: DateTime.Utc;
  readonly originator: RetailEnrollmentOriginator;
  readonly partyRef: PartyRef;
  readonly requestCorrelation: string;
  readonly sellingLegalEntityRef: typeof SellingLegalEntityRefSchema.Type;
}

export interface RetailCustomerProfileOwnerExecutors {
  readonly commitResolution: CommerceActionCommitResolution<EnsureRetailCustomerProfileResult>;
  readonly ensureProfile: (
    payload: EnsureProfilePayload,
    requestCorrelation: string,
    options: { readonly idempotencyKey: string },
  ) => Effect.Effect<EnsureRetailCustomerProfileResult, EnsureProfileError>;
}

export interface RetailPortalBindingOwnerInput {
  readonly compositionRevision: string;
  readonly crypto: Crypto.Crypto;
  readonly effectiveAt: DateTime.Utc;
  /** Opaque, non-secret reference to the Attempt evidence the binding Action re-verifies. */
  readonly enrollmentEvidenceRef: string;
  readonly originator: RetailEnrollmentOriginator;
  readonly principalRef: typeof RetailPortalPrincipalRefSchema.Type;
  readonly profileRef: typeof RetailCustomerProfileRefSchema.Type;
  readonly reason: string;
  readonly requestCorrelation: string;
  readonly sellingLegalEntityRef: typeof SellingLegalEntityRefSchema.Type;
}

export interface RetailPortalBindingOwnerExecutors {
  readonly bindProfile: (
    payload: BindProfilePayload,
    requestCorrelation: string,
    options: { readonly idempotencyKey: string },
  ) => Effect.Effect<RetailPortalBindingResult, BindProfileError>;
  readonly commitResolution: CommerceActionCommitResolution<RetailPortalBindingResult>;
  /** A terminal owner row is conjunctive with the exact live Permission baseline. Missing fails closed. */
  readonly confirmCurrentBinding?: (
    result: RetailPortalBindingResult,
  ) => Effect.Effect<boolean, CommerceActionCommitResolutionFailed>;
}

/** The journey's reading of one Commerce Action result, before it becomes an Attempt outcome. */
type CommerceOwnerVerdict =
  | { readonly kind: 'SUCCEEDED'; readonly outcomeCode: string; readonly resourceId: string }
  | { readonly kind: 'RECONCILE'; readonly outcomeCode: string; readonly reason: string }
  | { readonly kind: 'REJECTED'; readonly outcomeCode: string; readonly reason: string };

const COMMERCE_PROFILE_UNAVAILABLE_CODE = 'commerce_profile_unavailable';

const unavailable = (reason: string, cause?: unknown) =>
  ownerUnavailable(COMMERCE_PROFILE_UNAVAILABLE_CODE, reason, cause);

const decodeOutcome = (
  candidate: OwnerOutcomeDraft,
): Effect.Effect<CommerceEnrollmentOwnerEffectOutcome, CommerceEnrollmentOwnerEffectError> =>
  decodeOwnerOutcome(candidate, COMMERCE_PROFILE_UNAVAILABLE_CODE, 'The Commerce owner outcome is not representable');

const outcomeOf = (
  verdict: CommerceOwnerVerdict,
): Effect.Effect<CommerceEnrollmentOwnerEffectOutcome, CommerceEnrollmentOwnerEffectError> => {
  if (verdict.kind === 'SUCCEEDED') {
    return decodeOutcome({
      outcomeCode: verdict.outcomeCode,
      resultReference: verdict.resourceId,
      status: 'SUCCEEDED',
    });
  }
  if (verdict.kind === 'RECONCILE') {
    return decodeOutcome({
      failureCode: OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE,
      failureReason: verdict.reason.slice(0, 500),
      nextState: 'RECONCILIATION_REQUIRED',
      outcomeCode: verdict.outcomeCode,
      status: 'FAILED',
    });
  }
  return decodeOutcome({
    failureCode: 'owner_rejected',
    failureReason: verdict.reason.slice(0, 500),
    outcomeCode: verdict.outcomeCode,
    status: 'FAILED',
  });
};

const decodeCommerceProfileResolution = (candidate: OwnerResolutionDraft) =>
  decodeOwnerResolution(
    candidate,
    COMMERCE_PROFILE_UNAVAILABLE_CODE,
    'The Commerce reconciliation result is not representable',
  );

const resolutionOf = (
  reconciliation: CommerceEnrollmentOwnerReconciliationInput,
  ownerKey: string,
  resourceId: string,
  verdict: CommerceOwnerVerdict,
): Effect.Effect<ReconcileEnrollmentResolution, CommerceEnrollmentOwnerEffectError> => {
  const reconciliationRef = retailSelfEnrollmentEvidenceReference([
    ownerKey,
    reconciliation.ownerInvocationId,
    resourceId,
  ]);
  if (verdict.kind === 'SUCCEEDED') {
    return decodeCommerceProfileResolution({
      actorPrincipalId: reconciliation.actorPrincipalId,
      outcomeCode: verdict.outcomeCode,
      reconciliationRef,
      resultReference: verdict.resourceId,
      status: 'SUCCEEDED',
    });
  }
  if (verdict.kind === 'RECONCILE') {
    return decodeCommerceProfileResolution({
      actorPrincipalId: reconciliation.actorPrincipalId,
      failureCode: OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE,
      failureReason: verdict.reason.slice(0, 500),
      nextState: 'RECONCILIATION_REQUIRED',
      outcomeCode: verdict.outcomeCode,
      reconciliationRef,
      status: 'FAILED',
    });
  }
  return decodeCommerceProfileResolution({
    actorPrincipalId: reconciliation.actorPrincipalId,
    failureCode: 'owner_rejected',
    failureReason: verdict.reason.slice(0, 500),
    outcomeCode: verdict.outcomeCode,
    reconciliationRef,
    status: 'FAILED',
  });
};

/** The Retail Customer Profile is usable only when the ensured profile is ACTIVE. */
const ensureVerdict = (result: EnsureRetailCustomerProfileResult): CommerceOwnerVerdict =>
  result.state === 'ACTIVE'
    ? {
        kind: 'SUCCEEDED',
        outcomeCode: RETAIL_CUSTOMER_PROFILE_ENSURED_OUTCOME_CODE,
        resourceId: result.profileRef.resourceId,
      }
    : {
        kind: 'REJECTED',
        outcomeCode: 'retail_customer_profile_not_active',
        reason: `The Commerce Retail Customer Profile is ${result.state} and cannot carry portal access`,
      };

/** The binding is written with its final authorization, so an ACTIVE grant carries the reviewed baseline. */
export const retailPortalGrantsAreComplete = (result: RetailPortalBindingResult): boolean =>
  result.authorizationOperation === 'grant' && result.authorizationState === 'ACTIVE';

const bindingVerdictFor = (result: RetailPortalBindingResult, currentBaseline: boolean): CommerceOwnerVerdict => {
  if (result.outcome !== 'BINDING_ACTIVATED' || result.state !== 'ACTIVE') {
    return {
      kind: 'REJECTED',
      outcomeCode: 'retail_portal_binding_not_active',
      reason: 'The Retail Portal Profile Binding did not activate for this enrollment',
    };
  }
  return retailPortalGrantsAreComplete(result) && currentBaseline
    ? {
        kind: 'SUCCEEDED',
        outcomeCode: RETAIL_PORTAL_PROFILE_BOUND_OUTCOME_CODE,
        resourceId: result.bindingRef.resourceId,
      }
    : {
        kind: 'RECONCILE',
        outcomeCode: RETAIL_PORTAL_GRANTS_INCOMPLETE_OUTCOME_CODE,
        reason: 'The Retail Portal binding committed without the complete reviewed Permission baseline',
      };
};

const bindingVerdict = (
  result: RetailPortalBindingResult,
  executors: RetailPortalBindingOwnerExecutors,
): Effect.Effect<CommerceOwnerVerdict, CommerceEnrollmentOwnerEffectError> => {
  if (!retailPortalGrantsAreComplete(result) || executors.confirmCurrentBinding === undefined) {
    return Effect.succeed(bindingVerdictFor(result, false));
  }
  return executors.confirmCurrentBinding(result).pipe(
    Effect.map((current) => bindingVerdictFor(result, current)),
    Effect.mapError((cause) => unavailable('The Retail Portal Current access observation is unavailable', cause)),
  );
};

const ENSURE_OWNER_KEY = 'commerce.customer-context.ensure-retail-customer-profile';
const BIND_OWNER_KEY = 'commerce.customer-context.bind-retail-portal-profile';

/** Owner effect for `commerce.customer-context.ensure-retail-customer-profile`. */
export const retailCustomerProfileOwnerEffect = (
  input: RetailCustomerProfileOwnerInput,
  executors: RetailCustomerProfileOwnerExecutors,
): CommerceEnrollmentOwnerEffect => {
  const payload = (): Effect.Effect<EnsureProfilePayload, CommerceEnrollmentOwnerEffectError> =>
    Schema.decodeEffect(EnsureRetailCustomerProfilePayloadSchema)({
      effectiveAt: DateTime.formatIso(input.effectiveAt),
      subject: {
        kind: 'RETAIL',
        partyRef: input.partyRef,
        sellingLegalEntityRef: input.sellingLegalEntityRef,
      },
      trigger: 'AUTHORIZED_ONBOARDING',
    }).pipe(Effect.mapError((cause) => unavailable('The Retail Customer Profile request is invalid', cause)));

  const dispatch = Effect.fn('RetailCustomerProfileOwnerEffect.dispatch')(function* dispatchEnsure(
    transition: CommerceEnrollmentOwnerTransition,
  ): Effect.fn.Return<CommerceEnrollmentOwnerEffectOutcome, CommerceEnrollmentOwnerEffectError> {
    const request = yield* payload();
    const result = yield* executors
      .ensureProfile(request, input.requestCorrelation, { idempotencyKey: transition.ownerInvocationId })
      .pipe(Effect.mapError((cause) => unavailable('The Retail Customer Profile Action is unavailable', cause)));
    return yield* outcomeOf(ensureVerdict(result));
  });

  const reconcile = Effect.fn('RetailCustomerProfileOwnerEffect.reconcile')(function* reconcileEnsure(
    reconciliation: CommerceEnrollmentOwnerReconciliationInput,
  ): Effect.fn.Return<ReconcileEnrollmentResolution, CommerceEnrollmentOwnerEffectError> {
    const resolved = yield* executors
      .commitResolution(reconciliation.ownerInvocationId)
      .pipe(
        Effect.mapError((cause) => unavailable('The Retail Customer Profile commit resolution is unavailable', cause)),
      );
    if (resolved.state === 'OPEN') {
      return yield* ownerRejected(
        'commerce_profile_commit_open',
        'The Commerce Action invocation has not committed yet and must be retried',
      );
    }
    return yield* resolutionOf(
      reconciliation,
      ENSURE_OWNER_KEY,
      resolved.result.profileRef.resourceId,
      ensureVerdict(resolved.result),
    );
  });

  return Object.freeze({ dispatch, reconcile });
};

/** Owner effect for `commerce.customer-context.bind-retail-portal-profile`, the retail grant path. */
export const retailPortalBindingOwnerEffect = (
  input: RetailPortalBindingOwnerInput,
  executors: RetailPortalBindingOwnerExecutors,
): CommerceEnrollmentOwnerEffect => {
  const payload = (): Effect.Effect<BindProfilePayload, CommerceEnrollmentOwnerEffectError> =>
    Schema.decodeEffect(BindRetailPortalProfilePayloadSchema)({
      effectiveAt: DateTime.formatIso(input.effectiveAt),
      enrollmentEvidenceRef: input.enrollmentEvidenceRef,
      expectedRevision: null,
      expectedState: null,
      principalRef: input.principalRef,
      profileRef: input.profileRef,
      reason: input.reason,
      sellingLegalEntityRef: input.sellingLegalEntityRef,
    }).pipe(Effect.mapError((cause) => unavailable('The Retail Portal Binding request is invalid', cause)));

  const dispatch = Effect.fn('RetailPortalBindingOwnerEffect.dispatch')(function* dispatchBinding(
    transition: CommerceEnrollmentOwnerTransition,
  ): Effect.fn.Return<CommerceEnrollmentOwnerEffectOutcome, CommerceEnrollmentOwnerEffectError> {
    const request = yield* payload();
    const result = yield* executors
      .bindProfile(request, input.requestCorrelation, { idempotencyKey: transition.ownerInvocationId })
      .pipe(Effect.mapError((cause) => unavailable('The Retail Portal Binding Action is unavailable', cause)));
    return yield* outcomeOf(yield* bindingVerdict(result, executors));
  });

  const reconcile = Effect.fn('RetailPortalBindingOwnerEffect.reconcile')(function* reconcileBinding(
    reconciliation: CommerceEnrollmentOwnerReconciliationInput,
  ): Effect.fn.Return<ReconcileEnrollmentResolution, CommerceEnrollmentOwnerEffectError> {
    const resolved = yield* executors
      .commitResolution(reconciliation.ownerInvocationId)
      .pipe(
        Effect.mapError((cause) => unavailable('The Retail Portal Binding commit resolution is unavailable', cause)),
      );
    if (resolved.state === 'OPEN') {
      return yield* ownerRejected(
        'commerce_profile_commit_open',
        'The Commerce Action invocation has not committed yet and must be retried',
      );
    }
    return yield* resolutionOf(
      reconciliation,
      BIND_OWNER_KEY,
      resolved.result.bindingRef.resourceId,
      yield* bindingVerdict(resolved.result, executors),
    );
  });

  return Object.freeze({ dispatch, reconcile });
};

interface RetailOwnerInvocationAuthority {
  readonly compositionRevision: string;
  readonly crypto: Crypto.Crypto;
  readonly legalEntityId: string;
  readonly originator: RetailEnrollmentOriginator;
  readonly requestCorrelation: string;
  readonly tenantId: string;
}

/** The owner call acts for the Attempt's originator; the verified actor is this Commerce module. */
const issueRetailOwnerConnection = Effect.fn('RetailEnrollment.issueOwnerConnection')(
  function* issueRetailOwnerConnectionEffect(input: RetailOwnerInvocationAuthority) {
    if (
      input.originator.tenantId !== input.tenantId ||
      input.originator.compositionRevision !== input.compositionRevision
    ) {
      return yield* unavailable('The enrollment originator does not match the Attempt scope');
    }
    return yield* acquireRetailOwnerCredential({
      audience: 'commerce-customer-context',
      crypto: input.crypto,
      legalEntityId: input.legalEntityId,
      originator: input.originator,
      requestCorrelation: input.requestCorrelation,
    }).pipe(Effect.mapError((cause) => unavailable('The Retail owner credential is unavailable', cause)));
  },
);

/** Each scheduled dispatch uses its Attempt's immutable release and a fresh server-owned service credential. */
export const retailCustomerProfileActionExecutor = (
  input: RetailCustomerProfileOwnerInput,
): RetailCustomerProfileOwnerExecutors['ensureProfile'] => {
  const authority: RetailOwnerInvocationAuthority = Object.freeze({
    compositionRevision: input.compositionRevision,
    crypto: input.crypto,
    legalEntityId: input.sellingLegalEntityRef.resourceId,
    originator: input.originator,
    requestCorrelation: input.requestCorrelation,
    tenantId: input.partyRef.tenantId,
  });
  return Effect.fn('RetailEnrollment.executeProfileOwner')(function* executeRetailProfileOwner(
    payload: EnsureProfilePayload,
    _requestCorrelation: string,
    options: { readonly idempotencyKey: string },
  ): Effect.fn.Return<EnsureRetailCustomerProfileResult, EnsureProfileError> {
    const connection = yield* issueRetailOwnerConnection(authority).pipe(
      Effect.mapError((cause) => unavailable('The Retail Customer Profile owner credential is unavailable', cause)),
    );
    const answered = yield* executeEnsureRetailCustomerProfileWithAuthorization(
      payload,
      Redacted.value(connection.credential),
      authority.requestCorrelation,
      {
        baseUrl: connection.baseUrl,
        compositionRevision: authority.compositionRevision,
        idempotencyKey: options.idempotencyKey,
      },
    );
    // O85: a parked proposal is a public 202 success body, never a created Retail profile. This executor
    // requires execution, so the Action's own result schema decides the seam.
    return yield* Schema.decodeUnknownEffect(Schema.toType(EnsureRetailCustomerProfileResultSchema))(answered).pipe(
      Effect.mapError((cause) => unavailable('The Retail Customer Profile owner did not execute the request', cause)),
    );
  });
};

export const retailPortalBindingActionExecutor = (
  input: RetailPortalBindingOwnerInput,
): RetailPortalBindingOwnerExecutors['bindProfile'] => {
  const authority: RetailOwnerInvocationAuthority = Object.freeze({
    compositionRevision: input.compositionRevision,
    crypto: input.crypto,
    legalEntityId: input.sellingLegalEntityRef.resourceId,
    originator: input.originator,
    requestCorrelation: input.requestCorrelation,
    tenantId: input.profileRef.tenantId,
  });
  return Effect.fn('RetailEnrollment.executePortalOwner')(function* executeRetailPortalOwner(
    payload: BindProfilePayload,
    _requestCorrelation: string,
    options: { readonly idempotencyKey: string },
  ): Effect.fn.Return<RetailPortalBindingResult, BindProfileError> {
    const connection = yield* issueRetailOwnerConnection(authority).pipe(
      Effect.mapError((cause) => unavailable('The Retail Portal Binding owner credential is unavailable', cause)),
    );
    return yield* executeBindRetailPortalProfileWithAuthorization(
      payload,
      Redacted.value(connection.credential),
      authority.requestCorrelation,
      {
        baseUrl: connection.baseUrl,
        compositionRevision: authority.compositionRevision,
        idempotencyKey: options.idempotencyKey,
      },
    );
  });
};
