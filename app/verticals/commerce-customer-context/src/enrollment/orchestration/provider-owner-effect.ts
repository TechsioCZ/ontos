import { Effect, Schema } from 'effect';

import { CommercePortalAccountCreateInputSchema } from '../../../api/portal-auth/provider/account-create.ts';
import type {
  CommercePortalAccountCreateInputBoundary,
  CommercePortalAccountCreateResult,
  CommercePortalAuthAccountCreationFailure,
  CommercePortalAuthAccountCreationService,
} from '../../../api/portal-auth/provider/account-create.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../../shared/portal-auth-contracts.ts';
import { CommercePortalAuthAccountCreationInvalidRequest } from '../../../api/portal-auth/provider/account-creation-invalid-request.ts';
import { CommercePortalAuthAccountCreationRejected } from '../../../api/portal-auth/provider/account-creation-rejected.ts';
import { CommercePortalAuthAccountCreationUnavailable } from '../../../api/portal-auth/provider/account-creation-unavailable.ts';
import {
  CommercePortalAccountSubjectSchema,
  EnrollmentEvidenceReferenceSchema,
  EnrollmentKeySchema,
  EnrollmentProviderSubjectIdSchema,
  EnrollmentResourceIdSchema,
} from '../../../shared/enrollment-contracts.ts';
import type {
  CommercePortalAccountSubject,
  ReconcileEnrollmentResolution,
} from '../../../shared/enrollment-contracts.ts';
import type {
  CommerceEnrollmentOwnerEffect,
  CommerceEnrollmentOwnerEffectOutcome,
  CommerceEnrollmentOwnerReconciliationInput,
  CommerceEnrollmentOwnerTransition,
} from './owner-transition-driver.ts';
import {
  CommerceEnrollmentOwnerEffectIndeterminate,
  CommerceEnrollmentOwnerEffectRejected,
  CommerceEnrollmentOwnerEffectUnavailable,
} from './owner-transition-errors.ts';
import type { CommerceEnrollmentOwnerEffectError } from './owner-transition-errors.ts';

type EnrollmentEvidenceReference = typeof EnrollmentEvidenceReferenceSchema.Type;
type EnrollmentKey = typeof EnrollmentKeySchema.Type;
type EnrollmentResourceId = typeof EnrollmentResourceIdSchema.Type;

/**
 * A provider lookup is authoritative only when its implementation keys the lookup by the exact
 * owner invocation and request digest received here. Email continuity and a fresh sign-up retry
 * are deliberately outside this port.
 */
export const CommerceEnrollmentProviderOwnerReconciliationObservationSchema = Schema.Union([
  Schema.Struct({
    evidenceRef: EnrollmentEvidenceReferenceSchema,
    outcome: Schema.Literal('NOT_FOUND'),
  }),
  Schema.Struct({
    evidenceRef: EnrollmentEvidenceReferenceSchema,
    outcome: Schema.Literal('FOUND'),
    providerSubjectId: EnrollmentProviderSubjectIdSchema,
  }),
]).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type CommerceEnrollmentProviderOwnerReconciliationObservation =
  typeof CommerceEnrollmentProviderOwnerReconciliationObservationSchema.Type;

/** Performs an exact invocation lookup after an unknown provider response. */
export type CommerceEnrollmentProviderOwnerReconciliationLookup = (
  input: CommerceEnrollmentOwnerReconciliationInput,
) => Effect.Effect<CommerceEnrollmentProviderOwnerReconciliationObservation, CommerceEnrollmentOwnerEffectError>;

export interface CommerceEnrollmentPortalAuthOwnerEffectOptions {
  readonly accountCreation: CommercePortalAuthAccountCreationService['Service'];
  /** Builds private credentials and owner data; it must bind all three identity fields exactly. */
  readonly makeAccountInput: (
    input: CommerceEnrollmentOwnerTransition,
  ) => Effect.Effect<CommercePortalAccountCreateInputBoundary, CommerceEnrollmentOwnerEffectError>;
  /** Performs an exact invocation/digest lookup after an unknown provider response. */
  readonly reconcileAccount: CommerceEnrollmentProviderOwnerReconciliationLookup;
}

const withCause = <ErrorType extends object>(error: ErrorType, cause: unknown): ErrorType =>
  Object.defineProperty(error, 'cause', { configurable: false, enumerable: false, value: cause });

const unavailable = (code: string, reason: string, cause?: unknown): CommerceEnrollmentOwnerEffectUnavailable => {
  const error = new CommerceEnrollmentOwnerEffectUnavailable({
    code: code.slice(0, 200),
    reason: reason.slice(0, 500),
  });
  return cause === undefined ? error : withCause(error, cause);
};

const indeterminate = (code: string, reason: string, cause?: unknown): CommerceEnrollmentOwnerEffectIndeterminate => {
  const error = new CommerceEnrollmentOwnerEffectIndeterminate({
    code: code.slice(0, 200),
    reason: reason.slice(0, 500),
  });
  return cause === undefined ? error : withCause(error, cause);
};

