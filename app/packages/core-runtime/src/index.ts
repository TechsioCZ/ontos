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
  LegalEntityContext,
  LegalEntityContextAmbiguousError,
  LegalEntityContextInactiveError,
  LegalEntityContextInvalidError,
  LegalEntityContextLive,
  LegalEntityContextMissingError,
  LegalEntityContextUnavailableError,
  classifyActiveLegalEntities,
  classifySelectedLegalEntity,
  makeLegalEntityContext,
} from './auth/legal-entity-context.ts';
export type {
  LegalEntityContextError,
  LegalEntityContextRecord,
  LegalEntityContextShape,
  SafeLegalEntity,
} from './auth/legal-entity-context.ts';
export { DatabaseConnectionError } from './db/client.ts';
export { CorePersistenceLive } from './runtime-infrastructure.ts';
export {
  DatabaseConfig,
  DatabaseConfigError,
  ROOT_ENV_PATH,
  loadDatabaseConnectionPair,
  loadDatabaseConfig,
  parseDatabaseConnectionPair,
  parseDatabaseConfig,
} from './db/config.ts';
export {
  ACTION_AUTH_METHODS,
  ACTION_INVOCATION_STATUSES,
  CORE_SCHEMA_NAME,
  CORE_TABLE_INVENTORY,
} from './db/schema.ts';
export {
  enableGovernedRls,
  tenantLegalEntityRlsPolicies,
  tenantRlsPolicies,
} from './db/scoped-transaction.ts';
export {
  ContextAccess,
  ContextAccessLive,
  makeContextAccess,
  makeContextAccessLive,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
} from './permissions/context-access.ts';
export type {
  ContextAccessClientFactory,
  ContextAccessDecision,
  ContextAccessResult,
  ContextAccessShape,
  ResourceAccessTarget,
} from './permissions/context-access.ts';
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
  ActionTransportMetadata,
  TrustedPrincipalContext,
} from './actions/context.ts';
export {
  LEGAL_ENTITY_SCOPES,
  OperationalScopeResolver,
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
} from './operations/context.ts';
export type {
  LegalEntityScope,
  OperationalScope,
  OperationalScopeRepository,
  OperationalScopeResolverShape,
  ResolveOperationalScopeInput,
} from './operations/context.ts';
export {
  OperationAuthenticationRequired,
  OperationContextDenied,
  OperationContextInvalid,
  OperationContextUnavailable,
} from './operations/errors.ts';
export type { OperationContextError } from './operations/errors.ts';
export {
  READ_ACCESS_KINDS,
  READ_EVIDENCE_CAPTURE_MODES,
  READ_PERMISSION_TARGETS,
  defineRead,
} from './reads/definition.ts';
export type {
  ReadAccessKind,
  ReadDescriptor,
  ReadEvidenceCaptureMode,
  ReadHandler,
  ReadPermissionDenialStatus,
  ReadPermissionTarget,
  ReadPermissionTargetResolver,
  ReadPolicyDescriptor,
  ReadResultPermissionTargetResolver,
  ReadRegistration,
  ReadServiceFactory,
} from './reads/definition.ts';
export type {
  ReadEvidenceMetadata,
  ReadHandlerContext,
  ReadHandlerResult,
} from './reads/context.ts';
export {
  READ_RUNTIME_STAGES,
  ReadRuntime,
  ReadRuntimeLive,
  makeReadRuntimeLive,
} from './reads/runtime.ts';
export type { ReadRuntimeOptions, ReadRuntimeService, ReadRuntimeStage } from './reads/runtime.ts';
export {
  ReadEvidencePersistenceError,
  ReadEvidenceValidationError,
  ReadHandlerExecutionError,
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  ReadInputValidationError,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
  ReadPolicyDenied,
  ReadPolicyEvaluationError,
  ReadResultValidationError,
} from './reads/errors.ts';
export type { ReadCoreError } from './reads/errors.ts';
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
export {
  MODULE_ENTRYPOINT_ACCESSES,
  MODULE_ENTRYPOINT_ROLES,
  MODULE_ENTRYPOINT_SCOPES,
  ModuleEntrypointAccessSchema,
  ModuleEntrypointRoleSchema,
  ModuleEntrypointSchema,
  ModuleEntrypointScopeSchema,
  defineSystemModuleEntrypoint,
  defineTenantModuleEntrypoint,
} from './modules/module-entrypoint.ts';
export type {
  EntrypointAccessForRole,
  ModuleEntrypointAccess,
  ModuleEntrypointDescriptor,
  ModuleEntrypointRole,
  ModuleEntrypointScope,
  SystemModuleEntrypoint,
  TenantModuleEntrypoint,
} from './modules/module-entrypoint.ts';
export {
  ModuleStateCheckUnavailableError,
  ModuleStateDeniedError,
} from './modules/module-state-gate-errors.ts';
export type { ModuleStateGateError } from './modules/module-state-gate-errors.ts';
export {
  ModuleStateGate,
  ModuleStateGateLive,
  decideModuleStateAccess,
  tenantStatesAllowingAccess,
} from './modules/module-state-gate.ts';
export type { ModuleStateGateShape, ModuleStateSnapshot } from './modules/module-state-gate.ts';
export {
  ModuleEntrypointGateway,
  ModuleEntrypointGatewayLive,
} from './modules/module-entrypoint-gateway.ts';
export type {
  ModuleEntrypointGatewayShape,
  RunGatedModuleEntrypointInput,
} from './modules/module-entrypoint-gateway.ts';
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
  OntosDeploymentAppIdSchema,
  OntosDeploymentIdentitySchema,
  OntosModuleActivationSchema,
  OntosModuleActivationStateSchema,
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
export {
  OntosShellContributionsSchema,
  ShellMediaAttachmentContributionSchema,
  ShellNavigationContributionSchema,
  ShellPageContributionSchema,
  ShellPublicComponentContributionSchema,
  ShellReportContributionSchema,
  ShellResourceDetailContributionSchema,
  ShellSearchContributionSchema,
  ShellTimelineContributionSchema,
  validateShellContributions,
} from './modules/shell-contribution.ts';
export type {
  OntosShellContributions,
  ShellContributionReferenceSets,
} from './modules/shell-contribution.ts';
export type {
  OntosActionContract,
  OntosApiContract,
  OntosAuthoredPublicEvent,
  OntosAuthoredPublicSurface,
  OntosComponentContract,
  OntosDeploymentAppId,
  OntosModuleActivation,
  OntosModuleActivationState,
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
  getVerticalRuntimeEntrypoints,
  getVerticalRuntimeOutboxWorkers,
} from './modules/runtime-registration.ts';
export type {
  VerticalRuntimeRegistration,
  VerticalRuntimeEntrypointBindings,
  VerticalRuntimeEntrypointThunk,
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
