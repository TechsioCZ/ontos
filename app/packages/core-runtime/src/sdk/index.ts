/**
 * `@app/core-runtime/sdk`: the neutral kernel module code uses.
 *
 * Core gives module code two capabilities and nothing else:
 *
 * - `call`: Core calls a declared operation of another module, or of Core itself, and answers with
 *   its typed outcome as data. Credential, routing, composition revision, decoding and evidence are
 *   Core's work.
 * - `transaction`: Core opens the module's own scoped transaction, decides the owner rule, builds the
 *   module's services with the operation's own service factory and runs the module function in it.
 *
 * The module sequences them with ordinary Effect code: loops, branches and fan-out need no step kind.
 * The one rule Core enforces at runtime is that no call runs while a transaction of the same execution
 * is open, and that a transaction never opens inside another one.
 *
 * Nothing here is read-specific. Reads add their own authoring form in `@app/core-runtime/sdk/read`;
 * Actions and workers will add theirs on these same types.
 */
import { DateTime, Match, Option, Schema } from 'effect';
import type { Effect } from 'effect';

import { ActionInvocationIdSchema } from '../auth/external-identity-contracts.ts';
import { AccessKeySyntaxSchema } from '../authorization/access-key-syntax.ts';

/* ------------------------------------------------------------------------------------------------ */
/* Operation references                                                                             */
/* ------------------------------------------------------------------------------------------------ */

/** The exact provider operation a reference names, matching a manifest requirement's `provider`. */
export interface OperationProvider {
  readonly entrypointKey: string;
  readonly moduleId: string;
  readonly schemaVersion: string;
}

/** A read answers; a write changes owner state and therefore carries an idempotency key and a recovery. */
export const OperationEffectKindSchema = Schema.Literals(['read', 'write']);
export type OperationEffectKind = typeof OperationEffectKindSchema.Type;

/**
 * How Core reaches the provider. A module never chooses this: the reference carries it.
 *
 * - `Core`: a Core operation, run in-process through Core's own governed runtime with the caller's
 *   principal; `provider.entrypointKey` selects the registered Core operation.
 * - `Module`: a vertical's operation over the governed HTTP gateway. `path` is relative to the
 *   provider base URL the gateway delegation returns for the requirement's provider deployment.
 */
export const CoreOperationRouteSchema = Schema.TaggedStruct('Core', {});
export const ModuleOperationRouteSchema = Schema.TaggedStruct('Module', {
  path: Schema.TemplateLiteral(['/', Schema.String]),
});
export const OperationRouteSchema = Schema.Union([CoreOperationRouteSchema, ModuleOperationRouteSchema]);
export type OperationRoute = typeof OperationRouteSchema.Type;

/**
 * The schemas of a call: a codec without service requirements, so Core can encode the request and
 * decode the answer anywhere.
 */
export type CallSchema = Schema.Codec<unknown, unknown>;

/**
 * A typed reference to one provider operation. A vertical's generated contract package exports one per
 * public operation; Core exports its own in `coreOperations`.
 */
export interface OperationRef<
  RequestSchema extends CallSchema,
  ResponseSchema extends CallSchema,
  Kind extends OperationEffectKind = 'read',
> {
  readonly kind: Kind;
  readonly provider: Readonly<OperationProvider>;
  readonly request: RequestSchema;
  readonly response: ResponseSchema;
  readonly route: OperationRoute;
}

export type AnyOperationRef = OperationRef<CallSchema, CallSchema, OperationEffectKind>;
export type AnyReadOperationRef = OperationRef<CallSchema, CallSchema>;
export type AnyWriteOperationRef = OperationRef<CallSchema, CallSchema, 'write'>;

/** The decoded request type a module passes to `call`. */
export type OperationInput<Ref extends AnyOperationRef> = Ref['request']['Type'];
/** The decoded answer type a module receives from `call`. */
export type OperationOutput<Ref extends AnyOperationRef> = Ref['response']['Type'];

/** Declares a vertical operation reference. Generated contract packages call this; modules import the result. */
export const moduleOperation = <
  RequestSchema extends CallSchema,
  ResponseSchema extends CallSchema,
  const Kind extends OperationEffectKind,
>(input: {
  readonly kind: Kind;
  readonly path: `/${string}`;
  readonly provider: OperationProvider;
  readonly request: RequestSchema;
  readonly response: ResponseSchema;
}): OperationRef<RequestSchema, ResponseSchema, Kind> =>
  Object.freeze({
    kind: input.kind,
    provider: Object.freeze({ ...input.provider }),
    request: input.request,
    response: input.response,
    route: ModuleOperationRouteSchema.make({ path: input.path }),
  });

