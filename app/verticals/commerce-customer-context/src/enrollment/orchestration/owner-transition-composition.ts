import { Effect, Layer, Result, Schema } from 'effect';

import { CommercePortalAuthAccountLookupService } from '../../../api/portal-auth/provider/account-lookup-service.ts';
import type { CommercePortalAuthAccountLookup } from '../../../api/portal-auth/provider/account-lookup-service.ts';
import {
  EnrollmentEvidenceReferenceSchema,
  EnrollmentModuleKeySchema,
  EnrollmentTransitionKeySchema,
  isEnrollmentAttemptTerminal,
} from '../../../shared/enrollment-contracts.ts';
import type { EnrollmentAttemptSnapshot } from '../../../shared/enrollment-contracts.ts';
import type { CommerceEnrollmentOwnerScope } from '../attempts/attempt-persistence.ts';
import { attemptUnavailable } from '../attempts/errors.ts';
import type { CommerceEnrollmentAttemptError } from '../attempts/errors.ts';
import {
  CommerceEnrollmentOwnerTransactionRunner,
  commerceEnrollmentOwnerAttemptStoreForRun,
  commerceEnrollmentOwnerTransitionPreparationAuthorityForPorts,
} from './owner-transition-production.ts';
import type { CommerceEnrollmentOwnerPreparationPort } from './owner-transition-production.ts';
import { CommerceEnrollmentOwnerTransitionSchema } from './owner-transition-driver.ts';
import type {
  CommerceEnrollmentOwnerAttemptStore,
  CommerceEnrollmentOwnerReconciliationInput,
  CommerceEnrollmentOwnerTransition,
} from './owner-transition-driver.ts';
import { retailSelfEnrollmentPrepareStep } from '../journeys/retail-self-enrollment-preparation.ts';
import { retailSelfEnrollmentStepPlan } from '../journeys/retail-self-enrollment-contracts.ts';
import type { JourneyTransitionSpec } from '../journeys/journey-contracts.ts';
import { CommerceEnrollmentPreparationSubjectResolver } from './preparation-subject.ts';
import type { CommerceEnrollmentPreparationSubjectResolve } from './preparation-subject.ts';
import { commerceEnrollmentPortalAuthOwnerReconciliationForLookup } from './provider-owner-effect.ts';
import type { CommerceEnrollmentProviderOwnerReconciliationObservation } from './provider-owner-effect.ts';
import {
  CommerceEnrollmentOwnerEffectIndeterminate,
  CommerceEnrollmentOwnerEffectRejected,
  CommerceEnrollmentOwnerEffectUnavailable,
} from './owner-transition-errors.ts';
import {
  CLAIM_PORTAL_ENROLLMENT_TRANSITION_ACTION_KEY,
  CommerceEnrollmentOwnerTransitionPreparation,
  PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
  PORTAL_AUTH_OWNER_MODULE_KEY,
  ownerPreparationDenied as denied,
  ownerPreparationUnavailable as unavailable,
} from './prepared-owner-authority.ts';
import type {
  CommerceEnrollmentOwnerTransitionPreparationResult,
  CommerceEnrollmentPreparedOwnerBinding,
} from './prepared-owner-authority.ts';

/**
 * An owner-authoritative read is unavailable rather than denied whenever the failure is retryable;
 * every other Attempt failure is a definitive owner denial, so a claimed payload can never reach a
 * governed handler on an ambiguous owner answer.
 */
/**
 * Module and transition keys are module-owned literals, so they are decoded once at load: a
 * malformed constant is a build-time fact about this module, never a per-request effect.
 */
const decodeModuleKey = (value: string): CommerceEnrollmentPreparedOwnerBinding['ownerModuleKey'] =>
  Result.getOrThrow(Schema.decodeResult(EnrollmentModuleKeySchema)(value));
const decodeTransitionKey = (value: string): CommerceEnrollmentPreparedOwnerBinding['transitionKey'] =>
  Result.getOrThrow(Schema.decodeResult(EnrollmentTransitionKeySchema)(value));

const PORTAL_ACCOUNT_TRANSITION_IDENTITY = {
  ownerModuleKey: decodeModuleKey(PORTAL_AUTH_OWNER_MODULE_KEY),
  transitionKey: decodeTransitionKey(PORTAL_ACCOUNT_CREATION_TRANSITION_KEY),
} as const;

