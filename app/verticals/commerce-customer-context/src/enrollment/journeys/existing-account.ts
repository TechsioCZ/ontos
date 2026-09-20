import { Effect, Result, Schema } from 'effect';

import {
  AuthBindingIdSchema,
  AuthenticationNamespaceIdSchema,
  BindingRevisionSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import type {
  ActivatePrincipalBindingRequest,
  ReadPrincipalBindingRequest,
  ReservePrincipalBindingRequest,
} from '@app/shared-contracts/server/external-identity-client';

import {
  CommercePortalAccountSubjectSchema,
  EnrollmentAttemptIdSchema,
  EnrollmentDigestSchema,
  EnrollmentJourneySchema,
  EnrollmentModuleKeySchema,
  EnrollmentTenantIdSchema,
  EnrollmentTransitionKeySchema,
  enrollmentDigest,
} from '../../../shared/enrollment-contracts.ts';
import type { CommercePortalAccountSubject, EnrollmentResourceIdSchema } from '../../../shared/enrollment-contracts.ts';
import {
  PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
  PORTAL_AUTH_OWNER_MODULE_KEY,
} from '../orchestration/prepared-owner-authority.ts';
import { withCause } from '../attempts/errors.ts';
import { JourneyDefinitionSchema } from './journey-contracts.ts';
import type { JourneyDefinition, JourneyTransitionSpec } from './journey-contracts.ts';

/**
 * Existing-account enrollment journey. An already-authenticated Commerce Portal Account enrolls
 * into a SECOND Tenant: no new provider account and no second subject are ever created, only a
 * fresh Tenant-scoped Principal Auth Binding, after which the target journey's own
 * profile/binding/grant steps continue unchanged.
 *
 * This module never imports another journey module. Every delegated step is carried only as data —
 * the declared `JourneyDefinition` of the target journey, supplied by the caller — so it can never
 * duplicate, and can never drift from, the target journey's own step logic.
 */

/** Provider-neutral Core identity owner module, declared identically by every journey. */
export const CORE_IDENTITY_OWNER_MODULE_KEY = 'core.identity';
/**
 * The account-ownership proof. Existing-account is the only journey that binds an account someone
 * already holds to a Tenant it has never belonged to, so "an account with this address exists" is
 * never enough: the start must prove the caller is that account's authenticated owner. The proof is
 * a durable transition like every other — start claims it and records the session subject it
 * verified — so an Attempt that never proved ownership can never derive completion, and the subject
 * the Core reservation binds is the one this transition journalled rather than one a caller named.
 */
export const PORTAL_ACCOUNT_VERIFICATION_TRANSITION_KEY = 'provider.account.verify';
/**
 * Existing-account enrollment is the only journey that dispatches a reserve: the others create a
 * brand-new subject, so their account-creation step reserves the binding.
 */
export const RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY = 'core.principal-binding.reserve';
/** Byte-identical to the Counterparty invitation activation key, so one owner effect serves both. */
export const ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY = 'core.principal-binding.activate';

const existingAccountOwnDefinition: JourneyDefinition = Result.getOrThrow(
  Schema.decodeResult(JourneyDefinitionSchema)({
    kind: 'EXISTING_ACCOUNT',
    optionalTransitions: [],
    requiredTransitions: [
      {
        ownerModuleKey: PORTAL_AUTH_OWNER_MODULE_KEY,
        required: true,
        transitionKey: PORTAL_ACCOUNT_VERIFICATION_TRANSITION_KEY,
      },
      {
        ownerModuleKey: CORE_IDENTITY_OWNER_MODULE_KEY,
        required: true,
        transitionKey: RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY,
      },
      {
        ownerModuleKey: CORE_IDENTITY_OWNER_MODULE_KEY,
        required: true,
        transitionKey: ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY,
      },
    ],
  }),
);

const isCoreIdentityTransition = (transition: JourneyTransitionSpec): boolean =>
  transition.ownerModuleKey === CORE_IDENTITY_OWNER_MODULE_KEY;

/**
 * The ownership proof stands first: it is the precondition of the reservation that follows, and the
 * continuation runs required transitions in declaration order.
 */
export const EXISTING_ACCOUNT_OWNERSHIP_TRANSITIONS: readonly JourneyTransitionSpec[] =
  existingAccountOwnDefinition.requiredTransitions.filter((transition) => !isCoreIdentityTransition(transition));
export const EXISTING_ACCOUNT_CORE_IDENTITY_TRANSITIONS: readonly JourneyTransitionSpec[] =
  existingAccountOwnDefinition.requiredTransitions.filter(isCoreIdentityTransition);

/** Closed, safe rejection vocabulary for the Existing-account journey. */
export class ExistingAccountEnrollmentRejected extends Schema.TaggedError<ExistingAccountEnrollmentRejected>()(
  'ExistingAccountEnrollmentRejected',
  {
    code: Schema.Literals(['existing_account_target_journey_invalid', 'existing_account_transition_invalid']),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

/** Preserves the original failure as a non-enumerable `cause` instead of discarding it. */
const rejectExistingAccount = (
  code: typeof ExistingAccountEnrollmentRejected.Type.code,
  reason: string,
  cause?: unknown,
): ExistingAccountEnrollmentRejected => {
  const error = new ExistingAccountEnrollmentRejected({ code, reason: reason.slice(0, 500), retryable: false });
  return cause === undefined ? error : withCause(error, cause);
};

const isAccountCreationTransition = (transition: JourneyTransitionSpec): boolean =>
  transition.ownerModuleKey === PORTAL_AUTH_OWNER_MODULE_KEY &&
  transition.transitionKey === PORTAL_ACCOUNT_CREATION_TRANSITION_KEY;

/**
 * Compose the Existing-account definition for one target journey: the target's own
 * provider-account-creation step is dropped because Existing-account never creates an account, the
 * account-ownership proof this journey needs instead is declared in its place, and every other
 * declared step is inherited verbatim.
 */
export const existingAccountJourneyDefinitionFor = (
  targetDefinition: JourneyDefinition,
): Effect.Effect<JourneyDefinition, ExistingAccountEnrollmentRejected> => {
  if (targetDefinition.kind === 'EXISTING_ACCOUNT') {
    return Effect.fail(
      rejectExistingAccount(
        'existing_account_target_journey_invalid',
        'Existing-account enrollment must delegate to the Retail self-enrollment or Counterparty invitation journey definition, never to itself',
      ),
    );
  }
  return Schema.decodeEffect(JourneyDefinitionSchema)({
    kind: 'EXISTING_ACCOUNT',
    optionalTransitions: targetDefinition.optionalTransitions.filter(
      (transition) => !isAccountCreationTransition(transition),
    ),
    requiredTransitions: [
      ...EXISTING_ACCOUNT_OWNERSHIP_TRANSITIONS,
      ...EXISTING_ACCOUNT_CORE_IDENTITY_TRANSITIONS,
      ...targetDefinition.requiredTransitions.filter((transition) => !isAccountCreationTransition(transition)),
    ],
  }).pipe(
    Effect.mapError((cause) =>
      rejectExistingAccount(
        'existing_account_target_journey_invalid',
        'The delegated target journey declares owner transitions that Existing-account enrollment cannot compose safely',
        cause,
      ),
    ),
  );
};

/** The exact already-authenticated subject and the second Tenant it is enrolling into. */
const ExistingAccountEnrollmentSubjectSchema = Schema.Struct({
  accountSubject: CommercePortalAccountSubjectSchema,
  targetTenantId: EnrollmentTenantIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });

/**
 * Stable business intent of one Existing-account Core identity transition. No credential, no
 * provider payload and no timestamp, so an equivalent retry digests identically and the durable
 * owner operation is replayed rather than repeated.
 */
const ExistingAccountEnrollmentTransitionIntentSchema = Schema.Struct({
  journey: EnrollmentJourneySchema,
  ownerModuleKey: Schema.toEncoded(EnrollmentModuleKeySchema),
  portalEnrollmentAttemptId: Schema.toEncoded(EnrollmentAttemptIdSchema),
  subject: ExistingAccountEnrollmentSubjectSchema,
  transitionKey: Schema.toEncoded(EnrollmentTransitionKeySchema),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type ExistingAccountEnrollmentTransitionIntent = typeof ExistingAccountEnrollmentTransitionIntentSchema.Type;

const canonicalIntentJsonSchema = Schema.fromJsonString(ExistingAccountEnrollmentTransitionIntentSchema);

export const existingAccountRequestDigest = (
  intent: ExistingAccountEnrollmentTransitionIntent,
): Effect.Effect<typeof EnrollmentDigestSchema.Type, ExistingAccountEnrollmentRejected> =>
  Schema.encodeEffect(canonicalIntentJsonSchema)(intent).pipe(
    Effect.flatMap((canonical) => Schema.decodeEffect(EnrollmentDigestSchema)(enrollmentDigest(canonical))),
    Effect.mapError((cause) =>
      rejectExistingAccount(
        'existing_account_transition_invalid',
        'The Existing-account enrollment business intent could not be digested',
        cause,
      ),
    ),
  );

type EnrollmentResourceId = typeof EnrollmentResourceIdSchema.Type;

const decodeOrReject = <Value>(
  schema: Schema.ConstraintDecoder<Value>,
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- This is the Core identity wire boundary; the value is decoded before any request is built.
  value: unknown,
  reason: string,
): Effect.Effect<Value, ExistingAccountEnrollmentRejected> =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError((cause) => rejectExistingAccount('existing_account_transition_invalid', reason, cause)),
  );

const toCoreAuthBindingId = (
  value: EnrollmentResourceId,
): Effect.Effect<typeof AuthBindingIdSchema.Type, ExistingAccountEnrollmentRejected> =>
  decodeOrReject(
    AuthBindingIdSchema,
    String(value),
    'The reserved Principal Auth Binding reference is not a valid Core binding identifier',
  );

/**
 * The neutral Core reserve payload for the exact current subject. Composition supplies the opaque
 * `authenticationRef` evidence; no token, session cookie or credential is ever accepted here.
 */
export const existingAccountCoreIdentityReserveRequest = (input: {
  readonly accountSubject: CommercePortalAccountSubject;
  readonly authenticationRef: string;
}): Effect.Effect<ReservePrincipalBindingRequest, ExistingAccountEnrollmentRejected> =>
  decodeOrReject(
    AuthenticationNamespaceIdSchema,
    input.accountSubject.authenticationNamespaceId,
    'The current session authentication namespace could not be represented for Core identity',
  ).pipe(
    Effect.map((authenticationNamespaceId) => ({
      authenticationRef: input.authenticationRef,
      reservation: {
        authenticationNamespaceId,
        providerSubjectId: input.accountSubject.providerSubjectId,
        subjectType: input.accountSubject.subjectType,
      },
    })),
  );

/** Activate only ever follows a successfully recorded reserve; it never invents a binding ID. */
export const existingAccountCoreIdentityActivateRequest = (input: {
  /** The `resultReference` recorded by the prior successful reserve transition. */
  readonly authBindingId: EnrollmentResourceId;
  readonly authenticationRef: string;
  readonly expectedRevision: number;
}): Effect.Effect<ActivatePrincipalBindingRequest, ExistingAccountEnrollmentRejected> =>
  Effect.all(
    {
      authBindingId: toCoreAuthBindingId(input.authBindingId),
      expectedRevision: decodeOrReject(
        BindingRevisionSchema,
        input.expectedRevision,
        'The expected Principal Auth Binding revision is invalid',
      ),
    },
    { concurrency: 2 },
  ).pipe(
    Effect.map(({ authBindingId, expectedRevision }) => ({
      activation: { authBindingId, expectedRevision },
      authenticationRef: input.authenticationRef,
    })),
  );

/** The exact-binding Core read used to reconcile an indeterminate reserve/activate result. */
export const existingAccountCoreIdentityReadByBindingRequest = (
  authBindingId: EnrollmentResourceId,
): Effect.Effect<ReadPrincipalBindingRequest, ExistingAccountEnrollmentRejected> =>
  toCoreAuthBindingId(authBindingId).pipe(
    Effect.map((decoded) => ({ authBindingId: decoded, lookup: 'binding' as const })),
  );
