export {
  ACTION_PROVISIONING_INTENTS,
  ActionExecutionAuthorizationSchema,
  ActionProvisioningIntentSchema,
  AuthenticatedPrincipalAuthorizationSchema,
  CapabilityIssuanceAuthorizationSchema,
  ContextPermissionAuthorizationSchema,
  EntrypointAuthorizationSchema,
  IntentionalPublicAuthorizationSchema,
  OwnerLocalBackgroundAuthorizationSchema,
  decodeEntrypointAuthorization,
} from './authorization/entrypoint-classification.ts';
export {
  AUTHORIZATION_WOULD_DENY_SCHEMA_VERSION,
  decideAuthorizationRollout,
} from './authorization/rollout-decision.ts';
export type {
  AuthorizationDenialReason,
  AuthorizationRolloutDecisionInput,
  AuthorizationRolloutDecisionOptions,
  AuthorizationRolloutMode,
  AuthorizationRolloutRuntimeContract,
  AuthorizationWouldDenyEvent,
} from './authorization/rollout-decision.ts';
export {
  GatewayAssertionRedemptionService,
  GatewayAssertionRedemptionUnavailableError,
  GatewayAssertionReplayError,
} from './auth/gateway-assertion-redemption.ts';
export type {
  GatewayAssertionRedemption,
  GatewayAssertionRedemptionError,
  GatewayAssertionRedemptionInput,
} from './auth/gateway-assertion-redemption.ts';
export type {
  ActionExecutionAuthorization,
  ActionProvisioningIntent,
  EntrypointAuthorization,
} from './authorization/entrypoint-classification.ts';
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
  ProviderSubjectSchema,
  classifyApiKeyPrincipal,
  classifyAvailableTenants,
  classifyDefaultPrincipal,
  classifySelectedPrincipal,
  makePrincipalResolver,
} from './auth/principal-resolver.ts';
export type {
  ApiKeyBindingAdministration,
  AvailableTenant,
  PrincipalResolutionRecord,
  PrincipalResolverService,
  ProviderSubject,
  ResolvedPrincipalIdentity,
} from './auth/principal-resolver.ts';
export {
  SystemPrincipalContextDeniedError,
  SystemPrincipalContextInvalidError,
  SystemPrincipalContextUnavailableError,
  makeSystemPrincipalContextResolver,
  registerSystemWorkload,
} from './auth/system-principal-context.ts';
export {
  SupportRecoveryPrincipalContextDeniedError,
  SupportRecoveryPrincipalContextResolver,
  SupportRecoveryPrincipalContextResolverLive,
  SupportRecoveryPrincipalContextUnavailableError,
  makeSupportRecoveryPrincipalContextResolver,
} from './auth/support-recovery-principal-context.ts';
export type {
  SupportRecoveryPrincipalContextError,
  SupportRecoveryPrincipalContextResolverService,
} from './auth/support-recovery-principal-context.ts';
export type { SystemPrincipalContextError, SystemWorkloadRegistration } from './auth/system-principal-context.ts';
export {
  IdentityLifecycleConflictError,
  IdentityPersistenceUnavailableError,
  IdentityTargetInvalidError,
  PrincipalManagementErrorSchema,
} from './auth/principal-management-errors.ts';
export type { PrincipalManagementError } from './auth/principal-management-errors.ts';
export { managedPrincipalsRead, selfApiKeyBindingsRead } from './auth/principal-administration-reads.ts';
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
  LegalEntityContextService,
  SafeLegalEntity,
} from './auth/legal-entity-context.ts';
export { DatabaseConnectionError } from './db/client.ts';
export { DEFAULT_DATABASE_POOL_DEADLINES, configureDatabasePool } from './db/pool-configuration.ts';
export type { DatabasePoolDeadlines } from './db/pool-configuration.ts';
export { CorePersistenceLive } from './runtime-infrastructure.ts';
export {
  DatabaseConfig,
  DatabaseConfigError,
  DatabaseConfigLive,
  ROOT_ENV_PATH,
  loadDatabaseConnectionPair,
  loadDatabaseConfig,
  parseDatabaseConnectionPair,
  parseDatabaseConfig,
} from './db/config.ts';
export {
  ACTION_AUTH_METHODS,
  ACTION_INVOCATION_STATUSES,
  BINDING_STATUSES,
  BINDING_SUBJECT_TYPES,
  CORE_SCHEMA_NAME,
  CORE_TABLE_INVENTORY,
  PRINCIPAL_KINDS,
  PRINCIPAL_STATUSES,
} from './db/schema.ts';
export type { BindingStatus, BindingSubjectType, PrincipalKind, PrincipalStatus } from './db/schema.ts';
export { tenantLegalEntityRlsPolicies, tenantRlsPolicies } from './db/scoped-transaction.ts';
export type { ScopedTransactionExecutor } from './db/scoped-transaction.ts';
export {
  SCOPED_ROUTINE_INVOCATION_ERROR_CODES,
  SCOPED_ROUTINE_PARAMETER_TYPES,
  ScopedRoutineInvocationError,
  defineScopedRoutine,
  scopedRoutineInvokerFromTransaction,
} from './db/scoped-routine.ts';
export type {
  ScopedRoutineContextParameter,
  ScopedRoutineDefinition,
  ScopedRoutineDefinitionInput,
  ScopedRoutineInputParameter,
  ScopedRoutineInputValues,
  ScopedRoutineInvocationErrorCode,
  ScopedRoutineInvoker,
  ScopedRoutineParameter,
  ScopedRoutineParameterType,
} from './db/scoped-routine.ts';
export {
  DatabaseCommitAcknowledgementAmbiguous,
  DatabaseDriverFailureKindSchema,
  DatabaseDriverFailureSchema,
  DatabaseDriverFailureInputSchema,
  DatabaseDriverUnavailableFailure,
  DatabaseTransactionFailure,
  decodeDatabaseDriverFailure,
  isDatabaseCommitAcknowledgementAmbiguous,
  isDatabaseUnavailableFailure,
} from './database/driver-failure.ts';
export type {
  DatabaseDriverFailure,
  DatabaseDriverFailureInput,
  DatabaseDriverFailureKind,
} from './database/driver-failure.ts';
export { findPostgresFailure } from './database/postgres-failure.ts';
export type { PostgresFailureMetadata } from './database/postgres-failure.ts';
export {
  ContextAccess,
  ContextAccessLive,
  LEGAL_ENTITY_PERMISSION_KEYS,
  TENANT_PERMISSION_KEYS,
  makeContextAccess,
  makeContextAccessLive,
  toBusinessPermissionAccessKey,
  toBusinessPermissionAccessObjectId,
  toContextPermissionAccessKey,
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
} from './permissions/context-access.ts';
export type {
  BusinessAccessTarget,
  BusinessPermissionAccessTarget,
  ContextAccessClientFactory,
  ContextAccessDecision,
  ContextAccessResult,
  ContextAccessService,
  ContextPermissionAccessTarget,
  LegalEntityPermissionKey,
  ResourceAccessTarget,
  TenantPermissionKey,
} from './permissions/context-access.ts';
export {
  OwnerAuthorizationDecisionSchema,
  OwnerAuthorizationOverlay,
  OwnerAuthorizationOverlayAllowLive,
  allowOwnerAuthorizationOverlay,
  failClosedOwnerAuthorizationOverlay,
} from './permissions/owner-authorization-overlay.ts';
export type {
  OwnerAuthorizationDecision,
  OwnerAuthorizationInput,
  OwnerAuthorizationOverlayService,
  OwnerAuthorizationTarget,
} from './permissions/owner-authorization-overlay.ts';
export {
  ActionAuthorizationPreflight,
  ActionAuthorizationPreflightDatabase,
  ActionAuthorizationPreflightDatabaseLive,
  makeActionAuthorizationPreflightPermit,
  unavailableActionAuthorizationPreflight,
} from './permissions/action-authorization-preflight.ts';
export type {
  ActionAuthorizationPreflightDecision,
  ActionAuthorizationPreflightDatabaseService,
  ActionAuthorizationPreflightInput,
  ActionAuthorizationPreflightPermit,
  ActionAuthorizationPreflightService,
  ActionAuthorizationPreflightTransaction,
} from './permissions/action-authorization-preflight.ts';
export {
  BusinessPermissionAuditSensitivitySchema,
  BusinessPermissionCodeSchema,
  BusinessPermissionDescriptorSchema,
  BusinessPermissionScopeKindSchema,
  defineBusinessPermission,
  defineBusinessPermissionCatalog,
  isBusinessPermissionDescriptor,
} from './permissions/business-permission.ts';
export type {
  BusinessPermissionAuditSensitivity,
  BusinessPermissionCatalog,
  BusinessPermissionCode,
  BusinessPermissionDescriptor,
  BusinessPermissionScopeKind,
} from './permissions/business-permission.ts';
export {
  PrincipalEligibility,
  PrincipalEligibilityDecisionSchema,
  PrincipalRefSchema,
  unavailablePrincipalEligibility,
} from './permissions/principal-ref.ts';
export type {
  PrincipalEligibilityDecision,
  PrincipalEligibilityResult,
  PrincipalEligibilityService,
  PrincipalRef,
} from './permissions/principal-ref.ts';
export { PrincipalEligibilityLive, principalEligibilityForTransaction } from './permissions/principal-eligibility.ts';
export {
  AUTHORIZATION_MUTATION_STATES,
  AUTHORIZATION_MUTATION_TRANSITIONS,
  AuthorizationMutationJournal,
  AuthorizationMutationStateSchema,
  canTransitionAuthorizationMutation,
} from './permissions/authorization-mutation.ts';
export type {
  AuthorizationMutationJournalEntry,
  AuthorizationMutationJournalService,
  AuthorizationMutationState,
} from './permissions/authorization-mutation.ts';
export {
  AuthorizationMutationReconciler,
  AuthorizationMutationReconciliationUnavailable,
} from './permissions/authorization-reconciler.ts';
export type {
  AuthorizationMutationReconcilerService,
  AuthorizationMutationReconciliationSummary,
} from './permissions/authorization-reconciler.ts';
export {
  AuthorizationMutationSagaError,
  reconcileCommittedAuthorizationMutation,
} from './permissions/authorization-mutation-saga.ts';
export type {
  AuthorizationMutationSagaErrorCode,
  AuthorizationMutationSagaFinalizer,
  AuthorizationMutationSagaResult,
} from './permissions/authorization-mutation-saga.ts';
export {
  BusinessPermissionMutationUnavailable,
  BusinessPermissionRelationshipMutation,
  BusinessPermissionRelationshipMutationLive,
  createBusinessPermissionRelationshipMutationClient,
  makeBusinessPermissionRelationshipMutation,
  makeBusinessPermissionRelationshipMutationLive,
} from './permissions/business-permission-mutation.ts';
export type {
  BusinessPermissionRelationshipMutationClient,
  BusinessPermissionRelationshipMutationInput,
  BusinessPermissionRelationshipMutationService,
} from './permissions/business-permission-mutation.ts';
export {
  ContextPermissionMutationUnavailable,
  ContextPermissionRelationshipMutation,
  ContextPermissionRelationshipMutationLive,
  createContextPermissionRelationshipMutationClient,
  makeContextPermissionRelationshipMutation,
  makeContextPermissionRelationshipMutationLive,
} from './permissions/context-permission-mutation.ts';
export type {
  ContextPermissionRelationshipMutationClient,
  ContextPermissionRelationshipMutationInput,
  ContextPermissionRelationshipMutationService,
} from './permissions/context-permission-mutation.ts';
export {
  defineAction,
  defineActionBusinessPermission,
  defineActionResourcePermission,
  isActionRegistration,
} from './actions/definition.ts';
export type {
  ActionBusinessPermissionDeclaration,
  ActionBusinessPermissionTarget,
  ActionBusinessPermissionTargetResolver,
  ActionAuditProfile,
  ActionDescriptor,
  ActionDeniedAuditEvidenceDeclaration,
  ActionDeniedAuditEvidenceJsonValue,
  ActionDeniedAuditEvidenceResolver,
  ActionDeniedAuditEvidenceValue,
  ActionHandler,
  ActionIdempotencyRule,
  ActionLegalEntityPermission,
  ActionRegistration,
  ActionResourcePermission,
  ActionResourcePermissionDeclaration,
  ActionResourcePermissionTarget,
  ActionResourcePermissionTargetResolver,
  ActionRequirements,
  ActionTenantPermission,
  AnyActionRegistration,
} from './actions/definition.ts';
export { PolicyDenied, defineGlobalPolicy, defineMicroverticalPolicy, denyPolicy } from './actions/policy.ts';
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
export { ActionRuntime, ActionRuntimeLive, resolveActionCommit, runAction } from './actions/runtime.ts';
export type {
  ActionCommitOpen,
  ActionRuntimeService,
  ResolveActionCommitInput,
  RunActionInput,
} from './actions/runtime.ts';
export {
  ActionTransportMetadataSchema,
  TrustedPrincipalContextSchema,
  commitActionThenReject,
} from './actions/context.ts';
export type {
  ActionCollectorMethods,
  ActionHandlerContext,
  ActionTransportMetadata,
  CommittedActionDomainRejection,
  TrustedPrincipalContext,
} from './actions/context.ts';
export {
  isTrustedSystemPrincipalContext,
  isVerifiedGatewayPrincipalContext,
  trustResolvedSystemPrincipalContext,
  trustVerifiedGatewayPrincipalContext,
} from './auth/system-principal-context-provenance.ts';
export {
  LEGAL_ENTITY_SCOPES,
  OperationalScopeRepositoryLive,
  OperationalScopeResolver,
  OperationalScopeResolverFromRepositoryLive,
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
} from './operations/context.ts';
export { OperationalScopeRepositoryContext } from './operations/repository-context.ts';
export type {
  LegalEntityScope,
  OperationalScope,
  OperationalScopeRepository,
  OperationalScopeRequest,
  OperationalScopeResolverService,
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
  READ_CONDITIONAL_PERMISSION_REQUIREMENTS,
  READ_EVIDENCE_CAPTURE_MODES,
  READ_PERMISSION_TARGETS,
  defineRead,
  defineReadConditionalPermission,
  defineReadResourcePermission,
} from './reads/definition.ts';
export type {
  AlternativeResolvedReadPermissionTarget,
  AtomicResolvedReadPermissionTarget,
  ReadConditionalPermissionBranch,
  ReadConditionalPermissionBranches,
  ReadConditionalPermissionDeclaration,
  ReadConditionalPermissionRequirement,
  ReadAlternativeTenantPermission,
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
  ReadResourcePermissionDeclaration,
  ReadResourcePermissionTarget,
  ReadResourcePermissionTargetResolver,
  ReadServiceFactory,
  ResolvedReadPermissionTarget,
  ResolvedReadConditionalPermissionRequirement,
} from './reads/definition.ts';
export type { ReadEvidenceMetadata, ReadHandlerContext, ReadHandlerResult } from './reads/context.ts';
export { READ_RUNTIME_STAGES, ReadRuntime, ReadRuntimeLive } from './reads/runtime.ts';
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
  ReadCoreErrorSchema,
  isReadCoreError,
} from './reads/errors.ts';
export type { ReadCoreError } from './reads/errors.ts';
export {
  CoreSearchFacetSchema,
  CoreSearchMetadataFieldSchema,
  CoreSearchProjectionDocumentSchema,
  CoreSearchProjectionHitSchema,
  CoreSearchProjectionInvalid,
  CoreSearchProjectionMutationSchema,
  CoreSearchProjectionReplacementSchema,
  CoreSearchProjectionStore,
  CoreSearchProjectionUnavailable,
  CoreSearchQueryRuntime,
  CoreSearchQuerySchema,
  CoreSearchResourceRefSchema,
  CoreSearchTemporalFacetSchema,
  decodeCoreSearchProjectionMutation,
  decodeCoreSearchProjectionReplacement,
  createCoreSearchQueryRuntime,
  makeInMemoryCoreSearchProjectionStore,
} from './search/projection.ts';
export type {
  CoreSearchFacet,
  CoreSearchMetadataField,
  CoreSearchProjectionDocument,
  CoreSearchProjectionHit,
  CoreSearchProjectionStoreService,
  CoreSearchQuery,
  CoreSearchQueryRuntimeService,
  CoreSearchResourceRef,
  CoreSearchTemporalFacet,
  CoreSearchProjectionMutation,
  CoreSearchProjectionReplacement,
} from './search/projection.ts';
export {
  CoreSearchProjectionStoreLive,
  CoreSearchQueryRuntimeLive,
  makePostgresCoreSearchProjectionStore,
} from './search/persistence.ts';
export {
  CORE_SEARCH_INGESTION_REGISTRATIONS,
  CORE_SEARCH_PARTY_LIFECYCLE_TOPICS,
  CORE_SEARCH_PARTY_PROJECTOR_WORKER_KEYS,
  CoreSearchIngestion,
  CoreSearchIngestionLive,
  CoreSearchIngestionObservationSchema,
  makeCoreSearchIngestion,
} from './search/ingestion.ts';
export type {
  CoreSearchIngestionObservation,
  CoreSearchIngestionRegistration,
  CoreSearchIngestionService,
  CoreSearchPartyLifecycleTopic,
  CoreSearchPartyProjectorWorkerKey,
} from './search/ingestion.ts';
export { CoreSearchWorkerSnapshot, CoreSearchWorkerSnapshotLive } from './search/worker-snapshot.ts';
export type {
  CoreSearchSnapshotReadExecutor,
  CoreSearchWorkerSnapshotService,
  CoreSearchWorkerSnapshotView,
} from './search/worker-snapshot.ts';
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
  ONTOS_APPLICATION_COMPOSITION_SCHEMA_VERSION,
  ApplicationCompositionArtifactReferenceSchema,
  ApplicationCompositionModuleSchema,
  ApplicationCompositionSchema,
  ApplicationCompositionSingletonSchema,
  ApplicationCompositionValidationError,
  ApplicationCompositionVersionedIdentitySchema,
  canonicalizeApplicationComposition,
  validateApplicationCompositionCandidate,
} from './modules/application-composition.ts';
export type {
  ApplicationComposition,
  ApplicationCompositionCandidateEvidence,
  ApplicationCompositionModule,
  ApplicationCompositionVersionedIdentity,
  ObservedApplicationCompositionContract,
  ObservedModuleFederationManifest,
} from './modules/application-composition.ts';
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
export { ModuleStateCheckUnavailableError, ModuleStateDeniedError } from './modules/module-state-gate-errors.ts';
export type { ModuleStateGateError } from './modules/module-state-gate-errors.ts';
export {
  ModuleStateGate,
  ModuleStateGateLive,
  decideModuleStateAccess,
  tenantStatesAllowingAccess,
} from './modules/module-state-gate.ts';
export type { ModuleStateGateService, ModuleStateSnapshot } from './modules/module-state-gate.ts';
export { ModuleEntrypointGateway, ModuleEntrypointGatewayLive } from './modules/module-entrypoint-gateway.ts';
export type {
  ModuleEntrypointGatewayService,
  RunGatedModuleEntrypointInput,
} from './modules/module-entrypoint-gateway.ts';
export type {
  ActiveTenantModule,
  TenantModuleState,
  TenantModuleStateRecord,
  TenantModuleStateServiceContract,
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
export type { OntosShellContributions, ShellContributionReferenceSets } from './modules/shell-contribution.ts';
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
  resolveInstalledModuleCatalog,
} from './modules/catalog.ts';
export type {
  InstalledDeploymentContractInput,
  InstalledDeploymentFailureReason,
  InstalledDeploymentResolutionInput,
  InstalledDeploymentStatus,
  InstalledModuleCatalog,
  InstalledModuleCatalogServiceContract,
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

export { coreActionCatalog } from './modules/actions/catalog.ts';
export type { CoreActionDescriptor } from './modules/actions/catalog.ts';
export { ONTOS_SPICEDB_SCHEMA } from './permissions/schema.ts';

// <generated-core-action-exports>
export { bindManagedApiKeyAction } from './modules/actions/bind-managed-api-key.action.ts';
export { bindSelfApiKeyAction } from './modules/actions/bind-self-api-key.action.ts';
export { changePrincipalStatusAction } from './modules/actions/change-principal-status.action.ts';
export { changeTenantModuleStateAction } from './modules/actions/change-tenant-module-state.action.ts';
export { createNonHumanPrincipalAction } from './modules/actions/create-non-human-principal.action.ts';
export { recordSupportImpersonationAction } from './modules/actions/record-support-impersonation.action.ts';
export { setManagedApiKeyBindingStatusAction } from './modules/actions/set-managed-api-key-binding-status.action.ts';
export { setSelfApiKeyBindingStatusAction } from './modules/actions/set-self-api-key-binding-status.action.ts';
// </generated-core-action-exports>

export { defineOutboxWorker, extractOutboxWorkerSubscriptions } from './outbox/definition.ts';
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
  defineOutboxWorkerCompletion,
  OutboxWorkerCompletionPublicationError,
} from './outbox/completion-publication.ts';
export type {
  OutboxWorkerCompletionDefinition,
  OutboxWorkerCompletionInput,
  OutboxWorkerCompletionPublicationResult,
  OutboxWorkerCompletionPublisher,
} from './outbox/completion-publication.ts';
export {
  OutboxClaimLostError,
  OutboxHandlerExecutionError,
  OutboxPayloadDecodeError,
  OutboxPollerConfigError,
  OutboxPersistenceError,
  OutboxWorkerDescriptorError,
} from './outbox/errors.ts';
export type { OutboxWorkerHealth, OutboxWorkerHealthServer } from './outbox/health.ts';
export { parseOutboxPollingConfig, runOutboxPollingLoop } from './outbox/poller.ts';
export type {
  OutboxCycleRunner,
  OutboxPollingConfig,
  ParseOutboxPollingConfigInput,
  RunOutboxPollingLoopInput,
} from './outbox/poller.ts';
export { OutboxRepositoryLive } from './outbox/repository.ts';
export {
  makeOutboxWorkerLegalEntityScopeFanout,
  OutboxWorkerLegalEntityScopeError,
  OutboxWorkerLegalEntityScopeFanout,
  OutboxWorkerLegalEntityScopeFanoutLive,
} from './outbox/legal-entity-scope-fanout.ts';
export type {
  OutboxWorkerLegalEntityScope,
  OutboxWorkerLegalEntityScopeBackend,
  OutboxWorkerLegalEntityScopeFanoutService,
  OutboxWorkerLegalEntityScopeRecord,
} from './outbox/legal-entity-scope-fanout.ts';
export type { RunOutboxWorkerProcessInput, StartOutboxWorkerProcessInput } from './outbox/process.ts';
export { OutboxRuntime, OutboxRuntimeLive, matchOutboxMessages, runOutboxCycle } from './outbox/runtime.ts';
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