interface RetailPreparationStep {
  readonly ownerModuleKey: CommerceEnrollmentPreparedOwnerBinding['ownerModuleKey'];
  readonly step: JourneyTransitionSpec;
  readonly transitionKey: CommerceEnrollmentPreparedOwnerBinding['transitionKey'];
}

const RETAIL_PREPARATION_STEPS: readonly RetailPreparationStep[] = retailSelfEnrollmentStepPlan().map((step) => ({
  ownerModuleKey: decodeModuleKey(step.ownerModuleKey),
  step,
  transitionKey: decodeTransitionKey(step.transitionKey),
}));

const preparationFailure = (
  error: CommerceEnrollmentAttemptError,
): CommerceEnrollmentOwnerTransitionPreparationResult => (error.retryable ? unavailable : denied);

/**
 * The owner phases are authorized inside PostgreSQL from the Tenant the preflight already verified.
 * Nothing here is derived from the request payload.
 */
const ownerScopeFor = (binding: CommerceEnrollmentPreparedOwnerBinding): CommerceEnrollmentOwnerScope => ({
  tenantId: binding.tenantId,
});

const evidenceReferenceOf = (
  attempt: EnrollmentAttemptSnapshot,
): Effect.Effect<typeof EnrollmentEvidenceReferenceSchema.Type, CommerceEnrollmentAttemptError> =>
  Schema.decodeEffect(EnrollmentEvidenceReferenceSchema)(String(attempt.portalEnrollmentAttemptId)).pipe(
    Effect.mapError((cause) =>
      attemptUnavailable(
        'The durable Enrollment Attempt identity is not a usable owner evidence reference',
        attempt.portalEnrollmentAttemptId,
        cause,
      ),
    ),
  );

/**
 * The exact owner lookup used after an unknown provider outcome. It is keyed only by the stable
 * account subject the durable Attempt already recorded and confirmed against the provider's own
 * directory; email continuity and a fresh sign-up retry are deliberately outside it, so a lost
 * provider response can never be resolved from a login identifier.
 */
export const providerObservationFor = Effect.fn('CommerceEnrollmentPortalAuthOwnerPreparation.providerObservation')(
  function* providerObservationEffect(
    attempt: EnrollmentAttemptSnapshot,
    accountLookup: CommercePortalAuthAccountLookup,
  ): Effect.fn.Return<
    CommerceEnrollmentProviderOwnerReconciliationObservation,
    | InstanceType<typeof CommerceEnrollmentOwnerEffectIndeterminate>
    | InstanceType<typeof CommerceEnrollmentOwnerEffectUnavailable>
  > {
    const evidenceRef = yield* evidenceReferenceOf(attempt).pipe(
      Effect.mapError(
        (cause) =>
          new CommerceEnrollmentOwnerEffectUnavailable({
            code: 'provider_account_reconciliation_unavailable',
            reason: cause.reason,
          }),
      ),
    );
    const { accountSubject } = attempt;
    if (accountSubject === undefined) {
      // A creation that committed at the provider and lost its response records no subject, so
      // there is nothing to key the exact lookup on. Absent that key the provider's state is
      // unknown, and calling it NOT_FOUND would authorize a second account for the same Attempt.
      return yield* new CommerceEnrollmentOwnerEffectIndeterminate({
        code: 'provider_account_reconciliation_indeterminate',
        reason: 'The Attempt records no provider subject to correlate the original creation by',
      });
    }
    const persisted = yield* accountLookup
      .existsByProviderSubject({ providerSubjectId: accountSubject.providerSubjectId })
      .pipe(
        Effect.mapError((failure) =>
          Object.defineProperty(
            new CommerceEnrollmentOwnerEffectUnavailable({
              code: 'provider_account_reconciliation_unavailable',
              reason: 'The Commerce portal account directory could not be read for owner reconciliation',
            }),
            'cause',
            { configurable: false, enumerable: false, value: failure },
          ),
        ),
      );
    return persisted
      ? { evidenceRef, outcome: 'FOUND' as const, providerSubjectId: accountSubject.providerSubjectId }
      : { evidenceRef, outcome: 'NOT_FOUND' as const };
  },
);

