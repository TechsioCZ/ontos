/**
 * Private contract between the engine parts of the execution kernel. Not exported from the package.
 *
 * Collaborators are Context services. Each service's shape (`*Service`, with its obligations) lives
 * with its tag, one per file next to this one: `kernel-sessions.ts`, `kernel-transactions.ts`,
 * `kernel-calls.ts`, `call-requirements.ts`, `execution-evidence.ts`, `core-call-route.ts`,
 * `module-call-route.ts`. The data they exchange is declared here. Each lane provides the Layer of the
 * services it owns, in the file named below, and implements exactly the named functions:
 *
 * - runner lane:   `execution/runner.ts`       `KernelSessionsLive: Layer<KernelSessions, never, KernelTransactions | KernelCalls>`
 *                  `execution/transaction.ts`  `KernelTransactionsLive: Layer<KernelTransactions, never, CoreDatabase | OwnerAuthorizationOverlay>`
 *                  `execution/evidence.ts`     `ExecutionEvidenceLive: Layer<ExecutionEvidence, never, CoreDatabase>`,
 *                                              `callEvidenceRows: CallEvidenceRows`
 * - call lane:     `execution/call.ts`         `KernelCallsLive: Layer<KernelCalls, never, CallRequirements | CoreCallRoute>`
 *                                              (reads `ModuleCallRoute` with `Effect.serviceOption`)
 *                  `execution/requirements.ts` `CallRequirementsLive: Layer<CallRequirements>`,
 *                                              `selectCaller: SelectCaller`, `validateDeclaredCalls: ValidateDeclaredCalls`
 *                  `execution/core-route.ts`   `makeCoreCallRoute: MakeCoreCallRoute`
 *                  `execution/core-operations.ts` the two new Core reads named in `sdk/core-operations.ts`
 *                  `@app/shared-contracts/server/sdk-module-call-route` `ModuleCallRouteLive: Layer<ModuleCallRoute>`
 * - access lane:   `reads/access-questions.ts` `materializeAccessQuestions: MaterializeAccessQuestions`,
 *                                              `answerAccessQuestions: AnswerAccessQuestions`
 * - read adapter:  `reads/run-form.ts`         `executeRunFormRead: ExecuteRunFormRead`
 *
 * Shared rules every lane keeps:
 *
 * 1. The operation's own authority is decided before anything a module wrote runs, and a later
 *    failure never turns its denial into another error.
 * 2. No call while a transaction of the same execution is open; no transaction inside another one.
 *    Both are programming errors: Core dies with `ExecutionRuleViolation`.
 * 3. An expiry check accepts while now is strictly before the limit (`isUnexpired`).
 * 4. A transaction's services and handle are unusable once its body ended, and no statement of it is
 *    still running when it commits or rolls back.
 * 5. Nothing that field denial removes is released.
 */
import { Schema } from 'effect';
import type { Effect } from 'effect';

import type { AccessDecision } from '../access/decision/contract.ts';
import type { ListAccessPredicate } from '../access/decision/list-access.ts';
import type { GateCarrier } from '../access/enforcement/contract.ts';
import type { OwnerAuthorizationInput } from '../access/enforcement/owner-overlay.ts';
import type { TrustedPrincipalContext } from '../actions/principal-context.ts';
import type { ActionPolicyTarget } from '../actions/policy.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import type { OntosModuleRequirements } from '../modules/module-dependency-contracts.ts';
import type { BoundAccessGate } from '../operations/access-gate.ts';
import type { OperationalScope } from '../operations/context.ts';
import type { OperationContextUnavailable } from '../operations/errors.ts';
import type { LegalEntityScope } from '../operations/legal-entity-scope.ts';
import type { AnyReadRegistration, ReadEvidenceCaptureMode, ReadRegistration } from '../reads/definition.ts';
import type { ReadCoreError } from '../reads/errors.ts';
import type { PersistReadEvidenceInput } from '../reads/repository.ts';
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
import type { AccessAnswers, AccessQuestions } from '../sdk/read.ts';
import type { CallerNotPermitted } from './caller-not-permitted.ts';
import type { ExecutionEvidence } from './execution-evidence.ts';
import type { KernelSessions } from './kernel-sessions.ts';

/* ------------------------------------------------------------------------------------------------ */
/* Budget and the kernel's one runtime rule                                                         */
/* ------------------------------------------------------------------------------------------------ */