/* ------------------------------------------------------------------------------------------------ */
/* Declared calls and the caller identity a requirement permits                                     */
/* ------------------------------------------------------------------------------------------------ */

/**
 * The caller identities a manifest requirement on a vertical's operation permits for its call
 * (`requirements.operations[].callers`). Core selects exactly the one that matches the execution
 * identity and fails closed when that one is not listed; it never substitutes another. A requirement
 * on a Core operation (`provider.moduleId` starting with `core.`) declares no callers: Core runs it
 * in-process with the execution's own principal and the Core operation's own gate decides.
 *
 * - `person`: the execution's own principal, relayed (gateway `Assertion`). The receiver sees the
 *   person through the calling module.
 * - `registered`: the calling module acting for the identified principal under its registered
 *   declaration (gateway `RegisteredAssertion`). The one kind for a request whose principal is a
 *   verified workload, a recovery or a Core system principal; for recovery Core adds the canonical
 *   hash of the decoded call input. `pinPrincipal` sends `expectedPrincipalId` (the execution's
 *   principal), as the privacy module does today. It must match an entry of the module's
 *   `registeredWorkloadCalls` with the same `declarationKey` and the provider's `entrypointKey`, so the
 *   two declarations cannot drift.
 * - `workload`: the calling module as a registered workload (gateway `RegisteredWorkload`), for a
 *   worker delivery. Reserved until workers run on this kernel; matched against
 *   `registeredWorkloadCalls` the same way.
 *
 * `legalEntityScope` is the scope the delegated credential carries: the subject's selected Legal
 * Entity, or the tenant only.
 */
const CallerLegalEntityScopeSchema = Schema.Literals(['subject', 'tenant']);
/**
 * The access declaration a registered or workload caller acts under: an access key, written in a manifest
 * as a plain string like the module's `registeredWorkloadCalls[].declarationKey` it must match.
 */
export const CallerDeclarationKeySchema = AccessKeySyntaxSchema;
export const RequirementCallerSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('person'), legalEntityScope: CallerLegalEntityScopeSchema }),
  Schema.Struct({
    declarationKey: CallerDeclarationKeySchema,
    kind: Schema.Literal('registered'),
    legalEntityScope: CallerLegalEntityScopeSchema,
    pinPrincipal: Schema.Boolean,
  }),
  Schema.Struct({
    declarationKey: CallerDeclarationKeySchema,
    kind: Schema.Literal('workload'),
    legalEntityScope: CallerLegalEntityScopeSchema,
  }),
]);
export type RequirementCaller = typeof RequirementCallerSchema.Type;

/**
 * One call a module may make: the provider operation and the key of the requirement in the calling
 * module's own manifest that covers it. Declared as data on the operation's descriptor (`calls`), so
 * Core and the gate see every call an operation can make without running it.
 */
export interface DeclaredCall<Ref extends AnyOperationRef, Recovery extends string = string> {
  readonly operation: Ref;
  /**
   * A write call names, by its name in the same `calls` object, the declared read call that recovers an
   * indeterminate outcome with the same idempotency key. Absent for a read call.
   */
  readonly recovery?: Recovery;
  readonly requirementKey: string;
}

export type AnyDeclaredCall = DeclaredCall<AnyOperationRef>;
export type DeclaredCalls = Readonly<Record<string, AnyDeclaredCall>>;

/** Declares a read call covered by `requirementKey` of the calling module's manifest. */
export const declaredCall = <Ref extends AnyReadOperationRef>(
  operation: Ref,
  requirementKey: string,
): DeclaredCall<Ref, never> => Object.freeze({ operation, requirementKey });

/**
 * Declares a write call: covered by `requirementKey`, recovered by the read call named `recovery` in the
 * same `calls` object when its outcome is indeterminate (`RecoveriesDeclared` checks the name). Reserved
 * for Actions and workers: a read refuses it at definition, and the kernel dies `write_call_reserved`
 * until the Action adapter exists.
 */
export const declaredWriteCall = <Ref extends AnyWriteOperationRef, const Recovery extends string>(
  operation: Ref,
  requirementKey: string,
  recovery: Recovery,
): DeclaredCall<Ref, Recovery> & { readonly recovery: Recovery } =>
  Object.freeze({ operation, recovery, requirementKey });

