import { SupportedGatewayContextClaimsSchema } from '@app/shared-contracts';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import type { PartyRef } from '@app/party-registry/resources/party';
import { Config, DateTime, Effect, Encoding, Redacted, Schema } from 'effect';

import { BindRetailPortalProfilePayloadSchema } from '../../../shared/actions/bind-retail-portal-profile.ts';
import type { RetailPortalBindingResult } from '../../../shared/actions/bind-retail-portal-profile.ts';
import { EnsureRetailCustomerProfilePayloadSchema } from '../../../shared/actions/ensure-retail-customer-profile.ts';
import type { EnsureRetailCustomerProfileResult } from '../../../shared/actions/ensure-retail-customer-profile.ts';
import { RETAIL_PORTAL_SELF_SERVICE_BASELINE } from '../../../shared/domain/profile-contracts.ts';
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

/**
 * The two Commerce-owned Retail self-enrollment transitions: ensure the Retail Customer Profile,
 * then activate the Retail Portal Profile Binding.
 *
 * This vertical has no separate retail grant Action, so the binding Action's staged Permission
 * mutations are the retail grant path: a binding that commits without the complete reviewed
 * baseline is a partially completed grant, recorded as `retail_portal_grants_incomplete` so the
 * journey halts rather than reporting portal access that does not exist.
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
  readonly compositionRevision: string;
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
    decodeOwnerResolution(
      candidate,
      COMMERCE_PROFILE_UNAVAILABLE_CODE,
      'The Commerce reconciliation result is not representable',
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

/**
 * A reconciliation reads grant completeness from the durable authorization state, because the owner
 * keeps no copy of the Action's staged mutation list to republish once that response is gone.
 *
 * `PENDING_GRANT` is the state the binding Action itself leaves behind after staging the reviewed
 * baseline — dispatch calls that complete — and `ACTIVE` is the state the owner moves to only once
 * every baseline Permission is terminal. `RECONCILIATION_REQUIRED` is the owner's own record of the
 * partially completed grant, which is the halt the dispatch path records too.
 */
const reconciledGrantsAreComplete = (result: RetailPortalBindingResult): boolean => {
  if (result.permissionMutations !== undefined) {
    return retailPortalGrantsAreComplete(result);
  }
  return (
    result.authorizationOperation === 'grant' &&
    (result.authorizationState === 'ACTIVE' || result.authorizationState === 'PENDING_GRANT')
  );
};

const bindingVerdictFor = (
  result: RetailPortalBindingResult,
  grantsAreComplete: (result: RetailPortalBindingResult) => boolean,
): CommerceOwnerVerdict => {
  if (result.outcome !== 'BINDING_ACTIVATED' || result.state !== 'ACTIVE') {
    return {
      kind: 'REJECTED',
      outcomeCode: 'retail_portal_binding_not_active',
      reason: 'The Retail Portal Profile Binding did not activate for this enrollment',
    };
  }
  return grantsAreComplete(result)
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

const bindingVerdict = (result: RetailPortalBindingResult): CommerceOwnerVerdict =>
  bindingVerdictFor(result, retailPortalGrantsAreComplete);

const reconciledBindingVerdict = (result: RetailPortalBindingResult): CommerceOwnerVerdict =>
  bindingVerdictFor(result, reconciledGrantsAreComplete);

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
      return yield* ownerRejected(
        'commerce_profile_commit_open',
        'The Commerce Action invocation has not committed yet and must be retried',
      );
    }
    return yield* resolutionOf(
      reconciliation,
      BIND_OWNER_KEY,
      resolved.result.bindingRef.resourceId,
      reconciledBindingVerdict(resolved.result),
    );
  });

  return Object.freeze({ dispatch, reconcile });
};

const enrollmentShellUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    (url.protocol === 'http:' || url.protocol === 'https:') &&
    url.username === '' &&
    url.password === '' &&
    url.search === '' &&
    url.hash === ''
      ? undefined
      : 'Enrollment Shell URL must be HTTP(S) without credentials, query or fragment',
  ),
);

const enrollmentGatewayConfiguration = Config.all({
  apiKey: Config.Redacted('ONTOS_COMMERCE_CUSTOMER_CONTEXT_GATEWAY_API_KEY'),
  baseUrl: Config.schema(enrollmentShellUrl, 'ONTOS_SHELL_GATEWAY_BASE_URL'),
});

interface RetailOwnerInvocationAuthority {
  readonly compositionRevision: string;
  readonly legalEntityId: string;
  readonly requestCorrelation: string;
  readonly tenantId: string;
}

const issueRetailOwnerConnection = Effect.fn('RetailEnrollment.issueOwnerConnection')(
  function* issueRetailOwnerConnectionEffect(input: RetailOwnerInvocationAuthority) {
    const configured = yield* enrollmentGatewayConfiguration;
    const response = yield* issueApiKeyGatewayContext(
      {
        audience: 'commerce-customer-context',
        compositionRevision: input.compositionRevision,
        legalEntityId: input.legalEntityId,
      },
      { ...configured, requestCorrelation: input.requestCorrelation },
    );
    if (response.compositionRevision !== input.compositionRevision) {
      return yield* unavailable('The issued credential does not match the enrollment composition revision');
    }
    // The response came from the authenticated Shell issuer. These claims are checked only for
    // scope coherence; the receiving owner still verifies the signed assertion cryptographically.
    const [, encodedClaims] = yield* Schema.decodeUnknownEffect(
      Schema.Tuple([Schema.String, Schema.String, Schema.String]),
    )(response.token.split('.'));
    const claimsText = yield* Effect.fromResult(Encoding.decodeBase64UrlString(encodedClaims));
    const claims = yield* Schema.decodeEffect(Schema.fromJsonString(SupportedGatewayContextClaimsSchema))(claimsText);
    if (
      claims.aud !== 'commerce-customer-context' ||
      claims.compositionRevision !== input.compositionRevision ||
      claims.principal.tenantId !== input.tenantId ||
      claims.principal.legalEntityId !== input.legalEntityId ||
      claims.principal.authMethod !== 'api_key'
    ) {
      return yield* unavailable('The issued service credential does not match the enrollment scope');
    }
    return {
      baseUrl: new URL(response.apiBaseUrl, configured.baseUrl),
      credential: Redacted.make(`Bearer ${response.token}`),
    };
  },
);

/** Each scheduled dispatch uses its Attempt's immutable release and a fresh server-owned service credential. */
export const retailCustomerProfileActionExecutor = (
  input: RetailCustomerProfileOwnerInput,
): RetailCustomerProfileOwnerExecutors['ensureProfile'] => {
  const authority: RetailOwnerInvocationAuthority = Object.freeze({
    compositionRevision: input.compositionRevision,
    legalEntityId: input.sellingLegalEntityRef.resourceId,
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
    return yield* executeEnsureRetailCustomerProfileWithAuthorization(
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

export const retailPortalBindingActionExecutor = (
  input: RetailPortalBindingOwnerInput,
): RetailPortalBindingOwnerExecutors['bindProfile'] => {
  const authority: RetailOwnerInvocationAuthority = Object.freeze({
    compositionRevision: input.compositionRevision,
    legalEntityId: input.sellingLegalEntityRef.resourceId,
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
