import type { PartyRef } from '@app/party-registry/resources/party';
import { DateTime, Effect, Schema } from 'effect';

import { BindRetailPortalProfilePayloadSchema } from '../../../shared/actions/bind-retail-portal-profile.ts';
import type { RetailPortalBindingResult } from '../../../shared/actions/bind-retail-portal-profile.ts';
import { EnsureRetailCustomerProfilePayloadSchema } from '../../../shared/actions/ensure-retail-customer-profile.ts';
import type { EnsureRetailCustomerProfileResult } from '../../../shared/actions/ensure-retail-customer-profile.ts';
import { RETAIL_PORTAL_SELF_SERVICE_BASELINE } from '../../../shared/domain/profile-contracts.ts';
import type { SellingLegalEntityRefSchema } from '../../../shared/domain/profile-contracts.ts';
import { ReconcileEnrollmentResolutionSchema } from '../../../shared/enrollment-contracts.ts';
import type { ReconcileEnrollmentResolution } from '../../../shared/enrollment-contracts.ts';
import type { RetailCustomerProfileRefSchema } from '../../../shared/resources/retail-customer-profile.ts';
import type { RetailPortalPrincipalRefSchema } from '../../../shared/resources/retail-portal-profile-binding.ts';
import { executeBindRetailPortalProfile } from '../../api/bind-retail-portal-profile-action-client.ts';
import { executeEnsureRetailCustomerProfile } from '../../api/ensure-retail-customer-profile-action-client.ts';
import { CommerceEnrollmentOwnerEffectOutcomeSchema } from '../orchestration/owner-transition-driver.ts';
import type {
  CommerceEnrollmentOwnerEffect,
  CommerceEnrollmentOwnerEffectOutcome,
  CommerceEnrollmentOwnerReconciliationInput,
  CommerceEnrollmentOwnerTransition,
} from '../orchestration/owner-transition-driver.ts';
import {
  CommerceEnrollmentOwnerEffectRejected,
  CommerceEnrollmentOwnerEffectUnavailable,
} from '../orchestration/owner-transition-errors.ts';
import type { CommerceEnrollmentOwnerEffectError } from '../orchestration/owner-transition-errors.ts';
import {
  OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE,
  RETAIL_CUSTOMER_PROFILE_ENSURED_OUTCOME_CODE,
  RETAIL_PORTAL_GRANTS_INCOMPLETE_OUTCOME_CODE,
  RETAIL_PORTAL_PROFILE_BOUND_OUTCOME_CODE,
  retailSelfEnrollmentEvidenceReference,
} from './retail-self-enrollment-contracts.ts';

/**
 * The two Commerce-owned Retail self-enrollment transitions: ensure the Commerce Retail Customer
 * Profile and activate the Retail Portal Profile Binding, which durably stages the
 * reviewed Retail Portal Self-Service Permission baseline inside the binding transaction.
 *
 * This vertical has no separate retail grant Action — `grant-counterparty-commerce-access` is the
 * Counterparty path — so the binding Action's staged Permission mutations are the retail grant
 * path.  A binding that commits without the complete reviewed baseline is therefore a partially
 * completed grant: the owner records `retail_portal_grants_incomplete` and the journey halts into
 * reconciliation instead of reporting portal access that does not exist.
 *
 * Both Actions are dispatched under the immutable owner invocation as their idempotency key.  A
 * timeout after commit reconciles through the Action commit resolution port — an exact read of
 * that invocation's committed result — and never through a second dispatch.
 */

type EnsureProfilePayload = Parameters<typeof executeEnsureRetailCustomerProfile>[0];
type EnsureProfileError = Effect.Error<ReturnType<typeof executeEnsureRetailCustomerProfile>>;
type BindProfilePayload = Parameters<typeof executeBindRetailPortalProfile>[0];
type BindProfileError = Effect.Error<ReturnType<typeof executeBindRetailPortalProfile>>;

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
  /** Stable for the Attempt, so an equivalent retry produces an identical Action payload. */
  readonly effectiveAt: DateTime.Utc;
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
  readonly effectiveAt: DateTime.Utc;
  /** Opaque, non-secret reference to the Attempt evidence the binding Action re-verifies. */
  readonly enrollmentEvidenceRef: string;
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
}

/** The journey's reading of one Commerce Action result, before it becomes an Attempt outcome. */
type CommerceOwnerVerdict =
  | { readonly kind: 'SUCCEEDED'; readonly outcomeCode: string; readonly resourceId: string }
  | { readonly kind: 'RECONCILE'; readonly outcomeCode: string; readonly reason: string }
  | { readonly kind: 'REJECTED'; readonly outcomeCode: string; readonly reason: string };

