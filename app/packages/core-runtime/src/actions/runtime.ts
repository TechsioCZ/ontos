import { moduleCredentialOverlay } from '../auth/hosted-module-credentials.ts';
import {
  loadModuleOperationAdmission,
  operationCatalogLoader,
  prepareOperationIntrinsicState,
  validateBoundOperationOwner,
  withModuleOperationExecution,
  withoutModuleOperationExecution,
} from '../modules/module-operation-execution.ts';
import type { VerticalRuntimeRegistration } from '../modules/runtime-registration.ts';
import { getVerticalRuntimeReads } from '../modules/runtime-registration.ts';
import {
  Array as EffectArray,
  Cause,
  Context,
  DateTime,
  Effect,
  Exit,
  Match,
  Predicate,
  Layer,
  Option,
  Ref,
  Result,
  Schema,
} from 'effect';
import type { SqlError } from 'effect/sql/SqlError';
import { ConnectionError, UnknownError, isSqlError } from 'effect/sql/SqlError';

import type { AccessFieldGroup, AccessTarget } from '../authorization/access-declaration.ts';
import type { AccessAmount, AccessDecision, AccessRecordTarget } from '../access/decision/contract.ts';
import { lockActionAccessFence } from '../access/approvals/action-access-fence.ts';
import { ActionMandateDispatcher } from '../access/approvals/action-mandate-dispatch-service.ts';
import { actionExecutionDeadlineV2 } from '../access/approvals/action-lifecycle-v2.ts';
import { resolveGovernedAmount } from '../access/approvals/governed-amount.ts';
import {
  decodeActionCommandV2,
  makeActionCommandV2,
  rebindRegisteredActionCommandV2,
} from '../access/approvals/action-command-v2.ts';
import type { ActionCommandV2 } from '../access/approvals/action-command-v2.ts';
import type {
  ActionMandateDispatch,
  ActionProposalParked,
  MandatePrepared,
} from '../access/approvals/action-mandate-dispatch.ts';
import { CapabilityKeySchema, ModuleKeySchema, RecordKeySchema } from '../access/ids.ts';
import type { BoundAccessGate, PreparedAccessDecision } from '../operations/access-gate.ts';
import type { GateInput } from '../access/enforcement/contract.ts';
import { seamUnavailable } from '../access/enforcement/decisions.ts';
import { bindLiveActionAccessGate } from '../operations/access-gate.ts';
import { authorizeDeclaredFieldWrites, writtenFieldPaths } from './field-write-authorization.ts';
import { conjoinActionTargetDecisions, resolveActionTargetSet } from './target-set.ts';
import type { ActionTargetSetAdmission } from './target-set.ts';
import { getActionGoverningRead } from './governing-read.ts';
import { decideActionGoverningReads, requireAllowedGoverningReads } from './governing-read-authorization.ts';
import { actionPreparationObservation, originalActionPreparationFactory } from './preparation-observation.ts';
import type { ActionPreparationObservation } from './preparation-observation.ts';

import {
  decodeTrustedPrincipalContext,
  isTrustedSupportRecoveryPrincipalContext,
  preserveSystemPrincipalContextTrust,
  readVerifiedGatewayCompositionRevision,
} from '../auth/system-principal-context-provenance.ts';
import { isDatabaseCommitAcknowledgementAmbiguous } from '../database/driver-failure.ts';
import { findPostgresFailure } from '../database/postgres-failure.ts';
import { CoreDatabase as CoreDatabaseService } from '../db/client.ts';
import { DatabaseIdentityEnrollmentContext } from '../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../db/database-identity-manifest.ts';
import { installOperationalScope } from '../db/scoped-transaction.ts';
import { trustedTransactionTime } from '../operations/transaction-time.ts';
import type { CoreTransaction } from '../db/types.ts';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '../modules/active-application-composition.ts';
import type { ActiveApplicationCompositionServiceContract } from '../modules/active-application-composition.ts';
import { lockApplicationCompositionAuthority } from '../modules/application-composition-authority.ts';
import type { OntosDeploymentIdentitySchema } from '../modules/manifest.ts';
import type { ModuleEntrypointGatewayService } from '../modules/module-entrypoint-gateway.ts';
import { ModuleEntrypointGateway } from '../modules/module-entrypoint-gateway.ts';
import type { TenantModuleEntrypoint } from '../modules/module-entrypoint.ts';
import type { ModuleStateGateService } from '../modules/module-state-gate.ts';
import { ModuleStateGate } from '../modules/module-state-gate.ts';
import type { OperationalScope, OperationalScopeResolverService } from '../operations/context.ts';
import { OperationalScopeResolver } from '../operations/context.ts';
import { ContextAccess, isOwnerPermissionAccessTargetValid } from '../permissions/context-access.ts';
import { ActionAuthorizationPreflight } from './owner-proof-preflight.ts';
import { ActionProposalAcceptedSchema } from './proposal-accepted.ts';
import type { ActionProposalAccepted, ActionProposalSuccess, ActionSuccessContract } from './proposal-accepted.ts';
import type { ActionAuthorizationPreflightService } from './owner-proof-preflight.ts';
import { OwnerAuthorizationOverlay, failClosedOwnerAuthorizationOverlay } from '../access/enforcement/owner-overlay.ts';
import type {
  OwnerAccessFacts,
  OwnerAuthorizationDecision,
  OwnerAuthorizationTarget,
} from '../access/enforcement/owner-overlay.ts';
import type { ActionPermissionService } from '../permissions/service.ts';
import { ActionPermission } from '../permissions/service.ts';
import { createActionCollector } from './collector.ts';
import type {
  ActionOwnerTransaction,
  ActionTransportMetadata,
  CommittedActionDomainRejection,
  TrustedPrincipalContext,
} from './context.ts';
import {
  ActionTransportMetadataSchema,
  CommittedActionDomainRejectionSchema,
  commitActionThenReject,
  getCommittedActionDomainError,
} from './context.ts';
import type {
  ActionPostAttemptOutcome,
  ActionOwnerPermissionTarget,
  ActionDeniedAuditEvidenceDeclaration,
  ActionLegalEntityPermission,
  ActionRegistration,
  AnyActionRegistration,
  ActionServiceFactory,
  ActionResourcePermissionTarget,
  ActionTenantPermission,
} from './definition.ts';
import {
  decodeActionPostAttemptResult,
  getActionPostAttemptHook,
  decodeActionPayload,
  decodeActionResult,
  getActionAccessAmountResolver,
  getActionAccessTargetResolver,
  getActionAccessTargetsResolver,
  getActionOwnerFactsResolver,
  getActionReducesAuthorityResolver,
  getActionDecodedSuccessHook,
  getActionOwnerPermissionTargetResolver,
  getActionHandler,
  getActionResourcePermissionTargetResolver,
  getActionServiceFactory,
  getActionServicePreflight,
  getActionPreparationPolicies,
} from './definition.ts';
import {
  ActionAlreadyCommitted,
  ActionCollectorError,
  ActionCommitIndeterminate,
  ActionHandlerExecutionError,
  ActionIdempotencyKeyRequired,
  ActionInvocationPersistenceError,
  createActionInvocationPersistenceErrorWithCause,
  ActionInvocationNotFound,
  ActionInvocationStateError,
  ActionPayloadValidationError,
  ActionPermissionCheckError,
  ActionPermissionDenied,
  ActionPolicyDenied,
  ActionPolicyEvaluationError,
  ActionRequestHashConflict,
  ActionResultValidationError,
  ActionTransactionError,
  ActionTrustedContextValidationError,
} from './errors.ts';
import type { ActionCoreError } from './errors.ts';
import { createActionTransactionErrorWithCause } from './transaction-error.ts';
import type { DomainEventContractMap } from './events.ts';
import { ModuleStateCheckUnavailableError, ModuleStateDeniedError } from '../modules/module-state-gate-errors.ts';
import {
  OperationAuthenticationRequired,
  OperationContextDenied,
  OperationContextInvalid,
  OperationContextUnavailable,
} from '../operations/errors.ts';
import type { ActionPolicy, ActionPolicyEvaluatorInput, ActionPreparationPolicyEvaluator } from './policy.ts';
import { PolicyDenied } from './policy.ts';
import type {
  ActionInvocationRecord,
  ActionInvocationScopeExecutor,
  ActionPolicyEvidence,
  ActionRecordedRejection,
  ActionRepositoryService,
} from './repository.ts';
import {
  ActionRepository,
  computeActionRequestHash,
  computeCanonicalValueHash,
  logActionInvocationPersistenceFailureCause,
  logActionTransactionFailureCause,
  recoverSqlTransactionError,
  trackTransactionSettlement,
} from './repository.ts';
import { insideDatabaseTransaction } from '../db/transaction-io-guard.ts';

const requireIdempotencyKey = (idempotency: string, transport: ActionTransportMetadata) =>
  idempotency === 'required' && transport.idempotencyKey === undefined
    ? Effect.fail(
        new ActionIdempotencyKeyRequired({
          code: 'action_idempotency_key_required',
          reason: 'This Action requires an idempotency key',
        }),
      )
    : Effect.void;

const withOptionalProperty = <Base extends object, Key extends PropertyKey, Value, Trailing extends object>(
  base: Base,
  condition: boolean,
  key: Key,
  value: Value,
  trailing: Trailing,
) => (condition ? { ...base, [key]: value, ...trailing } : { ...base, ...trailing });

const attachFailureCause = <Failure extends object, FailureCause>(failure: Failure, cause: FailureCause): Failure => {
  Object.defineProperty(failure, 'cause', {
    configurable: false,
    enumerable: false,
    value: cause,
  });
  return failure;
};

// The descriptor's action-owned Schema is authoritative; this final object check only bounds the
// generic runtime seam before opaque audit JSON is persisted.
// oxlint-disable-next-line effect-native/no-json-schema-as-document-contract
const DeniedAuditEvidenceJsonObjectSchema = Schema.Record(Schema.String, Schema.Json);

const invalidEvidence = (reason: string, cause?: unknown) =>
  attachFailureCause(
    new ActionPayloadValidationError({
      code: 'action_payload_invalid',
      reason,
    }),
    cause,
  );

const resolveDeniedAuditEvidence = <Payload>(
  declaration: ActionDeniedAuditEvidenceDeclaration<Payload>,
  payload: Payload,
  scope: OperationalScope,
): Effect.Effect<Readonly<Record<string, Schema.Schema.Type<typeof Schema.Json>>>, ActionPayloadValidationError> =>
  Effect.try({
    catch: (cause) => invalidEvidence('The Action denial evidence could not be resolved safely', cause),
    try: () => declaration.resolve(payload, scope),
  }).pipe(
    Effect.flatMap((resolved) =>
      Schema.decodeEffect(declaration.schema)(resolved).pipe(
        Effect.mapError((cause) =>
          invalidEvidence('The Action denial evidence does not match its declared schema', cause),
        ),
      ),
    ),
    Effect.flatMap((decoded) =>
      Schema.encodeUnknownEffect(Schema.make<Schema.ConstraintEncoder<unknown>>(declaration.schema.ast))(decoded).pipe(
        Effect.mapError((cause) => invalidEvidence('The Action denial evidence cannot be encoded safely', cause)),
      ),
    ),
    Effect.flatMap((encoded) =>
      // oxlint-disable-next-line effect-native/no-json-schema-as-document-contract
      Schema.decodeUnknownEffect(DeniedAuditEvidenceJsonObjectSchema)(encoded).pipe(
        Effect.mapError((cause) => invalidEvidence('The Action denial evidence must be a JSON object', cause)),
      ),
    ),
  );

export const ACTION_RUNTIME_STAGES = [
  'payload_decoded',
  'trusted_context_validated',
  'module_state_gate',
  'invocation_prepared',
  'authentication_boundary',
  'permission_checked',
  'policy_boundary',
  'invocation_running',
  'database_scope_installed',
  'composition_authority_locked',
  'invocation_locked',
  'module_state_rechecked',
  'handler_executed',
  'success_evidence_flushed',
] as const;

export type ActionRuntimeStage = (typeof ACTION_RUNTIME_STAGES)[number];

export interface RunActionInput<
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string = string,
  Services = Readonly<Record<string, never>>,
  HandlerRequirements = never,
  SuccessContract extends ActionSuccessContract = 'result',
> {
  /** Private testing token. It observes preparation and cannot supply services or authority. */
  readonly [actionPreparationObservation]?: ActionPreparationObservation<
    ActionServiceFactory<Services, HandlerRequirements>
  >;
  /** Trusted receiving deployment audience for per-operation admission. */
  readonly audience?: string;
  readonly payload: unknown;
  readonly principal: unknown;
  readonly registration: ActionRegistration<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Owner,
    Services,
    HandlerRequirements
  >;
  /**
   * O85: the transport's own declared success contract. Only `'result-or-proposal'` states that the
   * endpoint's contract carries the parked-proposal 202, and only there does an explicit `propose`
   * intent answer `ActionProposalAccepted`. A result-only transport refuses that intent, because it
   * has no 202 to answer with; widening every caller would claim a response its contract cannot send.
   */
  readonly successContract?: SuccessContract | undefined;
  readonly transport: unknown;
}

export type ResolveActionCommitInput = { readonly principal: unknown } & (
  | { readonly actionKey?: never; readonly idempotencyKey?: never; readonly invocationId: unknown }
  | { readonly actionKey: unknown; readonly idempotencyKey: unknown; readonly invocationId?: never }
);

export type ResolveActionExecutionInput = ResolveActionCommitInput & {
  readonly expectedRequestHash?: unknown;
};

const ExpectedActionRequestHashSchema = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u));
const actionRequestMismatch = () =>
  new ActionPayloadValidationError({
    code: 'action_payload_invalid',
    reason: 'The original Action request could not be matched',
  });

const ActionInvocationIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('ActionInvocationId'));

const ActionCommitOpenSchema = Schema.TaggedStruct('ActionCommitOpen', {
  invocationId: ActionInvocationIdSchema,
});

export type ActionCommitOpen = typeof ActionCommitOpenSchema.Type;

const ActionCommitActionKeySchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(300),
).pipe(Schema.brand('ActionCommitActionKey'));

/** The exact caller-owned execution state a recovery endpoint answers with (O80, O85). */
export const ActionExecutionResolutionSchema = Schema.Union([
  Schema.Struct({ retryCommand: Schema.Literal(true), state: Schema.Literal('NOT_STARTED') }),
  Schema.Struct({
    invocationId: ActionInvocationIdSchema,
    retryCommand: Schema.Literal(true),
    state: Schema.Literal('RETRYABLE'),
  }),
  Schema.Struct({
    invocationId: ActionInvocationIdSchema,
    retryCommand: Schema.Literal(false),
    state: Schema.Literals(['RUNNING', 'REJECTED']),
  }),
  Schema.Struct({
    actionKey: ActionCommitActionKeySchema,
    invocationId: ActionInvocationIdSchema,
    retryCommand: Schema.Literal(false),
    state: Schema.Literal('COMMITTED'),
  }),
]);
export type ActionExecutionResolution = typeof ActionExecutionResolutionSchema.Type;

const ActionCommitIdempotencyKeySchema = Schema.String.check(
  Schema.isTrimmed(),
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
).pipe(Schema.brand('ActionCommitIdempotencyKey'));

const ActionCommitIdentitySchema = Schema.Union([
  Schema.Struct({
    actionKey: Schema.optionalKey(Schema.Never),
    idempotencyKey: Schema.optionalKey(Schema.Never),
    invocationId: ActionInvocationIdSchema,
  }),
  Schema.Struct({
    actionKey: ActionCommitActionKeySchema,
    idempotencyKey: ActionCommitIdempotencyKeySchema,
    invocationId: Schema.optionalKey(Schema.Never),
  }),
]);

export interface ActionRuntimeService {
  readonly resolveActionCommit: (
    input: ResolveActionCommitInput,
  ) => Effect.Effect<
    ActionCommitOpen,
    | ActionAlreadyCommitted
    | ActionCommitIndeterminate
    | ActionInvocationNotFound
    | ActionInvocationPersistenceError
    | ActionInvocationStateError
    | ActionPayloadValidationError
    | ActionTrustedContextValidationError
  >;
  /** The exact caller-owned execution state of one Action lookup, for a recovery endpoint (O80, O85). */
  readonly resolveActionExecution: (
    input: ResolveActionExecutionInput,
  ) => Effect.Effect<
    ActionExecutionResolution,
    ActionInvocationPersistenceError | ActionPayloadValidationError | ActionTrustedContextValidationError
  >;
  /**
   * The one Action runner (O80, O85). Its success channel is `Result`, plus the parked-proposal 202 for
   * a transport that declares `'result-or-proposal'`; the declaration is what makes the widening
   * honest, so a result-only transport still refuses a `propose` intent rather than answer an
   * untyped value. There is no second runner: parking and running are the same decision path.
   */
  readonly runAction: <
    PayloadSchema extends Schema.ConstraintDecoder<unknown>,
    ResultSchema extends Schema.ConstraintDecoder<unknown>,
    DomainErrorSchema extends Schema.ConstraintDecoder<{
      readonly _tag: string;
    }>,
    DomainEvents extends DomainEventContractMap,
    Owner extends string,
    Services,
    HandlerRequirements,
    SuccessContract extends ActionSuccessContract = 'result',
  >(
    input: RunActionInput<
      PayloadSchema,
      ResultSchema,
      DomainErrorSchema,
      DomainEvents,
      Owner,
      Services,
      HandlerRequirements,
      SuccessContract
    >,
  ) => Effect.Effect<
    ResultSchema['Type'] | ActionProposalSuccess<SuccessContract>,
    ActionCoreError | DomainErrorSchema['Type'],
    HandlerRequirements
  >;
}