/**
 * Bounds of one execution. A data-dependent loop of calls and transactions is ordinary module code;
 * the budget is what keeps it finite. Exhaustion is an answer, not a defect: a call answers
 * `Unavailable` (`retryable: false`), a transaction fails with `TransactionAborted('budget_exhausted')`.
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
 * A programming error in module code the kernel refuses. Always raised with `Effect.die`, never as a
 * typed failure: the read adapter answers it as `ReadHandlerUnavailable` and logs it.
 *
 * - `call_inside_transaction`: `call` while a transaction of this execution is open.
 * - `nested_transaction`: `transaction` while one is open.
 * - `transaction_ended`: a service or handle of a transaction used after its body ended.
 * - `undeclared_call`: `call` with a name the descriptor's `calls` does not hold.
 * - `capability_after_execution`: `call` or `transaction` after the session closed.
 */
export class ExecutionRuleViolation extends Schema.TaggedError<ExecutionRuleViolation>()('ExecutionRuleViolation', {
  detail: Schema.String,
  rule: Schema.Literals([
    'call_inside_transaction',
    'capability_after_execution',
    'nested_transaction',
    'transaction_ended',
    'undeclared_call',
  ]),
}) {}

/* ------------------------------------------------------------------------------------------------ */
/* Runner                                                                                           */
/* ------------------------------------------------------------------------------------------------ */

/** Everything the kernel needs about one admitted execution. Built by the kind adapter. */
export interface KernelExecution<Calls extends DeclaredCalls> {
  /** The composition revision the execution was admitted under; every transaction fences it. */
  readonly admittedRevision: string | undefined;
  readonly budget: ExecutionBudget;
  readonly calls: Calls;
  readonly facts: ExecutionFacts;
  /** The read's list predicate, handed to the service factory of every transaction. */
  readonly listAccess?: ListAccessPredicate;
  /** The owner rule's question for every transaction, completed with `operationAt` by the opener. */
  readonly owner: Omit<OwnerAuthorizationInput, 'operationAt'>;
  /** The decoded trusted principal (for delegation and for Core's in-process route). */
  readonly principal: TrustedPrincipalContext;
  /** The resolved operational scope every transaction installs. */
  readonly scope: OperationalScope;
  /** `read_only` for every read; `read_write` is reserved for the Action adapter. */
  readonly transactionMode: 'read_only' | 'read_write';
  /** The main decision and carrier, for the scoped workload admission seal (as today). */
  readonly workloadAdmission: Readonly<{ readonly carrier: GateCarrier; readonly decision?: AccessDecision }>;
}

/**
 * How the opener builds the operation's own services in one transaction: the operation's service
 * factory, unchanged (`ReadServiceFactory` for a read; the Action adapter passes its own later).
 */
export interface OwnerServicesBinding<Services, Requirements> {
  readonly build: (
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
    compositionRevision: string | undefined,
    listAccess?: ListAccessPredicate,
  ) => Effect.Effect<Services, OperationContextUnavailable, Requirements>;
}

/** One call as it happened, for evidence. Never holds the input or the answer. */
export interface CallRecord {
  readonly callerKind: 'refused' | RequirementCaller['kind'];
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
  /** How many transactions were opened so far. */
  readonly transactionCount: Effect.Effect<number>;
}

/* ------------------------------------------------------------------------------------------------ */
/* Transaction opener                                                                               */
/* ------------------------------------------------------------------------------------------------ */

export interface TransactionRequest {
  readonly execution: Pick<
    KernelExecution<DeclaredCalls>,
    'admittedRevision' | 'listAccess' | 'owner' | 'scope' | 'transactionMode' | 'workloadAdmission'
  >;
  /** 1-based order of this transaction in the execution. */
  readonly sequence: number;
}

/* ------------------------------------------------------------------------------------------------ */
/* Calls                                                                                            */
/* ------------------------------------------------------------------------------------------------ */

export interface CallExecutionRequest {
  readonly declared: AnyDeclaredCall;
  readonly execution: Pick<KernelExecution<DeclaredCalls>, 'admittedRevision' | 'facts' | 'principal' | 'scope'>;
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
  /** The caller identities the requirement permits (`requirements.operations[].callers`). */
  readonly callers: readonly RequirementCaller[];
  readonly compositionRevision: string;
  readonly provider: Readonly<OperationProvider>;
  /** The provider deployment's app id: the delegation audience for an HTTP call. */
  readonly providerAppId: string;
  readonly requirementKey: string;
}

/** The caller identity Core selected for one call, ready for the route. */
export interface SelectedCaller {
  readonly declarationKey?: string;
  readonly kind: RequirementCaller['kind'];
  readonly legalEntityScope: RequirementCaller['legalEntityScope'];
  /** The canonical hash of the decoded call input, exactly when the execution is a recovery. */
  readonly recoveryRequestHash?: string;
}

