import { ActionPermissionCheckError } from '@app/core-runtime'; // oxlint-disable-line eslint/max-classes-per-file -- These two Context.Service tags are the paired preflight and handler capability boundary; expires: 2027-09-17.
import type {
  ActionAuthorizationPreflightDecision,
  ActionAuthorizationPreflightInput,
  ActionAuthorizationPreflightService,
} from '@app/core-runtime';
import { Context, Effect, Layer, Schema } from 'effect';

import { ClaimPortalEnrollmentTransitionPayloadSchema } from '../../../shared/actions/claim-portal-enrollment-transition.ts';
import { RecordPortalEnrollmentOutcomePayloadSchema } from '../../../shared/actions/record-portal-enrollment-outcome.ts';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentDigestSchema,
  EnrollmentEvidenceReferenceSchema,
  EnrollmentModuleKeySchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
  EnrollmentTransitionKeySchema,
  ReconcileEnrollmentResolutionSchema,
} from '../../../shared/enrollment-contracts.ts';
import type { ReconcileEnrollmentResolution } from '../../../shared/enrollment-contracts.ts';
import { attemptRejected, attemptUnavailable, withCause } from '../attempts/errors.ts';
import type { CommerceEnrollmentAttemptError } from '../attempts/errors.ts';

export const CLAIM_PORTAL_ENROLLMENT_TRANSITION_ACTION_KEY =
  'commerce.customer-context.claim-portal-enrollment-transition';
export const RECORD_PORTAL_ENROLLMENT_OUTCOME_ACTION_KEY = 'commerce.customer-context.record-portal-enrollment-outcome';
export const PORTAL_AUTH_OWNER_MODULE_KEY = 'commerce.portal-auth';
export const PORTAL_ACCOUNT_CREATION_TRANSITION_KEY = 'provider.account.create';

const actionKeySchema = Schema.Literals([
  CLAIM_PORTAL_ENROLLMENT_TRANSITION_ACTION_KEY,
  RECORD_PORTAL_ENROLLMENT_OUTCOME_ACTION_KEY,
]);
const revisionSchema = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1));

