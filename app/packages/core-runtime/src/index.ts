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
  classifyAvailableTenants,
  classifyDefaultPrincipal,
  classifySelectedPrincipal,
  makePrincipalResolver,
} from './auth/principal-resolver.ts';
export type {
  AvailableTenant,
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
export { defineAction, isActionRegistration } from './actions/definition.ts';
export type {
  ActionAuditProfile,
  ActionDescriptor,
  ActionHandler,
  ActionIdempotencyRule,
  ActionRegistration,
  ActionRequirements,
  AnyActionRegistration,
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
export {
  TenantModuleStateConcurrentChangeError,
  TenantModuleStatePersistenceUnavailableError,
  TenantModuleStateReadUnavailableError,
  TenantModuleStateTenantMissingError,
  TenantModuleStateUnchangedError,
  TenantModuleStateUnsupportedChangeSourceError,
  TenantModuleStateDependencyInactiveError,
  TenantModuleStateUnknownModuleError,
  TenantModuleStateUnsupportedStateError,
  TenantModuleStateValidationUnavailableError,
} from './modules/tenant-module-state-errors.ts';
export type { TenantModuleStateTransitionError } from './modules/tenant-module-state-errors.ts';
export {
  ActiveTenantModuleSchema,
  TENANT_MODULE_STATES,
  TenantModuleStateSchema,
  TenantModuleStateRecordSchema,
  TenantModuleStateService,
  TenantModuleStateServiceLive,
  makeTenantModuleStateService,
  validateTenantModuleStateTransition,
} from './modules/tenant-module-state-service.ts';
export type {
  ActiveTenantModule,
  TenantModuleState,
  TenantModuleStateRecord,
  TenantModuleStateServiceShape,
} from './modules/tenant-module-state-service.ts';
export {
  ONTOS_MODULE_CONTRACT_MAX_BYTES,
  ONTOS_MODULE_CONTRACT_PATH,
  ONTOS_MODULE_CONTRACT_SCHEMA_VERSION,
  ONTOS_MODULE_CONTRACT_TIMEOUT_MS,
  OntosActionContractSchema,
  OntosApiContractSchema,
  OntosComponentContractSchema,
  OntosCoreCapabilitySchema,
  OntosDeploymentAppIdSchema,
  OntosDeploymentIdentitySchema,
  OntosExternalSystemDependencySchema,
  OntosModuleActivationSchema,
  OntosModuleActivationStateSchema,
  OntosModuleDependenciesSchema,
  OntosModuleDependencyModeSchema,
  OntosModuleDependencySchema,
  OntosModuleDeploymentContractSchema,
  OntosModuleIdSchema,
  OntosModuleIdentitySchema,
  OntosModuleKindSchema,
  OntosOutboxSubscriptionContractSchema,
  OntosPublicEventContractSchema,
  OntosReportDescriptorSchema,
  OntosResourceTypeSchema,
  OntosSearchDescriptorSchema,
  OntosSerializedModuleManifestSchema,
  OntosSerializedPublicSurfaceSchema,
  decodeOntosModuleDeploymentContract,
  defineOntosModuleManifest,
} from './modules/manifest.ts';
export type {
  OntosActionContract,
  OntosApiContract,
  OntosAuthoredPublicEvent,
  OntosAuthoredPublicSurface,
  OntosComponentContract,
  OntosCoreCapability,
  OntosDeploymentAppId,
  OntosExternalSystemDependency,
  OntosModuleActivation,
  OntosModuleActivationState,
  OntosModuleDependencies,
  OntosModuleDependency,
  OntosModuleDependencyMode,
  OntosModuleDeploymentContract,
  OntosModuleId,
  OntosModuleIdentity,
  OntosModuleKind,
  OntosManifestActionValue,
  OntosManifestComponentValue,
  OntosModuleManifest,
  OntosModuleManifestInput,
  OntosOutboxSubscriptionContract,
  OntosPublicEventContract,
  OntosReportDescriptor,
  OntosResourceType,
  OntosSearchDescriptor,
  OntosSerializedModuleManifest,
} from './modules/manifest.ts';
export {
  OntosModuleCatalogValidationError,
  InstalledModuleCatalogService,
  buildInstalledModuleCatalog,
} from './modules/catalog.ts';
export type {
  InstalledDeploymentContractInput,
  InstalledModuleCatalog,
  InstalledModuleCatalogServiceShape,
} from './modules/catalog.ts';
export {
  defineVerticalRuntimeRegistration,
  extractVerticalRuntimeSafeDescriptors,
  getVerticalRuntimeActions,
  getVerticalRuntimeOutboxWorkers,
} from './modules/runtime-registration.ts';
export type {
  VerticalRuntimeRegistration,
  VerticalRuntimeRegistrationInput,
  VerticalRuntimeSafeDescriptors,
} from './modules/runtime-registration.ts';

// <generated-core-action-exports>
export { changeTenantModuleStateAction } from './modules/actions/change-tenant-module-state.action.ts';
// </generated-core-action-exports>

export { defineOutboxWorker } from './outbox/definition.ts';
export type {
  AnyOutboxWorkerRegistration,
  OutboxWorkerDescriptor,
  OutboxWorkerHandler,
  OutboxWorkerHandlerContext,
  OutboxWorkerRegistration,
  OutboxWorkerRequirements,
  OutboxWorkerRetryPolicy,
  OutboxWorkerSubscription,
} from './outbox/definition.ts';
export {
  OutboxClaimLostError,
  OutboxHandlerExecutionError,
  OutboxModuleStateError,
  OutboxPayloadDecodeError,
  OutboxPollerConfigError,
  OutboxPersistenceError,
  OutboxWorkerDescriptorError,
} from './outbox/errors.ts';
export type { OutboxWorkerError } from './outbox/errors.ts';
export { parseOutboxPollingConfig, runOutboxPollingLoop } from './outbox/poller.ts';
export type {
  OutboxCycleRunner,
  OutboxPollingConfig,
  ParseOutboxPollingConfigInput,
  RunOutboxPollingLoopInput,
} from './outbox/poller.ts';
export {
  OutboxWorkerInfrastructureLive,
  runOutboxWorkerProcess,
  startOutboxWorkerProcess,
} from './outbox/process.ts';
export type {
  RunOutboxWorkerProcessInput,
  StartOutboxWorkerProcessInput,
} from './outbox/process.ts';
export {
  OutboxRuntime,
  OutboxRuntimeLive,
  matchOutboxMessages,
  runOutboxCycle,
} from './outbox/runtime.ts';
export type {
  MatchOutboxMessagesInput,
  OutboxCycleError,
  OutboxCycleResult,
  OutboxMatchResult,
  OutboxRuntimeService,
  RunOutboxCycleInput,
} from './outbox/runtime.ts';

// <generated-global-policy-exports>
// </generated-global-policy-exports>
