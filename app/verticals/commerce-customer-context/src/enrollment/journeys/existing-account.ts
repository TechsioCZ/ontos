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
import { CommerceEnrollmentOwnerTransitionSchema } from '../orchestration/owner-transition-driver.ts';
import type { CommerceEnrollmentOwnerTransition } from '../orchestration/owner-transition-driver.ts';
import { JourneyDefinitionSchema } from './journey-contracts.ts';
import type { JourneyDefinition, JourneyTransitionSpec } from './journey-contracts.ts';

/**
 * Existing-account enrollment journey. An already-authenticated Commerce Portal Account (exact current session, same
 * provider subject) enrolls into a SECOND Tenant. No new provider account and no second subject
 * are ever created here: the journey establishes only a fresh Tenant-scoped Principal Auth
 * Binding for the existing subject, then continues with the same profile/binding/grant steps a
 * brand-new subject would go through for that Tenant's target journey (Retail self-enrollment or
 * Counterparty invitation).
 *
 * This module deliberately never imports `retail-self-enrollment.ts` or `counterparty-invitation.ts`
 * (journey modules never import one another — see
 * `journey-contracts.ts`). Every delegated profile/binding/grant step is carried only as data —
 * the declared `JourneyDefinition` of the target journey, supplied by the caller — so this module
 * can never duplicate, and can never drift from, the target journey's own step logic. Building the
 * concrete owner transition for a delegated step remains the responsibility of the journey module
 * that declared it; this module only ever builds the two Core identity transitions it uniquely
 * owns.
 */

/**
 * Owner module that owns the neutral, provider-neutral Core identity Principal Auth Binding. This
 * matches `CORE_IDENTITY_OWNER_MODULE_KEY` as independently declared by `counterparty-invitation.ts`
 * (journey modules never import one another, so each declares its own copy) — both name the same
 * owner module by design, so a single owner-effect adapter can serve every journey's Core steps.
 */
export const CORE_IDENTITY_OWNER_MODULE_KEY = 'core.identity';
/**
 * Reserve a pending Tenant-scoped Principal Auth Binding for the existing subject. Existing-account
 * enrollment is the only journey that ever dispatches a reserve: Retail and Counterparty invitation
 * both create a brand-new subject, so their provider account-creation step reserves the binding as
 * part of establishing the account; Existing-account never creates an account, so it must reserve
 * the second Tenant's binding itself.
 */
export const RESERVE_PRINCIPAL_BINDING_TRANSITION_KEY = 'core.principal-binding.reserve';
/**
 * Activate the reserved binding after fresh same-subject proof for the exact current session. The
 * transition key is byte-identical to `CORE_PRINCIPAL_BINDING_ACTIVATION_TRANSITION_KEY` in
 * `counterparty-invitation.ts` on purpose: both journeys' activate step dispatches the exact same
 * `ActivatePrincipalBindingRequest` wire shape through `core.identity`, so one owner-effect case
 * can serve both.
 */
export const ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY = 'core.principal-binding.activate';

/**
 * The two Core identity transitions Existing-account enrollment uniquely owns, decoded once
 * through `JourneyDefinitionSchema` so every consumer works with the same branded
 * `JourneyTransitionSpec` values the driver and the composed definition both expect. They always
 * gate completion: a second Tenant is never presented as reachable before its own Principal Auth
 * Binding is durably active.
 */