const unavailable = (
  reason: string,
  cause?: unknown,
): InstanceType<typeof CommerceEnrollmentOwnerEffectUnavailable> => {
  const error = new CommerceEnrollmentOwnerEffectUnavailable({ code: 'commerce_profile_unavailable', reason });
  return cause === undefined
    ? error
    : Object.defineProperty(error, 'cause', { configurable: false, enumerable: false, value: cause });
};

const commitOpen = (): InstanceType<typeof CommerceEnrollmentOwnerEffectRejected> =>
  new CommerceEnrollmentOwnerEffectRejected({
    code: 'commerce_profile_commit_open',
    reason: 'The Commerce Action invocation has not committed yet and must be retried',
  });

/** Wire-shaped drafts, decoded through the owner schemas before they can leave this module. */
interface OwnerOutcomeDraft {
  readonly failureCode?: string;
  readonly failureReason?: string;
  readonly nextState?: string;
  readonly outcomeCode: string;
  readonly resultReference?: string;
  readonly status: 'FAILED' | 'SUCCEEDED';
}

interface OwnerResolutionDraft extends OwnerOutcomeDraft {
  readonly actorPrincipalId: string;
  readonly reconciliationRef: string;
}

const decodeOutcome = (
  candidate: OwnerOutcomeDraft,
): Effect.Effect<CommerceEnrollmentOwnerEffectOutcome, CommerceEnrollmentOwnerEffectError> =>
  Schema.decodeUnknownEffect(CommerceEnrollmentOwnerEffectOutcomeSchema)(candidate).pipe(
    Effect.mapError((cause) => unavailable('The Commerce owner outcome is not representable', cause)),
  );

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
  const decode = (candidate: OwnerResolutionDraft) =>
    Schema.decodeUnknownEffect(ReconcileEnrollmentResolutionSchema)(candidate).pipe(
      Effect.mapError((cause) => unavailable('The Commerce reconciliation result is not representable', cause)),
    );
  if (verdict.kind === 'SUCCEEDED') {
    return decode({
      actorPrincipalId: reconciliation.actorPrincipalId,
      outcomeCode: verdict.outcomeCode,
      reconciliationRef,
      resultReference: verdict.resourceId,
      status: 'SUCCEEDED',
    });
  }
  if (verdict.kind === 'RECONCILE') {
    return decode({
      actorPrincipalId: reconciliation.actorPrincipalId,
      failureCode: OWNER_RECONCILIATION_REQUIRED_FAILURE_CODE,
      failureReason: verdict.reason.slice(0, 500),
      nextState: 'RECONCILIATION_REQUIRED',
      outcomeCode: verdict.outcomeCode,
      reconciliationRef,
      status: 'FAILED',
    });
  }
  return decode({
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

/**
 * The reviewed baseline must be staged exactly: same permissions, all staged, one grant
 * operation.  Anything else is a partially completed grant, not a bound portal profile.
 */
export const retailPortalGrantsAreComplete = (result: RetailPortalBindingResult): boolean => {
  const { permissionMutations } = result;
  if (permissionMutations === undefined) {
    return false;
  }
  const permissions: readonly string[] = permissionMutations.map(({ permission }) => permission);
  const expected = new Set<string>(RETAIL_PORTAL_SELF_SERVICE_BASELINE);
  return (
    result.authorizationOperation === 'grant' &&
    permissions.length === expected.size &&
    new Set(permissions).size === permissions.length &&
    permissions.every((permission) => expected.has(permission)) &&
    permissionMutations.every(({ operation, staged }) => staged && operation === 'grant')
  );
};

const bindingVerdict = (result: RetailPortalBindingResult): CommerceOwnerVerdict => {
  if (result.outcome !== 'BINDING_ACTIVATED' || result.state !== 'ACTIVE') {
    return {
      kind: 'REJECTED',
      outcomeCode: 'retail_portal_binding_not_active',
      reason: 'The Retail Portal Profile Binding did not activate for this enrollment',
    };
  }
  return retailPortalGrantsAreComplete(result)
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
      return yield* commitOpen();
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
    return yield* outcomeOf(bindingVerdict(result));
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
      return yield* commitOpen();
    }
    return yield* resolutionOf(
      reconciliation,
      BIND_OWNER_KEY,
      resolved.result.bindingRef.resourceId,
      bindingVerdict(resolved.result),
    );
  });

  return Object.freeze({ dispatch, reconcile });
};

/** Production executors over the vertical's typed Action clients, for application composition. */
export const retailCustomerProfileActionExecutor: RetailCustomerProfileOwnerExecutors['ensureProfile'] = (
  payload,
  requestCorrelation,
  options,
) => executeEnsureRetailCustomerProfile(payload, requestCorrelation, { idempotencyKey: options.idempotencyKey });

export const retailPortalBindingActionExecutor: RetailPortalBindingOwnerExecutors['bindProfile'] = (
  payload,
  requestCorrelation,
  options,
) => executeBindRetailPortalProfile(payload, requestCorrelation, { idempotencyKey: options.idempotencyKey });