export interface ActionRuntimeOptions {
  /**
   * The access gate bound to this composition's enforcement ports (CUTOVER-PLAN §3.1). Every
   * descriptor that carries a v2 access carrier is decided here and nowhere else, and a composition
   * without it refuses every such descriptor with a retryable 503 instead of an implicit allow (O62).
   * Descriptors still on the legacy kinds keep the legacy checks until the codemod moves them (C05).
   */
  readonly accessDecision?: BoundAccessGate;
  readonly applicationComposition?: ActiveApplicationCompositionServiceContract;
  readonly authorizationPreflight?: ActionAuthorizationPreflightService;
  /** Transitional (O62, O68): the legacy ContextAccess the legacy kinds still consult until C05/C03b. */
  readonly contextAccess?: (typeof ContextAccess)['Service'];
  /**
   * The database-identity enrollment every scope install verifies against. It is owner-neutral: the
   * same enrollment serves every Action, and an Action never writes under a scope the connected
   * request role has no authority for.
   */
  readonly databaseIdentities: DatabaseIdentityEnrollment;
  readonly expectedDeployment?: typeof OntosDeploymentIdentitySchema.Type;
  readonly installScope?: typeof installOperationalScope;
  /** Scripted test seam; production uses the SQL shared row lock on the access fence. */
  readonly lockAccessExecutionFence?: typeof lockActionAccessFence;
  readonly lockCompositionAuthority?: typeof lockApplicationCompositionAuthority;
  /**
   * The transaction-bound approvals protocol (O75, O80, O85, O90): parks a proposed owner command and
   * executes an approved mandate. Absent means both fail closed rather than take a direct-run grant.
   */
  readonly mandateDispatch?: ActionMandateDispatch;
  readonly moduleEntrypointGateway: ModuleEntrypointGatewayService;
  readonly moduleStateGate: ModuleStateGateService;
  readonly onStage?: (stage: ActionRuntimeStage) => void;
  readonly ownerAuthorizationOverlay?: (typeof OwnerAuthorizationOverlay)['Service'];
  readonly ownerRegistration?: VerticalRuntimeRegistration;
  readonly resolveCompositionRevision?: (
    principal: TrustedPrincipalContext,
  ) => Effect.Effect<string, ActionTransactionError>;
  readonly resolveHandler?: typeof getActionHandler;
  readonly resolveServiceFactory?: typeof getActionServiceFactory;
  /**
   * The owner's staged service preparation (D14), when the Action declares one. Absent keeps the
   * ordinary in-transaction service acquisition.
   */
  readonly resolveServicePreflight?: typeof getActionServicePreflight;
}

const logInvocationPersistenceFailure = (
  failure: ActionInvocationPersistenceError,
  annotations: Readonly<Record<string, string>>,
): Effect.Effect<void> => logActionInvocationPersistenceFailureCause(failure, annotations);

const isCommitAcknowledgementFailure = (failure: SqlError): boolean =>
  isDatabaseCommitAcknowledgementAmbiguous(failure) ||
  (Option.isNone(findPostgresFailure(failure)) &&
    (Schema.is(ConnectionError)(failure.reason) || Schema.is(UnknownError)(failure.reason)));

const transactionFailure = () =>
  new ActionTransactionError({
    code: 'action_transaction_failed',
    reason: 'The Action transaction did not complete successfully',
  });

const ActionCoreErrorSchema = Schema.Union([
  ActionAlreadyCommitted,
  ActionCollectorError,
  ActionCommitIndeterminate,
  ActionHandlerExecutionError,
  ActionIdempotencyKeyRequired,
  ActionInvocationNotFound,
  ActionInvocationPersistenceError,
  ActionInvocationStateError,
  ActionPermissionCheckError,
  ActionPermissionDenied,
  ActionPayloadValidationError,
  ActionPolicyDenied,
  ActionPolicyEvaluationError,
  ActionRequestHashConflict,
  ActionResultValidationError,
  ActionTransactionError,
  ActionTrustedContextValidationError,
  ModuleStateCheckUnavailableError,
  ModuleStateDeniedError,
  OperationAuthenticationRequired,
  OperationContextDenied,
  OperationContextInvalid,
  OperationContextUnavailable,
]);

/** Nothing declared: one shared empty list, never a fresh mutable array. */
const NO_ACCESS_FIELD_GROUPS: readonly AccessFieldGroup[] = Object.freeze([]);
const UNAVAILABLE_AUTHORITY_REASON = 'unavailable.intent';

const alreadyCommitted = (invocationId: string) =>
  new ActionAlreadyCommitted({
    code: 'action_already_committed',
    invocationId,
    reason: 'This idempotency key already committed successfully',
  });

const permissionDeniedFailure = () =>
  new ActionPermissionDenied({
    code: 'action_permission_denied',
    reason: 'The principal is not permitted to execute this Action',
  });

const requestHashConflict = () =>
  new ActionRequestHashConflict({
    code: 'action_request_hash_conflict',
    reason: 'This idempotency key was already used for a different Action request',
  });

/** O67-Q9: a person who may propose but not run is told to seek an approval, never simply refused. */
const approvalRequiredFailure = (decision: AccessDecision) =>
  new ActionPermissionDenied({
    code: 'action_approval_required',
    reason: 'This Action needs an approved mandate before it can run',
    reasons: decision.reasons.map(({ code }) => code),
  });

/**
 * O80: an explicit propose intent on a command the gate already allows is refused, so the client runs
 * it directly instead of parking a proposal nobody needs.
 */
const proposeNotRequiredFailure = () =>
  new ActionPermissionDenied({
    code: 'action_permission_denied',
    reason: 'This Action does not need an approval; execute it directly',
  });

/** O85: the parked owner command is a successful 202, never a domain result and never Problem Details. */
const toActionProposalAccepted = (parked: ActionProposalParked): ActionProposalAccepted => ({
  _tag: 'ActionProposalAccepted',
  expiresAt: DateTime.fromDateUnsafe(parked.expiresAt),
  proposalId: parked.proposalId,
});

/** The gate's denial, carrying the engine's own reason codes for the decision log and "Proč?". */
const accessDeniedFailure = (decision: AccessDecision) =>
  new ActionPermissionDenied({
    code: 'action_permission_denied',
    reason: 'The principal is not permitted to execute this Action',
    reasons: decision.reasons.map(({ code }) => code),
  });

const permissionUnavailable = () =>
  new ActionPermissionCheckError({
    code: 'action_permission_check_failed',
    reason: 'The authorization service could not determine permission safely',
  });

/**
 * The v2 record target of a record-scoped Action, resolved from the declaration's own target
 * resolver (O9, O27). A malformed target is a Core authoring defect, so it is a retryable
 * unavailability and never an allow (CUTOVER-PLAN §5.3 risk 4).
 */
const AccessRecordTargetSchema = Schema.Struct({ moduleKey: ModuleKeySchema, recordKey: RecordKeySchema });
const decodeAccessRecordTarget = Schema.decodeUnknownOption(AccessRecordTargetSchema);

const resolveActionAccessTarget = <Payload>(
  payload: Payload,
  scope: OperationalScope,
  resolver: ((payload: Payload, scope: OperationalScope) => AccessTarget) | undefined,
): Effect.Effect<Option.Option<AccessRecordTarget>, ActionPermissionCheckError> =>
  Effect.suspend(() => {
    if (resolver === undefined) {
      return Effect.succeed(Option.none<AccessRecordTarget>());
    }
    return Effect.try({
      catch: (cause) =>
        attachFailureCause(
          new ActionPermissionCheckError({
            code: 'action_permission_check_failed',
            reason: 'The declared access target could not be resolved safely',
          }),
          cause,
        ),
      try: () => resolver(payload, scope),
    }).pipe(
      Effect.flatMap((declared) => {
        const decoded = decodeAccessRecordTarget(declared);
        return Option.isNone(decoded)
          ? Effect.fail(
              new ActionPermissionCheckError({
                code: 'action_permission_check_failed',
                reason: 'The declared access target is invalid',
              }),
            )
          : Effect.succeed(Option.some(decoded.value));
      }),
    );
  });

/**
 * The owner-local facts of a governed Action (O70): a flat string map naming the owner records the
 * owner's own business rule is about. They are resolved from the decoded payload before the request
 * reaches the transaction, handed to the owner overlay only, and never reach the decision engine. An
 * empty map is the owner's own statement that the request names no owner record, so it is passed
 * through unchanged rather than collapsed into "no facts"; a defect or a non-string fact is a
 * retryable 503, never an allow.
 */
const OwnerAccessFactsSchema = Schema.Record(Schema.String, Schema.String);
const decodeOwnerAccessFacts = Schema.decodeUnknownOption(OwnerAccessFactsSchema);

const resolveOwnerAccessFacts = <Payload>(
  payload: Payload,
  scope: OperationalScope,
  resolver: ((payload: Payload, scope: OperationalScope) => OwnerAccessFacts) | undefined,
): Effect.Effect<Option.Option<OwnerAccessFacts>, ActionPermissionCheckError> => {
  if (resolver === undefined) {
    return Effect.succeed(Option.none<OwnerAccessFacts>());
  }
  return Effect.try({
    catch: (cause) =>
      attachFailureCause(
        new ActionPermissionCheckError({
          code: 'action_permission_check_failed',
          reason: 'The owner-local facts of this Action could not be resolved safely',
        }),
        cause,
      ),
    try: () => resolver(payload, scope),
  }).pipe(
    Effect.flatMap((declared) => {
      const decoded = decodeOwnerAccessFacts(declared);
      return Option.isNone(decoded)
        ? Effect.fail(
            new ActionPermissionCheckError({
              code: 'action_permission_check_failed',
              reason: 'The owner-local facts of this Action are invalid',
            }),
          )
        : Effect.succeed(Option.some(decoded.value));
    }),
  );
};

/** Nothing for the legacy seam to check: a v2 descriptor names its record target instead (O9, Q2). */
const NO_OWNER_PERMISSION_TARGETS: readonly ActionOwnerPermissionTarget[] = Object.freeze([]);
const NO_OWNER_AUTHORIZATION_TARGETS: readonly OwnerAuthorizationTarget[] = Object.freeze([]);

const ownerAuthorizationFailure = (decision: Exclude<OwnerAuthorizationDecision, 'allowed'>) => {
  if (decision === 'denied') {
    return Effect.fail(
      new ActionPermissionDenied({
        code: 'action_permission_denied',
        reason: 'The owner-local authorization state denies this Action',
      }),
    );
  }
  return Effect.fail(permissionUnavailable());
};

const resolveActionTenantPermission = <Payload>(
  payload: Payload,
  resolver: ((payload: Payload) => ActionTenantPermission | undefined) | undefined,
): Effect.Effect<Option.Option<ActionTenantPermission>, ActionPermissionCheckError> =>
  Effect.try({
    catch: (cause) =>
      attachFailureCause(
        new ActionPermissionCheckError({
          code: 'action_permission_check_failed',
          reason: 'The declared tenant permission could not be resolved safely',
        }),
        cause,
      ),
    try: () => Option.fromNullishOr(resolver?.(payload)),
  });

const ActionResourcePermissionTargetSchema = Schema.Struct({
  permission: Schema.Literals(['read', 'write']),
  resource: Schema.Struct({
    moduleId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(
      Schema.brand('ActionTargetModuleId'),
    ),
    resourceId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(
      Schema.brand('ActionTargetResourceId'),
    ),
    resourceType: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)).pipe(
      Schema.brand('ActionTargetResourceType'),
    ),
  }),
});

const resolveActionResourcePermissionTarget = <Payload>(
  payload: Payload,
  scope: OperationalScope,
  resolver: ((payload: Payload, scope: OperationalScope) => ActionResourcePermissionTarget) | undefined,
): Effect.Effect<Option.Option<ActionResourcePermissionTarget>, ActionPermissionCheckError> =>
  Effect.suspend(() => {
    if (resolver === undefined) {
      return Effect.succeed(Option.none<ActionResourcePermissionTarget>());
    }
    return Effect.try({
      catch: (cause) =>
        attachFailureCause(
          new ActionPermissionCheckError({
            code: 'action_permission_check_failed',
            reason: 'The declared Action permission target could not be resolved safely',
          }),
          cause,
        ),
      try: () => resolver(payload, scope),
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(ActionResourcePermissionTargetSchema)),
      Effect.mapError((cause) =>
        attachFailureCause(
          new ActionPermissionCheckError({
            code: 'action_permission_check_failed',
            reason: 'The declared Action permission target is invalid',
          }),
          cause,
        ),
      ),
      Effect.map((target) =>
        Option.some(
          Object.freeze({
            permission: target.permission,
            resource: Object.freeze({ ...target.resource }),
          }),
        ),
      ),
    );
  });

const resolveActionOwnerPermissionTargets = <Payload>(
  payload: Payload,
  scope: OperationalScope,
  resolver: ((payload: Payload, scope: OperationalScope) => readonly ActionOwnerPermissionTarget[]) | undefined,
): Effect.Effect<readonly ActionOwnerPermissionTarget[], ActionPermissionCheckError> =>
  Effect.suspend(() => {
    if (resolver === undefined) {
      return Effect.succeed([]);
    }
    return Effect.try({
      catch: (cause) =>
        attachFailureCause(
          new ActionPermissionCheckError({
            code: 'action_permission_check_failed',
            reason: 'The declared owner permission targets could not be resolved safely',
          }),
          cause,
        ),
      try: () => resolver(payload, scope),
    }).pipe(
      Effect.filterOrFail(
        (targets) =>
          EffectArray.isArray(targets) &&
          targets.length > 0 &&
          targets.length <= 8 &&
          targets.every((target) => isOwnerPermissionAccessTargetValid(target, scope)) &&
          new Set(targets.map((target) => target.key)).size === targets.length &&
          targets.every((target) => target.transportObjectId === targets[0]?.transportObjectId),
        () =>
          new ActionPermissionCheckError({
            code: 'action_permission_check_failed',
            reason: 'The declared owner permission targets do not match trusted scope',
          }),
      ),
    );
  });

const terminalInvocation = () =>
  new ActionInvocationStateError({
    code: 'action_invocation_state_invalid',
    reason: 'This Action invocation is terminal and cannot execute again',
  });

// A same-key retry of a rejected invocation reports the recorded rejection, so the outcome does
// not depend on whether the retry arrived before or after the first request committed it.
const recordedRejectionFailure = (rejection: Option.Option<ActionRecordedRejection>) => {
  if (Option.isNone(rejection)) {
    return terminalInvocation();
  }
  return rejection.value.stage === 'authz'
    ? permissionDeniedFailure()
    : new ActionPolicyDenied({
        code: 'action_policy_denied',
        policyReasonCode: rejection.value.policyReasonCode,
        reason: 'A required Action Policy rejected this invocation',
      });
};

const recordedRejectionPersistenceFailure = (cause: unknown) =>
  createActionInvocationPersistenceErrorWithCause(
    {
      code: 'action_invocation_persistence_failed',
      reason: 'Unable to load the recorded Action rejection',
    },
    cause,
  );

const verifyInvocation = (
  invocation: ActionInvocationRecord,
  requestHash: string,
  recordedRejection: Effect.Effect<Option.Option<ActionRecordedRejection>, ActionInvocationPersistenceError>,
): Effect.Effect<
  void,
  | ActionAlreadyCommitted
  | ActionCommitIndeterminate
  | ActionInvocationPersistenceError
  | ActionInvocationStateError
  | ActionPermissionDenied
  | ActionPolicyDenied
  | ActionRequestHashConflict
> => {
  if (invocation.requestHash !== requestHash) {
    return Effect.fail(requestHashConflict());
  }
  if (invocation.status === 'succeeded') {
    return Effect.fail(alreadyCommitted(invocation.actionInvocationId));
  }
  if (invocation.status === 'indeterminate') {
    return Effect.fail(
      new ActionCommitIndeterminate({
        code: 'action_commit_indeterminate',
        invocationId: invocation.actionInvocationId,
        reason: 'This invocation requires commit resolution before it can execute',
      }),
    );
  }
  if ((invocation.status === 'received' || invocation.status === 'running') && invocation.completedAt === null) {
    return Effect.void;
  }
  if (invocation.status === 'rejected') {
    return recordedRejection.pipe(Effect.flatMap((rejection) => Effect.fail(recordedRejectionFailure(rejection))));
  }
  return Effect.fail(terminalInvocation());
};

const StoppedCheckpointPayloadSchema = Schema.Struct({
  checkpoint: Schema.Literal('stopped'),
});