const existingAccountCoreIdentityDefinition: JourneyDefinition = Result.getOrThrow(
  Schema.decodeResult(JourneyDefinitionSchema)({
    kind: 'EXISTING_ACCOUNT',
    optionalTransitions: [],
    requiredTransitions: [
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
export const EXISTING_ACCOUNT_CORE_IDENTITY_TRANSITIONS: readonly JourneyTransitionSpec[] =
  existingAccountCoreIdentityDefinition.requiredTransitions;

/** Closed, safe rejection vocabulary for the Existing-account journey. */
export class ExistingAccountEnrollmentRejected extends Schema.TaggedError<ExistingAccountEnrollmentRejected>()(
  'ExistingAccountEnrollmentRejected',
  {
    code: Schema.Literals([
      'existing_account_target_journey_invalid',
      'existing_account_transition_undeclared',
      'existing_account_transition_invalid',
      'existing_account_subject_mismatch',
      'existing_account_tenant_mismatch',
    ]),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

/**
 * Build a closed-vocabulary rejection, preserving the original failure as a non-enumerable
 * `cause` instead of discarding it, matching `counterparty-invitation.ts`'s `rejectTransition`.
 */
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
 * Compose the Existing-account journey definition for one target journey. The target is the
 * journey the second Tenant enrollment continues as (Retail self-enrollment or Counterparty
 * invitation); its own provider-account-creation step is dropped because Existing-account never
 * creates a new provider account. Every other declared step of the target is inherited verbatim,
 * so a change to the target journey's profile/binding/grant steps is automatically reflected here
 * without this module changing at all.
 *
 * Existing-account's required-transition set is a function of the target journey, not a single
 * fixed catalog entry: the caller (composition, or a future derived-completion authority) selects
 * the target definition for one exact Attempt — e.g. from whether the Attempt carries an
 * `invitationId` — and calls this factory to obtain the definition to gate that Attempt's
 * completion.
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
  const delegatedRequired = targetDefinition.requiredTransitions.filter(
    (transition) => !isAccountCreationTransition(transition),
  );
  const delegatedOptional = targetDefinition.optionalTransitions.filter(
    (transition) => !isAccountCreationTransition(transition),
  );
  return Schema.decodeEffect(JourneyDefinitionSchema)({
    kind: 'EXISTING_ACCOUNT',
    optionalTransitions: delegatedOptional,
    requiredTransitions: [...EXISTING_ACCOUNT_CORE_IDENTITY_TRANSITIONS, ...delegatedRequired],
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

/**
 * The exact already-authenticated subject and the second Tenant it is enrolling into. No provider
 * payload, credential or session token ever enters this shape.
 */
export const ExistingAccountEnrollmentSubjectSchema = Schema.Struct({
  accountSubject: CommercePortalAccountSubjectSchema,
  targetTenantId: EnrollmentTenantIdSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
type ExistingAccountEnrollmentSubject = typeof ExistingAccountEnrollmentSubjectSchema.Type;

/**
 * Reject when the exact current session subject does not match the subject the Existing-account
 * request names. Account/session existence alone never authorizes a second-Tenant binding for a
 * different subject; a revoked or disabled binding in the *source* Tenant is Tenant-local and is
 * never inspected here.
 */
export const validateExistingAccountEnrollmentSubject = (params: {
  readonly currentSessionSubject: CommercePortalAccountSubject;
  readonly requestedAccountSubject: CommercePortalAccountSubject;
}): Effect.Effect<CommercePortalAccountSubject, ExistingAccountEnrollmentRejected> => {
  const { currentSessionSubject, requestedAccountSubject } = params;
  if (
    currentSessionSubject.authenticationNamespaceId !== requestedAccountSubject.authenticationNamespaceId ||
    currentSessionSubject.providerSubjectId !== requestedAccountSubject.providerSubjectId ||
    currentSessionSubject.subjectType !== requestedAccountSubject.subjectType
  ) {
    return Effect.fail(
      new ExistingAccountEnrollmentRejected({
        code: 'existing_account_subject_mismatch',
        reason: 'The exact current session subject does not match the requested Existing-account enrollment subject',
        retryable: false,
      }),
    );
  }
  return Effect.succeed(requestedAccountSubject);
};

/**
 * Stable business intent of one Existing-account Core identity transition. No credential, no
 * provider payload and no timestamp: the digest must be identical for an equivalent retry so the
 * durable owner operation is replayed rather than repeated (a second Tenant never gets a second
 * reserved binding from a retried request).
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

/**
 * Deterministic lowercase SHA-256 digest of the canonical intent. The same subject and target
 * Tenant always produce the same digest for the same transition, so a retry converges on the
 * exact same durable owner operation instead of reserving or activating a second binding.
 */
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

export interface ExistingAccountEnrollmentTransitionInput {
  readonly identity: Omit<CommerceEnrollmentOwnerTransition, 'ownerModuleKey' | 'requestDigest' | 'transitionKey'>;
  readonly subject: ExistingAccountEnrollmentSubject;
}

/**
 * The second Tenant the request names must be the exact Tenant the trusted Attempt identity
 * belongs to. Mirrors `tenantBindingIssue` in `counterparty-invitation.ts`: a mismatch is a typed
 * rejection here, before any digest is derived, so two requests that differ only in
 * `targetTenantId` can never collapse onto the same digest for one step.
 */
const tenantBindingIssue = (input: ExistingAccountEnrollmentTransitionInput): string | undefined =>
  input.subject.targetTenantId === input.identity.tenantId
    ? undefined
    : 'The requested second Tenant does not match the Tenant of the Existing-account Enrollment Attempt';

/**
 * Build one driver transition for a declared Core identity step (reserve or activate). The caller
 * cannot supply a request digest: it is derived from the step's own declaration and the trusted
 * subject, so an Attempt can never claim a transition this journey does not own. A delegated step
 * (owned by the target journey) is rejected here on purpose — it must be built by the journey
 * module that declared it, never reconstructed from this module's own intent shape.
 */
export const makeExistingAccountTransition = Effect.fn('ExistingAccountJourney.makeTransition')(
  function* makeExistingAccountTransitionEffect(
    step: JourneyTransitionSpec,
    input: ExistingAccountEnrollmentTransitionInput,
  ): Effect.fn.Return<CommerceEnrollmentOwnerTransition, ExistingAccountEnrollmentRejected> {
    const declared = EXISTING_ACCOUNT_CORE_IDENTITY_TRANSITIONS.find(
      (candidate) => candidate.ownerModuleKey === step.ownerModuleKey && candidate.transitionKey === step.transitionKey,
    );
    if (declared === undefined) {
      return yield* rejectExistingAccount(
        'existing_account_transition_undeclared',
        'Existing-account enrollment builds owner transitions only for the Core identity reserve/activate steps it owns; every delegated transition is built by its owning journey module',
      );
    }
    const tenantIssue = tenantBindingIssue(input);
    if (tenantIssue !== undefined) {
      return yield* rejectExistingAccount('existing_account_tenant_mismatch', tenantIssue);
    }
    const requestDigest = yield* existingAccountRequestDigest({
      journey: 'EXISTING_ACCOUNT',
      ownerModuleKey: step.ownerModuleKey,
      portalEnrollmentAttemptId: input.identity.portalEnrollmentAttemptId,
      subject: input.subject,
      transitionKey: step.transitionKey,
    });
    return yield* Schema.decodeEffect(CommerceEnrollmentOwnerTransitionSchema)({
      ...input.identity,
      ownerModuleKey: step.ownerModuleKey,
      requestDigest,
      transitionKey: step.transitionKey,
    }).pipe(
      Effect.mapError((cause) =>
        rejectExistingAccount(
          'existing_account_transition_invalid',
          'The Core identity owner transition could not be constructed safely',
          cause,
        ),
      ),
    );
  },
);

type EnrollmentResourceId = typeof EnrollmentResourceIdSchema.Type;

/** Decode one value into its Core identity contract, reporting a bad value as a typed rejection. */
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

export interface ExistingAccountCoreIdentityReserveRequestInput {
  readonly accountSubject: CommercePortalAccountSubject;
  readonly authenticationRef: string;
}

/**
 * Build the neutral Core reserve payload for the exact current subject. Composition supplies the
 * opaque `authenticationRef` evidence; this function never accepts or forwards a token, session
 * cookie or credential.
 */
export const existingAccountCoreIdentityReserveRequest = (
  input: ExistingAccountCoreIdentityReserveRequestInput,
): Effect.Effect<ReservePrincipalBindingRequest, ExistingAccountEnrollmentRejected> =>
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

export interface ExistingAccountCoreIdentityActivateRequestInput {
  /** The `resultReference` recorded by the prior successful reserve transition. */
  readonly authBindingId: EnrollmentResourceId;
  readonly authenticationRef: string;
  readonly expectedRevision: number;
}

/**
 * Build the neutral Core activate payload from the reserved binding. Activate only ever follows a
 * successfully recorded reserve outcome for the exact same Attempt; it never invents a binding ID.
 */
export const existingAccountCoreIdentityActivateRequest = (
  input: ExistingAccountCoreIdentityActivateRequestInput,
): Effect.Effect<ActivatePrincipalBindingRequest, ExistingAccountEnrollmentRejected> =>
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

/** Build the exact-binding Core read used to reconcile an indeterminate reserve/activate result. */
export const existingAccountCoreIdentityReadByBindingRequest = (
  authBindingId: EnrollmentResourceId,
): Effect.Effect<ReadPrincipalBindingRequest, ExistingAccountEnrollmentRejected> =>
  toCoreAuthBindingId(authBindingId).pipe(
    Effect.map((decoded) => ({ authBindingId: decoded, lookup: 'binding' as const })),
  );