/** Rebuild the immutable owner transition identity from the durable operation, never the payload. */
const ownerTransitionFor = (
  binding: CommerceEnrollmentPreparedOwnerBinding,
  requestDigest: string,
): Effect.Effect<CommerceEnrollmentOwnerTransition, CommerceEnrollmentAttemptError> =>
  Schema.decodeEffect(CommerceEnrollmentOwnerTransitionSchema)({
    actorPrincipalId: binding.actorPrincipalId,
    correlationId: `commerce-enrollment-owner:${binding.actionInvocationId}`,
    expectedRevision: binding.expectedRevision,
    ownerInvocationId: binding.ownerInvocationId,
    ownerModuleKey: binding.ownerModuleKey,
    portalEnrollmentAttemptId: binding.portalEnrollmentAttemptId,
    requestDigest,
    tenantId: binding.tenantId,
    transitionKey: binding.transitionKey,
  }).pipe(
    Effect.mapError((cause) =>
      attemptUnavailable(
        'The owner transition identity could not be rebuilt from the durable operation',
        binding.portalEnrollmentAttemptId,
        cause,
      ),
    ),
  );

const prepareClaim = Effect.fn('CommerceEnrollmentPortalAuthOwnerPreparation.prepareClaim')(
  function* prepareClaimEffect(
    store: CommerceEnrollmentOwnerAttemptStore,
    binding: CommerceEnrollmentPreparedOwnerBinding,
  ): Effect.fn.Return<CommerceEnrollmentOwnerTransitionPreparationResult, CommerceEnrollmentAttemptError> {
    const attempt = yield* store.read({
      portalEnrollmentAttemptId: binding.portalEnrollmentAttemptId,
      tenantId: binding.tenantId,
    });
    if (isEnrollmentAttemptTerminal(attempt.state) || attempt.state === 'RECONCILIATION_REQUIRED') {
      return denied;
    }
    if (attempt.revision !== binding.expectedRevision) {
      return denied;
    }
    const evidenceRef = yield* evidenceReferenceOf(attempt);
    return { evidenceRef, outcome: 'prepared' as const };
  },
);

const prepareRecord = Effect.fn('CommerceEnrollmentPortalAuthOwnerPreparation.prepareRecord')(
  function* prepareRecordEffect(
    store: CommerceEnrollmentOwnerAttemptStore,
    accountLookup: CommercePortalAuthAccountLookup,
    binding: CommerceEnrollmentPreparedOwnerBinding,
  ): Effect.fn.Return<CommerceEnrollmentOwnerTransitionPreparationResult, CommerceEnrollmentAttemptError> {
    const { attempt, operation } = yield* Effect.all(
      {
        attempt: store.read({
          portalEnrollmentAttemptId: binding.portalEnrollmentAttemptId,
          tenantId: binding.tenantId,
        }),
        operation: store.readOwnerOperation({
          ownerModuleKey: binding.ownerModuleKey,
          portalEnrollmentAttemptId: binding.portalEnrollmentAttemptId,
          tenantId: binding.tenantId,
          transitionKey: binding.transitionKey,
        }),
      },
      { concurrency: 2 },
    );
    if (
      operation.ownerInvocationId !== binding.ownerInvocationId ||
      operation.actorPrincipalId !== binding.actorPrincipalId ||
      attempt.revision !== binding.expectedRevision
    ) {
      return denied;
    }
    if (operation.status !== 'INDETERMINATE' && operation.status !== 'RECONCILIATION_REQUIRED') {
      // A still-leased, already succeeded or already failed owner operation has nothing to
      // reconcile; the Action must observe the durable state instead of recording a second one.
      return operation.status === 'IN_PROGRESS' ? unavailable : denied;
    }
    const transition = yield* ownerTransitionFor(binding, operation.requestDigest);
    const reconciliationInput: CommerceEnrollmentOwnerReconciliationInput =
      operation.resultReference === undefined
        ? { ...transition, observedRevision: attempt.revision, ownerOperationRevision: operation.revision }
        : {
            ...transition,
            observedRevision: attempt.revision,
            ownerOperationRevision: operation.revision,
            ownerResultReference: operation.resultReference,
          };
    const owner = commerceEnrollmentPortalAuthOwnerReconciliationForLookup(() =>
      providerObservationFor(attempt, accountLookup),
    );
    return yield* owner.reconcile(reconciliationInput).pipe(
      Effect.match({
        onFailure: (failure): CommerceEnrollmentOwnerTransitionPreparationResult =>
          Schema.is(CommerceEnrollmentOwnerEffectRejected)(failure) ? denied : unavailable,
        onSuccess: (resolution): CommerceEnrollmentOwnerTransitionPreparationResult => ({
          evidenceRef: resolution.reconciliationRef,
          outcome: 'prepared' as const,
          resolution,
        }),
      }),
    );
  },
);