const validatePrincipal = <Input, Registration extends object = object, Payload = undefined>(
  input: Input,
  actionRegistration?: Registration,
  payload?: Payload,
): Effect.Effect<TrustedPrincipalContext, ActionTrustedContextValidationError> =>
  decodeTrustedPrincipalContext(input).pipe(
    Effect.filterOrFail(
      (principal) =>
        !isTrustedSupportRecoveryPrincipalContext(principal) ||
        (actionRegistration !== undefined &&
          isTrustedSupportRecoveryPrincipalContext(principal, actionRegistration) &&
          Schema.is(StoppedCheckpointPayloadSchema)(payload)),
      () =>
        new ActionTrustedContextValidationError({
          code: 'action_trusted_context_invalid',
          reason: 'The support recovery context does not authorize this Action',
        }),
    ),
    Effect.mapError((cause) =>
      attachFailureCause(
        new ActionTrustedContextValidationError({
          code: 'action_trusted_context_invalid',
          reason: 'The trusted principal context is incomplete or invalid',
        }),
        cause,
      ),
    ),
  );

const validateTransport = <Input>(input: Input): Effect.Effect<ActionTransportMetadata, ActionPayloadValidationError> =>
  Schema.decodeUnknownEffect(ActionTransportMetadataSchema, { onExcessProperty: 'error' })(input).pipe(
    Effect.mapError((cause) =>
      attachFailureCause(
        new ActionPayloadValidationError({
          code: 'action_payload_invalid',
          reason: 'The Action transport metadata is structurally invalid',
        }),
        cause,
      ),
    ),
  );

const makeHandlerExecutionError = () =>
  new ActionHandlerExecutionError({
    code: 'action_handler_execution_failed',
    reason: 'The Action handler failed unexpectedly',
  });

const decodeRegisteredMandateCommand = Effect.fn('ActionRuntime.decodeRegisteredMandateCommand')(
  function* decodeRegisteredMandateCommand(input: {
    readonly prepared: MandatePrepared | undefined;
    readonly registration: AnyActionRegistration;
    readonly scope: OperationalScope;
  }) {
    if (input.prepared === undefined) {
      return Option.none<ActionCommandV2>();
    }
    const command = yield* decodeActionCommandV2(input.prepared.command.payload);
    yield* rebindRegisteredActionCommandV2({ command, registration: input.registration, scope: input.scope });
    return Option.some(command);
  },
);

const policyEvidence = <Payload, Owner extends string>(policy: ActionPolicy<Payload, Owner>): ActionPolicyEvidence =>
  policy.scope === 'global'
    ? { policyKey: policy.policyKey, scope: policy.scope }
    : {
        owningModuleKey: policy.owningModuleKey,
        policyKey: policy.policyKey,
        scope: policy.scope,
      };

type ActionRuntimeConstruction = readonly [
  database: (typeof CoreDatabaseService)['Service'],
  repository: ActionRepositoryService,
  permission: ActionPermissionService,
  operationalScopeResolver: OperationalScopeResolverService,
  options: ActionRuntimeOptions,
];

const unavailableActionComposition = (cause?: unknown) =>
  createActionTransactionErrorWithCause(
    {
      code: 'action_transaction_failed',
      reason: 'The receiving owner release is not approved by the active Application Composition',
    },
    cause,
  );

/** Core-private resolver shared by the live runtime and its release-race regression tests. */
export const makeActionCompositionRevisionResolver = (
  applicationComposition: ActiveApplicationCompositionServiceContract,
  expectedDeployment: typeof OntosDeploymentIdentitySchema.Type,
) => {
  const receivingDeployment = Object.freeze({ ...expectedDeployment });
  return Effect.fn('ActionRuntime.resolveCompositionRevision')(function* resolveCompositionRevision(
    principal: TrustedPrincipalContext,
  ) {
    const snapshot = yield* applicationComposition.load.pipe(
      Effect.flatMap(validateActiveApplicationCompositionSnapshot),
      Effect.mapError(unavailableActionComposition),
    );
    const selectedOwner = snapshot.composition.modules.find(
      (module) =>
        module.deployment.appId === receivingDeployment.appId &&
        module.deployment.buildMarker === receivingDeployment.buildMarker,
    );
    const shellDeployment = snapshot.composition.shell.deployment;
    const isSelectedShell =
      receivingDeployment.appId === shellDeployment.appId &&
      receivingDeployment.buildMarker === shellDeployment.buildMarker;
    const gatewayRevision = readVerifiedGatewayCompositionRevision(principal);
    if (
      (selectedOwner === undefined && !isSelectedShell) ||
      (gatewayRevision !== undefined && gatewayRevision !== snapshot.composition.revision)
    ) {
      return yield* unavailableActionComposition();
    }
    return snapshot.composition.revision;
  });
};

