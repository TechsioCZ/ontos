/**
 * Private contract between the engine parts of the execution kernel. Kind-neutral: nothing here knows
 * a read, a list predicate, a field group or read evidence. The read adapter's private contract is
 * `reads/sdk-contract.ts`; Actions and workers will add theirs next to it.
 *
 * Each service's shape lives with its Context tag, one per file next to this one; the data they
 * exchange is declared here.
 *
 * Shared rules every part keeps:
 *
 * 1. The operation's own authority is decided before anything a module wrote runs, and a later
 *    failure never turns its denial into another error. An owner-rule denial is sticky (see
 *    `TransactionAborted`).
 * 2. No call while a transaction of the same execution is open; no transaction inside another one.
 *    Both are programming errors: Core dies with `ExecutionRuleViolation`.
 * 3. An expiry check accepts while now is strictly before the limit (`isUnexpired`).
 * 4. A transaction's services and handle are unusable once its body ended, and no statement of it is
 *    still running when it commits or rolls back.
 * 5. Nothing that field denial removes is released.
 */
import { Schema } from 'effect';
import type { DateTime, Effect } from 'effect';

import type { OwnerAuthorizationDecision } from '../access/enforcement/owner-overlay.ts';
import { TrustedPrincipalContextSchema } from '../actions/principal-context.ts';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { OperationalScope } from '../operations/context.ts';
import type { OperationContextUnavailable } from '../operations/errors.ts';
import type { AnyReadRegistration } from '../reads/definition.ts';
import type { ReadCoreError } from '../reads/errors.ts';
import type {
  AnyDeclaredCall,
  AnyOperationRef,
  CallOutcome,
  DeclaredCalls,
  ExecutionCapabilities,
  ExecutionFacts,
  ExecutionIdentity,
  OperationProvider,
  Placement,
  RequirementCaller,
  WriteCallOutcome,
} from '../sdk/index.ts';

/* ------------------------------------------------------------------------------------------------ */
/* Budget and the kernel's one runtime rule                                                         */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Bounds of one execution. A data-dependent loop of calls and transactions is ordinary module code;
 * the budget is what keeps it finite. Exhaustion is an answer, not a defect: a call answers
 * `Unavailable` (`retryable: false`), a transaction fails with `TransactionAborted('budget_exhausted')`.
 * The opening owner check (`KernelTransactionsService.checkOwner`) does not count.
 */
export interface ExecutionBudget {
  readonly maxCalls: number;
  /**
   * Measured from the moment the session opens; checked before each call and each transaction, and the
   * kind adapter bounds the whole module function by it (a read's `run` is interrupted when it is spent).
   */
  readonly maxDurationMillis: number;
  readonly maxTransactions: number;
}

/** The budget of a read. Current pricing, the heaviest known read, needs about 20 calls and 12 transactions. */
export const READ_EXECUTION_BUDGET: ExecutionBudget = Object.freeze({
  maxCalls: 64,
  maxDurationMillis: 25_000,
  maxTransactions: 24,
});

/**
 * A programming error the kernel refuses. Always raised with `Effect.die`, never as a typed failure:
 * the read adapter answers it as `ReadHandlerUnavailable` and logs it.
 *
 * - `call_inside_transaction`: `call` while a transaction of this execution is open.
 * - `nested_transaction`: `transaction` while one is open.
 * - `transaction_ended`: a service or handle of a transaction used after its body ended.
 * - `undeclared_call`: `call` with a name the descriptor's `calls` does not hold.
 * - `capability_after_execution`: `call` or `transaction` after the session closed.
 * - `write_call_reserved`: a write call before the Action adapter exists.
 * - `module_call_without_route`: a module call in a host that provides no `ModuleCallRoute` (the read
 *   runtime refuses to start such a host first; this is the backstop).
 */
export class ExecutionRuleViolation extends Schema.TaggedError<ExecutionRuleViolation>()('ExecutionRuleViolation', {
  detail: Schema.String,
  rule: Schema.Literals([
    'call_inside_transaction',
    'capability_after_execution',
    'module_call_without_route',
    'nested_transaction',
    'transaction_ended',
    'undeclared_call',
    'write_call_reserved',
  ]),
}) {}

/* ------------------------------------------------------------------------------------------------ */
/* What the kind adapter supplies                                                                   */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Whose authority a call carries, supplied by the kind adapter. Only `RequestPrincipal` exists now (a
 * read, later an Action served for a request). Reserved, added by their adapters: an admitted Action
 * invocation (gateway `Admission`, `RegisteredAdmission`, `Originator`) and an attested worker delivery
 * (`RegisteredWorkload`). The adapter passes the very scope object the execution's lease was opened with,
 * never a copy made by this schema: the lease and the gateway delegation recognise that instance, and a
 * copy would fail requirement lookup and delegation for every call.
 */
