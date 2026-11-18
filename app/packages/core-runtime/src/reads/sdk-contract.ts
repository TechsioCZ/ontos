/**
 * Private contract of the read adapter of the execution kernel: everything read-only that the neutral
 * engine (`execution/contract.ts`) must not know. Not exported from the package.
 *
 * - access lane:   `reads/access-questions.ts` `materializeAccessQuestions: MaterializeAccessQuestions`,
 *                                              `answerAccessQuestions: AnswerAccessQuestions`
 * - read adapter:  `reads/run-form.ts`         `executeRunFormRead: ExecuteRunFormRead`
 * - runner lane:   `reads/run-evidence-live.ts` (tag and types in `reads/run-evidence.ts`)
 */
import type { Effect, Schema } from 'effect';

import type { AccessDecision } from '../access/decision/contract.ts';
import type { ListAccessPredicate } from '../access/decision/list-access.ts';
import type { GateCarrier } from '../access/enforcement/contract.ts';
import type { OwnerAuthorizationInput, OwnerAuthorizationOverlay } from '../access/enforcement/owner-overlay.ts';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import type { ActionPolicyTarget } from '../actions/policy.ts';
import type { CoreTransaction } from '../db/types.ts';
import type { KernelSessions } from '../execution/kernel-sessions.ts';
import type { BoundAccessGate } from '../operations/access-gate.ts';
import type { OperationalScope } from '../operations/context.ts';
import type { LegalEntityScope } from '../operations/legal-entity-scope.ts';
import type { ExecutionFacts } from '../sdk/index.ts';
import type { AccessAnswers, AccessQuestions } from '../sdk/read.ts';
import type { ReadRegistration } from './definition.ts';
import type { ReadCoreError } from './errors.ts';
import type { ReadRunEvidence } from './run-evidence.ts';

/* ------------------------------------------------------------------------------------------------ */
/* Access questions                                                                                 */
/* ------------------------------------------------------------------------------------------------ */

/** One question, resolved once at definition into the gate input it asks (minus `now` and `scope`). */
export interface MaterializedAccessQuestion {
  readonly carrier: GateCarrier;
  readonly kind: 'decide' | 'field' | 'list';
  readonly legalEntityScope: LegalEntityScope;
  readonly name: string;
  /** For a field question: the parent capability, decided scope-wide. */
  readonly parentCapabilityKey?: string;
  /** Equal to the read's own carrier: answered from the read's own decision, never asked twice. */
  readonly sameAsOwnDecision: boolean;
}

/**
 * Definition time (`reads/access-questions.ts`), called by `defineRead`: turns `accessQuestions` into
 * concrete questions once. Refuses (throws `ReadDefinitionInvariantError`) a target without a protected
 * carrier, a `can_run` whose declaration has record selectors, a `can_see_fields` naming a group the
 * target does not declare, and more than 16 questions.
 */
export type MaterializeAccessQuestions = (
  read: Readonly<{ readonly accessKind: string; readonly carrier: GateCarrier }>,
  questions: AccessQuestions,
) => readonly MaterializedAccessQuestion[];

/**
 * Request time, only after the read's own decision is ALLOWED (never for a denied or unavailable read,
 * so no question can change the read's own answer). Asks every question not `sameAsOwnDecision` in one
 * `decideMany` where the gate has it, lists separately, with the same `now` and scope as the read's
 * decision. `transaction` is the transaction the read's own decision used (the governed `{ load }`
 * path passes the same `ownedTransaction` as `authorizeThroughGate`, so no second pooled connection is
 * opened while the governed transaction is held, O75); the `{ run }` path holds none and passes
 * `undefined`. Never fails: an unavailable gate or answer is `'unavailable'` /
 * `Result.fail('unavailable')` for that name. A list answer without a predicate is
 * `Result.succeed(Option.none())`. `NEEDS_APPROVAL` is `'needs_approval'` for `can_run`, `'denied'`
 * for a field group.
 */
export type AnswerAccessQuestions = <Questions extends AccessQuestions>(input: {
  readonly gate: BoundAccessGate | undefined;
  readonly now: Date;
  readonly own: Readonly<{ readonly decision: AccessDecision; readonly listAccess?: ListAccessPredicate }>;
  readonly questions: readonly MaterializedAccessQuestion[];
  readonly scope: OperationalScope;
  readonly transaction?: CoreTransaction;
}) => Effect.Effect<AccessAnswers<Questions>>;

/* ------------------------------------------------------------------------------------------------ */
/* The `{ run }` form                                                                               */
/* ------------------------------------------------------------------------------------------------ */

/** Today's `withReadExecution` bound to one read: keeps the module operation execution lease open. */
export type ExecutionLease = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