/** Freeze only owned record/array data; native schema values retain their own semantics. */
const freezeActionPostAttemptValue = <Value>(value: Value): Value => {
  if (
    value !== null &&
    Predicate.isObjectKeyword(value) &&
    (Object.getPrototypeOf(value) === Array.prototype ||
      Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    for (const nested of Object.values(value)) {
      freezeActionPostAttemptValue(nested);
    }
    Object.freeze(value);
  }
  return value;
};

interface ActionAttemptOriginal<Payload> {
  readonly invocationId: string;
  readonly payload: Payload;
  readonly principal: TrustedPrincipalContext;
  readonly requestHash: string;
  readonly scope: OperationalScope;
}
interface ActionAttemptState<Payload, DomainError> {
  committedRejection: DomainError | undefined;
  disposition: 'unstarted' | 'uncommitted' | 'indeterminate' | 'committed';
  original: ActionAttemptOriginal<Payload> | undefined;
  revision: string | undefined;
}

// oxlint-disable-next-line effect-native/no-wide-factory-signature -- Trusted scope and the four resolved optional permission targets are cohesive authorization data for this Action run.
const buildOwnerAuthorizationTargets = (
  scope: OperationalScope,
  tenantPermission: Option.Option<ActionTenantPermission>,
  legalEntityPermission: ActionLegalEntityPermission | undefined,
  ownerPermissionTargets: readonly ActionOwnerPermissionTarget[],
  resourcePermissionTarget: Option.Option<ActionResourcePermissionTarget>,
): readonly OwnerAuthorizationTarget[] => {
  const targets: OwnerAuthorizationTarget[] = [];
  if (Option.isSome(tenantPermission)) {
    targets.push({ kind: 'tenant', permission: tenantPermission.value, tenantId: scope.tenantId });
  }
  if (legalEntityPermission !== undefined && scope.legalEntityId !== undefined) {
    targets.push({
      kind: 'legal_entity',
      legalEntityId: scope.legalEntityId,
      permission: legalEntityPermission,
    });
  }

  for (const target of ownerPermissionTargets) {
    targets.push({
      kind: 'owner_permission',
      target,
    });
  }
  if (Option.isSome(resourcePermissionTarget)) {
    targets.push({
      kind: 'resource',
      permission: resourcePermissionTarget.value.permission,
      resource: resourcePermissionTarget.value.resource,
    });
  }
  return Object.freeze(targets);
};

export const makeActionRuntime = (...construction: ActionRuntimeConstruction): ActionRuntimeService => {
  const [database, repository, permission, operationalScopeResolver, options] = construction;
  const operationAuthority = options.expectedDeployment === undefined ? undefined : options.applicationComposition;
  const {
    accessDecision,
    authorizationPreflight,
    contextAccess,
    mandateDispatch,
    moduleEntrypointGateway,
    moduleStateGate,
    ownerAuthorizationOverlay = failClosedOwnerAuthorizationOverlay,
  } = options;
  const resolveHandler = options.resolveHandler ?? getActionHandler;
  const resolveServiceFactory = options.resolveServiceFactory ?? getActionServiceFactory;
  const resolveServicePreflight = options.resolveServicePreflight ?? getActionServicePreflight;
  const installScope = options.installScope ?? installOperationalScope;
  const lockCompositionAuthority = options.lockCompositionAuthority ?? lockApplicationCompositionAuthority;
  const lockAccessExecutionFence = options.lockAccessExecutionFence ?? lockActionAccessFence;
  /**
   * Invocation evidence is recorded only after the invocation's trusted database scope is
   * installed, so tenant-bound row-level security admits the request role's own tenant alone.
   */
  const invocationScopeExecutor = (scope: OperationalScope): ActionInvocationScopeExecutor => ({
    transaction: (body) =>
      database.executor.transaction((transaction) =>
        installScope(transaction, scope, options.databaseIdentities).pipe(Effect.andThen(() => body(transaction))),
      ),
  });
  const loadRecordedRejectionInScope = (scope: OperationalScope, invocationId: string) =>
    invocationScopeExecutor(scope)
      .transaction((transaction) => repository.loadRecordedRejection(transaction, invocationId))
      .pipe(
        recoverSqlTransactionError,
        Effect.catchTags({
          OperationContextUnavailable: (failure) => Effect.fail(recordedRejectionPersistenceFailure(failure)),
          SqlError: (failure) => Effect.fail(recordedRejectionPersistenceFailure(failure)),
        }),
      );
  const resolveCompositionRevision =
    (options.applicationComposition !== undefined && options.expectedDeployment !== undefined
      ? makeActionCompositionRevisionResolver(options.applicationComposition, options.expectedDeployment)
      : options.resolveCompositionRevision) ??
    (() =>
      Effect.fail(
        new ActionTransactionError({
          code: 'action_transaction_failed',
          reason: 'The Action has no approved Application Composition authority',
        }),
      ));
  const notifyStage = (stage: ActionRuntimeStage): void => {
    options.onStage?.(stage);
  };

  const checkTenantActionPermission = (
    principal: TrustedPrincipalContext,
    tenantPermission: Option.Option<ActionTenantPermission>,
  ): Effect.Effect<'allowed' | 'denied', ActionPermissionCheckError> => {
    if (Option.isNone(tenantPermission)) {
      return Effect.succeed('allowed');
    }
    if (contextAccess === undefined) {
      return Effect.fail(permissionUnavailable());
    }
    return contextAccess
      .tenants({
        permission: tenantPermission.value,
        principalId: principal.principalId,
        tenantIds: [principal.tenantId],
      })
      .pipe(
        Effect.flatMap(([decision]) =>
          decision?.key === principal.tenantId && (decision.decision === 'allowed' || decision.decision === 'denied')
            ? Effect.succeed(decision.decision)
            : Effect.fail(permissionUnavailable()),
        ),
      );
  };

  const checkActionLegalEntityPermission = (
    scope: OperationalScope,
    legalEntityPermission: ActionLegalEntityPermission | undefined,
  ): Effect.Effect<'allowed' | 'denied', ActionPermissionCheckError> => {
    if (legalEntityPermission === undefined) {
      return Effect.succeed('allowed');
    }
    if (contextAccess === undefined || scope.legalEntityId === undefined) {
      return Effect.fail(permissionUnavailable());
    }
    return contextAccess
      .legalEntities({
        legalEntityIds: [scope.legalEntityId],
        permission: legalEntityPermission,
        principalId: scope.principalId,
        tenantId: scope.tenantId,
      })
      .pipe(
        Effect.flatMap(([decision]) =>
          decision !== undefined &&
          decision.key === scope.legalEntityId &&
          (decision.decision === 'allowed' || decision.decision === 'denied')
            ? Effect.succeed(decision.decision)
            : Effect.fail(permissionUnavailable()),
        ),
      );
  };

  const checkActionResourcePermission = (
    scope: OperationalScope,
    resourceTarget: Option.Option<ActionResourcePermissionTarget>,
  ): Effect.Effect<'allowed' | 'denied', ActionPermissionCheckError> => {
    if (Option.isNone(resourceTarget)) {
      return Effect.succeed('allowed');
    }
    if (contextAccess === undefined || scope.legalEntityId === undefined) {
      return Effect.fail(permissionUnavailable());
    }
    const target = resourceTarget.value;
    return contextAccess
      .resources({
        legalEntityId: scope.legalEntityId,
        permission: target.permission,
        principalId: scope.principalId,
        resources: [target.resource],
        tenantId: scope.tenantId,
      })
      .pipe(
        Effect.flatMap(([decision]) =>
          decision?.key ===
            `${target.resource.moduleId}:${target.resource.resourceType}:${target.resource.resourceId}` &&
          (decision.decision === 'allowed' || decision.decision === 'denied')
            ? Effect.succeed(decision.decision)
            : Effect.fail(permissionUnavailable()),
        ),
      );
  };

  const checkActionOwnerPermissions = (
    scope: OperationalScope,
    ownerTargets: readonly ActionOwnerPermissionTarget[],
  ): Effect.Effect<'allowed' | 'denied', ActionPermissionCheckError> => {
    if (ownerTargets.length === 0) {
      return Effect.succeed('allowed');
    }
    if (
      contextAccess?.ownerPermissions === undefined ||
      ownerTargets.some((target) => !isOwnerPermissionAccessTargetValid(target, scope))
    ) {
      return Effect.fail(permissionUnavailable());
    }
    const { legalEntityId } = scope;
    const checkInputBase = {
      principal: { principalId: scope.principalId, tenantId: scope.tenantId },
      targets: ownerTargets.map((entry) => ({ target: entry })),
    };
    const checkInputWithStorefront =
      scope.trustedStorefrontId === undefined
        ? checkInputBase
        : { ...checkInputBase, trustedStorefrontId: scope.trustedStorefrontId };
    const checkInput =
      legalEntityId === undefined ? checkInputWithStorefront : { ...checkInputWithStorefront, legalEntityId };
    return contextAccess.ownerPermissions(checkInput).pipe(
      Effect.flatMap((decisions) => {
        if (
          decisions.length !== ownerTargets.length ||
          decisions.some(
            (decision, index) =>
              decision.key !== (ownerTargets[index] === undefined ? undefined : ownerTargets[index]?.key) ||
              decision.decision === 'unavailable',
          )
        ) {
          return Effect.fail(permissionUnavailable());
        }
        return decisions.some(({ decision }) => decision === 'denied')
          ? Effect.succeed('denied' as const)
          : Effect.succeed('allowed' as const);
      }),
    );
  };

  const runActionBoundary = Effect.fn('ActionRuntime.runAction')(function* runActionEffect<
    PayloadSchema extends Schema.ConstraintDecoder<unknown>,
    ResultSchema extends Schema.ConstraintDecoder<unknown>,
    DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
    DomainEvents extends DomainEventContractMap,
    Owner extends string,
    Services,
    HandlerRequirements,
    SuccessContract extends ActionSuccessContract,
  >(
    input: RunActionInput<
      PayloadSchema,
      ResultSchema,
      DomainErrorSchema,
      DomainEvents,
      Owner,
      Services,
      HandlerRequirements,
      SuccessContract
    >,
  ) {
    /** Only a transport whose success union names the 202 may park a proposal (O85). */
    const acceptsParkedProposal = input.successContract === 'result-or-proposal';
    /**
     * The descriptor decides which authority answers (O62, O68): a v2 carrier (the `protected`
     * classification, or a workload marker of any kind) goes through the one access gate, and a
     * descriptor still on a legacy kind keeps the legacy checks until the codemod moves it (C05).
     */
    const usesAccessGate =
      input.registration.descriptor.entrypoint.authorization.kind === 'protected' ||
      input.registration.descriptor.accessWorkload !== undefined ||
      input.registration.descriptor.accessActor !== undefined ||
      input.registration.descriptor.accessTargets !== undefined;
    /**
     * The registered, decoded carrier of this Action: definition time already decoded, validated and
     * froze it, so no request decodes it again (O5, O58, O59).
     */
    const declaredCarrier = input.registration.descriptor;
    const accessTargetsResolver = getActionAccessTargetsResolver(declaredCarrier.accessTargets);
    const supportsProposal = (declaredCarrier.accessDeclaration?.modes ?? []).includes('propose');

    const postAttemptHook = getActionPostAttemptHook(input.registration);
    const attempt: ActionAttemptState<PayloadSchema['Type'], DomainErrorSchema['Type']> = {
      committedRejection: undefined,
      disposition: 'unstarted',
      original: undefined,
      revision: undefined,
    };
    const executeAttempt = Effect.fn('ActionRuntime.executeAttempt')(function* executeAttemptEffect() {
      const prepareTrustedInputAndContext = Effect.fn('ActionRuntime.prepareTrustedInputAndContext')(
        function* prepareTrustedInputAndContextEffect() {
          const receivedTransport = yield* validateTransport(input.transport);
          const { mandateId } = receivedTransport;
          // Mandate retries always resolve the SAME invocation, even when transport metadata changes.
          const transport =
            mandateId === undefined
              ? receivedTransport
              : { ...receivedTransport, idempotencyKey: `mandate:${mandateId}` };
          if (transport.intent === 'propose') {
            if (!acceptsParkedProposal) {
              // O85: a parked proposal is a 202 body, so only a transport that declares that success
              // union may ask for one; a result-only transport refuses instead of answering an untyped value.
              return yield* new ActionPermissionDenied({
                code: 'action_permission_denied',
                reason: 'This Action endpoint does not accept proposal requests',
              });
            }
            if (!usesAccessGate) {
              // A proposal is the v2 gate's answer for a protected carrier; a legacy carrier has none.
              return yield* permissionDeniedFailure();
            }
          }
          const initialPayload =
            mandateId === undefined
              ? yield* decodeActionPayload(input.registration.descriptor.payloadSchema, input.payload)
              : undefined;
          const principal = yield* validatePrincipal(input.principal, input.registration, initialPayload);
          const scope = yield* operationalScopeResolver.resolve(
            withOptionalProperty(
              withOptionalProperty(
                {
                  correlationId: transport.correlationId,
                  legalEntityScope: input.registration.descriptor.legalEntityScope,
                  principal,
                },
                transport.traceId !== undefined,
                'traceId',
                transport.traceId,
                {},
              ),
              input.audience !== undefined,
              'audience',
              input.audience,
              {},
            ),
          );
          let mandatePrepared: MandatePrepared | undefined;
          if (mandateId !== undefined) {
            if (mandateDispatch === undefined) {
              return yield* permissionUnavailable();
            }
            if (input.payload !== undefined && input.payload !== null) {
              return yield* new ActionPayloadValidationError({
                code: 'action_payload_invalid',
                reason: 'Mandate execution accepts only its stored frozen command, not a request payload',
              });
            }
            const declaration = declaredCarrier.accessDeclaration;
            const capabilityKey = declaration?.key;
            // A stored mandate cannot widen the current registration's modes: identity-bound,
            // ephemeral and run-only admin Actions do not permit approval-based execution (O14/O22/O43).
            if (!usesAccessGate || capabilityKey === undefined || declaration?.modes.includes('approve') !== true) {
              return yield* permissionDeniedFailure();
            }
            mandatePrepared = yield* mandateDispatch.prepare({
              actionKey: declaredCarrier.actionKey,
              administrative: declaredCarrier.accessDeclaration?.kind === 'admin',
              capabilityKey,
              legalEntityScope: input.registration.descriptor.legalEntityScope,
              mandateId,
              registration: input.registration,
              requestPayload: input.payload,
              scope,
            });
          }
          const mandateCommand = Option.getOrUndefined(
            yield* decodeRegisteredMandateCommand({
              prepared: mandatePrepared,
              registration: input.registration,
              scope,
            }),
          );
          const payload =
            mandateCommand === undefined
              ? (initialPayload ??
                (yield* decodeActionPayload(input.registration.descriptor.payloadSchema, input.payload)))
              : yield* decodeActionPayload(input.registration.descriptor.payloadSchema, mandateCommand.payload);
          notifyStage('payload_decoded');
          notifyStage('trusted_context_validated');
          const deniedAuditEvidenceDeclaration = input.registration.descriptor.deniedAuditEvidence;
          const deniedAuditEvidence =
            deniedAuditEvidenceDeclaration === undefined
              ? undefined
              : yield* resolveDeniedAuditEvidence(deniedAuditEvidenceDeclaration, payload, scope);
          return { deniedAuditEvidence, mandatePrepared, payload, principal, scope, transport };
        },
      );

      type ActionTransportTarget = Pick<
        ActionTransportMetadata,
        'targetModuleKey' | 'targetResourceId' | 'targetResourceType'
      >;

      const buildGovernedTransport = (
        transport: ActionTransportMetadata,
        target: ActionTransportTarget,
      ): ActionTransportMetadata =>
        withOptionalProperty(
          withOptionalProperty(
            { correlationId: transport.correlationId, ...target },
            transport.idempotencyKey !== undefined,
            'idempotencyKey',
            transport.idempotencyKey,
            {},
          ),
          transport.traceId !== undefined,
          'traceId',
          transport.traceId,
          {},
        );

      /* oxlint-disable anti-slop/no-known-value-widening -- The normalized governed-target result intentionally preserves the existing owner authorization contract across all branches. */
      const prepareGovernedTarget = (
        transport: ActionTransportMetadata,
        _scope: OperationalScope,
        ownerPermissionTargets: readonly ActionOwnerPermissionTarget[],
        resourcePermissionTarget: Option.Option<ActionResourcePermissionTarget>,
        hasCanonicalScopeTarget: boolean,
      ): Readonly<{
        actionTarget: Pick<ActionTransportMetadata, 'targetModuleKey' | 'targetResourceId' | 'targetResourceType'>;
        governedTransport: ActionTransportMetadata;
      }> => {
        if (ownerPermissionTargets.length > 0) {
          const [singleTarget] = ownerPermissionTargets;
          const actionTarget = {
            targetModuleKey: singleTarget?.transportModuleKey ?? input.registration.descriptor.owningModuleKey,
            targetResourceId: singleTarget?.transportObjectId ?? 'owner-permission-unavailable',
            targetResourceType:
              singleTarget?.transportResourceType ??
              singleTarget?.contract.targetResourceType ??
              'owner-permission-unavailable',
          };
          return { actionTarget, governedTransport: buildGovernedTransport(transport, actionTarget) };
        }
        if (Option.isSome(resourcePermissionTarget)) {
          const target = resourcePermissionTarget.value;
          const actionTarget = {
            targetModuleKey: target.resource.moduleId,
            targetResourceId: target.resource.resourceId,
            targetResourceType: target.resource.resourceType,
          };
          return { actionTarget, governedTransport: buildGovernedTransport(transport, actionTarget) };
        }
        if (hasCanonicalScopeTarget) {
          const actionTarget = {};
          return { actionTarget, governedTransport: buildGovernedTransport(transport, actionTarget) };
        }
        const actionTarget = withOptionalProperty(
          withOptionalProperty(
            withOptionalProperty(
              {},
              transport.targetModuleKey !== undefined,
              'targetModuleKey',
              transport.targetModuleKey,
              {},
            ),
            transport.targetResourceId !== undefined,
            'targetResourceId',
            transport.targetResourceId,
            {},
          ),
          transport.targetResourceType !== undefined,
          'targetResourceType',
          transport.targetResourceType,
          {},
        );
        return { actionTarget, governedTransport: transport };
      };
      /* oxlint-enable anti-slop/no-known-value-widening */

      const prepareAuthorizationContext = Effect.fn('ActionRuntime.prepareAuthorizationContext')(
        function* prepareAuthorizationContextEffect(
          payload: PayloadSchema['Type'],
          principal: TrustedPrincipalContext,
          scope: OperationalScope,
          transport: ActionTransportMetadata,
        ) {
          const { earlyCompositionRevision, intrinsicDependencies } = yield* prepareOperationIntrinsicState(
            input.registration,
            principal,
            options,
          ).pipe(Effect.mapError(unavailableActionComposition));
          const moduleStateSnapshot = yield* moduleEntrypointGateway.prepareSnapshot(
            scope,
            [input.registration.descriptor.entrypoint],
            intrinsicDependencies,
          );
          yield* moduleEntrypointGateway.check(moduleStateSnapshot, input.registration.descriptor.entrypoint);
          notifyStage('module_state_gate');

          yield* requireIdempotencyKey(input.registration.descriptor.idempotency, transport);

          if (usesAccessGate) {
            const { accessDeclaration } = declaredCarrier;
            // The record target and the governed amount are owner callbacks; run them in declaration
            // order so a defect in one is reported before the other observes mutable state.
            const [resolvedAccessTarget, accessAmount, accessOwnerFacts] = yield* Effect.all(
              [
                resolveActionAccessTarget(payload, scope, getActionAccessTargetResolver(input.registration)),
                resolveGovernedAmount(
                  payload,
                  scope,
                  getActionAccessAmountResolver(input.registration),
                  accessDeclaration,
                ),
                resolveOwnerAccessFacts(payload, scope, getActionOwnerFactsResolver(input.registration)),
              ] as const,
              { concurrency: 1 },
            );
            const targetSet =
              accessTargetsResolver === undefined
                ? undefined
                : yield* resolveActionTargetSet(payload, scope, declaredCarrier.owningModuleKey, accessTargetsResolver);
            if (targetSet !== undefined) {
              freezeActionPostAttemptValue(payload);
            }
            const accessTarget =
              targetSet?.targets.length === 1 ? Option.some(targetSet.targets[0]) : resolvedAccessTarget;
            const singleRecord =
              targetSet?.targets.length === 1 ? targetSet.targets[0] : Option.getOrUndefined(accessTarget);
            const singleActionTarget =
              singleRecord === undefined
                ? {}
                : {
                    targetModuleKey: singleRecord.moduleKey,
                    targetResourceId: singleRecord.recordKey,
                    targetResourceType: accessDeclaration?.key ?? input.registration.descriptor.actionKey,
                  };
            // The digest is transport/history identity only. No gate is asked about a digest record.
            const actionTarget =
              targetSet === undefined || targetSet.targets.length === 1
                ? singleActionTarget
                : {
                    targetModuleKey: declaredCarrier.owningModuleKey,
                    targetResourceId: targetSet.hash,
                    targetResourceType: accessDeclaration?.key ?? declaredCarrier.actionKey,
                  };
            return {
              accessAmount,
              accessOwnerFacts,
              accessTarget,
              actionTarget,
              earlyCompositionRevision,
              frozenOwnerAuthorizationTargets: NO_OWNER_AUTHORIZATION_TARGETS,
              governedTransport: buildGovernedTransport(transport, actionTarget),
              intrinsicDependencies,
              legalEntityPermission: undefined,
              ownerPermissionTargets: NO_OWNER_PERMISSION_TARGETS,
              resourcePermissionTarget: Option.none<ActionResourcePermissionTarget>(),
              targetSet,
              tenantPermission: Option.none<ActionTenantPermission>(),
            };
          }

          const tenantPermission = isTrustedSupportRecoveryPrincipalContext(principal, input.registration)
            ? Option.none<ActionTenantPermission>()
            : yield* resolveActionTenantPermission(payload, input.registration.descriptor.tenantPermission);
          const { legalEntityPermission } = input.registration.descriptor;
          const [ownerPermissionTargets, resourcePermissionTarget] = yield* Effect.all(
            [
              resolveActionOwnerPermissionTargets(
                payload,
                scope,
                getActionOwnerPermissionTargetResolver(input.registration),
              ),
              resolveActionResourcePermissionTarget(
                payload,
                scope,
                getActionResourcePermissionTargetResolver(input.registration),
              ),
            ],
            { concurrency: 1 },
          );
          const hasCanonicalScopeTarget =
            Option.isSome(tenantPermission) || legalEntityPermission !== undefined || ownerPermissionTargets.length > 0;
          const frozenOwnerAuthorizationTargets = buildOwnerAuthorizationTargets(
            scope,
            tenantPermission,
            legalEntityPermission,
            ownerPermissionTargets,
            resourcePermissionTarget,
          );
          const { actionTarget, governedTransport } = prepareGovernedTarget(
            transport,
            scope,
            ownerPermissionTargets,
            resourcePermissionTarget,
            hasCanonicalScopeTarget,
          );
          return {
            accessAmount: Option.none<AccessAmount>(),
            accessOwnerFacts: Option.none<OwnerAccessFacts>(),
            accessTarget: Option.none<AccessRecordTarget>(),
            actionTarget,
            earlyCompositionRevision,
            frozenOwnerAuthorizationTargets,
            governedTransport,
            intrinsicDependencies,
            legalEntityPermission,
            ownerPermissionTargets,
            resourcePermissionTarget,
            targetSet: undefined,
            tenantPermission,
          };
        },
      );

      /** The stored 202 of an invocation that already parked a proposal; absence parks a new one. */
      const findParkedProposal = Effect.fn('ActionRuntime.findParkedProposal')(function* findParkedProposalEffect(
        actionInvocationId: string,
        scope: OperationalScope,
      ) {
        if (mandateDispatch === undefined) {
          // Without the transaction-joining adapter nothing can be parked or replayed: fail closed.
          return yield* permissionUnavailable();
        }
        const parked = yield* mandateDispatch.loadParkedProposal({ actionInvocationId, scope });
        return parked.pipe(Option.map(toActionProposalAccepted));
      });

      const prepareInvocation = Effect.fn('ActionRuntime.prepareInvocation')(function* prepareInvocationEffect(
        payload: PayloadSchema['Type'],
        principal: TrustedPrincipalContext,
        transport: ActionTransportMetadata,
        actionTarget: Pick<ActionTransportMetadata, 'targetModuleKey' | 'targetResourceId' | 'targetResourceType'>,
        governedTransport: ActionTransportMetadata,
        scope: OperationalScope,
      ) {
        const normalizedPayload = yield* Effect.try({
          catch: (cause) =>
            attachFailureCause(
              new ActionPayloadValidationError({
                code: 'action_payload_invalid',
                reason: 'The decoded Action payload cannot be encoded safely',
              }),
              cause,
            ),
          try: () =>
            Result.getOrThrow(
              Schema.encodeUnknownResult(
                Schema.make<Schema.ConstraintEncoder<unknown>>(input.registration.descriptor.payloadSchema.ast),
              )(payload),
            ),
        });
        const requestHash = yield* Effect.try({
          catch: (cause) =>
            attachFailureCause(
              new ActionPayloadValidationError({
                code: 'action_payload_invalid',
                reason: 'The decoded Action payload cannot be normalized safely',
              }),
              cause,
            ),
          try: () =>
            computeActionRequestHash({
              actionKey: input.registration.descriptor.actionKey,
              normalizedPayload,
              owningModuleKey: input.registration.descriptor.owningModuleKey,
              principal,
              schemaVersion: input.registration.descriptor.schemaVersion,
              target: actionTarget,
            }),
        });
        const invocation = yield* repository
          .createOrResolveInvocation(invocationScopeExecutor(scope), {
            actionKey: input.registration.descriptor.actionKey,
            idempotencyKey: transport.idempotencyKey,
            principal,
            requestHash,
            transport: governedTransport,
          })
          .pipe(
            Effect.tapError((error) =>
              logInvocationPersistenceFailure(error, {
                actionKey: input.registration.descriptor.actionKey,
                correlationId: transport.correlationId,
              }),
            ),
          );
        notifyStage('invocation_prepared');
        if (postAttemptHook !== undefined && invocation.requestHash === requestHash) {
          const ownedPayload = freezeActionPostAttemptValue(
            yield* decodeActionPayload(input.registration.descriptor.payloadSchema, normalizedPayload),
          );
          attempt.original = Object.freeze({
            invocationId: invocation.actionInvocationId,
            payload: ownedPayload,
            principal,
            requestHash,
            scope,
          });
        }
        // Receipt replay is still bound to the original request, even when terminal-state validation
        // is skipped for a successfully parked proposal.
        if (invocation.requestHash !== requestHash) {
          return yield* requestHashConflict();
        }
        // O90.4: a retried propose request answers the receipt its first attempt committed; it never
        // parks a second proposal and never reaches the owner handler. A carrier without a propose
        // mode cannot own this receipt and needs no mandate adapter to refuse the request.
        if (acceptsParkedProposal && transport.intent === 'propose' && supportsProposal) {
          const parked = yield* findParkedProposal(invocation.actionInvocationId, scope);
          if (Option.isSome(parked)) {
            return { invocation, normalizedPayload, parked, requestHash };
          }
        }
        yield* verifyInvocation(
          invocation,
          requestHash,
          loadRecordedRejectionInScope(scope, invocation.actionInvocationId),
        );
        return { invocation, normalizedPayload, parked: Option.none<ActionProposalAccepted>(), requestHash };
      });

      const prepareInputAndContext = Effect.fn('ActionRuntime.prepareInputAndContext')(
        function* prepareInputAndContextEffect() {
          const { deniedAuditEvidence, mandatePrepared, payload, principal, scope, transport } =
            yield* prepareTrustedInputAndContext();
          const authorizationContext = yield* prepareAuthorizationContext(payload, principal, scope, transport);
          // The original command reader above re-derives every target and applicable field. No
          // scalar mandate target or first record is authority for a complete bulk invocation.
          const { invocation, normalizedPayload, parked, requestHash } = yield* prepareInvocation(
            payload,
            principal,
            transport,
            authorizationContext.actionTarget,
            authorizationContext.governedTransport,
            scope,
          );
          if (Option.isSome(parked)) {
            return { accepted: parked.value, kind: 'parked' } as const;
          }
          return {
            ...authorizationContext,
            deniedAuditEvidence,
            invocation,
            kind: 'run' as const,
            mandatePrepared,
            normalizedPayload,
            payload,
            principal,
            requestHash,
            scope,
            transport,
          };
        },
      );
      const preparedInputAndContext = yield* prepareInputAndContext();
      if (preparedInputAndContext.kind === 'parked') {
        return preparedInputAndContext.accepted;
      }
      const {
        accessAmount,
        accessOwnerFacts,
        accessTarget,
        actionTarget,
        deniedAuditEvidence,
        earlyCompositionRevision,
        frozenOwnerAuthorizationTargets,
        governedTransport,
        intrinsicDependencies,
        invocation,
        legalEntityPermission,
        mandatePrepared,
        normalizedPayload,
        ownerPermissionTargets,
        payload,
        principal,
        requestHash,
        resourcePermissionTarget,
        scope,
        targetSet,
        tenantPermission,
        transport,
      } = preparedInputAndContext;

      /** O80: only an explicit transport intent parks a command; NEEDS_APPROVAL alone never does. */
      const proposeIntent = acceptsParkedProposal && transport.intent === 'propose';
      let targetSetAdmission: ActionTargetSetAdmission | undefined;
      let preflightTargetDecisions: readonly AccessDecision[] = [];
      const preparedAccess = new Map<string, PreparedAccessDecision>();
      let authorizedMandate = mandatePrepared;

      const logPermissionInvocationFailure = Effect.fn('ActionRuntime.logPermissionInvocationFailure')(
        function* logPermissionInvocationFailureEffect(failure: ActionInvocationPersistenceError) {
          yield* logInvocationPersistenceFailure(failure, {
            actionKey: input.registration.descriptor.actionKey,
            correlationId: transport.correlationId,
            invocationId: invocation.actionInvocationId,
          });
        },
      );
      const logPermissionTransactionFailure = Effect.fn('ActionRuntime.logPermissionTransactionFailure')(
        function* logPermissionTransactionFailureEffect(failure: ActionTransactionError) {
          yield* logActionTransactionFailureCause(failure, 'Unexpected permission denial persistence failure', {
            actionKey: input.registration.descriptor.actionKey,
            correlationId: transport.correlationId,
            invocationId: invocation.actionInvocationId,
          });
        },
      );
      const rejectPermission = (failure: ActionPermissionDenied) =>
        repository
          .rejectPermissionDenied(
            invocationScopeExecutor(scope),
            withOptionalProperty(
              {
                actionInvocationId: invocation.actionInvocationId,
                actionKey: input.registration.descriptor.actionKey,
                auditProfile: input.registration.descriptor.auditProfile,
                principal,
                transport: governedTransport,
              },
              deniedAuditEvidence !== undefined,
              'deniedAuditEvidence',
              deniedAuditEvidence,
              {},
            ),
          )
          .pipe(
            Effect.tapErrorTag('ActionInvocationPersistenceError', logPermissionInvocationFailure),
            Effect.tapErrorTag('ActionTransactionError', logPermissionTransactionFailure),
            Effect.flatMap((earlierRejection) =>
              Effect.fail(Option.isSome(earlierRejection) ? recordedRejectionFailure(earlierRejection) : failure),
            ),
          );

      const prepareAuthorizationPreflight = Effect.fn('ActionRuntime.prepareAuthorizationPreflight')(
        function* prepareAuthorizationPreflightEffect() {
          const decision =
            authorizationPreflight === undefined
              ? ({ outcome: 'not_applicable' } as const)
              : yield* authorizationPreflight
                  .prepare({
                    actionInvocationId: invocation.actionInvocationId,
                    actionKey: input.registration.descriptor.actionKey,
                    correlationId: transport.correlationId,
                    payload,
                    principal,
                    scope,
                  })
                  .pipe(Effect.tapError((error) => Effect.logError(error.reason)));
          const permit = decision.outcome === 'allowed' ? decision.permit : undefined;
          if (
            permit !== undefined &&
            (permit.actionInvocationId !== invocation.actionInvocationId ||
              permit.actionKey !== input.registration.descriptor.actionKey ||
              permit.principalId !== principal.principalId)
          ) {
            return yield* permissionUnavailable();
          }
          return { denied: decision.outcome === 'denied', permit };
        },
      );

      const hasPermissionDenial = Effect.fn('ActionRuntime.hasPermissionDenial')(function* hasPermissionDenialEffect(
        preflightDenied: boolean,
      ) {
        const permissionDecision = yield* permission
          .checkActionPermission(
            withOptionalProperty(
              {
                actionKey: input.registration.descriptor.actionKey,
                correlationId: transport.correlationId,
                principalId: principal.principalId,
                tenantId: scope.tenantId,
              },
              scope.legalEntityId !== undefined,
              'legalEntityId',
              scope.legalEntityId,
              {},
            ),
          )
          .pipe(Effect.tapError((error) => Effect.logError(error.reason)));
        const tenantPermissionDecision = yield* checkTenantActionPermission(principal, tenantPermission);
        const legalEntityPermissionDecision = yield* checkActionLegalEntityPermission(scope, legalEntityPermission);
        const resourcePermissionDecision = yield* checkActionResourcePermission(scope, resourcePermissionTarget);
        const ownerPermissionDecision = yield* checkActionOwnerPermissions(scope, ownerPermissionTargets);
        return (
          preflightDenied ||
          permissionDecision === 'denied' ||
          tenantPermissionDecision === 'denied' ||
          legalEntityPermissionDecision === 'denied' ||
          resourcePermissionDecision === 'denied' ||
          ownerPermissionDecision === 'denied'
        );
      });

      /**
       * The one v2 question: this entrypoint's own carrier, decided by the access gate (§3.1).
       *
       * `transaction` is the owner transaction when this question is asked inside one (O75): the gate
       * then proves its answer from that transaction's snapshot and writes its evidence there, instead
       * of opening a second connection a nested transaction cannot use. Preflight and standalone
       * callers leave it out and keep the request's own scoped read.
       */
      const decideInvocationAccess = Effect.fn('ActionRuntime.decideInvocationAccess')(
        function* decideInvocationAccessEffect(question: GateInput, transaction?: CoreTransaction) {
          if (accessDecision === undefined) {
            return seamUnavailable(UNAVAILABLE_AUTHORITY_REASON);
          }
          if (accessDecision.prepare === undefined) {
            // Scripted gates have no remote ports. Live binding always supplies revision preparation.
            return yield* accessDecision.decide(question, transaction);
          }
          const key = computeCanonicalValueHash({
            amount: question.amount,
            carrier: {
              accessActor: question.carrier.accessActor,
              accessDeclaration: question.carrier.accessDeclaration,
              accessWorkload: question.carrier.accessWorkload,
            },
            legalEntityScope: question.legalEntityScope,
            mode: question.mode,
            parentRead: question.parentRead,
            target: question.target,
          });
          if (transaction !== undefined) {
            const prepared = preparedAccess.get(key);
            if (prepared === undefined) {
              return seamUnavailable(UNAVAILABLE_AUTHORITY_REASON);
            }
            const rechecked = yield* Effect.result(prepared.recheck(question.now, transaction));
            return Result.isFailure(rechecked)
              ? attachFailureCause(seamUnavailable(UNAVAILABLE_AUTHORITY_REASON), rechecked.failure)
              : rechecked.success;
          }
          const prepared = yield* Effect.result(accessDecision.prepare(question));
          if (Result.isFailure(prepared)) {
            return attachFailureCause(seamUnavailable(UNAVAILABLE_AUTHORITY_REASON), prepared.failure);
          }
          preparedAccess.set(key, prepared.success);
          return prepared.success.decision;
        },
      );

      const decideAccessThroughGate = Effect.fn('ActionRuntime.decideAccess')(function* decideAccessEffect(
        now: Date,
        transaction?: CoreTransaction,
      ) {
        if (accessDecision === undefined) {
          // No gate in this composition means no protected descriptor can be admitted (fail closed).
          return yield* permissionUnavailable();
        }
        const question = withOptionalProperty(
          withOptionalProperty(
            {
              carrier: declaredCarrier,
              legalEntityScope: input.registration.descriptor.legalEntityScope,
              mode: mandatePrepared === undefined ? ('run' as const) : ('approve' as const),
              now,
              scope,
            },
            Option.isSome(accessTarget),
            'target',
            Option.getOrUndefined(accessTarget),
            {},
          ),
          Option.isSome(accessAmount),
          'amount',
          Option.getOrUndefined(accessAmount),
          {},
        );
        if (targetSet === undefined) {
          return yield* decideInvocationAccess(question, transaction);
        }
        const [firstTarget, ...otherTargets] = targetSet.targets;
        const first = yield* decideInvocationAccess({ ...question, target: firstTarget }, transaction);
        const rest = yield* Effect.forEach(
          otherTargets,
          (target) => decideInvocationAccess({ ...question, target }, transaction),
          { concurrency: 1 },
        );
        if (transaction === undefined) {
          preflightTargetDecisions = Object.freeze([first, ...rest]);
        }
        return conjoinActionTargetDecisions([first, ...rest]);
      });

      const decideFieldWrites = Effect.fn('ActionRuntime.decideFieldWrites')(function* decideFieldWritesEffect(
        now: Date,
        transaction?: CoreTransaction,
      ) {
        const declaration = declaredCarrier.accessDeclaration;
        const groups = declaredCarrier.accessFieldGroups ?? NO_ACCESS_FIELD_GROUPS;
        const decisions: AccessDecision[] = [];
        if (groups.length === 0) {
          return { decisions, outcomes: [] };
        }
        if (accessDecision === undefined || declaration === undefined) {
          return yield* permissionUnavailable();
        }
        const targets = targetSet?.targets ?? [Option.getOrUndefined(accessTarget)];
        const outcomes = yield* Effect.forEach(
          targets,
          (target) =>
            authorizeDeclaredFieldWrites({
              accessDecision: {
                decide: (fieldInput) =>
                  decideInvocationAccess(
                    {
                      ...fieldInput,
                      mode: mandatePrepared === undefined ? 'run' : 'approve',
                    },
                    transaction,
                  ).pipe(
                    Effect.tap((decision) =>
                      Effect.sync(() => {
                        decisions.push(decision);
                      }),
                    ),
                  ),
              },
              declaration,
              groups:
                targetSet === undefined
                  ? groups
                  : groups.filter((group) => writtenFieldPaths(group, payload).length > 0),
              legalEntityScope: declaredCarrier.legalEntityScope,
              now,
              payload,
              scope,
              ...withOptionalProperty(
                {},
                Option.isSome(accessAmount),
                'amount',
                Option.getOrUndefined(accessAmount),
                {},
              ),
              ...withOptionalProperty({}, target !== undefined, 'target', target, {}),
            }),
          { concurrency: 1 },
        );
        return { decisions, outcomes };
      });

      /**
       * The `field_write` groups of this Action (O58, O74): field access rides the Action's own
       * capability, so each group is decided beside it in this same scope — with the record the Action
       * acts on when its declaration is record-scoped, and scope-wide when it is not. A group refuses
       * only a payload that really writes one of its fields; every other field stays writable.
       */
      const authorizeFieldWrites = Effect.fn('ActionRuntime.authorizeFieldWrites')(function* authorizeFieldWritesEffect(
        now: Date,
      ) {
        const { decisions, outcomes } = yield* decideFieldWrites(now);
        if (outcomes.some((authorization) => authorization.outcome === 'unavailable')) {
          // An unreadable field decision is retryable, never a silent allow (O48b).
          return yield* permissionUnavailable();
        }
        const failure = outcomes.find((authorization) => authorization.failure !== undefined)?.failure;
        if (failure !== undefined) {
          return yield* rejectPermission(failure);
        }
        return decisions;
      });

      const decideGoverningReads = (now: Date, transaction?: CoreTransaction) =>
        decideActionGoverningReads({
          decide: (question) => decideInvocationAccess(question, transaction),
          now,
          reference: input.registration.descriptor.accessGoverningRead,
          scope,
          targets: targetSet?.targets ?? Option.toArray(accessTarget),
        });

      const authorizeGoverningReads = Effect.fn('ActionRuntime.authorizeGoverningReads')(
        function* authorizeGoverningReads() {
          if (proposeIntent) {
            return;
          }
          const governingReadDecisions = yield* decideGoverningReads(yield* DateTime.nowAsDate);
          yield* requireAllowedGoverningReads(governingReadDecisions).pipe(
            Effect.catchTag('ActionPermissionDenied', rejectPermission),
          );
          if (targetSetAdmission !== undefined) {
            targetSetAdmission = Object.freeze({
              ...targetSetAdmission,
              decision: conjoinActionTargetDecisions([targetSetAdmission.decision, ...governingReadDecisions]),
              governingReadDecisions: Object.freeze(governingReadDecisions),
            });
          }
        },
      );
      const authorizeMandateExecution = Effect.fn('ActionRuntime.authorizeMandateExecution')(
        function* authorizeMandateExecution() {
          if (mandatePrepared === undefined || mandateDispatch?.authorizeExecution === undefined) {
            return yield* Effect.void;
          }
          authorizedMandate = yield* mandateDispatch
            .authorizeExecution({
              prepared: mandatePrepared,
              registration: input.registration,
              scope,
            })
            .pipe(Effect.catchTag('ActionPermissionDenied', rejectPermission));
          const { executionPreparation } = authorizedMandate;
          if (executionPreparation !== undefined && targetSetAdmission !== undefined) {
            const deadline = yield* actionExecutionDeadlineV2(executionPreparation).pipe(
              Effect.mapError((cause) => attachFailureCause(permissionUnavailable(), cause)),
            );
            const existing = targetSetAdmission.decision.admissionDeadline;
            targetSetAdmission = Object.freeze({
              ...targetSetAdmission,
              decision: {
                ...targetSetAdmission.decision,
                admissionDeadline: existing !== undefined && existing < deadline ? existing : deadline,
              },
            });
          }
          return yield* Effect.void;
        },
      );

      const authorizeThroughGate = Effect.fn('ActionRuntime.authorizeThroughGate')(function* authorizeThroughGateEffect(
        preflightDenied: boolean,
      ) {
        if (preflightDenied) {
          return yield* rejectPermission(permissionDeniedFailure());
        }
        const now = yield* DateTime.nowAsDate;
        const decision = yield* decideAccessThroughGate(now);
        notifyStage('permission_checked');
        if (decision.outcome === 'UNAVAILABLE') {
          // A retryable 503 is not a denial: nothing is recorded and the caller may retry (O48b).
          return yield* permissionUnavailable();
        }
        if (decision.outcome === 'NEEDS_APPROVAL') {
          // O80: only an explicit propose intent on a proposal-supporting declaration parks this command;
          // every other approval requirement stays the ordinary refusal.
          if (proposeIntent && supportsProposal) {
            return yield* Effect.void;
          }
          return yield* rejectPermission(approvalRequiredFailure(decision));
        }
        if (decision.outcome === 'DENIED') {
          return yield* rejectPermission(accessDeniedFailure(decision));
        }
        if (proposeIntent) {
          return yield* rejectPermission(proposeNotRequiredFailure());
        }
        const fieldDecisions = yield* authorizeFieldWrites(now);
        if (targetSet !== undefined) {
          targetSetAdmission = Object.freeze({
            actionInvocationId: invocation.actionInvocationId,
            actionKey: declaredCarrier.actionKey,
            decision: conjoinActionTargetDecisions([decision, ...fieldDecisions]),
            fieldDecisions: Object.freeze(fieldDecisions),
            mode: mandatePrepared === undefined ? ('run' as const) : ('approve' as const),
            requestHash,
            targetDecisions: preflightTargetDecisions,
            targetSet,
          });
        }
        return yield* Effect.void;
      });

      /**
       * The payload-level reduction exemption (O35, O71). Only an Action that declares its own
       * declaration can answer it, and only an exact `true` skips the grant decision; every other
       * payload of the same Action still needs its grant.
       */
      const reducesOwnAuthority =
        usesAccessGate && getActionReducesAuthorityResolver(input.registration)?.(payload) === true;

      const authorizePermissions = Effect.fn('ActionRuntime.authorizePermissions')(
        function* authorizePermissionsEffect() {
          // The trusted context already represents authentication. Authorization
          // uses only the immutable Action key and trusted principal identity.
          notifyStage('authentication_boundary');
          const { denied: preflightDenied, permit: preflightPermit } = yield* prepareAuthorizationPreflight();
          if (usesAccessGate && reducesOwnAuthority) {
            // A payload that only takes the actor's own authority away is never blocked by a grant
            // (O35, O71): the request still authenticated into a resolved scope, its owner preflight
            // still runs, and the act is still recorded by the invocation, audit evidence and outbox.
            if (preflightDenied) {
              return yield* rejectPermission(permissionDeniedFailure());
            }
            if (proposeIntent) {
              // An authority-reducing command never waits for an approval, so there is nothing to park.
              return yield* rejectPermission(proposeNotRequiredFailure());
            }
            notifyStage('permission_checked');
          } else if (usesAccessGate) {
            yield* authorizeThroughGate(preflightDenied);
          } else {
            const permissionDenied = yield* hasPermissionDenial(preflightDenied);
            notifyStage('permission_checked');
            if (permissionDenied) {
              return yield* rejectPermission(permissionDeniedFailure());
            }
          }
          const admission =
            options.applicationComposition !== undefined && options.expectedDeployment !== undefined
              ? yield* loadModuleOperationAdmission(
                  options.applicationComposition,
                  options.expectedDeployment,
                  input.registration,
                  principal,
                  options.ownerRegistration,
                ).pipe(Effect.mapError(unavailableActionComposition))
              : undefined;
          const revision = admission === undefined ? yield* resolveCompositionRevision(principal) : admission.revision;
          if (earlyCompositionRevision !== undefined && earlyCompositionRevision !== revision) {
            return yield* unavailableActionComposition();
          }
          if (admission?.catalog !== undefined) {
            const { catalog } = admission;
            yield* validateBoundOperationOwner(input.registration, catalog, options.ownerRegistration).pipe(
              Effect.mapError(unavailableActionComposition),
            );
          }
          const governingRead = getActionGoverningRead(input.registration.descriptor.accessGoverningRead);
          if (governingRead !== undefined) {
            const registered = yield* Effect.try({
              catch: unavailableActionComposition,
              try: () =>
                options.ownerRegistration !== undefined &&
                getVerticalRuntimeReads(options.ownerRegistration).some((read) => read === governingRead),
            });
            if (!registered || admission?.catalog === undefined) {
              return yield* unavailableActionComposition();
            }
            yield* validateBoundOperationOwner(governingRead, admission.catalog, options.ownerRegistration).pipe(
              Effect.mapError(unavailableActionComposition),
            );
          }
          yield* authorizeGoverningReads();
          yield* authorizeMandateExecution();
          attempt.revision = revision;
          if (preflightPermit !== undefined) {
            yield* withModuleOperationExecution(
              {
                loadCatalog: operationCatalogLoader(operationAuthority, revision),
                ownerRegistration: options.ownerRegistration,
                phase: 'execution',
                registration: input.registration,
                revision,
                scope,
              },
              preflightPermit.consume,
            );
          }
          return revision;
        },
      );

      const preparationPolicies = getActionPreparationPolicies(input.registration);
      const policyInput: ActionPolicyEvaluatorInput<typeof payload> = Object.freeze({
        action: Object.freeze({
          actionKey: input.registration.descriptor.actionKey,
          owningModuleKey: input.registration.descriptor.owningModuleKey,
          schemaVersion: input.registration.descriptor.schemaVersion,
        }),
        payload,
        principal: Object.freeze({ ...principal }),
        target: Object.freeze({ ...actionTarget }),
        transport: Object.freeze(
          withOptionalProperty(
            {
              correlationId: transport.correlationId,
            },
            transport.traceId !== undefined,
            'traceId',
            transport.traceId,
            {},
          ),
        ),
      });
      const evaluateActionPolicy = Effect.fn('ActionRuntime.evaluatePolicy')(function* evaluatePolicy<
        Value,
        Requirements,
      >(
        policy: ActionPolicy<typeof payload, string>,
        evaluate: (
          input: ActionPolicyEvaluatorInput<typeof payload>,
        ) => Effect.Effect<Value, ActionCoreError | DomainErrorSchema['Type'] | PolicyDenied, Requirements>,
        phase: 'preparation' | 'static' = 'static',
      ) {
        const policyExit = yield* Effect.exit(Effect.suspend(() => evaluate(policyInput)));
        if (Exit.isSuccess(policyExit)) {
          return { evidence: policyEvidence(policy), value: policyExit.value };
        }

        const failureReasons = policyExit.cause.reasons.filter(Cause.isFailReason);
        const [failureReason] = failureReasons;
        if (
          failureReasons.length === policyExit.cause.reasons.length &&
          failureReason !== undefined &&
          Schema.is(PolicyDenied)(failureReason.error)
        ) {
          const denial = failureReason.error;
          const earlierRejection = yield* repository
            .finalizePolicyDenial(
              invocationScopeExecutor(scope),
              withOptionalProperty(
                {
                  actionInvocationId: invocation.actionInvocationId,
                  actionKey: input.registration.descriptor.actionKey,
                  auditProfile: input.registration.descriptor.auditProfile,
                  policy: policyEvidence(policy),
                  principal,
                  reasonCode: denial.reasonCode,
                  transport: governedTransport,
                },
                deniedAuditEvidence !== undefined,
                'deniedAuditEvidence',
                deniedAuditEvidence,
                {},
              ),
            )
            .pipe(
              Effect.tapError((error) =>
                logInvocationPersistenceFailure(error, {
                  actionKey: input.registration.descriptor.actionKey,
                  correlationId: transport.correlationId,
                  invocationId: invocation.actionInvocationId,
                  policyKey: policy.policyKey,
                }),
              ),
            );
          if (
            Option.isSome(earlierRejection) &&
            !(
              earlierRejection.value.stage === 'policy' && earlierRejection.value.policyReasonCode === denial.reasonCode
            )
          ) {
            return yield* recordedRejectionFailure(earlierRejection);
          }
          return yield* new ActionPolicyDenied({
            code: 'action_policy_denied',
            policyReasonCode: denial.reasonCode,
            reason: denial.reason,
          });
        }

        if (phase === 'preparation' && policyExit.cause.reasons.every(Cause.isInterruptReason)) {
          return yield* Effect.failCause(
            Cause.fromReasons<never>(policyExit.cause.reasons.filter(Cause.isInterruptReason)),
          );
        }
        if (
          phase === 'preparation' &&
          failureReasons.length === 1 &&
          policyExit.cause.reasons.length === 1 &&
          failureReason !== undefined &&
          !Schema.is(ActionPolicyDenied)(failureReason.error) &&
          (Schema.is(ActionCoreErrorSchema)(failureReason.error) ||
            Schema.is(input.registration.descriptor.domainErrorSchema)(failureReason.error))
        ) {
          return yield* Effect.failCause(Cause.fail(failureReason.error));
        }
        yield* Effect.logError('Unexpected Action Policy evaluation failure', policyExit.cause);
        return yield* new ActionPolicyEvaluationError({
          code: 'action_policy_evaluation_failed',
          reason: 'A required Action Policy could not be evaluated',
        });
      });
      const evaluatePolicies = Effect.fn('ActionRuntime.evaluatePolicies')(function* evaluatePoliciesEffect() {
        notifyStage('policy_boundary');
        const allowedPolicies = yield* Effect.forEach(
          input.registration.descriptor.policies.filter((policy) => !preparationPolicies.includes(policy)),
          (policy) => evaluateActionPolicy(policy, policy.evaluate).pipe(Effect.map(({ evidence }) => evidence)),
          { concurrency: 1 },
        );
        return allowedPolicies;
      });

      const authorizeAndEvaluatePolicies = Effect.fn('ActionRuntime.authorizeAndEvaluatePolicies')(
        function* authorizeAndEvaluatePoliciesEffect() {
          const admittedCompositionRevision = yield* authorizePermissions();
          if (proposeIntent) {
            // A proposal is not an execution: its Policies are evaluated when the mandate runs, and the
            // invocation never enters the running stage.
            return { admittedCompositionRevision, allowedPolicies: [] };
          }
          const allowedPolicies = yield* withModuleOperationExecution(
            {
              loadCatalog: operationCatalogLoader(operationAuthority, admittedCompositionRevision),
              ownerRegistration: options.ownerRegistration,
              phase: 'execution',
              registration: input.registration,
              revision: admittedCompositionRevision,
              scope,
            },
            evaluatePolicies(),
          );
          // Keep the public stage contract stable. The durable status transition happens inside the
          // owner-authorized transaction below, after the transaction-local fence has passed.
          notifyStage('invocation_running');
          return { admittedCompositionRevision, allowedPolicies };
        },
      );
      const { admittedCompositionRevision, allowedPolicies } = yield* authorizeAndEvaluatePolicies();
      const proposalPreparation =
        proposeIntent && mandateDispatch?.prepareProposal !== undefined
          ? yield* mandateDispatch
              .prepareProposal({
                actionInvocationId: invocation.actionInvocationId,
                command: yield* makeActionCommandV2({ payload, registration: input.registration, scope }),
                registration: input.registration,
                scope,
              })
              .pipe(Effect.catchTag('ActionPermissionDenied', rejectPermission))
          : undefined;

      /**
       * A short, composition-admitted SQL snapshot transaction for the owner's staged service
       * preparation (D14). It never returns transaction-bound services, and it refuses remote I/O and
       * a second pooled connection exactly like the owner's own write transaction.
       */
      const preparationTransaction: ActionOwnerTransaction = (snapshot) => {
        const settlement = trackTransactionSettlement();
        return database.executor
          .transaction((transaction) =>
            Effect.gen(function* prepareOwnerSnapshot() {
              const scoped = yield* installScope(transaction, scope, options.databaseIdentities);
              yield* lockCompositionAuthority(transaction, admittedCompositionRevision, 'write').pipe(
                Effect.mapError((cause) =>
                  createActionTransactionErrorWithCause(
                    {
                      code: 'action_transaction_failed',
                      reason: 'The approved Application Composition no longer admits this Action',
                    },
                    cause,
                  ),
                ),
              );
              const { entrypoint } = input.registration.descriptor;
              if (entrypoint.scope === 'tenant') {
                yield* moduleStateGate
                  .recheckWrite(
                    transaction,
                    scope.tenantId,
                    { ...entrypoint, scope: 'tenant' as const },
                    intrinsicDependencies.get(entrypoint.moduleKey),
                  )
                  .pipe(
                    Effect.mapError((cause) =>
                      createActionTransactionErrorWithCause(
                        {
                          code: 'action_transaction_failed',
                          reason: 'The Action owner is no longer writable during preparation',
                        },
                        cause,
                      ),
                    ),
                  );
              }
              return yield* snapshot(scoped);
            }).pipe(insideDatabaseTransaction(input.registration.descriptor.actionKey), settlement.capture),
          )
          .pipe(
            settlement.recover,
            Effect.mapError((cause) =>
              isSqlError(cause)
                ? createActionTransactionErrorWithCause(
                    {
                      code: 'action_transaction_failed',
                      reason: 'The Action preparation snapshot transaction did not complete',
                    },
                    cause,
                  )
                : cause,
            ),
          );
      };
      /**
       * The owner's staged service preparation (D14) runs after authorization and before the business
       * transaction, so its remote grants and owner snapshots never hold the owner's write transaction
       * open. Its factory replaces ordinary acquisition, and a defect stays a handler execution error.
       */
      const prepareActionServices = Effect.fn('ActionRuntime.prepareServices')(function* prepareActionServicesEffect() {
        const prepareServices = resolveServicePreflight(input.registration);
        if (prepareServices === undefined) {
          if (preparationPolicies.length > 0) {
            return yield* new ActionPolicyEvaluationError({
              code: 'action_policy_evaluation_failed',
              reason: 'Required preparation Policies have no registered preparation',
            });
          }
          return resolveServiceFactory(input.registration);
        }
        const startedPolicies = new Set<ActionPolicy<typeof payload, string>>();
        const completedPolicies = new Set<ActionPolicy<typeof payload, string>>();
        const policyFailures: Cause.Cause<ActionCoreError | DomainErrorSchema['Type']>[] = [];
        let preparationOpen = true;
        const evaluatePolicy: ActionPreparationPolicyEvaluator<typeof payload, DomainErrorSchema['Type']> = Effect.fn(
          'ActionRuntime.evaluatePreparationPolicy',
        )(function* evaluatePreparationPolicy<Value, Requirements>(
          policy: ActionPolicy<typeof payload, string>,
          evaluate: (
            input: ActionPolicyEvaluatorInput<typeof payload>,
          ) => Effect.Effect<Value, ActionCoreError | DomainErrorSchema['Type'] | PolicyDenied, Requirements>,
        ) {
          if (!preparationOpen || !preparationPolicies.includes(policy) || startedPolicies.has(policy)) {
            const cause = Cause.fail(
              new ActionPolicyEvaluationError({
                code: 'action_policy_evaluation_failed',
                reason: 'Preparation requires each exact registered Policy once',
              }),
            );
            policyFailures.push(cause);
            return yield* Effect.failCause(cause);
          }
          startedPolicies.add(policy);
          const policyExit = yield* Effect.exit(evaluateActionPolicy(policy, evaluate, 'preparation'));
          if (Exit.isFailure(policyExit)) {
            policyFailures.push(policyExit.cause);
            return yield* Effect.failCause(policyExit.cause);
          }
          completedPolicies.add(policy);
          return policyExit.value.value;
        });
        const preparationExit = yield* Effect.exit(
          withModuleOperationExecution(
            {
              loadCatalog: operationCatalogLoader(operationAuthority, admittedCompositionRevision),
              ownerRegistration: options.ownerRegistration,
              phase: 'execution',
              registration: input.registration,
              revision: admittedCompositionRevision,
              scope,
            },
            Effect.suspend(() =>
              prepareServices(
                payload,
                Object.freeze({
                  actionInvocationId: invocation.actionInvocationId,
                  compositionRevision: admittedCompositionRevision,
                  evaluatePolicy,
                  scope,
                  ...withOptionalProperty(
                    {},
                    targetSetAdmission !== undefined,
                    'targetSetAdmission',
                    targetSetAdmission,
                    {},
                  ),
                  transaction: preparationTransaction,
                }),
              ),
            ),
          ),
        );
        preparationOpen = false;
        const [policyFailure] = policyFailures;
        if (policyFailure !== undefined) {
          // Catching a Policy failure in owner code cannot turn it into admitted authority.
          return yield* Effect.failCause(policyFailure);
        }
        if (Exit.isFailure(preparationExit)) {
          if (
            preparationExit.cause.reasons.every(Cause.isFailReason) ||
            preparationExit.cause.reasons.some(Cause.isInterruptReason)
          ) {
            return yield* Effect.failCause(preparationExit.cause);
          }
          yield* Effect.logError('Unexpected Action service preparation defect', preparationExit.cause);
          return yield* makeHandlerExecutionError();
        }
        if (completedPolicies.size !== preparationPolicies.length) {
          return yield* new ActionPolicyEvaluationError({
            code: 'action_policy_evaluation_failed',
            reason: 'A required registered preparation Policy was not evaluated',
          });
        }
        // Every declared Policy is now accounted for; metadata keeps the original descriptor order.
        allowedPolicies.splice(
          0,
          allowedPolicies.length,
          ...input.registration.descriptor.policies.map(policyEvidence),
        );
        input[actionPreparationObservation]?.publish({
          registration: input.registration,
          value: preparationExit.value[originalActionPreparationFactory] ?? preparationExit.value,
        });
        return preparationExit.value;
      });
      // A proposal parks before any owner command runs, so it acquires no owner services (O85, O90).
      const serviceFactory = proposeIntent ? resolveServiceFactory(input.registration) : yield* prepareActionServices();

      /** The same gate under the shared writer fence: the answer this transaction acts on (R5a-2). */
      const decideAccessInTransaction = Effect.fn('ActionRuntime.decideAccessInTransaction')(
        function* decideAccessInTransactionEffect(transaction: CoreTransaction, now: Date) {
          yield* lockAccessExecutionFence(
            transaction,
            scope,
            input.registration.descriptor.legalEntityScope,
            declaredCarrier.accessDeclaration?.kind === 'admin',
          );
          if (targetSet !== undefined && accessTargetsResolver !== undefined) {
            const currentTargets = yield* resolveActionTargetSet(
              payload,
              scope,
              declaredCarrier.owningModuleKey,
              accessTargetsResolver,
            );
            if (currentTargets.hash !== targetSet.hash) {
              return yield* permissionUnavailable();
            }
          }
          const current = yield* decideAccessThroughGate(now, transaction);
          if (current.outcome === 'UNAVAILABLE') {
            return yield* permissionUnavailable();
          }
          return current;
        },
      );

      /** The same gate, under the shared writer fence, immediately before the owner handler. */
      const recheckAccessInTransaction = Effect.fn('ActionRuntime.recheckAccessInTransaction')(
        function* recheckAccessInTransactionEffect(transaction: CoreTransaction, now: Date) {
          if (!usesAccessGate) {
            return yield* Effect.void;
          }
          if (reducesOwnAuthority) {
            return yield* requireAllowedGoverningReads(yield* decideGoverningReads(now, transaction));
          }
          const current = yield* decideAccessInTransaction(transaction, now);
          if (current.outcome !== 'ALLOWED') {
            return yield* current.outcome === 'NEEDS_APPROVAL'
              ? approvalRequiredFailure(current)
              : accessDeniedFailure(current);
          }
          const { outcomes } = yield* decideFieldWrites(now, transaction);
          if (outcomes.some((authorization) => authorization.outcome === 'unavailable')) {
            return yield* permissionUnavailable();
          }
          const failure = outcomes.find((authorization) => authorization.failure !== undefined)?.failure;
          if (failure !== undefined) {
            return yield* failure;
          }
          yield* requireAllowedGoverningReads(yield* decideGoverningReads(now, transaction));
          return yield* Effect.void;
        },
      );

      const claimMandateInTransaction = Effect.fn('ActionRuntime.claimMandateInTransaction')(
        function* claimMandateInTransactionEffect(transaction: CoreTransaction, now: Date) {
          if (authorizedMandate === undefined) {
            return yield* Effect.void;
          }
          if (mandateDispatch === undefined) {
            return yield* permissionUnavailable();
          }
          yield* mandateDispatch.claim({
            actionInvocationId: invocation.actionInvocationId,
            now,
            prepared: authorizedMandate,
            scope,
            transaction,
          });
          return yield* Effect.void;
        },
      );

      /**
       * O75/O90: the propose branch of the owner transaction. The proposal, its frozen command and the
       * invocation's terminal `proposed` receipt commit with the gate's own in-transaction answer, so a
       * rollback leaves nothing parked and the same idempotency key may retry.
       */
      const parkProposalInTransaction = Effect.fn('ActionRuntime.parkProposalInTransaction')(
        function* parkProposalInTransactionEffect(transaction: CoreTransaction, actionInvocationId: string, now: Date) {
          const decision = yield* decideAccessInTransaction(transaction, now);
          if (decision.outcome !== 'NEEDS_APPROVAL') {
            return yield* decision.outcome === 'ALLOWED' ? proposeNotRequiredFailure() : accessDeniedFailure(decision);
          }
          if (mandateDispatch === undefined) {
            return yield* permissionUnavailable();
          }
          const declarationKey = declaredCarrier.accessDeclaration?.key;
          if (declarationKey === undefined) {
            return yield* permissionDeniedFailure();
          }
          const parked = yield* mandateDispatch.parkProposal({
            actionInvocationId,
            actionKey: input.registration.descriptor.actionKey,
            capabilityKey: CapabilityKeySchema.make(declarationKey),
            decision,
            now,
            payload: normalizedPayload,
            ...withOptionalProperty({}, proposalPreparation !== undefined, 'preparation', proposalPreparation, {}),
            scope,
            ...withOptionalProperty(
              {},
              proposalPreparation === undefined && Option.isSome(accessTarget),
              'target',
              accessTarget.pipe(
                Option.map((target) => target.recordKey),
                Option.getOrUndefined,
              ),
              {},
            ),
            transaction,
          });
          return toActionProposalAccepted(parked);
        },
      );

      /** The invocation lock, the recorded-state check, and a retried park's stored answer (O90.4). */
      const lockAndVerifyInvocation = Effect.fn('ActionRuntime.lockAndVerifyInvocation')(
        function* lockAndVerifyInvocationEffect(transaction: CoreTransaction) {
          const lockedInvocation = yield* repository.lockInvocation(transaction, invocation.actionInvocationId).pipe(
            Effect.tapError((error) =>
              logInvocationPersistenceFailure(error, {
                actionKey: input.registration.descriptor.actionKey,
                correlationId: transport.correlationId,
                invocationId: invocation.actionInvocationId,
              }),
            ),
          );
          notifyStage('invocation_locked');
          if (lockedInvocation.requestHash !== requestHash) {
            return yield* requestHashConflict();
          }
          if (proposeIntent && lockedInvocation.status === 'proposed' && lockedInvocation.completedAt !== null) {
            // The request that lost the invocation lock answers its predecessor's receipt instead of
            // parking a second proposal or reaching the owner handler.
            const parked = yield* findParkedProposal(lockedInvocation.actionInvocationId, scope);
            if (Option.isNone(parked)) {
              return yield* permissionUnavailable();
            }
            return { lockedInvocation, parked };
          }
          yield* verifyInvocation(
            lockedInvocation,
            requestHash,
            repository.loadRecordedRejection(transaction, lockedInvocation.actionInvocationId),
          );
          return { lockedInvocation, parked: Option.none<ActionProposalAccepted>() };
        },
      );

      /** The tenant-scope module state recheck the owner write depends on (step 3 of the lifecycle). */
      const recheckModuleStateInTransaction = Effect.fn('ActionRuntime.recheckModuleState')(
        function* recheckModuleStateEffect(transaction: CoreTransaction) {
          const actionEntrypoint = input.registration.descriptor.entrypoint;
          if (actionEntrypoint.scope === 'tenant') {
            const tenantEntrypoint = Object.freeze({
              ...actionEntrypoint,
              scope: 'tenant' as const,
            }) satisfies TenantModuleEntrypoint<'action', 'write', Owner>;
            yield* moduleStateGate.recheckWrite(
              transaction,
              scope.tenantId,
              tenantEntrypoint,
              intrinsicDependencies.get(actionEntrypoint.moduleKey),
            );
          }
          notifyStage('module_state_rechecked');
        },
      );

      /** O75: the mandate receipt commits with the owner success evidence, never after it. */
      const commitMandateInTransaction = Effect.fn('ActionRuntime.commitMandate')(function* commitMandateEffect(
        transaction: CoreTransaction,
        now: Date,
      ) {
        if (authorizedMandate === undefined) {
          return yield* Effect.void;
        }
        if (mandateDispatch === undefined) {
          return yield* permissionUnavailable();
        }
        // The CAS/receipt shares the exact transaction with the owner write and succeeded invocation.
        // A failed claim or CAS rolls everything back; a lost commit acknowledgement is resolved by the
        // same deterministic invocation id, not a second dispatch.
        yield* mandateDispatch.commit({
          actionInvocationId: invocation.actionInvocationId,
          now,
          prepared: authorizedMandate,
          scope,
          transaction,
        });
        return yield* Effect.void;
      });

      const executeTransactionAndHandleExit = Effect.fn('ActionRuntime.executeTransactionAndHandleExit')(
        function* executeTransactionAndHandleExitEffect() {
          const transactionBodyCompleted = yield* Ref.make(false);
          const transactionBodyExit = yield* Ref.make<Exit.Exit<unknown, unknown> | null>(null);
          const transactionProgram: (
            drizzleTransaction: CoreTransaction,
          ) => Effect.Effect<
            ResultSchema['Type'] | ActionProposalAccepted | CommittedActionDomainRejection<DomainErrorSchema['Type']>,
            ActionCoreError | DomainErrorSchema['Type'],
            HandlerRequirements
          > = Effect.fn('ActionRuntime.transaction')(function* executeTransaction(drizzleTransaction: CoreTransaction) {
            const scopedTransaction = yield* installScope(drizzleTransaction, scope, options.databaseIdentities);
            notifyStage('database_scope_installed');
            yield* lockCompositionAuthority(drizzleTransaction, admittedCompositionRevision, 'write').pipe(
              Effect.mapError((cause) =>
                createActionTransactionErrorWithCause(
                  {
                    code: 'action_transaction_failed',
                    reason: 'The approved Application Composition no longer admits owner writes',
                  },
                  cause,
                ),
              ),
            );
            notifyStage('composition_authority_locked');
            const { lockedInvocation, parked } = yield* lockAndVerifyInvocation(drizzleTransaction);
            if (Option.isSome(parked)) {
              yield* Ref.set(transactionBodyCompleted, true);
              return parked.value;
            }
            yield* recheckModuleStateInTransaction(drizzleTransaction);
            const operationAt = yield* trustedTransactionTime(drizzleTransaction);
            const operationDate = DateTime.toDateUtc(operationAt);
            if (proposeIntent) {
              const accepted = yield* parkProposalInTransaction(
                drizzleTransaction,
                lockedInvocation.actionInvocationId,
                operationDate,
              );
              yield* Ref.set(transactionBodyCompleted, true);
              return accepted;
            }
            // R5a-2: access writers cannot take Changing while this shared fence lock is held; a
            // stale preflight ALLOWED never becomes authority for a handler after revocation.
            yield* recheckAccessInTransaction(drizzleTransaction, operationDate);
            yield* claimMandateInTransaction(drizzleTransaction, operationDate);
            const ownerTargets = targetSet?.targets ?? [Option.getOrUndefined(accessTarget)];
            const ownerAuthorizationDecisions = yield* Effect.forEach(
              ownerTargets,
              (ownerTarget) =>
                ownerAuthorizationOverlay.authorize(
                  scopedTransaction,
                  Object.freeze(
                    withOptionalProperty(
                      withOptionalProperty(
                        {
                          capabilityKey:
                            declaredCarrier.accessDeclaration?.key ?? input.registration.descriptor.actionKey,
                          operation: 'action' as const,
                          operationAt,
                          operationKey: input.registration.descriptor.actionKey,
                          owningModuleKey: input.registration.descriptor.owningModuleKey,
                          scope,
                          targets: frozenOwnerAuthorizationTargets,
                        },
                        ownerTarget !== undefined,
                        'target',
                        ownerTarget,
                        {},
                      ),
                      Option.isSome(accessOwnerFacts),
                      'ownerFacts',
                      Option.getOrUndefined(accessOwnerFacts),
                      {},
                    ),
                  ),
                ),
              { concurrency: 1 },
            );
            const ownerAuthorizationDecision = ownerAuthorizationDecisions.includes('unavailable')
              ? 'unavailable'
              : ownerAuthorizationDecisions.find((decision) => decision !== 'allowed');
            if (ownerAuthorizationDecision !== undefined) {
              return yield* ownerAuthorizationFailure(ownerAuthorizationDecision);
            }
            const runningInvocation = yield* repository
              .transitionInvocationToRunning(scopedTransaction, invocation.actionInvocationId)
              .pipe(
                Effect.tapError((error) =>
                  logInvocationPersistenceFailure(error, {
                    actionKey: input.registration.descriptor.actionKey,
                    correlationId: transport.correlationId,
                    invocationId: invocation.actionInvocationId,
                  }),
                ),
              );
            yield* verifyInvocation(
              runningInvocation,
              requestHash,
              repository.loadRecordedRejection(scopedTransaction, runningInvocation.actionInvocationId),
            );
            const services = yield* serviceFactory(scopedTransaction, scope, admittedCompositionRevision);
            const handler = resolveHandler(input.registration);

            const collector = createActionCollector(
              input.registration.descriptor.domainEvents,
              input.registration.descriptor.owningModuleKey,
              input.registration.descriptor.accessEvidencePolicy,
              input.registration.descriptor.auditEvidenceSchema,
              admittedCompositionRevision,
            );
            const handlerContext = Object.freeze({
              actionInvocationId: lockedInvocation.actionInvocationId,
              addDomainEvent: collector.addDomainEvent,
              addOutboxMessage: collector.addOutboxMessage,
              compositionRevision: admittedCompositionRevision,
              recordAuditEvidence: collector.recordAuditEvidence,
              recordDataAccess: collector.recordDataAccess,
              scope,
              services,
            });

            const handlerExit = yield* Effect.exit(Effect.suspend(() => handler(payload, handlerContext)));

            if (Exit.isFailure(handlerExit)) {
              const failureReasons = handlerExit.cause.reasons.filter(Cause.isFailReason);
              const [failureReason] = failureReasons;
              if (failureReasons.length === handlerExit.cause.reasons.length && failureReason !== undefined) {
                if (Schema.is(ActionCollectorError)(failureReason.error)) {
                  return yield* failureReason.error;
                }
                const decodedDomainError = yield* Effect.option(
                  Schema.decodeUnknownEffect(input.registration.descriptor.domainErrorSchema)(failureReason.error),
                );
                if (Option.isSome(decodedDomainError)) {
                  return yield* Effect.fail(decodedDomainError.value);
                }
              }
              yield* Effect.logError('Unexpected Action execution defect', handlerExit.cause);
              return yield* makeHandlerExecutionError();
            }
            notifyStage('handler_executed');

            const handlerValue = handlerExit.value;
            let transactionValue: ResultSchema['Type'] | CommittedActionDomainRejection<DomainErrorSchema['Type']>;
            let resultHash: string;
            if (Schema.is(CommittedActionDomainRejectionSchema)(handlerValue)) {
              // A committed domain rejection is not successful mandate execution: rollback its
              // business transaction instead of consuming the one-use approval on a failed command.
              if (mandatePrepared !== undefined) {
                return yield* transactionFailure();
              }
              const committedDomainError = yield* Schema.encodeUnknownEffect(
                Schema.make<Schema.ConstraintEncoder<unknown>>(input.registration.descriptor.domainErrorSchema.ast),
              )(getCommittedActionDomainError(handlerValue)).pipe(
                Effect.flatMap((encodedDomainError) =>
                  Schema.decodeUnknownEffect(input.registration.descriptor.domainErrorSchema)(encodedDomainError).pipe(
                    Effect.map((domainError) => ({ domainError, encodedDomainError })),
                  ),
                ),
                Effect.tapError((cause) =>
                  Effect.logError('Invalid committed Action domain rejection returned by handler', cause),
                ),
                Effect.mapError((cause) => attachFailureCause(makeHandlerExecutionError(), cause)),
              );
              transactionValue = commitActionThenReject(committedDomainError.domainError);
              resultHash = yield* Effect.try({
                catch: (cause) => attachFailureCause(makeHandlerExecutionError(), cause),
                try: () => computeCanonicalValueHash(committedDomainError.encodedDomainError),
              });
            } else {
              const result = yield* decodeActionResult(input.registration.descriptor.resultSchema, handlerValue);
              transactionValue = result;
              resultHash = yield* Effect.try({
                catch: (cause) =>
                  attachFailureCause(
                    new ActionResultValidationError({
                      code: 'action_result_invalid',
                      reason: 'The decoded Action result cannot be normalized safely',
                    }),
                    cause,
                  ),
                try: () =>
                  computeCanonicalValueHash(
                    Result.getOrThrow(
                      Schema.encodeUnknownResult(
                        Schema.make<Schema.ConstraintEncoder<unknown>>(input.registration.descriptor.resultSchema.ast),
                      )(result),
                    ),
                  ),
              });
              const onDecodedSuccess = getActionDecodedSuccessHook(input.registration);
              if (onDecodedSuccess !== undefined) {
                const hookExit = yield* Effect.exit(
                  Effect.suspend(() =>
                    onDecodedSuccess(
                      Object.freeze({
                        actionInvocationId: lockedInvocation.actionInvocationId,
                        result,
                        scope,
                        services,
                      }),
                    ),
                  ),
                );
                if (Exit.isFailure(hookExit)) {
                  const failureReasons = hookExit.cause.reasons.filter(Cause.isFailReason);
                  const [failureReason] = failureReasons;
                  if (failureReasons.length === hookExit.cause.reasons.length && failureReason !== undefined) {
                    const decodedDomainError = yield* Effect.option(
                      Schema.decodeUnknownEffect(input.registration.descriptor.domainErrorSchema)(failureReason.error),
                    );
                    if (Option.isSome(decodedDomainError)) {
                      return yield* Effect.fail(decodedDomainError.value);
                    }
                    if (Schema.is(ActionCoreErrorSchema)(failureReason.error)) {
                      return yield* Effect.failCause(Cause.fail(failureReason.error));
                    }
                  }
                  yield* Effect.logError('Unexpected Action decoded-success hook defect', hookExit.cause);
                  return yield* makeHandlerExecutionError();
                }
              }
            }
            yield* repository
              .flushSuccess(drizzleTransaction, {
                actionInvocationId: invocation.actionInvocationId,
                actionKey: input.registration.descriptor.actionKey,
                allowedPolicies,
                auditProfile: input.registration.descriptor.auditProfile,
                evidence: collector.snapshot(),
                owningModuleKey: input.registration.descriptor.owningModuleKey,
                principal,
                resultHash,
                transport: governedTransport,
              })
              .pipe(
                Effect.tapError((error) =>
                  logActionTransactionFailureCause(error, 'Unexpected Action success evidence persistence failure', {
                    actionKey: input.registration.descriptor.actionKey,
                    correlationId: transport.correlationId,
                    invocationId: invocation.actionInvocationId,
                  }),
                ),
              );
            notifyStage('success_evidence_flushed');
            yield* commitMandateInTransaction(drizzleTransaction, operationDate);
            yield* Ref.set(transactionBodyCompleted, true);
            return transactionValue;
          });
          // The driver/body stay interruptible; classify the settled Cause before interruption resumes.
          const transactionOutcomeExit = yield* Effect.exit(
            Effect.uninterruptibleMask(
              Effect.fn('ActionRuntime.classifyTransactionOutcome')(function* classifyTransactionOutcome(
                restore: <Value, Failure, Requirements>(
                  effect: Effect.Effect<Value, Failure, Requirements>,
                ) => Effect.Effect<Value, Failure, Requirements>,
              ) {
                const transactionExit = yield* Effect.exit(
                  restore(
                    database.executor.transaction((transaction) =>
                      withModuleOperationExecution(
                        {
                          loadCatalog: operationCatalogLoader(operationAuthority, admittedCompositionRevision),
                          ownerRegistration: options.ownerRegistration,
                          phase: 'execution',
                          registration: input.registration,
                          revision: admittedCompositionRevision,
                          scope,
                        },
                        transactionProgram(transaction).pipe(
                          insideDatabaseTransaction(input.registration.descriptor.actionKey),
                        ),
                      ).pipe(Effect.onExit((exit) => Ref.set(transactionBodyExit, exit))),
                    ),
                  ),
                );
                if (Exit.isSuccess(transactionExit)) {
                  attempt.disposition = 'committed';
                  return transactionExit.value;
                }

                const bodyExit = yield* Ref.get(transactionBodyExit);
                const bodyCompleted =
                  (yield* Ref.get(transactionBodyCompleted)) && bodyExit !== null && Exit.isSuccess(bodyExit);
                const driverSqlFailure = transactionExit.cause.reasons.some((reason) =>
                  Cause.isFailReason(reason)
                    ? isSqlError(reason.error)
                    : Cause.isDieReason(reason) && isSqlError(reason.defect),
                );
                attempt.disposition =
                  bodyExit !== null && Exit.isFailure(bodyExit) && !driverSqlFailure ? 'uncommitted' : 'indeterminate';
                if (
                  bodyExit !== null &&
                  Exit.isFailure(bodyExit) &&
                  transactionExit.cause.reasons.some((reason) => Cause.isDieReason(reason) && isSqlError(reason.defect))
                ) {
                  yield* Effect.logError('Action body failed before transaction rollback failed', bodyExit.cause);
                }
                return yield* Effect.failCause(
                  Cause.fromReasons(
                    transactionExit.cause.reasons.map((reason) => {
                      if (Cause.isInterruptReason(reason)) {
                        return reason;
                      }
                      const failure = Cause.isFailReason(reason) ? reason.error : reason.defect;
                      if (!isSqlError(failure)) {
                        return reason;
                      }
                      return Cause.makeFailReason(
                        bodyCompleted && isCommitAcknowledgementFailure(failure)
                          ? new ActionCommitIndeterminate({
                              code: 'action_commit_indeterminate',
                              invocationId: invocation.actionInvocationId,
                              reason: 'The database did not confirm whether the Action commit completed',
                            })
                          : transactionFailure(),
                      );
                    }),
                  ),
                );
              }),
            ),
          );
          if (Exit.isFailure(transactionOutcomeExit)) {
            const ownerDenied = transactionOutcomeExit.cause.reasons.some(
              (reason) => Cause.isFailReason(reason) && Schema.is(ActionPermissionDenied)(reason.error),
            );
            if (ownerDenied) {
              return yield* rejectPermission(permissionDeniedFailure());
            }
            return yield* Effect.failCause(transactionOutcomeExit.cause);
          }
          const transactionResult = transactionOutcomeExit.value;
          if (Schema.is(ActionProposalAcceptedSchema)(transactionResult)) {
            // O85: the parked proposal is a successful 202 body, never a domain result.
            return transactionResult;
          }
          if (Schema.is(CommittedActionDomainRejectionSchema)(transactionResult)) {
            attempt.committedRejection = getCommittedActionDomainError<DomainErrorSchema['Type']>(transactionResult);
            return yield* Effect.fail(attempt.committedRejection);
          }
          return transactionResult;
        },
      );
      return yield* executeTransactionAndHandleExit();
    });
    const classifyAttemptOutcome = Effect.fn('ActionRuntime.classifyPostAttemptOutcome')(
      function* classifyPostAttemptOutcome(
        executionExit: Exit.Exit<
          Effect.Success<ReturnType<typeof executeAttempt>>,
          Effect.Error<ReturnType<typeof executeAttempt>>
        >,
      ) {
        let outcome: ActionPostAttemptOutcome<ResultSchema['Type'], DomainErrorSchema['Type']>;
        if (Exit.isSuccess(executionExit)) {
          const result = freezeActionPostAttemptValue(
            yield* decodeActionResult(input.registration.descriptor.resultSchema, executionExit.value),
          );
          outcome = Object.freeze({ _tag: 'Committed', result });
        } else if (attempt.committedRejection !== undefined) {
          outcome = Object.freeze({ _tag: 'CommittedRejection', rejection: attempt.committedRejection });
        } else if (executionExit.cause.reasons.some(Cause.isInterruptReason)) {
          outcome = Object.freeze({ _tag: 'Interrupted' });
        } else if (
          executionExit.cause.reasons.some(
            (reason) => Cause.isFailReason(reason) && Schema.is(ActionAlreadyCommitted)(reason.error),
          )
        ) {
          outcome = Object.freeze({ _tag: 'AlreadyCommitted' });
        } else if (
          attempt.disposition === 'indeterminate' ||
          attempt.disposition === 'committed' ||
          executionExit.cause.reasons.some(
            (reason) => Cause.isFailReason(reason) && Schema.is(ActionCommitIndeterminate)(reason.error),
          )
        ) {
          outcome = Object.freeze({ _tag: 'Indeterminate' });
        } else {
          const [failure] = executionExit.cause.reasons;
          const rejection =
            executionExit.cause.reasons.length === 1 && failure !== undefined && Cause.isFailReason(failure)
              ? yield* Effect.option(
                  Schema.decodeUnknownEffect(input.registration.descriptor.domainErrorSchema)(failure.error),
                )
              : Option.none();
          outcome = Option.isSome(rejection)
            ? Object.freeze({ _tag: 'DefinitelyUncommitted', rejection: rejection.value })
            : Object.freeze({ _tag: 'DefinitelyUncommitted' });
        }

        return outcome;
      },
    );
    const failSettlement = Effect.fn('ActionRuntime.failPostAttemptSettlement')(function* failPostAttemptSettlement(
      cause: Cause.Cause<ActionCoreError | DomainErrorSchema['Type']>,
    ) {
      if (cause.reasons.some(Cause.isInterruptReason)) {
        return yield* Effect.failCause(cause);
      }
      const [failure] = cause.reasons;
      if (cause.reasons.length === 1 && failure !== undefined && Cause.isFailReason(failure)) {
        const domainFailure = yield* Effect.option(
          Schema.decodeUnknownEffect(input.registration.descriptor.domainErrorSchema)(failure.error),
        );
        if (Option.isSome(domainFailure)) {
          return yield* Effect.fail(domainFailure.value);
        }
        if (Schema.is(ActionCoreErrorSchema)(failure.error)) {
          return yield* Effect.failCause(cause);
        }
      }
      yield* Effect.logError('Unexpected Action post-attempt hook failure', cause);
      return yield* makeHandlerExecutionError();
    });
    const confirmOriginalRecovery = Effect.fn('ActionRuntime.confirmOriginalRecovery')(
      function* confirmOriginalRecovery(
        result: ResultSchema['Type'],
        original: ActionAttemptOriginal<PayloadSchema['Type']>,
        recoverable: boolean,
      ) {
        if (!recoverable) {
          return yield* makeHandlerExecutionError();
        }
        const resolved = yield* Effect.option(
          repository.resolveInvocation(invocationScopeExecutor(original.scope), {
            invocationId: original.invocationId,
            principal: original.principal,
          }),
        );
        if (
          Option.isNone(resolved) ||
          resolved.value.actionInvocationId !== original.invocationId ||
          resolved.value.requestHash !== original.requestHash ||
          resolved.value.status !== 'succeeded'
        ) {
          return yield* new ActionCommitIndeterminate({
            code: 'action_commit_indeterminate',
            invocationId: original.invocationId,
            reason: 'The original Action commit could not be confirmed',
          });
        }
        return result;
      },
    );
    if (postAttemptHook === undefined) {
      return yield* executeAttempt();
    }
    return yield* Effect.uninterruptibleMask(
      Effect.fn('ActionRuntime.settleActionAttempt')(function* settleActionAttempt(
        restore: <Value, Failure, Requirements>(
          effect: Effect.Effect<Value, Failure, Requirements>,
        ) => Effect.Effect<Value, Failure, Requirements>,
      ) {
        const executionExit = yield* Effect.exit(restore(executeAttempt()));
        const { original } = attempt;
        // A parked proposal ran no owner command, so there is no attempt for the owner to settle (O85).
        if (
          original === undefined ||
          (Exit.isSuccess(executionExit) && Schema.is(ActionProposalAcceptedSchema)(executionExit.value))
        ) {
          return yield* executionExit;
        }
        const outcome = yield* classifyAttemptOutcome(executionExit);
        const mode = Match.value(outcome).pipe(
          Match.tags({
            AlreadyCommitted: () => ({ interrupted: false, phase: 'recovery' as const, recoverable: true }),
            Committed: () => ({ interrupted: false, phase: 'settlement' as const, recoverable: false }),
            CommittedRejection: () => ({ interrupted: false, phase: 'settlement' as const, recoverable: false }),
            DefinitelyUncommitted: () => ({ interrupted: false, phase: 'settlement' as const, recoverable: false }),
            Indeterminate: () => ({ interrupted: false, phase: 'recovery' as const, recoverable: true }),
            Interrupted: () => ({ interrupted: true, phase: 'settlement' as const, recoverable: false }),
          }),
          Match.exhaustive,
        );
        let { revision } = attempt;
        if (revision === undefined) {
          if (options.applicationComposition !== undefined && options.expectedDeployment !== undefined) {
            const admission = yield* loadModuleOperationAdmission(
              options.applicationComposition,
              options.expectedDeployment,
              input.registration,
              original.principal,
            ).pipe(Effect.mapError(unavailableActionComposition));
            if (admission.catalog !== undefined) {
              yield* validateBoundOperationOwner(input.registration, admission.catalog, options.ownerRegistration).pipe(
                Effect.mapError(unavailableActionComposition),
              );
            }
            ({ revision } = admission);
          } else {
            revision = yield* resolveCompositionRevision(original.principal);
          }
        }
        const settlementExit = yield* Effect.exit(
          withModuleOperationExecution(
            {
              loadCatalog: operationCatalogLoader(operationAuthority, revision),
              ownerRegistration: options.ownerRegistration,
              phase: mode.phase,
              registration: input.registration,
              revision,
              scope: original.scope,
            },
            Effect.suspend(() =>
              postAttemptHook(
                Object.freeze({
                  actionInvocationId: original.invocationId,
                  compositionRevision: revision,
                  outcome,
                  payload: original.payload,
                  scope: original.scope,
                }),
              ),
            ),
          ),
        );
        if (mode.interrupted) {
          return yield* executionExit;
        }
        if (Exit.isFailure(settlementExit)) {
          return yield* failSettlement(settlementExit.cause);
        }
        const settlement = yield* decodeActionPostAttemptResult(
          input.registration.descriptor.resultSchema,
          settlementExit.value,
        ).pipe(Effect.mapError((cause) => attachFailureCause(makeHandlerExecutionError(), cause)));
        return yield* Match.value(settlement).pipe(
          Match.tags({
            Recovered: ({ result }) => confirmOriginalRecovery(result, original, mode.recoverable),
            Settled: () => executionExit,
          }),
          Match.exhaustive,
        );
      }),
    );
  });

  /**
   * The one runner (O85): a parked 202 leaves this entry point only when the transport declared the
   * success contract that carries it, and a `propose` intent is refused otherwise inside the program
   * before anything is written.
   */
  const runAction: ActionRuntimeService['runAction'] = (input) =>
    withoutModuleOperationExecution(runActionBoundary(input));

  /**
   * Exact caller-owned execution state. A caller that only knows the original key resolves through the
   * same exact tenant, company and caller ownership; only a `COMMITTED` invocation names its Action key.
   */
  const resolveActionExecution: ActionRuntimeService['resolveActionExecution'] = Effect.fn(
    'ActionRuntime.resolveActionExecution',
  )(function* resolveActionExecutionEffect(input: ResolveActionExecutionInput) {
    const { expectedRequestHash, ...lookupInput } = input;
    if (expectedRequestHash !== undefined && !Schema.is(ExpectedActionRequestHashSchema)(expectedRequestHash)) {
      return yield* actionRequestMismatch();
    }
    const principal = yield* validatePrincipal(input.principal);
    const identity = yield* Schema.decodeUnknownEffect(ActionCommitIdentitySchema)(lookupInput).pipe(
      Effect.mapError((cause) =>
        attachFailureCause(
          new ActionPayloadValidationError({
            code: 'action_payload_invalid',
            reason: 'The Action execution lookup identity is invalid',
          }),
          cause,
        ),
      ),
    );
    const invocation = yield* repository
      .resolveInvocation(
        invocationScopeExecutor(preserveSystemPrincipalContextTrust(principal, { ...principal, correlationId: '' })),
        { ...identity, principal },
      )
      .pipe(
        Effect.asSome,
        Effect.catchTag('ActionInvocationNotFound', () => Effect.succeedNone),
      );
    if (
      expectedRequestHash !== undefined &&
      (Option.isNone(invocation) || invocation.value.requestHash !== expectedRequestHash)
    ) {
      return yield* actionRequestMismatch();
    }
    if (Option.isNone(invocation)) {
      return { retryCommand: true, state: 'NOT_STARTED' } as const;
    }
    const record = invocation.value;
    const invocationId = ActionInvocationIdSchema.make(record.actionInvocationId);
    if (record.status === 'succeeded') {
      return {
        actionKey: ActionCommitActionKeySchema.make(record.actionKey),
        invocationId,
        retryCommand: false,
        state: 'COMMITTED',
      } as const;
    }
    if (record.status === 'received' && record.completedAt === null) {
      return { invocationId, retryCommand: true, state: 'RETRYABLE' } as const;
    }
    if ((record.status === 'running' || record.status === 'indeterminate') && record.completedAt === null) {
      return { invocationId, retryCommand: false, state: 'RUNNING' } as const;
    }
    return { invocationId, retryCommand: false, state: 'REJECTED' } as const;
  });

  const resolveActionCommit: ActionRuntimeService['resolveActionCommit'] = Effect.fn(
    'ActionRuntime.resolveActionCommit',
  )(function* resolveActionCommitEffect(input: ResolveActionCommitInput) {
    const principal = yield* validatePrincipal(input.principal);
    const identity = yield* Schema.decodeUnknownEffect(ActionCommitIdentitySchema)(input).pipe(
      Effect.mapError((cause) =>
        attachFailureCause(
          new ActionPayloadValidationError({
            code: 'action_payload_invalid',
            reason: 'The Action commit lookup identity is invalid',
          }),
          cause,
        ),
      ),
    );
    const requestedInvocationId = 'invocationId' in identity ? identity.invocationId : undefined;
    const invocation = yield* repository
      .resolveInvocation(
        invocationScopeExecutor(preserveSystemPrincipalContextTrust(principal, { ...principal, correlationId: '' })),
        { ...identity, principal },
      )
      .pipe(
        Effect.tapError((error) =>
          Schema.is(ActionInvocationPersistenceError)(error)
            ? logInvocationPersistenceFailure(
                error,
                withOptionalProperty(
                  { principalId: principal.principalId, tenantId: principal.tenantId },
                  requestedInvocationId !== undefined,
                  'invocationId',
                  requestedInvocationId,
                  {},
                ),
              )
            : Effect.void,
        ),
        Effect.mapError((error) =>
          Schema.is(ActionInvocationPersistenceError)(error) && requestedInvocationId !== undefined
            ? new ActionCommitIndeterminate({
                code: 'action_commit_indeterminate',
                invocationId: requestedInvocationId,
                reason: 'The database cannot confirm the Action commit state yet',
              })
            : error,
        ),
      );

    if (invocation.status === 'succeeded') {
      return yield* alreadyCommitted(invocation.actionInvocationId);
    }
    if (
      (invocation.status === 'received' || invocation.status === 'running' || invocation.status === 'indeterminate') &&
      invocation.completedAt === null
    ) {
      return Object.freeze({
        _tag: 'ActionCommitOpen',
        invocationId: ActionInvocationIdSchema.make(invocation.actionInvocationId),
      }) satisfies ActionCommitOpen;
    }
    return yield* new ActionInvocationStateError({
      code: 'action_invocation_state_invalid',
      reason: 'This Action invocation has a terminal non-committed state',
    });
  });

  return Object.freeze({ resolveActionCommit, resolveActionExecution, runAction });
};

export class ActionRuntime extends Context.Service<ActionRuntime, ActionRuntimeService>()(
  '@app/core-runtime/actions/runtime/ActionRuntime',
) {}

export const makeActionRuntimeLive = (
  expectedDeployment: typeof OntosDeploymentIdentitySchema.Type,
  ownerRegistration?: VerticalRuntimeRegistration,
) =>
  Layer.merge(
    Layer.effect(
      ActionRuntime,
      Effect.gen(function* makeActionRuntimeService() {
        const databaseIdentities = yield* DatabaseIdentityEnrollmentContext;
        const applicationComposition = yield* ActiveApplicationCompositionService;
        const ownerAuthorizationOverlay = yield* Effect.serviceOption(OwnerAuthorizationOverlay);
        const authorizationPreflight = yield* Effect.serviceOption(ActionAuthorizationPreflight);
        const mandateDispatcher = yield* Effect.serviceOption(ActionMandateDispatcher);
        const [
          database,
          repository,
          permission,
          moduleEntrypointGateway,
          moduleStateGate,
          scopeResolver,
          contextAccess,
        ] = yield* Effect.all(
          [
            CoreDatabaseService,
            ActionRepository,
            ActionPermission,
            ModuleEntrypointGateway,
            ModuleStateGate,
            OperationalScopeResolver,
            ContextAccess,
          ] as const,
          { concurrency: 7 },
        );
        const accessDecision = yield* bindLiveActionAccessGate;
        let runtimeOptions: ActionRuntimeOptions = {
          accessDecision,
          applicationComposition,
          contextAccess,
          databaseIdentities,
          expectedDeployment,
          moduleEntrypointGateway,
          moduleStateGate,
          ownerAuthorizationOverlay: Option.isSome(ownerAuthorizationOverlay)
            ? ownerAuthorizationOverlay.value
            : failClosedOwnerAuthorizationOverlay,
          resolveCompositionRevision: makeActionCompositionRevisionResolver(applicationComposition, expectedDeployment),
        };
        if (ownerRegistration !== undefined) {
          runtimeOptions = { ...runtimeOptions, ownerRegistration };
        }
        if (Option.isSome(authorizationPreflight)) {
          runtimeOptions = { ...runtimeOptions, authorizationPreflight: authorizationPreflight.value };
        }
        if (Option.isSome(mandateDispatcher)) {
          runtimeOptions = { ...runtimeOptions, mandateDispatch: mandateDispatcher.value };
        }
        return makeActionRuntime(database, repository, permission, scopeResolver, runtimeOptions);
      }),
    ),
    // The owner's own module credential: in a host that serves several owners, the handlers this runtime serves
    // read only the key the host handed this deployment, never the shared environment.
    moduleCredentialOverlay(expectedDeployment.appId),
  );

export const runAction = <
  PayloadSchema extends Schema.ConstraintDecoder<unknown>,
  ResultSchema extends Schema.ConstraintDecoder<unknown>,
  DomainErrorSchema extends Schema.ConstraintDecoder<{ readonly _tag: string }>,
  DomainEvents extends DomainEventContractMap,
  Owner extends string,
  Services,
  HandlerRequirements,
  SuccessContract extends ActionSuccessContract = 'result',
>(
  input: RunActionInput<
    PayloadSchema,
    ResultSchema,
    DomainErrorSchema,
    DomainEvents,
    Owner,
    Services,
    HandlerRequirements,
    SuccessContract
  >,
): Effect.Effect<
  ResultSchema['Type'] | ActionProposalSuccess<SuccessContract>,
  ActionCoreError | DomainErrorSchema['Type'],
  ActionRuntime | HandlerRequirements
> => ActionRuntime.pipe(Effect.flatMap((runtime) => runtime.runAction(input)));

export const resolveActionCommit = (
  input: ResolveActionCommitInput,
): Effect.Effect<
  ActionCommitOpen,
  | ActionAlreadyCommitted
  | ActionCommitIndeterminate
  | ActionInvocationNotFound
  | ActionInvocationPersistenceError
  | ActionInvocationStateError
  | ActionPayloadValidationError
  | ActionTrustedContextValidationError,
  ActionRuntime
> => ActionRuntime.pipe(Effect.flatMap((runtime) => runtime.resolveActionCommit(input)));