/** A write call whose `recovery` names a read call of `Calls`: itself, else `never`. */
type RecoveredWriteCall<Calls extends DeclaredCalls, Name extends keyof Calls> = Calls[Name] extends {
  readonly recovery: infer Recovery;
}
  ? Recovery extends keyof Calls
    ? Calls[Recovery]['operation']['kind'] extends 'read'
      ? Calls[Name]
      : never
    : never
  : never;

/**
 * `Calls` itself when every write call names, as `recovery`, a read call of the same object and no read
 * call names one, else `never` at the offending entry: what the registration check refuses at runtime.
 * The Action and worker authoring forms will constrain their `calls` with it; a type test asserts it.
 */
export type RecoveriesDeclared<Calls extends DeclaredCalls> = {
  readonly [Name in keyof Calls]: Calls[Name]['operation']['kind'] extends 'read'
    ? Calls[Name] extends { readonly recovery: string }
      ? never
      : Calls[Name]
    : RecoveredWriteCall<Calls, Name>;
};

/* ------------------------------------------------------------------------------------------------ */
/* Typed outcomes                                                                                   */
/* ------------------------------------------------------------------------------------------------ */

/**
 * What a read call answers. Every provider answer is data; `call` itself never fails.
 *
 * - `Ok`: the provider's success answer, decoded by its own response schema.
 * - `NotFound`: the provider answered 404.
 * - `Forbidden`: the provider refused this caller (401, 403), the requirement does not permit the
 *   caller identity this execution has, or the owner rule already denied this execution (then the call
 *   never leaves the process).
 * - `Rejected`: the provider refused the request by its own rule (409, 422); `code` is its problem code.
 * - `Unavailable`: anything else: no route, no credential, composition revision mismatch, budget
 *   exhausted, transport failure, an undecodable answer, 5xx. `retryable` is true exactly for 503 and
 *   transport failures.
 */
export const callOkSchema = <Value extends Schema.Top>(value: Value) => Schema.TaggedStruct('Ok', { value });
export const CallNotFoundSchema = Schema.TaggedStruct('NotFound', { reason: Schema.String });
export const CallForbiddenSchema = Schema.TaggedStruct('Forbidden', { reason: Schema.String });
export const CallRejectedSchema = Schema.TaggedStruct('Rejected', { code: Schema.String, reason: Schema.String });
export const CallUnavailableSchema = Schema.TaggedStruct('Unavailable', {
  reason: Schema.String,
  retryable: Schema.Boolean,
});
export type CallOk<Output> = ReturnType<typeof callOkSchema<Schema.Codec<Output>>>['Type'];
export type CallFailure =
  | typeof CallForbiddenSchema.Type
  | typeof CallNotFoundSchema.Type
  | typeof CallRejectedSchema.Type
  | typeof CallUnavailableSchema.Type;
export type CallOutcome<Output> = CallFailure | CallOk<Output>;

/**
 * What a write call answers (reserved for Actions and workers).
 *
 * - `Committed`: the provider committed; `value` is its decoded answer.
 * - `CommittedRejection`: the provider committed a refusal of this exact request; retrying with the same
 *   key answers the same.
 * - `DefinitelyUncommitted`: nothing was committed; a retry with the same key is safe.
 * - `Indeterminate`: Core cannot tell. The caller must run the declared recovery with the same key
 *   before any retry.
 */
export const callCommittedSchema = <Value extends Schema.Top>(value: Value) =>
  Schema.TaggedStruct('Committed', { value });
export const CallCommittedRejectionSchema = Schema.TaggedStruct('CommittedRejection', {
  code: Schema.String,
  reason: Schema.String,
});
export const CallDefinitelyUncommittedSchema = Schema.TaggedStruct('DefinitelyUncommitted', {
  reason: Schema.String,
  retryable: Schema.Boolean,
});
/** A stable caller-chosen key that makes a write call safe to retry and recoverable. */
export const IdempotencyKeySchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).pipe(
  Schema.brand('IdempotencyKey'),
);
export type IdempotencyKey = typeof IdempotencyKeySchema.Type;
export const CallIndeterminateSchema = Schema.TaggedStruct('Indeterminate', {
  idempotencyKey: IdempotencyKeySchema,
  reason: Schema.String,
});
export type CallCommitted<Output> = ReturnType<typeof callCommittedSchema<Schema.Codec<Output>>>['Type'];
export type WriteCallOutcome<Output> =
  | CallCommitted<Output>
  | typeof CallCommittedRejectionSchema.Type
  | typeof CallDefinitelyUncommittedSchema.Type
  | typeof CallIndeterminateSchema.Type;