export const RequestPrincipalCallerSourceSchema = Schema.TaggedStruct('RequestPrincipal', {
  /**
   * The trusted receiving deployment audience the request was admitted under, when it had one. Core's
   * in-process route runs its nested read under the same audience, so a namespace that requires
   * per-operation admission admits it as it admitted the outer read.
   */
  audience: Schema.optionalKey(Schema.String),
  /** The execution's verified scope: requirement lookup, delegation, and Core's in-process route. */
  principal: TrustedPrincipalContextSchema,
});
const CallerSourceSchema = RequestPrincipalCallerSourceSchema;
export type CallerSource = typeof CallerSourceSchema.Type;

/**
 * The operation's owner side, supplied by the kind adapter, which closes over everything kind-specific
 * (for a read: the owner authorization question and overlay, the workload admission carrier and main
 * decision, the list predicate and the read's service factory).
 */
export interface OwnerBinding<Services, Requirements> {
  /** The operation's services in one transaction. A failure is `TransactionAborted('database_unavailable')`. */
  readonly build: (
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
    compositionRevision: string | undefined,
  ) => Effect.Effect<Services, OperationContextUnavailable, Requirements>;
  /** The owner rule at `operationAt`, read through the sealed scoped transaction; never fails. */
  readonly decide: (
    transaction: ScopedTransactionExecutor,
    operationAt: DateTime.Utc,
  ) => Effect.Effect<OwnerAuthorizationDecision>;
  /** Seals the scoped executor with the kind's admission (a read: `bindScopedWorkloadAdmission`). */
  readonly seal: (
    transaction: ScopedTransactionExecutor,
  ) => Readonly<{ readonly close: () => void; readonly transaction: ScopedTransactionExecutor }>;
}

/** Everything the kernel needs about one admitted execution. Built by the kind adapter. */
export interface KernelExecution<Calls extends DeclaredCalls, Identity extends ExecutionIdentity = ExecutionIdentity> {
  readonly budget: ExecutionBudget;
  readonly callerSource: CallerSource;
  readonly calls: Calls;
  /** `facts.compositionRevision` is the revision the execution was admitted under; every transaction fences it. */
  readonly facts: ExecutionFacts<Identity>;
  /** The resolved operational scope every transaction installs. */
  readonly scope: OperationalScope;
  /**
   * How each transaction opens. `session_default` is a plain BEGIN: the isolation and access mode the
   * database session's defaults give, as main opens every read transaction. When the execution carries a
   * composition revision the fence then requires READ COMMITTED; without one there is no fence and the
   * session default stands. `read_only` and `read_write` set READ COMMITTED and that access mode after BEGIN.
   * The fence admits the transaction as a write only for `read_write`.
   */
  readonly transactionMode: 'read_only' | 'read_write' | 'session_default';
}

/* ------------------------------------------------------------------------------------------------ */
/* Runner                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

/**
 * One call as it happened, for evidence. Never holds the input or the answer. A call the session
 * interrupted before its executor reported is `Interrupted`, with `callerKind: 'unknown'`.
 */
export interface CallRecord {
  readonly callerKind: SelectedCaller['kind'] | 'refused' | 'unknown';
  readonly durationMillis: number;
  readonly name: string;
  readonly outcome: CallOutcome<unknown>['_tag'] | WriteCallOutcome<unknown>['_tag'] | 'Interrupted';
  readonly placement: Exclude<Placement, 'inside'>;
  readonly provider: Readonly<OperationProvider>;
  readonly requirementKey: string;
  readonly route: 'Core' | 'Module';
  /** 1-based order of this call in the execution. */
  readonly sequence: number;
}

/** The open session of one execution: the two capabilities and what the runner observed. */
export interface KernelSession<
  Services,
  Calls extends DeclaredCalls,
  Identity extends ExecutionIdentity = ExecutionIdentity,
> {
  /** Call records so far, in order. Read by the adapter when it writes evidence, success or failure. */
  readonly callRecords: Effect.Effect<readonly CallRecord[]>;
  readonly capabilities: ExecutionCapabilities<Services, Calls, Identity>;
  /**
   * True once the owner rule of any transaction of this execution answered denied (noted when it
   * answers, not when its transaction settles). Sticky; the adapter answers the operation as denied
   * whenever it is true, whatever the module's code returned.
   */
  readonly ownerDenied: Effect.Effect<boolean>;
  /** What is left of `budget.maxDurationMillis`, measured from the moment the session opened (never below 0). */
  readonly remainingMillis: Effect.Effect<number>;
  /**
   * Ends the session's work: admits no further call or transaction, interrupts and awaits every call
   * and transaction still running (a transaction rolls back; a call is recorded `Interrupted`). The
   * adapter settles before it reads `ownerDenied` and `callRecords`.
   */
  readonly settle: Effect.Effect<void>;
  /** How many transactions were opened so far. */
  readonly transactionCount: Effect.Effect<number>;
}