/** What `reads/runtime.ts` has established when it hands a `{ run }` read to the run-form executor. */
export interface RunFormReadInput {
  readonly access: AccessAnswers<AccessQuestions>;
  readonly admittedRevision: string | undefined;
  readonly decodedInput: unknown;
  readonly deniedFieldPaths: readonly (readonly string[])[];
  /** `identity` is `Request` with `via` computed as `RequestExecutionSchema` documents. */
  readonly facts: ExecutionFacts;
  readonly lease: ExecutionLease;
  readonly listAccess?: ListAccessPredicate;
  /** The owner rule's question, completed with each transaction's `operationAt`. */
  readonly ownerQuestion: Omit<OwnerAuthorizationInput, 'operationAt'>;
  readonly permissionTargetMetadata: ActionPolicyTarget;
  readonly principal: TrustedPrincipalContext;
  readonly queryHash: string | undefined;
  readonly scope: OperationalScope;
  /** True when the access gate decided this read: `deniedFieldPaths` is then handed to `run`. */
  readonly usesAccessGate: boolean;
  /** The main decision and carrier, for the scoped workload admission seal (as today). */
  readonly workloadAdmission: Readonly<{ readonly carrier: GateCarrier; readonly decision?: AccessDecision }>;
}

/**
 * Runs a `{ run }` read after admission (`reads/run-form.ts`). Obligations, in order:
 *
 * 1. Builds the `OwnerBinding`: `build` = the read's service factory closed over `listAccess`;
 *    `decide` = `OwnerAuthorizationOverlay.authorize(sealed, { ...ownerQuestion, operationAt })`;
 *    `seal` = `bindScopedWorkloadAdmission(tx, { carrier, scope }, decision)`. `callerSource` is
 *    `RequestPrincipalCallerSourceSchema.make({ principal })`. The read runtime provides the
 *    `OwnerAuthorizationOverlay` it uses today (`failClosedOwnerAuthorizationOverlay` where it has none).
 * 2. Opens a kernel session with `READ_EXECUTION_BUDGET` and `transactionMode: 'read_only'`, inside
 *    `input.lease` so requirement lookups resolve. `open` decides the owner rule first; its failure
 *    goes to step 5 and no module code runs.
 * 3. Runs `run(decodedInput, context)` with `context = { ...capabilities, access, deniedFieldPaths
 *    (when `usesAccessGate`), listAccess, readKey, scope }`.
 * 4. Success, and `session.ownerDenied` is false: decode the result with `Schema.toType(resultSchema)`;
 *    the legacy result permission check when declared; `validateReadEvidenceMetadata`; then
 *    `ReadRunEvidence.settle` with the read's `allowed` row plus `callEvidenceRows`; then
 *    `projectReadResultFields` with `deniedFieldPaths`. The caller receives the projection only after
 *    the evidence committed; the result is released as computed (see `TransactionFacts.operationAt`).
 * 5. Denied, whatever `run` returned: `session.ownerDenied` is true, or `open` or `run` failed with
 *    `TransactionAborted('owner_denied')` or with `ReadPermissionDenied` anywhere in the cause. Settle
 *    the read's `denied` row (`outcomeCode: 'read_permission_denied'`, `outcomeStage: 'authz'`) plus
 *    the call rows, then fail `ReadPermissionDenied`. If that settle fails, combine causes as today;
 *    the denial stays the answer.
 * 6. `TransactionAborted('owner_unavailable')`: `ReadPermissionUnavailable`, as today. Any other
 *    `TransactionAborted`: `ReadHandlerUnavailable`. An `ExecutionRuleViolation` defect:
 *    `ReadHandlerUnavailable`, logged. Domain failures: `sanitizeReadHandlerFailure` as today. In every
 *    failure path the call rows are still settled with the read's `failed` row; an evidence failure
 *    there never replaces the read's own failure.
 * 7. Never holds an outer transaction across `run`: today's governed composition lock is replaced by
 *    the fence at the start of the owner check, of every owner transaction and of the evidence
 *    transaction.
 */
export type ExecuteRunFormRead = <
  InputSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  Owner extends string,
  Services,
  HandlerError,
  Requirements,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
>(
  registration: ReadRegistration<
    InputSchema,
    ResultSchema,
    Owner,
    Services,
    HandlerError,
    Requirements,
    DomainErrorSchema
  >,
  input: RunFormReadInput,
) => Effect.Effect<
  ResultSchema['Type'],
  DomainErrorSchema['Type'] | ReadCoreError,
  KernelSessions | OwnerAuthorizationOverlay | ReadRunEvidence | Requirements
>;
