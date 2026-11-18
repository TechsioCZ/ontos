/**
 * Private contract between the engine parts of the execution kernel. Kind-neutral: nothing here knows
 * a read, a list predicate, a field group or read evidence. The read adapter's private contract is
 * `reads/sdk-contract.ts`; Actions and workers will add theirs next to it.
 *
 * Collaborators are Context services. Each service's shape (`*Service`, with its obligations) lives
 * with its tag, one per file next to this one: `kernel-sessions.ts`, `kernel-transactions.ts`,
 * `kernel-calls.ts`, `call-requirements.ts`, `core-call-route.ts`, `module-call-route.ts`. The data they
 * exchange is declared here. Each lane provides the Layer of the services it owns, in the file named
 * below, and implements exactly the named functions:
 *
 * - runner lane:   `execution/runner.ts`       `KernelSessionsLive: Layer<KernelSessions, never, KernelTransactions | KernelCalls>`
 *                  `execution/transaction.ts`  `KernelTransactionsLive: Layer<KernelTransactions, never, CoreDatabase>`
 *                  `reads/run-evidence-live.ts` `ReadRunEvidenceLive: Layer<ReadRunEvidence, never, CoreDatabase>`,
 *                                              `callEvidenceRows: CallEvidenceRows` (tag and types in `reads/run-evidence.ts`)
 * - call lane:     `execution/call.ts`         `KernelCallsLive: Layer<KernelCalls, never, CallRequirements | CoreCallRoute>`
 *                                              (reads `ModuleCallRoute` with `Effect.serviceOption`; see `module-call-route.ts`)
 *                  `execution/requirements.ts` `CallRequirementsLive: Layer<CallRequirements>`,
 *                                              `selectCaller: SelectCaller`, `validateDeclaredCalls: ValidateDeclaredCalls`
 *                  `execution/core-route.ts`   `coreCallRouteFor: CoreCallRouteFor`
 *                  `execution/core-operations.ts` `coreOperationRegistrations` and the two new Core reads
 *                  `@app/shared-contracts/server/sdk-module-call-route` `ModuleCallRouteLive: Layer<ModuleCallRoute>`
 * - access lane:   `reads/access-questions.ts` (types in `reads/sdk-contract.ts`)
 * - read adapter:  `reads/run-form.ts`         (types in `reads/sdk-contract.ts`)
 *
 * Shared rules every lane keeps:
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
import type { OntosModuleRequirements } from '../modules/module-dependency-contracts.ts';
import type { OntosRegisteredWorkloadCall } from '../modules/registered-workload-calls.ts';
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
import type { CallerNotPermitted } from './caller-not-permitted.ts';

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
  /** Measured from the moment the session opens; checked before each call and each transaction. */
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
  /** The execution's verified scope: requirement lookup, delegation, and Core's in-process route. */
  principal: TrustedPrincipalContextSchema,
});
export const CallerSourceSchema = RequestPrincipalCallerSourceSchema;
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
export interface KernelExecution<Calls extends DeclaredCalls> {
  /** The composition revision the execution was admitted under; every transaction fences it. */
  readonly admittedRevision: string | undefined;
  readonly budget: ExecutionBudget;
  readonly callerSource: CallerSource;
  readonly calls: Calls;
  readonly facts: ExecutionFacts;
  /** The resolved operational scope every transaction installs. */
  readonly scope: OperationalScope;
  /** `read_only` for every read; `read_write` is reserved for the Action adapter. */
  readonly transactionMode: 'read_only' | 'read_write';
}

/* ------------------------------------------------------------------------------------------------ */
/* Runner                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

/** One call as it happened, for evidence. Never holds the input or the answer. */
export interface CallRecord {
  readonly callerKind: SelectedCaller['kind'] | 'refused';
  readonly durationMillis: number;
  readonly name: string;
  readonly outcome: CallOutcome<unknown>['_tag'] | WriteCallOutcome<unknown>['_tag'];
  readonly placement: Exclude<Placement, 'inside'>;
  readonly provider: Readonly<OperationProvider>;
  readonly requirementKey: string;
  readonly route: 'Core' | 'Module';
  /** 1-based order of this call in the execution. */
  readonly sequence: number;
}

/** The open session of one execution: the two capabilities and what the runner observed. */
export interface KernelSession<Services, Calls extends DeclaredCalls> {
  /** Call records so far, in order. Read by the adapter when it writes evidence, success or failure. */
  readonly callRecords: Effect.Effect<readonly CallRecord[]>;
  readonly capabilities: ExecutionCapabilities<Services, Calls>;
  /**
   * True once any transaction of this execution answered `owner_denied`. Sticky; the adapter answers
   * the operation as denied whenever it is true, whatever the module's code returned.
   */
  readonly ownerDenied: Effect.Effect<boolean>;
  /** How many transactions were opened so far. */
  readonly transactionCount: Effect.Effect<number>;
}

/* ------------------------------------------------------------------------------------------------ */
/* Transaction opener                                                                               */
/* ------------------------------------------------------------------------------------------------ */

export interface TransactionRequest {
  readonly execution: Pick<KernelExecution<DeclaredCalls>, 'admittedRevision' | 'scope' | 'transactionMode'>;
  /** 1-based order of this transaction in the execution; 0 for the opening owner check. */
  readonly sequence: number;
}