export type CallOutcomeOf<Declared extends AnyDeclaredCall> = Declared['operation']['kind'] extends 'write'
  ? WriteCallOutcome<OperationOutput<Declared['operation']>>
  : CallOutcome<OperationOutput<Declared['operation']>>;

/** The success answer of a read call, or `None` for every other outcome. */
export const callAnswer = <Output>(outcome: CallOutcome<Output>): Option.Option<Output> =>
  Match.valueTags(outcome, {
    Forbidden: () => Option.none(),
    NotFound: () => Option.none(),
    Ok: ({ value }) => Option.some(value),
    Rejected: () => Option.none(),
    Unavailable: () => Option.none(),
  });

/* ------------------------------------------------------------------------------------------------ */
/* Execution identity and facts                                                                     */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Who this execution acts as, given by Core. A module reads it; it never builds one. The trusted scope
 * itself is on the kind's context (`context.scope`), as today.
 *
 * - `Request`: a read (and later an Action) served for a request principal. `via` is the verified
 *   provenance of that principal, computed by Core from the decoded trusted principal in this order:
 *   `recovery` when `readVerifiedGatewayRecovery(principal)` is defined, `workload` when
 *   `readVerifiedGatewayWorkload(principal)` is defined, `system` when `authMethod === 'system'`,
 *   otherwise `person`.
 * - `ActionInvocation`: reserved for Actions: the admitted invocation.
 * - `WorkerDelivery`: reserved for workers: the attested claim of one outbox delivery. Tenant, Legal
 *   Entity and composition revision are not repeated here: they are the scope and the facts.
 */
export const RequestExecutionSchema = Schema.TaggedStruct('Request', {
  via: Schema.Literals(['person', 'recovery', 'system', 'workload']),
});
/** An Action key or a worker key: the module operation an execution runs. */
export const ExecutionOperationKeySchema = Schema.NonEmptyString.check(Schema.isMaxLength(300)).pipe(
  Schema.brand('ExecutionOperationKey'),
);
export const ActionInvocationExecutionSchema = Schema.TaggedStruct('ActionInvocation', {
  actionInvocationId: ActionInvocationIdSchema,
  actionKey: ExecutionOperationKeySchema,
  attempt: Schema.Finite.check(Schema.isInt()),
});
export const WorkerDeliveryExecutionSchema = Schema.TaggedStruct('WorkerDelivery', {
  attempt: Schema.Finite.check(Schema.isInt()),
  claimId: Schema.String.pipe(Schema.brand('OutboxClaimId')),
  deliveryId: Schema.String.pipe(Schema.brand('OutboxDeliveryId')),
  workerKey: ExecutionOperationKeySchema,
});
export const ExecutionIdentitySchema = Schema.Union([
  ActionInvocationExecutionSchema,
  RequestExecutionSchema,
  WorkerDeliveryExecutionSchema,
]);
export type ExecutionIdentity = typeof ExecutionIdentitySchema.Type;
export type RequestExecution = typeof RequestExecutionSchema.Type;
export type ActionInvocationExecution = typeof ActionInvocationExecutionSchema.Type;
export type WorkerDeliveryExecution = typeof WorkerDeliveryExecutionSchema.Type;

/**
 * Plain facts about the running execution. Request correlation stays on the scope, as today. Each kind
 * fixes `Identity` to the one it runs as (a read: `RequestExecution`).
 */
export interface ExecutionFacts<Identity extends ExecutionIdentity = ExecutionIdentity> {
  /** The composition revision the operation was admitted under; every transaction is fenced to it. */
  readonly compositionRevision: string | undefined;
  readonly identity: Identity;
  /** The operation key: a read key, an Action key, a worker key. */
  readonly operationKey: string;
  readonly owningModuleKey: string;
}

/**
 * Where a step ran relative to the owner's transactions: before the first, inside one, or after one
 * ended. Calls are never `inside`. Recorded on call evidence; Actions will use it for post-commit steps.
 */
export const PlacementSchema = Schema.Literals(['after', 'before', 'inside']);
export type Placement = typeof PlacementSchema.Type;

/* ------------------------------------------------------------------------------------------------ */
/* The two capabilities                                                                             */
/* ------------------------------------------------------------------------------------------------ */

