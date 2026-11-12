import { Cause, Context, Effect, Exit, Layer, Match, Option, Schema } from 'effect';
import type { DateTime } from 'effect';

import { isOwnerPermissionAccessTargetValid } from '../../permissions/context-access.ts';
import type { OwnerPermissionAccessTarget, ResourceAccessTarget } from '../../permissions/context-access.ts';
import type { LegalEntityPermissionKey, TenantPermissionKey } from '../../permissions/context-permissions.ts';
import type { AccessRecordTarget } from '../decision/contract.ts';
import { reportableReasonCodes } from './reason-codes.ts';
import type { ScopedTransactionExecutor } from '../../db/scoped-transaction.ts';
import type { OperationalScope } from '../../operations/context.ts';

/**
 * Owner-local authorization is deliberately a small Core seam. Core owns the lifecycle and
 * transaction, while an owner supplies the decision for its canonical state. The owner adapter
 * must read through the supplied scoped transaction so a mutation cannot authorize against a
 * snapshot that is later changed before the handler commits (CUTOVER-PLAN §3.2).
 *
 * v2 is not a second permission system: the entrypoint's capability is decided by the one access
 * gate, and this seam carries only the owner's own business rule over its own state — the customer's
 * counterparty grant, a cart's draft authority, an inventory resource's import assertion (O67-Q1).
 */
export const OwnerAuthorizationDecisionSchema = Schema.Literals(['allowed', 'denied', 'unavailable']);
export type OwnerAuthorizationDecision = typeof OwnerAuthorizationDecisionSchema.Type;

/**
 * The owner-local facts of one governed request (O70): a flat, owner-defined projection of the
 * decoded payload, e.g. the counterparty whose own grant the owner rule has to check. The
 * entrypoint's own resolver produces them from the decoded payload and the trusted scope, Core
 * hands them to the overlay inside the transaction, and they never reach the decision engine:
 * facts name the owner record a business rule is about, they grant nothing (O64, O67-Q1).
 */
export type OwnerAccessFacts = Readonly<Record<string, string>>;

/**
 * Transitional: the legacy authorization targets of a descriptor that is still on a legacy kind.
 * They disappear with those kinds (C03b/C14); a v2 descriptor names `target` instead (O9, O27).
 */
export type OwnerAuthorizationTarget =
  | Readonly<{
      readonly kind: 'owner_permission';
      readonly target: OwnerPermissionAccessTarget;
      readonly trustedStorefrontId?: string;
    }>
  | Readonly<{
      readonly kind: 'legal_entity';
      readonly legalEntityId: string;
      readonly permission?: LegalEntityPermissionKey;
    }>
  | Readonly<{
      readonly kind: 'module';
      readonly legalEntityId?: string;
      readonly moduleId: string;
    }>
  | Readonly<{
      readonly kind: 'resource';
      readonly permission: 'read' | 'write';
      readonly resource: ResourceAccessTarget;
    }>
  | Readonly<{
      readonly kind: 'tenant';
      readonly permission: TenantPermissionKey;
      readonly tenantId: string;
    }>;

export interface OwnerAuthorizationInput {
  /** The entrypoint's own capability key: the identity an owner rule switches on (O27). */
  readonly capabilityKey: string;
  readonly operation: 'action' | 'read';
  /** Core-minted PostgreSQL transaction start time; never derived from request input. */
  readonly operationAt: DateTime.Utc;
  readonly operationKey: string;
  /**
   * The owner-local facts this request carries (O70), absent when the entrypoint declares no
   * resolver. The owner rule reads the records they name from its own state; no fact is authority.
   */
  readonly ownerFacts?: OwnerAccessFacts;
  readonly owningModuleKey: string;
  readonly scope: OperationalScope;
  /** The record the capability acts on when its declaration is record-scoped (O9, O27). */
  readonly target?: AccessRecordTarget;
  /**
   * Transitional: the legacy targets of a descriptor still on a legacy kind. A v2 descriptor
   * carries none and names `target` instead (O62, O68).
   */
  readonly targets: readonly OwnerAuthorizationTarget[];
}

/**
 * A decided owner-rule refusal that says why. `reasons` are the owner's stable, non-secret codes
 * (`deny.owner.*`, then `requires.<owner right>` naming the owner-local right the actor lacks). The
 * v2 gate and "Proč?" cannot see an owner rule, so these codes are the only way the refused person
 * and the operator learn which rule refused; Core puts them on the 403 and on its refusal warning.
 */
export interface OwnerAuthorizationDenial {
  readonly decision: 'denied';
  readonly reasons: readonly [string, ...string[]];
}

/** What an owner overlay answers: a bare decision, or a refusal that names its reasons. */
export type OwnerAuthorizationOutcome = OwnerAuthorizationDecision | OwnerAuthorizationDenial;

/** The reason Core reports when an owner overlay refuses without naming one, or names one it cannot report. */
export const OWNER_RULE_DENIED_REASON = 'deny.owner_rule';

/**
 * The one closed contract of an owner overlay's answer, decoded by Core before it acts on it: a bare
 * decision, or a refusal naming non-empty string reasons. Nothing else is an answer (O48).
 */
const OwnerAuthorizationAnswerSchema = Schema.Union([
  OwnerAuthorizationDecisionSchema,
  Schema.Struct({
    decision: Schema.Literal('denied'),
    reasons: Schema.NonEmptyArray(Schema.String),
  }),
]);
const decodeOwnerAnswer = Schema.decodeUnknownOption(OwnerAuthorizationAnswerSchema, { onExcessProperty: 'error' });