/* ------------------------------------------------------------------------------------------------ */
/* Calls                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

export interface CallExecutionRequest {
  readonly declared: AnyDeclaredCall;
  readonly execution: Pick<KernelExecution<DeclaredCalls>, 'admittedRevision' | 'callerSource' | 'facts' | 'scope'>;
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

/**
 * For a vertical provider only (a Core provider is `in_process` without selection). Selects the one
 * caller kind the execution identity implies and requires it in `permitted`:
 *
 * - `Request` via `person` → `person`.
 * - `Request` via `workload`, `recovery` or `system` → `registered` (with `recoveryRequestHash` for
 *   `recovery`, and `expectedPrincipalId` = the principal's id when the caller pins it).
 * - `ActionInvocation` → refused (`wanted: 'none'`) until the Action adapter adds its admission caller
 *   kinds (gateway `Admission`, `RegisteredAdmission`).
 * - `WorkerDelivery` → `workload` (reserved).
 *
 * Absent from `permitted` → `CallerNotPermitted`. Never falls back to another kind.
 */
export type SelectCaller = (
  identity: ExecutionIdentity,
  permitted: readonly RequirementCaller[],
  facts: Readonly<{ readonly principalId: string; readonly recoveryRequestHash: string | undefined }>,
) => Effect.Effect<SelectedCaller, CallerNotPermitted>;

/**
 * Definition-time check, run where a vertical's runtime registration is built (manifest and reads
 * together, `modules/runtime-registration.ts`). Returns the issues; empty means valid. Every declared
 * call names a requirement of the same module whose `entrypointKey` is the declaring operation's
 * entrypoint and whose `provider` equals the reference's provider. A vertical provider's requirement
 * lists at least one caller, and each `registered` or `workload` caller matches an entry of
 * `registeredWorkloadCalls` with the same `declarationKey` and `entrypointKey` equal to
 * `provider.entrypointKey`; a Core provider's requirement lists none. A read declares only read calls.
 * A write call's `recovery` names a read call of the same `calls`.
 */
export type ValidateDeclaredCalls = (input: {
  readonly calls: DeclaredCalls;
  readonly consumerEntrypointKey: string;
  readonly consumerKind: 'action' | 'read' | 'worker';
  readonly registeredWorkloadCalls: readonly OntosRegisteredWorkloadCall[];
  readonly requirements: OntosModuleRequirements | undefined;
}) => readonly string[];

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

/**
 * Core's in-process route (`execution/core-route.ts`, built by `coreCallRouteFor` inside the read
 * runtime, which provides it). Obligations:
 *
 * - Its registry is derived from `coreOperationRegistrations` (`execution/core-operations.ts`), keyed
 *   by `provider.entrypointKey`: `legalEntityDetailRead`, `managedPrincipalsRead`, and the two new
 *   Core reads `core.modules.api.action-commit-state` and `core.identity.api.assignable-principals`
 *   (schemas in `sdk/core-operations.ts`, their own access declarations; the assignable principals
 *   read declares the field group `ASSIGNABLE_PRINCIPAL_NAMES_FIELD_GROUP` on `eligible[].displayName`).
 *   An unknown key is `Problem 404`.
 * - Runs the operation through the read runtime's `runRead` (which clears the caller's module operation
 *   lease, so the Core read never borrows it) with the execution's own principal
 *   (`callerSource.principal`) and the scope's correlation and trace ids, so the Core operation's own
 *   access decision, field groups and evidence apply. There is no caller-kind check: no credential is
 *   used, and the Core operation's own gate decides for whatever principal the execution has.
 * - Encodes the result with `operation.response` into `Answered.encoded`.
 * - Maps Read errors to problems: not found 404, permission denied 403, policy denied its own status,
 *   input invalid 400, every unavailable 503, a domain error 409 with its `_tag` as code.
 * - The action commit state read binds tenant and principal of the caller and refuses (403) an
 *   `actionKey` the calling module (`execution.facts.owningModuleKey`) does not own.
 */
// The Context tag is `CoreCallRoute` in `execution/core-call-route.ts`.

/** The governed read runner the Core route delegates to: the read runtime's own `runRead`. */
export type CoreRunRead = (input: {
  readonly input: unknown;
  readonly principal: TrustedPrincipalContext;
  readonly registration: AnyReadRegistration;
  /** The read transport metadata built from the execution scope, exactly as a host builds it. */
  readonly transport: unknown;
}) => Effect.Effect<unknown, ReadCoreError>;

export type CoreCallRouteFor = (runRead: CoreRunRead) => CallRoute;

/**
 * The HTTP route to verticals (`@app/shared-contracts/server/sdk-module-call-route`, `ModuleCallRouteLive`;
 * shared-contracts depends on core-runtime, not the other way round, and imports the tag and these
 * types from `@app/core-runtime/execution/module-call-route`). Obligations: build the gateway
 * delegation subject from `caller` (`person` → `Assertion` with the execution scope; `registered` →
 * `RegisteredAssertion` with `declarationKey`, `expectedPrincipalId` when present,
 * `operationRequirementKey: requirement.requirementKey` and `recoveryRequestHash` when present;
 * `workload` → `RegisteredWorkload`, reserved; `in_process` never reaches it); call
 * `acquireDelegatedGatewayContext({ audience: requirement.providerAppId, legalEntityScope:
 * caller.legalEntityScope, requestCorrelation: scope.correlationId, subject })`; answer `Problem 503`
 * when the issued `compositionRevision` differs from `execution.admittedRevision`; POST `encodedInput`
 * as JSON to `new URL(route.path, apiBaseUrl)` with the headers `makeGovernedEffectBffClient` sends
 * (authorization, x-correlation-id, x-trace-id, x-ontos-composition-revision, idempotency-key for
 * writes); 2xx is `Answered` with the parsed JSON body; a problem body gives `status`, `code`,
 * `reason`; a delegation or network failure is `Unreachable`.
 */
// The Context tag is `ModuleCallRoute` in `execution/module-call-route.ts`.
