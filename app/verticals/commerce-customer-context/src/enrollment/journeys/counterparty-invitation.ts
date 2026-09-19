import { createHash } from 'node:crypto';
import { Effect, Result, Schema } from 'effect';

import {
  CounterpartyPermissionScopeSchema,
  CounterpartyRefSchema,
  PrincipalRefSchema,
} from '../../../shared/domain/access-contract.ts';
import {
  EnrollmentAttemptIdSchema,
  EnrollmentDigestSchema,
  EnrollmentJourneySchema,
  EnrollmentModuleKeySchema,
  EnrollmentTransitionKeySchema,
} from '../../../shared/enrollment-contracts.ts';
import { CounterpartyAccessInvitationRefSchema } from '../../../shared/resources/counterparty-access-invitation.ts';
import { CommerceEnrollmentOwnerTransitionSchema } from '../orchestration/owner-transition-driver.ts';
import type { CommerceEnrollmentOwnerTransition } from '../orchestration/owner-transition-driver.ts';
import {
  PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
  PORTAL_AUTH_OWNER_MODULE_KEY,
} from '../orchestration/prepared-owner-authority.ts';
import type { JourneyDefinition, JourneyTransitionSpec } from './journey-contracts.ts';
import { JourneyDefinitionSchema, journeyTransitions } from './journey-contracts.ts';

/**
 * Counterparty invitation enrollment journey.
 *
 * The journey composes exactly three owner transitions: the Commerce Portal Account creation, the
 * existing `claim-counterparty-access-invitation` Action, and the Core Principal Auth Binding
 * activation.  There is deliberately no fourth "grant" transition: the claim owner already stages
 * the invitation's intended Permission mutations inside its own transaction, so a journey-level
 * grant loop would either duplicate those mutations or invent authority the invitation never
 * carried.  The invitation itself is never treated as a Permission; access exists only once the
 * claim owner's staged grants are Current.
 *
 * Every transition travels through the generic owner-transition driver, so a lost claim response
 * converges on the exact original owner invocation through `reconcile` rather than a second blind
 * claim, and partial grant progress is preserved instead of rolled back.
 */

/** Owner module that owns the Counterparty Access invitation claim and its staged grants. */
export const COUNTERPARTY_ACCESS_OWNER_MODULE_KEY = 'commerce.customer-context';
/** Stable transition identity of the existing claim-counterparty-access-invitation Action. */
export const CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY = 'counterparty-access-invitation.claim';
/** Owner module that owns the Tenant-scoped Principal Auth Binding. */
export const CORE_IDENTITY_OWNER_MODULE_KEY = 'core.identity';
/** Enrollment may only establish a binding; disable/revoke stays with its own owner Action. */
export const CORE_PRINCIPAL_BINDING_ACTIVATION_TRANSITION_KEY = 'core.principal-binding.activate';

/**
 * Dispatch order.  The portal account must exist before an invitation can be claimed by an
 * authenticated Principal, and the claim must have committed before the Core binding is activated
 * for the Tenant the invitation belongs to.
 */
const COUNTERPARTY_INVITATION_TRANSITIONS = [
  {
    ownerModuleKey: PORTAL_AUTH_OWNER_MODULE_KEY,
    required: true,
    transitionKey: PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
  },
  {
    ownerModuleKey: COUNTERPARTY_ACCESS_OWNER_MODULE_KEY,
    required: true,
    transitionKey: CLAIM_COUNTERPARTY_ACCESS_INVITATION_TRANSITION_KEY,
  },
  {
    ownerModuleKey: CORE_IDENTITY_OWNER_MODULE_KEY,
    required: true,
    transitionKey: CORE_PRINCIPAL_BINDING_ACTIVATION_TRANSITION_KEY,
  },
] as const;

/**
 * All three transitions gate completion.  A claimed invitation without an active Principal Auth
 * Binding, or a binding without a committed claim, is an incomplete journey and must never project
 * as COMPLETE.
 */