/**
 * Selects the one caller kind the execution identity implies and requires it in `permitted`:
 *
 * - `Request` via `person` → `person`.
 * - `Request` via `workload` or `recovery` → `registered` (with `recoveryRequestHash` for `recovery`).
 * - `Request` via `system` → refused (`wanted: 'none'`).
 * - `ActionInvocation` → `registered` (reserved).
 * - `WorkerDelivery` → `workload` (reserved).
 *
 * Absent from `permitted` → `CallerNotPermitted`. Never falls back to another kind.
 */
export type SelectCaller = (
  identity: ExecutionIdentity,
  permitted: readonly RequirementCaller[],
  recoveryRequestHash: string | undefined,
) => Effect.Effect<SelectedCaller, CallerNotPermitted>;

/**
 * Definition-time check, run where a vertical's runtime registration is built (manifest and reads
 * together, `modules/runtime-registration.ts`): every declared call names a requirement of the same
 * module whose `entrypointKey` is the declaring operation's entrypoint, whose `provider` equals the
 * reference's provider, and which lists at least one caller; a read declares only read calls. Returns
 * the issues; empty means valid.
 */
export type ValidateDeclaredCalls = (input: {
  readonly calls: DeclaredCalls;
  readonly consumerEntrypointKey: string;
  readonly consumerKind: 'action' | 'read' | 'worker';
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
 * Core's in-process route (`execution/core-route.ts`, built by `makeCoreCallRoute` inside the read
 * runtime, which provides it). Obligations:
 *
 * - Keeps the registry of Core operations by `provider.entrypointKey`: `legalEntityDetailRead`,
 *   `managedPrincipalsRead`, and the two new Core reads of `execution/core-operations.ts`
 *   (`core.modules.api.action-commit-state`, `core.identity.api.assignable-principals`) with the
 *   request and response schemas of `sdk/core-operations.ts` and their own access declarations. An
 *   unknown key is `Problem 404`.
 * - Runs the operation through `runRead` with `execution.principal` and the scope's correlation and
 *   trace ids, so the Core operation's own access decision, field groups and evidence apply. Only
 *   `caller.kind === 'person'` is accepted; any other kind is `Problem 403`.
 * - Encodes the result with `operation.response` into `Answered.encoded`.
 * - Maps Read errors to problems: not found 404, permission denied 403, policy denied its own status,
 *   input invalid 400, every unavailable 503, a domain error 409 with its `_tag` as code.
 * - The action commit state read binds tenant and principal of the caller and refuses (403) an
 *   `actionKey` the calling module (`execution.facts.owningModuleKey`) does not own.
 */
// The Context tag is `CoreCallRoute` in `execution/core-call-route.ts`.

/** The governed read runner the Core route delegates to (the read runtime's own `runRead`). */
export type CoreRunRead = (input: {
  readonly input: unknown;
  readonly principal: TrustedPrincipalContext;
  readonly registration: AnyReadRegistration;
  /** The read transport metadata built from the execution scope, exactly as a host builds it. */
  readonly transport: unknown;
}) => Effect.Effect<unknown, ReadCoreError>;

export type MakeCoreCallRoute = (runRead: CoreRunRead) => CallRoute;

/**
 * The HTTP route to verticals (`@app/shared-contracts/server/sdk-module-call-route`, `ModuleCallRouteLive`;
 * shared-contracts depends on core-runtime, not the other way round). Obligations: build the gateway
 * delegation subject from `caller` (`person` → `Assertion` with the execution scope; `registered` →
 * `RegisteredAssertion` with `declarationKey`, `operationRequirementKey: requirement.requirementKey`
 * and `recoveryRequestHash` when present; `workload` → `RegisteredWorkload`, reserved); call
 * `acquireDelegatedGatewayContext({ audience: requirement.providerAppId, legalEntityScope:
 * caller.legalEntityScope, requestCorrelation: scope.correlationId, subject })`; answer `Problem 503`
 * when the issued `compositionRevision` differs from `execution.admittedRevision`; POST `encodedInput`
 * as JSON to `new URL(route.path, apiBaseUrl)` with the headers `makeGovernedEffectBffClient` sends
 * (authorization, x-correlation-id, x-trace-id, x-ontos-composition-revision, idempotency-key for
 * writes); 2xx is `Answered` with the parsed JSON body; a problem body gives `status`, `code`,
 * `reason`; a delegation or network failure is `Unreachable`. A vertical host provides the layer once
 * next to `ReadRuntimeLive`; without it every module call answers `Unavailable`.
 */
// The Context tag is `ModuleCallRoute` in `execution/module-call-route.ts`.

/* ------------------------------------------------------------------------------------------------ */
/* Evidence                                                                                         */
/* ------------------------------------------------------------------------------------------------ */

/**
 * One `data_access_events` row per call: `servingModuleKey` = the calling module, `targetModuleKey` =
 * `provider.moduleId`, `targetResourceType` = `provider.entrypointKey`, `outcomeStage: 'execution'`,
 * `outcome` = `allowed` for `Ok`/`Committed`, `denied` for `Forbidden`, otherwise `failed`,
 * `outcomeCode` = `call_` + the snake-cased outcome tag, `resultCount` 1 for `Ok`, else 0, and the
 * operation's own `policyKey`, `captureMode`, `readKey` and `accessKind`.
 */
export type CallEvidenceRows = (
  calls: readonly CallRecord[],
  base: Readonly<{
    readonly accessKind: PersistReadEvidenceInput['accessKind'];
    readonly captureMode: ReadEvidenceCaptureMode;
    readonly policyKey: string;
    readonly readKey: string;
    readonly scope: OperationalScope;
    readonly servingModuleKey: string;
  }>,
) => readonly PersistReadEvidenceInput[];

/* ------------------------------------------------------------------------------------------------ */
/* Read adapter: access questions                                                                   */
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
 * decision and no owned transaction. Never fails: an unavailable gate or answer is `'unavailable'` /
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
}) => Effect.Effect<AccessAnswers<Questions>>;