const rejected = (code: string, reason: string, cause?: unknown): CommerceEnrollmentOwnerEffectRejected => {
  const error = new CommerceEnrollmentOwnerEffectRejected({
    code: code.slice(0, 200),
    reason: reason.slice(0, 500),
  });
  return cause === undefined ? error : withCause(error, cause);
};

const mapAccountCreationFailure = (
  cause: CommercePortalAuthAccountCreationFailure,
): CommerceEnrollmentOwnerEffectError => {
  if (Schema.is(CommercePortalAuthAccountCreationRejected)(cause)) {
    return rejected('provider_account_rejected', cause.reason, cause);
  }
  if (Schema.is(CommercePortalAuthAccountCreationInvalidRequest)(cause)) {
    return rejected('provider_account_invalid_request', cause.reason, cause);
  }
  if (Schema.is(CommercePortalAuthAccountCreationUnavailable)(cause)) {
    return unavailable('provider_account_unavailable', cause.reason, cause);
  }
  return indeterminate('provider_account_unknown_failure', 'The provider account result was not classifiable', cause);
};

const decodeKey = (value: string): Effect.Effect<EnrollmentKey, CommerceEnrollmentOwnerEffectUnavailable> =>
  Schema.decodeEffect(EnrollmentKeySchema)(value).pipe(
    Effect.mapError((cause) =>
      unavailable('provider_account_invalid_result', 'The provider returned an invalid outcome key', cause),
    ),
  );

const decodeResourceId = (
  value: string,
): Effect.Effect<EnrollmentResourceId, CommerceEnrollmentOwnerEffectUnavailable> =>
  Schema.decodeEffect(EnrollmentResourceIdSchema)(value).pipe(
    Effect.mapError((cause) =>
      unavailable('provider_account_invalid_result', 'The provider returned an invalid result reference', cause),
    ),
  );

const decodeEvidenceReference = (
  value: string,
): Effect.Effect<EnrollmentEvidenceReference, CommerceEnrollmentOwnerEffectUnavailable> =>
  Schema.decodeEffect(EnrollmentEvidenceReferenceSchema)(value).pipe(
    Effect.mapError((cause) =>
      unavailable('provider_account_invalid_result', 'The provider returned invalid owner evidence', cause),
    ),
  );

const decodeProviderSubject = (
  value: string,
): Effect.Effect<CommercePortalAccountSubject, CommerceEnrollmentOwnerEffectUnavailable> =>
  Schema.decodeEffect(CommercePortalAccountSubjectSchema)({
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    providerSubjectId: value,
    subjectType: 'user',
  }).pipe(
    Effect.mapError((cause) =>
      unavailable('provider_account_invalid_result', 'The provider returned an invalid account subject', cause),
    ),
  );

const decodeRevision = (value: number): Effect.Effect<number, CommerceEnrollmentOwnerEffectUnavailable> =>
  Schema.decodeEffect(Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)))(value).pipe(
    Effect.mapError((cause) =>
      unavailable('provider_account_invalid_result', 'The provider returned an invalid Attempt revision', cause),
    ),
  );

const validateAccountInput = (
  transition: CommerceEnrollmentOwnerTransition,
  input: CommercePortalAccountCreateInputBoundary,
): Effect.Effect<CommercePortalAccountCreateInputBoundary, CommerceEnrollmentOwnerEffectRejected> =>
  Schema.decodeEffect(CommercePortalAccountCreateInputSchema)(input).pipe(
    Effect.mapError((cause) =>
      rejected('provider_account_invalid_request', 'The owner account request is invalid', cause),
    ),
    Effect.flatMap((decoded) =>
      decoded.enrollmentAttemptId === transition.portalEnrollmentAttemptId &&
      decoded.ownerInvocationId === transition.ownerInvocationId &&
      decoded.tenantId === transition.tenantId
        ? Effect.succeed(input)
        : Effect.fail(
            rejected(
              'provider_account_identity_mismatch',
              'The owner account request is not bound to the claimed Attempt transition',
            ),
          ),
    ),
  );

const dispatchOutcome = Effect.fn('CommerceEnrollmentPortalAuthOwnerEffect.dispatchOutcome')(
  function* dispatchOutcomeEffect(
    input: CommerceEnrollmentOwnerTransition,
    result: CommercePortalAccountCreateResult,
  ): Effect.fn.Return<CommerceEnrollmentOwnerEffectOutcome, CommerceEnrollmentOwnerEffectError> {
    if (result.enrollmentAttemptId !== input.portalEnrollmentAttemptId) {
      return yield* indeterminate(
        'provider_account_indeterminate',
        'The provider account result names a different Enrollment Attempt; the external effect cannot be classified',
      );
    }
    const revision = yield* decodeRevision(result.revision);
    if (revision !== input.expectedRevision + 1) {
      return yield* unavailable(
        'provider_account_stale_result',
        'The provider account proof was observed at a different Attempt revision',
      );
    }
    const { accountSubject, outcomeCode, resultReference } = yield* Effect.all(
      {
        accountSubject: decodeProviderSubject(result.providerSubjectId),
        outcomeCode: decodeKey('provider_account_created'),
        resultReference: decodeEvidenceReference(result.evidenceRef).pipe(
          Effect.flatMap((reference) => decodeResourceId(reference)),
        ),
      },
      { concurrency: 3 },
    );
    return {
      accountSubject,
      outcomeCode,
      resultReference,
      status: 'SUCCEEDED',
    };
  },
);