export const counterpartyInvitationJourneyDefinition: JourneyDefinition = Result.getOrThrow(
  Schema.decodeResult(JourneyDefinitionSchema)({
    kind: 'COUNTERPARTY_INVITATION',
    optionalTransitions: [],
    requiredTransitions: [...COUNTERPARTY_INVITATION_TRANSITIONS],
  }),
);

/**
 * The exact invitation, Counterparty, claimant and Permission scope the journey may operate on.
 * It carries no claim proof, no credential and no Permission list: the intended Permissions belong
 * to the invitation read, never to the Attempt's business intent.
 */
export const CounterpartyInvitationSubjectSchema = Schema.Struct({
  claimant: PrincipalRefSchema,
  counterpartyRef: CounterpartyRefSchema,
  invitationRef: CounterpartyAccessInvitationRefSchema,
  scope: CounterpartyPermissionScopeSchema,
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type CounterpartyInvitationSubject = typeof CounterpartyInvitationSubjectSchema.Type;

/**
 * Stable business intent of one Counterparty invitation transition.  It carries no claim proof, no
 * provider payload and no timestamp, so an equivalent retry produces an identical digest and the
 * durable owner operation is replayed instead of repeated.
 */
const CounterpartyInvitationTransitionIntentSchema = Schema.Struct({
  journey: EnrollmentJourneySchema,
  ownerModuleKey: Schema.toEncoded(EnrollmentModuleKeySchema),
  portalEnrollmentAttemptId: Schema.toEncoded(EnrollmentAttemptIdSchema),
  subject: CounterpartyInvitationSubjectSchema,
  transitionKey: Schema.toEncoded(EnrollmentTransitionKeySchema),
}).annotate({ parseOptions: { onExcessProperty: 'error' } });
export type CounterpartyInvitationTransitionIntent = typeof CounterpartyInvitationTransitionIntentSchema.Type;

const canonicalIntentJsonSchema = Schema.fromJsonString(CounterpartyInvitationTransitionIntentSchema);

export class CounterpartyInvitationTransitionRejected extends Schema.TaggedError<CounterpartyInvitationTransitionRejected>()(
  'CounterpartyInvitationTransitionRejected',
  {
    code: Schema.Literals([
      'counterparty_invitation_transition_undeclared',
      'counterparty_invitation_tenant_mismatch',
      'counterparty_invitation_transition_invalid',
    ]),
    reason: Schema.String,
    retryable: Schema.Boolean,
  },
) {}

const preserveCause = <Value extends object>(error: Value, cause: unknown): Value =>
  Object.defineProperty(error, 'cause', { configurable: false, enumerable: false, value: cause });

const rejectTransition = (
  code: typeof CounterpartyInvitationTransitionRejected.Type.code,
  reason: string,
  cause?: unknown,
): CounterpartyInvitationTransitionRejected => {
  const error = new CounterpartyInvitationTransitionRejected({ code, reason: reason.slice(0, 500), retryable: false });
  return cause === undefined ? error : preserveCause(error, cause);
};

/**
 * Deterministic lowercase SHA-256 digest of the canonical intent.  The same invitation, claimant,
 * scope and transition always produce the same digest, so a retry reuses the exact owner operation
 * instead of creating a second account, a second claim or a second Principal Auth Binding.
 */
export const makeCounterpartyInvitationRequestDigest = (
  intent: CounterpartyInvitationTransitionIntent,
): Effect.Effect<typeof EnrollmentDigestSchema.Type, CounterpartyInvitationTransitionRejected> =>
  Schema.encodeEffect(canonicalIntentJsonSchema)(intent).pipe(
    Effect.flatMap((canonical) =>
      Schema.decodeEffect(EnrollmentDigestSchema)(createHash('sha256').update(canonical).digest('hex')),
    ),
    Effect.mapError((cause) =>
      rejectTransition(
        'counterparty_invitation_transition_invalid',
        'The Counterparty invitation business intent could not be digested',
        cause,
      ),
    ),
  );

/**
 * The ordered dispatch plan: every declared Counterparty invitation transition, required first.
 * Each step consumes the previous step's durable owner outcome.
 */
export const counterpartyInvitationStepPlan = (): readonly JourneyTransitionSpec[] =>
  journeyTransitions(counterpartyInvitationJourneyDefinition);

/**
 * Trusted owner identity minus everything the journey derives itself.  The caller cannot name an
 * owner module, a transition key or a request digest: those come from the journey's own
 * declaration and the trusted subject.
 */
export interface CounterpartyInvitationTransitionInput {
  readonly identity: Omit<CommerceEnrollmentOwnerTransition, 'ownerModuleKey' | 'requestDigest' | 'transitionKey'>;
  readonly subject: CounterpartyInvitationSubject;
}

const declaredStep = (step: JourneyTransitionSpec): JourneyTransitionSpec | undefined =>
  counterpartyInvitationStepPlan().find(
    (candidate) => candidate.ownerModuleKey === step.ownerModuleKey && candidate.transitionKey === step.transitionKey,
  );

/**
 * Every subject reference must belong to the trusted Tenant of the Attempt.  A cross-Tenant
 * invitation, Counterparty or claimant is a typed rejection here, before any owner effect runs, so
 * a wrong-Tenant invitation can never reach the claim Action as a dispatchable transition.
 */
const tenantBindingIssue = (input: CounterpartyInvitationTransitionInput): string | undefined => {
  const { tenantId } = input.identity;
  if (input.subject.invitationRef.tenantId !== tenantId) {
    return 'The invitation belongs to a different Tenant than the Enrollment Attempt';
  }
  if (input.subject.counterpartyRef.tenantId !== tenantId) {
    return 'The Counterparty belongs to a different Tenant than the Enrollment Attempt';
  }
  return input.subject.claimant.tenantId === tenantId
    ? undefined
    : 'The claimant belongs to a different Tenant than the Enrollment Attempt';
};

/**
 * Build one driver transition for a declared Counterparty invitation step.  An Attempt cannot
 * claim a transition this journey does not own, and two equivalent requests cannot disagree about
 * their request digest.
 */
export const makeCounterpartyInvitationTransition = Effect.fn('CounterpartyInvitationJourney.makeTransition')(
  function* makeCounterpartyInvitationTransitionEffect(
    step: JourneyTransitionSpec,
    input: CounterpartyInvitationTransitionInput,
  ): Effect.fn.Return<CommerceEnrollmentOwnerTransition, CounterpartyInvitationTransitionRejected> {
    const declared = declaredStep(step);
    if (declared === undefined) {
      return yield* rejectTransition(
        'counterparty_invitation_transition_undeclared',
        'The requested owner transition is not declared by the Counterparty invitation journey',
      );
    }
    const tenantIssue = tenantBindingIssue(input);
    if (tenantIssue !== undefined) {
      return yield* rejectTransition('counterparty_invitation_tenant_mismatch', tenantIssue);
    }
    const requestDigest = yield* makeCounterpartyInvitationRequestDigest({
      journey: 'COUNTERPARTY_INVITATION',
      ownerModuleKey: declared.ownerModuleKey,
      portalEnrollmentAttemptId: input.identity.portalEnrollmentAttemptId,
      subject: input.subject,
      transitionKey: declared.transitionKey,
    });
    return yield* Schema.decodeEffect(CommerceEnrollmentOwnerTransitionSchema)({
      ...input.identity,
      ownerModuleKey: declared.ownerModuleKey,
      requestDigest,
      transitionKey: declared.transitionKey,
    }).pipe(
      Effect.mapError((cause) =>
        rejectTransition(
          'counterparty_invitation_transition_invalid',
          'The Counterparty invitation transition identity is invalid',
          cause,
        ),
      ),
    );
  },
);