/**
 * The installed Commerce portal owner port for `provider.account.create`. Claim preparation is an
 * owner-authoritative durable read of the exact Attempt; record preparation is the owner's exact
 * reconciliation of an indeterminate transition. Both open their own transactions through the
 * runner, so no owner work happens inside the governed Action transaction, and neither path can
 * reach the private account-creation capability.
 */
export const makeCommerceEnrollmentPortalAuthOwnerPreparationPort = Effect.fn(
  'CommerceEnrollmentPortalAuthOwnerPreparation.make',
)(function* makePortalAuthOwnerPreparationPort(): Effect.fn.Return<
  CommerceEnrollmentOwnerPreparationPort,
  never,
  CommerceEnrollmentOwnerTransactionRunner | CommercePortalAuthAccountLookupService
> {
  const runner = yield* CommerceEnrollmentOwnerTransactionRunner;
  const accountLookup = yield* CommercePortalAuthAccountLookupService;
  const prepare = (
    input: CommerceEnrollmentPreparedOwnerBinding,
  ): Effect.Effect<CommerceEnrollmentOwnerTransitionPreparationResult> => {
    const store = commerceEnrollmentOwnerAttemptStoreForRun(ownerScopeFor(input), runner.run);
    const prepared =
      input.actionKey === CLAIM_PORTAL_ENROLLMENT_TRANSITION_ACTION_KEY
        ? prepareClaim(store, input)
        : prepareRecord(store, accountLookup, input);
    return prepared.pipe(Effect.match({ onFailure: preparationFailure, onSuccess: (result) => result }));
  };
  return { ...PORTAL_ACCOUNT_TRANSITION_IDENTITY, prepare };
});

/**
 * The Retail self-enrollment ports, bound to the durable Attempt rather than to a subject a caller
 * supplied. Each port captures the exact step it was built for and resolves the journey subject
 * for the Attempt named in the binding, so the digest a port vouches for is always derived from
 * Attempt state that survived a crash.
 */
const prepareRetailStep = (
  resolveSubject: CommerceEnrollmentPreparationSubjectResolve,
  step: JourneyTransitionSpec,
  binding: CommerceEnrollmentPreparedOwnerBinding,
): Effect.Effect<CommerceEnrollmentOwnerTransitionPreparationResult> =>
  resolveSubject({ portalEnrollmentAttemptId: binding.portalEnrollmentAttemptId, tenantId: binding.tenantId }).pipe(
    Effect.flatMap((subject) => retailSelfEnrollmentPrepareStep(subject, step, binding)),
    Effect.match({ onFailure: preparationFailure, onSuccess: (result) => result }),
  );

/** One journey-derived port per declared Retail self-enrollment step. */
const retailPreparationPorts = (
  resolveSubject: CommerceEnrollmentPreparationSubjectResolve,
): readonly CommerceEnrollmentOwnerPreparationPort[] =>
  RETAIL_PREPARATION_STEPS.map(({ ownerModuleKey, step, transitionKey }) => ({
    ownerModuleKey,
    prepare: (binding: CommerceEnrollmentPreparedOwnerBinding) => prepareRetailStep(resolveSubject, step, binding),
    transitionKey,
  }));

/**
 * The deployed preparation authority: the Commerce portal owner port for the provider
 * account-creation transition, plus one port per declared Retail self-enrollment transition. Every
 * other owner module or transition key still fails closed through the router.
 *
 * The portal account-creation pair is declared by the Retail journey too. Listing the portal-auth
 * port first is what keeps it: it is the owner-authoritative one — it reads the durable claim and
 * reconciles an indeterminate provider effect — and the registry never lets a later,
 * journey-derived digest check shadow an earlier port.
 */
export const commerceEnrollmentOwnerTransitionPreparationLive = Layer.effect(
  CommerceEnrollmentOwnerTransitionPreparation,
  Effect.gen(function* makePreparationAuthority() {
    const resolver = yield* CommerceEnrollmentPreparationSubjectResolver;
    const portalAuthPort = yield* makeCommerceEnrollmentPortalAuthOwnerPreparationPort();
    return commerceEnrollmentOwnerTransitionPreparationAuthorityForPorts([
      portalAuthPort,
      ...retailPreparationPorts(resolver.resolve),
    ]);
  }),
);