const reconcileOutcome = Effect.fn('CommerceEnrollmentPortalAuthOwnerEffect.reconcileOutcome')(
  function* reconcileOutcomeEffect(
    input: CommerceEnrollmentOwnerReconciliationInput,
    observation: CommerceEnrollmentProviderOwnerReconciliationObservation,
  ): Effect.fn.Return<ReconcileEnrollmentResolution, CommerceEnrollmentOwnerEffectError> {
    const evidenceRef = yield* decodeEvidenceReference(observation.evidenceRef);
    if (String(evidenceRef) === String(input.ownerInvocationId)) {
      return yield* unavailable(
        'provider_account_reconciliation_unavailable',
        'Provider reconciliation returned the original owner invocation as its evidence reference',
      );
    }
    const resultReference = yield* decodeResourceId(evidenceRef);
    if (observation.outcome === 'NOT_FOUND') {
      const { failureCode, outcomeCode } = yield* Effect.all(
        {
          failureCode: decodeKey('provider_account_not_found'),
          outcomeCode: decodeKey('provider_account_absent'),
        },
        { concurrency: 2 },
      );
      return {
        actorPrincipalId: input.actorPrincipalId,
        failureCode,
        failureReason: 'The exact owner lookup found no persisted portal account effect',
        outcomeCode,
        reconciliationRef: evidenceRef,
        resultReference,
        status: 'FAILED',
      };
    }
    const { accountSubject, outcomeCode } = yield* Effect.all(
      {
        accountSubject: decodeProviderSubject(observation.providerSubjectId),
        outcomeCode: decodeKey('provider_account_reconciled'),
      },
      { concurrency: 2 },
    );
    return {
      accountSubject,
      actorPrincipalId: input.actorPrincipalId,
      outcomeCode,
      reconciliationRef: evidenceRef,
      resultReference,
      status: 'SUCCEEDED',
    };
  },
);

/**
 * The reconciliation half of the Portal Auth owner adapter. An owner preparation that only has to
 * resolve an already dispatched, indeterminate transition needs no credential carrier and no
 * account-creation port: building it separately keeps the private sign-up capability out of the
 * governed Action preparation path entirely.
 */
export const commerceEnrollmentPortalAuthOwnerReconciliationForLookup = (
  reconcileAccount: CommerceEnrollmentProviderOwnerReconciliationLookup,
): Pick<CommerceEnrollmentOwnerEffect, 'reconcile'> => ({
  reconcile: Effect.fn('CommerceEnrollmentPortalAuthOwnerEffect.reconcile')(function* reconcileAccountEffect(
    input: CommerceEnrollmentOwnerReconciliationInput,
  ): Effect.fn.Return<ReconcileEnrollmentResolution, CommerceEnrollmentOwnerEffectError> {
    const observation = yield* reconcileAccount(input);
    const decodedObservation = yield* Schema.decodeEffect(
      CommerceEnrollmentProviderOwnerReconciliationObservationSchema,
    )(observation).pipe(
      Effect.mapError((cause) =>
        indeterminate(
          'provider_account_invalid_reconciliation',
          'The provider reconciliation result is invalid',
          cause,
        ),
      ),
    );
    return yield* reconcileOutcome(input, decodedObservation);
  }),
});

/**
 * Private Portal Auth owner adapter. Account creation is invoked once after the durable driver
 * claim; all provider failures remain typed, and an unknown response is recovered only through
 * the exact lookup callback supplied by Portal Auth composition.
 */
// oxlint-disable-next-line effect-native/no-wide-factory-signature -- This private owner adapter receives immutable deployment ports; a Context layer is supplied by the API composition root. remove-when: owner adapters become Context services.
export const makeCommerceEnrollmentPortalAuthOwnerEffect = (
  options: CommerceEnrollmentPortalAuthOwnerEffectOptions,
): CommerceEnrollmentOwnerEffect => {
  const dispatch = Effect.fn('CommerceEnrollmentPortalAuthOwnerEffect.dispatch')(function* dispatchAccount(
    input: CommerceEnrollmentOwnerTransition,
  ): Effect.fn.Return<CommerceEnrollmentOwnerEffectOutcome, CommerceEnrollmentOwnerEffectError> {
    const accountInput = yield* options.makeAccountInput(input);
    const validatedInput = yield* validateAccountInput(input, accountInput);
    const result = yield* options.accountCreation
      .createAccount(validatedInput)
      .pipe(Effect.mapError(mapAccountCreationFailure));
    return yield* dispatchOutcome(input, result);
  });

  const { reconcile } = commerceEnrollmentPortalAuthOwnerReconciliationForLookup(options.reconcileAccount);

  return Object.freeze({ dispatch, reconcile });
};