/* ------------------------------------------------------------------------------------------------ */
/* Read adapter: the `{ run }` form                                                                 */
/* ------------------------------------------------------------------------------------------------ */

/** Today's `withReadExecution` bound to one read: keeps the module operation execution lease open. */
export type ExecutionLease = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;

/** What `reads/runtime.ts` has established when it hands a `{ run }` read to the run-form executor. */
export interface RunFormReadInput {
  readonly access: AccessAnswers<AccessQuestions>;
  readonly admittedRevision: string | undefined;
  readonly decodedInput: unknown;
  readonly deniedFieldPaths: readonly (readonly string[])[];
  readonly facts: ExecutionFacts;
  readonly lease: ExecutionLease;
  readonly listAccess?: ListAccessPredicate;
  readonly owner: KernelExecution<DeclaredCalls>['owner'];
  readonly permissionTargetMetadata: ActionPolicyTarget;
  readonly principal: TrustedPrincipalContext;
  readonly queryHash: string | undefined;
  readonly scope: OperationalScope;
  /** True when the access gate decided this read: `deniedFieldPaths` is then handed to `run`. */
  readonly usesAccessGate: boolean;
  readonly workloadAdmission: KernelExecution<DeclaredCalls>['workloadAdmission'];
}

/**
 * Runs a `{ run }` read after admission (`reads/run-form.ts`). Obligations, in order:
 *
 * 1. Opens a kernel session with `READ_EXECUTION_BUDGET`, `transactionMode: 'read_only'` and the read's
 *    service factory as `OwnerServicesBinding`, inside `input.lease` so requirement lookups resolve.
 * 2. Runs `run(decodedInput, context)` with `context = { ...capabilities, access, deniedFieldPaths
 *    (when `usesAccessGate`), listAccess, readKey, scope }`.
 * 3. On success: decode the result with `Schema.toType(resultSchema)`; the legacy result permission
 *    check when declared; `validateReadEvidenceMetadata`; then `ExecutionEvidence.settle` with the
 *    read's `allowed` row plus `callEvidenceRows`; then `projectReadResultFields` with
 *    `deniedFieldPaths`. The caller receives the projection only after the evidence committed.
 * 4. `TransactionAborted('owner_denied')` anywhere in `run`'s failure: settle the read's `denied` row
 *    (`outcomeCode: 'read_permission_denied'`, `outcomeStage: 'authz'`) plus the call rows, then fail
 *    `ReadPermissionDenied`. If that settle fails, combine causes as today; the denial stays the answer.
 * 5. Any other `TransactionAborted`: `ReadHandlerUnavailable`. An `ExecutionRuleViolation` defect:
 *    `ReadHandlerUnavailable`, logged. Domain failures: `sanitizeReadHandlerFailure` as today. In
 *    every failure path the call rows are still settled with the read's `failed` row; an evidence
 *    failure there never replaces the read's own failure.
 * 6. Never holds an outer transaction across `run`: today's governed composition lock is replaced by
 *    the fence at the start of every owner transaction and of the evidence transaction.
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
  ExecutionEvidence | KernelSessions | Requirements
>;