const PreparedOwnerBindingSchema = Schema.Struct({
  actionInvocationId: EnrollmentActionInvocationIdSchema,
  actionKey: actionKeySchema,
  actorPrincipalId: EnrollmentPrincipalIdSchema,
  expectedRevision: revisionSchema,
  ownerInvocationId: EnrollmentActionInvocationIdSchema,
  ownerModuleKey: EnrollmentModuleKeySchema,
  portalEnrollmentAttemptId: EnrollmentAttemptIdSchema,
  requestDigest: Schema.optionalKey(EnrollmentDigestSchema),
  tenantId: EnrollmentTenantIdSchema,
  transitionKey: EnrollmentTransitionKeySchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

export type CommerceEnrollmentPreparedOwnerBinding = typeof PreparedOwnerBindingSchema.Type;

const PreparedOwnerObservationSchema = Schema.Struct({
  evidenceRef: EnrollmentEvidenceReferenceSchema,
  resolution: Schema.optionalKey(ReconcileEnrollmentResolutionSchema),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

type CommerceEnrollmentPreparedOwnerObservation = typeof PreparedOwnerObservationSchema.Type;

const OwnerPreparationResultSchema = Schema.Union([
  Schema.Struct({ outcome: Schema.Literal('not_applicable') }),
  Schema.Struct({ outcome: Schema.Literal('denied') }),
  Schema.Struct({ outcome: Schema.Literal('unavailable') }),
  Schema.Struct({
    outcome: Schema.Literal('prepared'),
    ...PreparedOwnerObservationSchema.fields,
  }),
]);

export type CommerceEnrollmentOwnerTransitionPreparationResult = typeof OwnerPreparationResultSchema.Type;

/** The three non-prepared preparation answers, shared so every port returns the same values. */
export const ownerPreparationDenied: CommerceEnrollmentOwnerTransitionPreparationResult = Object.freeze({
  outcome: 'denied' as const,
});
export const ownerPreparationNotApplicable: CommerceEnrollmentOwnerTransitionPreparationResult = Object.freeze({
  outcome: 'not_applicable' as const,
});
export const ownerPreparationUnavailable: CommerceEnrollmentOwnerTransitionPreparationResult = Object.freeze({
  outcome: 'unavailable' as const,
});

/**
 * Owner HTTP/authority adapters implement this seam.  Adapters map transport failures to
 * `unavailable` and owner denials to `denied`; no credentials or provider response is exposed to
 * an Action handler.
 */
export class CommerceEnrollmentOwnerTransitionPreparation extends Context.Service<
  CommerceEnrollmentOwnerTransitionPreparation,
  {
    readonly prepare: (
      input: CommerceEnrollmentPreparedOwnerBinding,
    ) => Effect.Effect<CommerceEnrollmentOwnerTransitionPreparationResult>;
  }
>()(
  '@app/commerce-customer-context/enrollment/orchestration/prepared-owner-authority/CommerceEnrollmentOwnerTransitionPreparation',
) {}

/** Request-scoped owner capability bundle consumed by the deployment Action runtime wrapper. */
export class CommerceEnrollmentPreparedOwnerExecutionService extends Context.Service<
  CommerceEnrollmentPreparedOwnerExecutionService,
  CommerceEnrollmentPreparedOwnerExecution
>()(
  '@app/commerce-customer-context/enrollment/orchestration/prepared-owner-authority/CommerceEnrollmentPreparedOwnerExecutionService',
) {}

export interface CommerceEnrollmentPreparedOwnerEvidence extends CommerceEnrollmentPreparedOwnerBinding {
  readonly evidenceRef: typeof EnrollmentEvidenceReferenceSchema.Type;
  readonly resolution?: ReconcileEnrollmentResolution;
}

/**
 * Request-scoped capability exposed to an Action service factory. The implementation only reveals
 * an observation after ordinary Core authorization has allowed the handler to run, and removes it
 * on read.
 */
export class CommerceEnrollmentPreparedOwnerCapability extends Context.Service<
  CommerceEnrollmentPreparedOwnerCapability,
  {
    readonly take: (
      binding: CommerceEnrollmentPreparedOwnerBinding,
    ) => Effect.Effect<CommerceEnrollmentPreparedOwnerEvidence, CommerceEnrollmentAttemptError>;
  }
>()(
  '@app/commerce-customer-context/enrollment/orchestration/prepared-owner-authority/CommerceEnrollmentPreparedOwnerCapability',
) {}

type PreparedOwnerEntry = Readonly<{
  readonly binding: CommerceEnrollmentPreparedOwnerBinding;
  readonly evidence: CommerceEnrollmentPreparedOwnerEvidence;
}>;

interface PreparedOwnerStore {
  readonly clear: () => void;
  readonly entries: Map<string, PreparedOwnerEntry>;
  readonly register: (
    binding: CommerceEnrollmentPreparedOwnerBinding,
    observation: CommerceEnrollmentPreparedOwnerObservation,
  ) => void;
}

const permissionUnavailable = (cause?: unknown): ActionPermissionCheckError => {
  const error = new ActionPermissionCheckError({
    code: 'action_permission_check_failed',
    reason: 'Commerce Enrollment owner authorization could not be established safely',
  });
  return cause === undefined ? error : withCause(error, cause);
};

const makePreparedOwnerStore = (): PreparedOwnerStore => {
  const entries = new Map<string, PreparedOwnerEntry>();
  const register = (
    binding: CommerceEnrollmentPreparedOwnerBinding,
    observation: CommerceEnrollmentPreparedOwnerObservation,
  ): void => {
    const evidence: CommerceEnrollmentPreparedOwnerEvidence =
      observation.resolution === undefined
        ? Object.freeze({ ...binding, evidenceRef: observation.evidenceRef })
        : Object.freeze({ ...binding, evidenceRef: observation.evidenceRef, resolution: observation.resolution });
    entries.set(binding.actionInvocationId, { binding, evidence });
  };
  return { clear: () => entries.clear(), entries, register };
};

const capabilityBindingMatches = (
  expected: CommerceEnrollmentPreparedOwnerBinding,
  actual: CommerceEnrollmentPreparedOwnerBinding,
): boolean =>
  expected.actionInvocationId === actual.actionInvocationId &&
  expected.actionKey === actual.actionKey &&
  expected.actorPrincipalId === actual.actorPrincipalId &&
  expected.expectedRevision === actual.expectedRevision &&
  expected.ownerInvocationId === actual.ownerInvocationId &&
  expected.ownerModuleKey === actual.ownerModuleKey &&
  expected.portalEnrollmentAttemptId === actual.portalEnrollmentAttemptId &&
  expected.requestDigest === actual.requestDigest &&
  expected.tenantId === actual.tenantId &&
  expected.transitionKey === actual.transitionKey;

const makePreparedOwnerCapability = (
  store: PreparedOwnerStore,
): CommerceEnrollmentPreparedOwnerCapability['Service'] => {
  const service: CommerceEnrollmentPreparedOwnerCapability['Service'] = Object.freeze({
    take: (binding): Effect.Effect<CommerceEnrollmentPreparedOwnerEvidence, CommerceEnrollmentAttemptError> =>
      Schema.decodeEffect(PreparedOwnerBindingSchema)(binding).pipe(
        Effect.mapError((cause) => attemptRejected('The owner authorization binding is invalid', undefined, cause)),
        Effect.flatMap((decodedBinding) => {
          const entry = store.entries.get(decodedBinding.actionInvocationId);
          if (entry === undefined) {
            return Effect.fail(
              attemptUnavailable(
                'The owner authorization evidence was not prepared for this Action invocation',
                decodedBinding.portalEnrollmentAttemptId,
              ),
            );
          }
          if (!capabilityBindingMatches(entry.binding, decodedBinding)) {
            return Effect.fail(
              attemptRejected(
                'The owner authorization binding does not match the current Action invocation',
                decodedBinding.portalEnrollmentAttemptId,
              ),
            );
          }
          store.entries.delete(decodedBinding.actionInvocationId);
          return Effect.succeed(entry.evidence);
        }),
      ),
  });
  return service;
};

const decodedClaimPayload = (input: ActionAuthorizationPreflightInput) =>
  Schema.decodeUnknownEffect(ClaimPortalEnrollmentTransitionPayloadSchema)(input.payload);

const decodedRecordPayload = (input: ActionAuthorizationPreflightInput) =>
  Schema.decodeUnknownEffect(RecordPortalEnrollmentOutcomePayloadSchema)(input.payload);

const trustedContextMatches = (input: ActionAuthorizationPreflightInput): boolean =>
  input.principal.principalId === input.scope.principalId && input.principal.tenantId === input.scope.tenantId;

/** The preflight identity this binding is built for, branded at the external-identity boundary. */
interface PreflightOwnerIdentity {
  readonly actorPrincipalId: typeof EnrollmentPrincipalIdSchema.Type;
  readonly tenantId: typeof EnrollmentTenantIdSchema.Type;
}

/**
 * Core's principal context and operational scope carry plain strings on the decoded side.  The
 * Enrollment binding speaks the external-identity contract, so brand both ids by decoding them
 * once here instead of widening the contract.
 */
const decodedPreflightIdentity = (
  input: ActionAuthorizationPreflightInput,
): Effect.Effect<PreflightOwnerIdentity, ActionPermissionCheckError> =>
  Effect.all(
    {
      actorPrincipalId: Schema.decodeEffect(EnrollmentPrincipalIdSchema)(input.principal.principalId),
      tenantId: Schema.decodeEffect(EnrollmentTenantIdSchema)(input.scope.tenantId),
    },
    { concurrency: 2 },
  ).pipe(Effect.mapError((cause) => permissionUnavailable(cause)));

const buildClaimBinding = (details: {
  readonly actionInvocationId: typeof EnrollmentActionInvocationIdSchema.Type;
  readonly identity: PreflightOwnerIdentity;
  readonly payload: typeof ClaimPortalEnrollmentTransitionPayloadSchema.Type;
}): CommerceEnrollmentPreparedOwnerBinding => ({
  actionInvocationId: details.actionInvocationId,
  actionKey: CLAIM_PORTAL_ENROLLMENT_TRANSITION_ACTION_KEY,
  actorPrincipalId: details.identity.actorPrincipalId,
  expectedRevision: details.payload.expectedRevision,
  ownerInvocationId: details.payload.ownerInvocationId,
  ownerModuleKey: details.payload.ownerModuleKey,
  portalEnrollmentAttemptId: details.payload.portalEnrollmentAttemptId,
  requestDigest: details.payload.requestDigest,
  tenantId: details.identity.tenantId,
  transitionKey: details.payload.transitionKey,
});

const buildRecordBinding = (details: {
  readonly actionInvocationId: typeof EnrollmentActionInvocationIdSchema.Type;
  readonly identity: PreflightOwnerIdentity;
  readonly payload: typeof RecordPortalEnrollmentOutcomePayloadSchema.Type;
}): CommerceEnrollmentPreparedOwnerBinding => ({
  actionInvocationId: details.actionInvocationId,
  actionKey: RECORD_PORTAL_ENROLLMENT_OUTCOME_ACTION_KEY,
  actorPrincipalId: details.identity.actorPrincipalId,
  expectedRevision: details.payload.expectedRevision,
  ownerInvocationId: details.payload.ownerInvocationId,
  ownerModuleKey: details.payload.ownerModuleKey,
  portalEnrollmentAttemptId: details.payload.portalEnrollmentAttemptId,
  tenantId: details.identity.tenantId,
  transitionKey: details.payload.transitionKey,
});

const decodePreparationResult = (
  result: CommerceEnrollmentOwnerTransitionPreparationResult,
): Effect.Effect<CommerceEnrollmentOwnerTransitionPreparationResult, ActionPermissionCheckError> =>
  Schema.decodeEffect(OwnerPreparationResultSchema)(result).pipe(
    Effect.mapError((cause) => permissionUnavailable(cause)),
  );

const prepareOwnerTransition = Effect.fn('CommerceEnrollmentOwnerTransitionPreparation.prepareForAction')(
  function* prepareOwnerTransitionEffect(
    preparation: CommerceEnrollmentOwnerTransitionPreparation['Service'],
    store: PreparedOwnerStore,
    binding: CommerceEnrollmentPreparedOwnerBinding,
    requiresResolution: boolean,
  ) {
    const result = yield* preparation.prepare(binding).pipe(Effect.flatMap(decodePreparationResult));
    if (result.outcome === 'not_applicable') {
      return { outcome: 'not_applicable' } as const;
    }
    if (result.outcome === 'denied') {
      return { outcome: 'denied' } as const;
    }
    if (result.outcome === 'unavailable') {
      return yield* permissionUnavailable();
    }
    if (requiresResolution && result.resolution === undefined) {
      return { outcome: 'denied' } as const;
    }
    if (
      result.resolution !== undefined &&
      (result.resolution.actorPrincipalId !== binding.actorPrincipalId ||
        String(result.resolution.reconciliationRef) === String(binding.ownerInvocationId))
    ) {
      return { outcome: 'denied' } as const;
    }
    store.register(binding, result);
    // Owner preparation only stages evidence. Core's ordinary authorization and any other
    // preflight remain authoritative for whether this Action reaches its handler.
    return { outcome: 'not_applicable' } as const;
  },
);

const prepareClaim = (
  preparation: CommerceEnrollmentOwnerTransitionPreparation['Service'],
  store: PreparedOwnerStore,
  input: ActionAuthorizationPreflightInput,
) =>
  Schema.decodeEffect(EnrollmentActionInvocationIdSchema)(input.actionInvocationId).pipe(
    Effect.mapError((cause) => permissionUnavailable(cause)),
    Effect.flatMap((actionInvocationId) =>
      decodedClaimPayload(input).pipe(
        Effect.mapError((cause) => permissionUnavailable(cause)),
        Effect.flatMap((payload) => {
          if (!trustedContextMatches(input) || input.scope.tenantId !== input.principal.tenantId) {
            return Effect.succeed({ outcome: 'denied' } as const);
          }
          return decodedPreflightIdentity(input).pipe(
            Effect.flatMap((identity) =>
              prepareOwnerTransition(
                preparation,
                store,
                buildClaimBinding({ actionInvocationId, identity, payload }),
                false,
              ),
            ),
          );
        }),
      ),
    ),
  );

const prepareRecord = (
  preparation: CommerceEnrollmentOwnerTransitionPreparation['Service'],
  store: PreparedOwnerStore,
  input: ActionAuthorizationPreflightInput,
) =>
  Schema.decodeEffect(EnrollmentActionInvocationIdSchema)(input.actionInvocationId).pipe(
    Effect.mapError((cause) => permissionUnavailable(cause)),
    Effect.flatMap((actionInvocationId) =>
      decodedRecordPayload(input).pipe(
        Effect.mapError((cause) => permissionUnavailable(cause)),
        Effect.flatMap((payload) => {
          if (!trustedContextMatches(input) || input.scope.tenantId !== input.principal.tenantId) {
            return Effect.succeed({ outcome: 'denied' } as const);
          }
          return decodedPreflightIdentity(input).pipe(
            Effect.flatMap((identity) =>
              prepareOwnerTransition(
                preparation,
                store,
                buildRecordBinding({ actionInvocationId, identity, payload }),
                true,
              ),
            ),
          );
        }),
      ),
    ),
  );

const makeCommerceEnrollmentActionAuthorizationPreflightForStore = (
  preparation: CommerceEnrollmentOwnerTransitionPreparation['Service'],
  store: PreparedOwnerStore,
): ActionAuthorizationPreflightService =>
  Object.freeze({
    prepare: (input: ActionAuthorizationPreflightInput) => {
      if (input.actionKey === CLAIM_PORTAL_ENROLLMENT_TRANSITION_ACTION_KEY) {
        return prepareClaim(preparation, store, input);
      }
      if (input.actionKey === RECORD_PORTAL_ENROLLMENT_OUTCOME_ACTION_KEY) {
        return prepareRecord(preparation, store, input);
      }
      return Effect.succeed({ outcome: 'not_applicable' } as const);
    },
  });

/**
 * Allocate the exact capability/preflight pair for one governed Action execution. Root constructs
 * its per-execution ActionRuntime with `preflight`, provides `capability` to the Action service
 * factory, and runs `clear` from the surrounding scoped finalizer.
 */
export interface CommerceEnrollmentPreparedOwnerExecution {
  readonly capability: CommerceEnrollmentPreparedOwnerCapability['Service'];
  readonly clear: () => void;
  readonly preflight: ActionAuthorizationPreflightService;
}

export const makeCommerceEnrollmentPreparedOwnerExecution = (
  preparation: CommerceEnrollmentOwnerTransitionPreparation['Service'],
): CommerceEnrollmentPreparedOwnerExecution => {
  const store = makePreparedOwnerStore();
  const capability = makePreparedOwnerCapability(store);
  return Object.freeze({
    capability,
    clear: store.clear,
    preflight: makeCommerceEnrollmentActionAuthorizationPreflightForStore(preparation, store),
  });
};

/**
 * Build a fresh request-scoped capability and preflight together.  The finalizer is owned by the
 * caller's request scope so denied, interrupted and failed Actions cannot leave evidence behind.
 */
export const commerceEnrollmentPreparedOwnerExecutionLive = Layer.effect(
  CommerceEnrollmentPreparedOwnerExecutionService,
  Effect.gen(function* makeCommerceEnrollmentPreparedOwnerExecutionLive() {
    const preparation = yield* CommerceEnrollmentOwnerTransitionPreparation;
    return makeCommerceEnrollmentPreparedOwnerExecution(preparation);
  }),
);

const continueActionAuthorizationPreflight = (
  decision: ActionAuthorizationPreflightDecision,
  next: Effect.Effect<ActionAuthorizationPreflightDecision, ActionPermissionCheckError>,
): Effect.Effect<ActionAuthorizationPreflightDecision, ActionPermissionCheckError> =>
  decision.outcome === 'not_applicable' ? next : Effect.succeed(decision);

const visitActionAuthorizationPreflights = (
  // oxlint-disable-next-line effect-native/no-dependency-parameters -- Root composes already-built Core preflight services around this request-scoped owner preflight; expires: 2027-09-17.
  preflights: readonly ActionAuthorizationPreflightService[],
  input: ActionAuthorizationPreflightInput,
  index: number,
): Effect.Effect<ActionAuthorizationPreflightDecision, ActionPermissionCheckError> => {
  const preflight = preflights[index];
  if (preflight === undefined) {
    return Effect.succeed({ outcome: 'not_applicable' } as const);
  }
  return preflight
    .prepare(input)
    .pipe(
      Effect.flatMap((decision) =>
        continueActionAuthorizationPreflight(
          decision,
          visitActionAuthorizationPreflights(preflights, input, index + 1),
        ),
      ),
    );
};

/** Root uses this to preserve the existing invitation preflight and any future owner preflights. */
export const composeActionAuthorizationPreflights = (
  // oxlint-disable-next-line effect-native/no-dependency-parameters -- Root passes already-built Core preflight services into this owner-local composition seam; expires: 2027-09-17.
  preflights: readonly ActionAuthorizationPreflightService[],
): ActionAuthorizationPreflightService =>
  Object.freeze({
    prepare: (input: ActionAuthorizationPreflightInput) => visitActionAuthorizationPreflights(preflights, input, 0),
  });