/* ------------------------------------------------------------------------------------------------ */
/* Transaction opener                                                                               */
/* ------------------------------------------------------------------------------------------------ */

export interface TransactionRequest {
  readonly execution: Pick<KernelExecution<DeclaredCalls>, 'scope' | 'transactionMode'> & {
    readonly facts: Pick<ExecutionFacts, 'compositionRevision'>;
  };
  /** 1-based order of this transaction in the execution; 0 for the opening owner check. */
  readonly sequence: number;
}

/* ------------------------------------------------------------------------------------------------ */
/* Calls                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

export interface CallExecutionRequest {
  readonly declared: AnyDeclaredCall;
  readonly execution: Pick<KernelExecution<DeclaredCalls>, 'callerSource' | 'facts' | 'scope'>;
  /** Present exactly for a write call. */
  readonly idempotencyKey?: string;
  /** The decoded input the module passed (`OperationInput` of the declared operation). */
  readonly input: unknown;
  readonly name: string;
  readonly placement: Exclude<Placement, 'inside'>;
  readonly sequence: number;
}

export interface CallExecution {
  readonly outcome: CallOutcome<unknown> | WriteCallOutcome<unknown>;
  readonly record: CallRecord;
}

/* Requirements ----------------------------------------------------------------------------------- */

/** A manifest requirement resolved inside the active execution lease. */
export interface ResolvedCallRequirement {
  /** The caller identities the requirement permits; empty for a Core provider. */
  readonly callers: readonly RequirementCaller[];
  readonly compositionRevision: string;
  /** The calling deployment's app id: whose own module credential a delegated HTTP call authenticates with. */
  readonly consumerAppId: string;
  readonly provider: Readonly<OperationProvider>;
  /** The provider deployment's app id: the delegation audience for an HTTP call. */
  readonly providerAppId: string;
  readonly requirementKey: string;
}

/**
 * The caller identity Core selected for one call, ready for the route. `in_process` is a Core
 * provider: Core runs it with the execution's own principal and no credential, so no caller kind is
 * selected and none is refused.
 */
export type SelectedCaller =
  | Readonly<{ readonly kind: 'in_process' }>
  | Readonly<{ readonly kind: 'person'; readonly legalEntityScope: RequirementCaller['legalEntityScope'] }>
  | Readonly<{
      readonly declarationKey: string;
      /** The execution's principal id, exactly when the caller declares `pinPrincipal: true`. */
      readonly expectedPrincipalId?: string;
      readonly kind: 'registered';
      readonly legalEntityScope: RequirementCaller['legalEntityScope'];
      /** The canonical hash of the decoded call input, exactly when the execution is a recovery. */
      readonly recoveryRequestHash?: string;
    }>
  | Readonly<{
      readonly declarationKey: string;
      readonly kind: 'workload';
      readonly legalEntityScope: RequirementCaller['legalEntityScope'];
    }>;

/* Routes ----------------------------------------------------------------------------------------- */

export interface CallRouteRequest {
  readonly caller: SelectedCaller;
  /** The request encoded by `operation.request`. */
  readonly encodedInput: unknown;
  readonly execution: CallExecutionRequest['execution'];
  readonly idempotencyKey?: string;
  readonly operation: AnyOperationRef;
  readonly requirement: ResolvedCallRequirement;
}

/** What a route observed. `Answered.encoded` is always the encoded side of `operation.response`. */
export const RouteAnswerSchema = Schema.Union([
  Schema.TaggedStruct('Answered', { encoded: Schema.Unknown }),
  Schema.TaggedStruct('Problem', {
    code: Schema.optionalKey(Schema.String),
    reason: Schema.String,
    status: Schema.Finite.check(Schema.isInt()),
  }),
  Schema.TaggedStruct('Unreachable', { reason: Schema.String }),
]);
export type RouteAnswer = typeof RouteAnswerSchema.Type;

/** What both routes do: deliver one encoded request and report what they observed. */
export interface CallRoute {
  readonly send: (request: CallRouteRequest) => Effect.Effect<RouteAnswer>;
}

/** The governed read runner the Core route delegates to: the read runtime's own `runRead`. */
export type CoreRunRead = (input: {
  /** The receiving audience of the outer request (`RequestPrincipal.audience`), when it had one. */
  readonly audience?: string;
  readonly input: unknown;
  readonly principal: TrustedPrincipalContext;
  readonly registration: AnyReadRegistration;
  /** The read transport metadata built from the execution scope, exactly as a host builds it. */
  readonly transport: unknown;
}) => Effect.Effect<unknown, ReadCoreError>;
