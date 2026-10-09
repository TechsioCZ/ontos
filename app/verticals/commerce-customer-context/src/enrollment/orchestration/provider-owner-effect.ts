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
import { decodeOwnerField, ownerIndeterminate, ownerRejected, ownerUnavailable } from './owner-effect-codec.ts';
import type {
  CommerceEnrollmentOwnerEffect,
  CommerceEnrollmentOwnerEffectOutcome,
  CommerceEnrollmentOwnerReconciliationInput,
  CommerceEnrollmentOwnerTransition,
} from './owner-transition-driver.ts';
import type {
  CommerceEnrollmentOwnerEffectError,
  CommerceEnrollmentOwnerEffectRejected,
  CommerceEnrollmentOwnerEffectUnavailable,
} from './owner-transition-errors.ts';

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
]);
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

const unavailable = ownerUnavailable;
const indeterminate = ownerIndeterminate;
const rejected = ownerRejected;

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

const INVALID_RESULT_CODE = 'provider_account_invalid_result';

const decodeProviderField = <Value>(
  schema: Schema.ConstraintDecoder<Value>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the provider wire boundary; the value is decoded before it reaches any Attempt phase.
  value: unknown,
  reason: string,
): Effect.Effect<Value, InstanceType<typeof CommerceEnrollmentOwnerEffectUnavailable>> =>
  decodeOwnerField(schema, value, INVALID_RESULT_CODE, reason);

const decodeKey = (
  value: string,
): Effect.Effect<EnrollmentKey, InstanceType<typeof CommerceEnrollmentOwnerEffectUnavailable>> =>
  decodeProviderField(EnrollmentKeySchema, value, 'The provider returned an invalid outcome key');

const decodeResourceId = (
  value: string,
): Effect.Effect<EnrollmentResourceId, InstanceType<typeof CommerceEnrollmentOwnerEffectUnavailable>> =>
  decodeProviderField(EnrollmentResourceIdSchema, value, 'The provider returned an invalid result reference');

const decodeEvidenceReference = (
  value: string,
): Effect.Effect<EnrollmentEvidenceReference, InstanceType<typeof CommerceEnrollmentOwnerEffectUnavailable>> =>
  decodeProviderField(EnrollmentEvidenceReferenceSchema, value, 'The provider returned invalid owner evidence');

const decodeProviderSubject = (
  value: string,
): Effect.Effect<CommercePortalAccountSubject, InstanceType<typeof CommerceEnrollmentOwnerEffectUnavailable>> =>
  decodeProviderField(
    CommercePortalAccountSubjectSchema,
    {
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      providerSubjectId: value,
      subjectType: 'user',
    },
    'The provider returned an invalid account subject',
  );

const decodeRevision = (
  value: number,
): Effect.Effect<number, InstanceType<typeof CommerceEnrollmentOwnerEffectUnavailable>> =>
  decodeProviderField(
    Schema.Finite.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(1)),
    value,
    'The provider returned an invalid Attempt revision',
  );

const validateAccountInput = (
  transition: CommerceEnrollmentOwnerTransition,
  input: CommercePortalAccountCreateInputBoundary,
): Effect.Effect<
  CommercePortalAccountCreateInputBoundary,
  InstanceType<typeof CommerceEnrollmentOwnerEffectRejected>
> =>
  Schema.decodeEffect(CommercePortalAccountCreateInputSchema, { onExcessProperty: 'error' })(input).pipe(
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
      { onExcessProperty: 'error' },
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