/** An owner answer as Core acts on it: one decision, and for a refusal the reason codes Core may report. */
export type DecodedOwnerAuthorization =
  | { readonly decision: 'allowed' | 'unavailable' }
  | { readonly decision: 'denied'; readonly reasons: readonly [string, ...string[]] };

/** The refusal's own codes when Core may report every one of them; otherwise the generic owner-rule code (R3). */
const reportableReasons = (reasons: readonly string[]): readonly [string, ...string[]] => {
  const [first, ...rest] = Option.getOrElse(reportableReasonCodes(reasons), () => []);
  return first === undefined ? [OWNER_RULE_DENIED_REASON] : [first, ...rest];
};

/**
 * Decodes whatever an owner overlay answered. Any value outside the closed contract — an unknown
 * string, a missing or extra field, `null`, `undefined` — is `unavailable`: Core fails closed and never
 * reads an odd answer as an allow (a type escape or a separately built owner unit can send anything). A
 * refusal whose reasons Core cannot report keeps its refusal and reports `deny.owner_rule` instead.
 */
export const decodeOwnerAuthorizationOutcome = (answer: OwnerAuthorizationOutcome): DecodedOwnerAuthorization =>
  Option.match(decodeOwnerAnswer(answer), {
    onNone: (): DecodedOwnerAuthorization => ({ decision: 'unavailable' }),
    onSome: (value): DecodedOwnerAuthorization => {
      if (Schema.is(OwnerAuthorizationDecisionSchema)(value)) {
        return value === 'denied' ? { decision: 'denied', reasons: [OWNER_RULE_DENIED_REASON] } : { decision: value };
      }
      return { decision: 'denied', reasons: reportableReasons(value.reasons) };
    },
  });

/**
 * One owner answer as Core acts on it, from the exit of the overlay's own effect: a decoded answer, or
 * `unavailable` for a defect or failure the overlay raised (never an allow, never a crashed request).
 * Interruption stays interruption.
 */
export const ownerAuthorizationFromExit = (
  exit: Exit.Exit<OwnerAuthorizationOutcome>,
): Effect.Effect<DecodedOwnerAuthorization> => {
  if (Exit.isSuccess(exit)) {
    return Effect.succeed(decodeOwnerAuthorizationOutcome(exit.value));
  }
  return Cause.hasInterruptsOnly(exit.cause)
    ? Effect.failCause(exit.cause)
    : Effect.logWarning('Owner authorization overlay failed; answered unavailable').pipe(
        Effect.as<DecodedOwnerAuthorization>({ decision: 'unavailable' }),
      );
};

export const ownerAuthorizationDenial = (reason: string, ...more: readonly string[]): OwnerAuthorizationDenial => ({
  decision: 'denied',
  reasons: [reason, ...more],
});

export interface OwnerAuthorizationOverlayService {
  readonly authorize: (
    transaction: ScopedTransactionExecutor,
    input: OwnerAuthorizationInput,
  ) => Effect.Effect<OwnerAuthorizationOutcome>;
}

export class OwnerAuthorizationOverlay extends Context.Service<
  OwnerAuthorizationOverlay,
  OwnerAuthorizationOverlayService
>()('@app/core-runtime/access/enforcement/owner-overlay/OwnerAuthorizationOverlay') {}

/** The explicit default keeps deployments without owner state fail-safe for owner-neutral targets. */
export const allowOwnerAuthorizationOverlay: OwnerAuthorizationOverlayService = Object.freeze({
  authorize: () => Effect.succeed('allowed' as const),
});

/**
 * The production-safe fallback for deployments that do not install an owner adapter.
 *
 * Core can authorize the capability itself on its own state. Owner-held targets are different: their
 * canonical state belongs to the owning MicroVertical, so silently treating an omitted owner adapter
 * as an allow would turn a partial deployment into an authorization bypass. Keep this fallback
 * deliberately small and target-based; owner-neutral operations remain available while every
 * owner-governed legacy target fails closed as unavailable.
 *
 * An owner may explicitly declare a target whose authority requires only trusted scope and Current
 * Permission, with no owner-held record. That declaration still cannot bypass scope validation.
 */
export const failClosedOwnerAuthorizationDecision = (input: OwnerAuthorizationInput): OwnerAuthorizationDecision =>
  input.targets.some((target) =>
    Match.value(target).pipe(
      Match.when(
        { kind: 'owner_permission' },
        (owner) =>
          !isOwnerPermissionAccessTargetValid(owner.target, input.scope, input.owningModuleKey) ||
          owner.target.contract.ownerStateRequired !== false,
      ),
      Match.when({ kind: 'tenant' }, () => false),
      Match.when({ kind: 'module' }, () => false),
      Match.when({ kind: 'legal_entity' }, () => false),
      Match.when({ kind: 'resource' }, () => false),
      Match.orElse(() => true),
    ),
  )
    ? 'unavailable'
    : 'allowed';

export const failClosedOwnerAuthorizationOverlay: OwnerAuthorizationOverlayService = Object.freeze({
  authorize: (_transaction: ScopedTransactionExecutor, input: OwnerAuthorizationInput) =>
    Effect.succeed(failClosedOwnerAuthorizationDecision(input)),
});

export const OwnerAuthorizationOverlayAllowLive = Layer.succeed(
  OwnerAuthorizationOverlay,
  allowOwnerAuthorizationOverlay,
);