type CallArguments<Declared extends AnyDeclaredCall> = Declared['operation']['kind'] extends 'write'
  ? readonly [input: OperationInput<Declared['operation']>, options: { readonly idempotencyKey: IdempotencyKey }]
  : readonly [input: OperationInput<Declared['operation']>];

/**
 * The arguments every call `Name` names accepts: a call's own for one name, and for a name typed as a
 * union only what each of its calls accepts, so a name is never paired with another call's input.
 */
type ArgumentsForEvery<Calls extends DeclaredCalls, Name extends keyof Calls> = (
  Name extends unknown ? (...args: CallArguments<Calls[Name]>) => void : never
) extends (...args: infer Args extends readonly unknown[]) => void
  ? Args
  : never;

/**
 * Calls one declared operation by its name in the descriptor's `calls`. Never fails: every answer is a
 * typed outcome. A write call takes the caller's stable idempotency key. It dies (a programming error)
 * when a transaction of this execution is open.
 */
export type CallCapability<Calls extends DeclaredCalls> = <Name extends keyof Calls & string>(
  name: Name,
  ...args: ArgumentsForEvery<Calls, Name>
) => Effect.Effect<CallOutcomeOf<Calls[Name]>>;

/** Facts Core establishes at the start of one owner transaction. */
export interface TransactionFacts {
  /**
   * The trusted "now" of this transaction: PostgreSQL `statement_timestamp()` of one statement Core
   * issues after the fence wait and the scope install, before the owner rule and the module function.
   * It is never earlier than the fence wait, and every statement the module runs afterwards reads a
   * READ COMMITTED snapshot taken at or after it. A verdict computed against it is a statement about
   * that instant: Core releases it as computed, so an answer that must still hold later carries its
   * own limit (as the Market proof carries `nextApplicabilityBoundary`) for the consumer to check.
   */
  readonly operationAt: DateTime.Utc;
  /** 1 for the first transaction of the execution, then 2, 3, ... */
  readonly sequence: number;
}

/**
 * Why Core ended a transaction without running, or without committing, the module function.
 *
 * - `owner_denied`: the owner rule denied this execution. The denial is sticky: Core records it in the
 *   execution, answers the operation as denied whatever the module does with this failure, fails every
 *   later `transaction` with it again, and answers every later `call` `Forbidden` without leaving the
 *   process. Catching it changes nothing.
 * - `owner_unavailable`: the owner rule could not answer; for a read, Core answers permission
 *   unavailable.
 * - `composition_changed`, `database_unavailable`: retryable unavailability.
 * - `budget_exhausted`: the execution opened more transactions than its budget allows, or ran past its
 *   duration.
 */
export class TransactionAborted extends Schema.TaggedError<TransactionAborted>()('TransactionAborted', {
  reason: Schema.Literals([
    'budget_exhausted',
    'composition_changed',
    'database_unavailable',
    'owner_denied',
    'owner_unavailable',
  ]),
}) {}

/**
 * Runs `body` in one new owner transaction with the operation's services. A read's transaction opens
 * exactly as every other read transaction does (a plain BEGIN, READ COMMITTED), so its owner rule
 * decides as it does for any read. The services and the transaction handle are unusable once `body`
 * ends. It dies (a programming error) when called inside another transaction of the same execution.
 */
export type TransactionCapability<Services> = <A, E, R>(
  body: (services: Services, facts: TransactionFacts) => Effect.Effect<A, E, R>,
) => Effect.Effect<A, E | TransactionAborted, R>;

/**
 * What every kind's context carries. Reads, Actions and workers extend it and fix `Identity` to the
 * identity they run as, so none handles an identity it never receives.
 */
export interface ExecutionCapabilities<
  Services,
  Calls extends DeclaredCalls,
  Identity extends ExecutionIdentity = ExecutionIdentity,
> {
  readonly call: CallCapability<Calls>;
  readonly execution: ExecutionFacts<Identity>;
  readonly transaction: TransactionCapability<Services>;
}

/* ------------------------------------------------------------------------------------------------ */
/* Small helpers                                                                                    */
/* ------------------------------------------------------------------------------------------------ */

/**
 * An expiry check: a fact with limit `notAfter` is still valid while `now` is strictly before it. A fact
 * without a limit never expires by time.
 */
export const isUnexpired = (now: DateTime.Utc, notAfter: DateTime.Utc | undefined): boolean =>
  notAfter === undefined || DateTime.toEpochMillis(now) < DateTime.toEpochMillis(notAfter);
