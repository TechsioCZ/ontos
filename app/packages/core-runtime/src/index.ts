export {
  PrincipalBindingAmbiguousError,
  PrincipalBindingInactiveError,
  PrincipalBindingMissingError,
  PrincipalInactiveError,
  PrincipalResolverUnavailableError,
  TenantInactiveError,
} from './auth/principal-resolver-errors.ts';
export type { PrincipalResolutionError } from './auth/principal-resolver-errors.ts';
export {
  PrincipalResolver,
  PrincipalResolverLive,
  classifyPrincipalResolution,
  makePrincipalResolver,
} from './auth/principal-resolver.ts';
export type {
  PrincipalResolutionRecord,
  PrincipalResolverShape,
  ResolvedPrincipalIdentity,
} from './auth/principal-resolver.ts';
export {
  CoreDatabase,
  CoreDatabaseLive,
  DatabaseConnectionError,
  acquirePoolResource,
  makeCoreDatabase,
} from './db/client.ts';
export {
  DatabaseConfig,
  DatabaseConfigError,
  DatabaseConfigLive,
  ROOT_ENV_PATH,
  loadDatabaseConfig,
  parseDatabaseConfig,
} from './db/config.ts';
export {
  ACTION_AUTH_METHODS,
  ACTION_INVOCATION_STATUSES,
  CORE_SCHEMA_NAME,
  CORE_TABLE_INVENTORY,
  CORE_TABLES,
  actionInvocations,
  coreDatabaseSchema,
} from './db/schema.ts';
export type { CoreDatabaseExecutor, CoreDbExecutor, CoreTransaction } from './db/types.ts';
export { defineAction } from './actions/definition.ts';
export type {
  ActionAuditProfile,
  ActionDescriptor,
  ActionHandler,
  ActionIdempotencyRule,
  ActionRegistration,
} from './actions/definition.ts';
export {
  PolicyDenied,
  defineGlobalPolicy,
  defineMicroverticalPolicy,
  denyPolicy,
} from './actions/policy.ts';
export type {
  ActionPolicy,
  ActionPolicyEvaluator,
  ActionPolicyEvaluatorInput,
  ActionPolicyIdentity,
  ActionPolicyTarget,
  DefineGlobalPolicyInput,
  DefineMicroverticalPolicyInput,
  GlobalActionPolicy,
  MicroverticalActionPolicy,
} from './actions/policy.ts';
export {
  ActionRuntime,
  ActionRuntimeLive,
  resolveActionCommit,
  runAction,
} from './actions/runtime.ts';
export type {
  ActionCommitOpen,
  ActionRuntimeService,
  ResolveActionCommitInput,
  RunActionInput,
} from './actions/runtime.ts';
export { ActionTransportMetadataSchema, TrustedPrincipalContextSchema } from './actions/context.ts';
export type {
  ActionCollectorMethods,
  ActionHandlerContext,
  ActionTransactionExecutor,
  ActionTransportMetadata,
  TrustedPrincipalContext,
} from './actions/context.ts';
export { DataAccessEventSchema, DomainEventSchema, OutboxMessageSchema } from './actions/events.ts';
export type {
  ActionAccessEvidencePolicy,
  DataAccessEvent,
  DataAccessEventInput,
  DeclaredDomainEvent,
  DomainEvent,
  DomainEventContractMap,
  DomainEventReference,
  OutboxMessage,
} from './actions/events.ts';
export {
  ACTION_CORE_ERROR_TAGS,
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
} from './actions/errors.ts';
export type { ActionCoreError } from './actions/errors.ts';
