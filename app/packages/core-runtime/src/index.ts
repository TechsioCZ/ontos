export { withPostgresSessionAdvisoryLock } from './db/session-advisory-lock.ts';
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
  PrincipalResolverConfiguration,
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
  SupportRecoveryPrincipalContextResolverConfiguration,
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
  PeopleDirectoryInputSchema,
  PeopleDirectoryResultSchema,
  peopleDirectoryRead,
} from './auth/people-directory-read.ts';
export { RoleCatalogResultSchema, roleCatalogRead } from './auth/role-catalog-read.ts';
export { acceptPersonInvitationFromTransaction } from './auth/person-invitation-acceptance.ts';
export { PersonInvitationIdentityProvider } from './auth/person-invitation-identity-provider.ts';
export type {
  PersonInvitationIdentityInput,
  PersonInvitationIdentityWriter,
} from './auth/person-invitation-identity-provider.ts';
export { InvitePersonPayloadSchema, InvitePersonResultSchema } from './auth/person-invitation.ts';
export type { InvitePersonPayload, InvitePersonResult } from './auth/person-invitation.ts';
export { invitePersonAction } from './modules/actions/invite-person.action.ts';
export { identityAdministrationAuditRead } from './auth/identity-administration-audit-read.ts';
export { IdentityAdministrationAuditResultSchema } from './auth/identity-administration-audit-contract.ts';
export {
  IdentityAdministrationDeniedAudit,
  IdentityAdministrationDeniedAuditLive,
} from './auth/identity-administration-audit-denied.ts';
export {
  StaffRoleTemplateAccountProvider,
  StaffRoleTemplateEmailsSchema,
  StaffRoleTemplateAccountsSchema,
} from './auth/staff-role-template-account-provider.ts';
export { staffRoleTemplateBindingsRead } from './auth/staff-role-template-bindings-read.ts';
export { mutateAgentProposalsAction } from './modules/actions/mutate-agent-proposals.action.ts';
export {
  AgentProposalCommandPayloadSchema,
  AgentProposalCommandResultSchema,
} from './auth/agent-proposal-command-contract.ts';
export type {
  AgentProposalCommandPayload,
  AgentProposalCommandResult,
} from './auth/agent-proposal-command-contract.ts';
export { AgentProposalCommandError } from './auth/agent-proposal-command-error.ts';
export {
  AgentProposalCommandPreparation,
  AgentProposalCommandPreparationLive,
  AgentProposalCommandAuthorizationPreflightLive,
} from './auth/agent-proposal-command-preparation.ts';
export { agentProposalQueueRead } from './auth/agent-proposal-queue-read.ts';
export {
  AGENT_PROPOSAL_QUEUE_CANDIDATE_LIMIT,
  AGENT_PROPOSAL_WITHDRAWAL_BATCH_LIMIT,
  AgentProposalCommandRecoverySchema,
  AgentProposalReservationSchema,
  AgentProposalQueueInputSchema,
  AgentProposalQueueModuleReview,
  AgentProposalQueueRequestSchema,
  AgentProposalQueueResultSchema,
  AgentProposalQueueRiskSchema,
  AgentProposalQueueRowSchema,
  AgentProposalQueueStatusSchema,
  AgentProposalQueueVisibilitySchema,
} from './auth/agent-proposal-queue-contract.ts';
export type {
  AgentProposalCommandRecovery,
  AgentProposalReservation,
  AgentProposalQueueInput,
  AgentProposalQueueModuleReviewService,
  AgentProposalQueueRow,
} from './auth/agent-proposal-queue-contract.ts';
export { isConnectionWriteAllowed } from './auth/oauth-connection-scope.ts';
export { OAuthAuthenticationAudit, OAuthAuthenticationAuditLive } from './auth/oauth-authentication-audit.ts';
export { OAuthAuthenticationAuditUnavailable } from './auth/oauth-authentication-audit-unavailable.ts';
export { OAuthConnectionCompanies, OAuthConnectionCompaniesLive } from './auth/oauth-connection-companies.ts';
export { OAuthGrantOwners } from './auth/oauth-grant-owners.ts';
export { OAuthGrantRegistry } from './auth/oauth-grant-registry-service.ts';
export { OAuthGrantRegistryLive } from './auth/oauth-grant-registry-live.ts';
export { OAuthGrantRegistryUnavailable } from './auth/oauth-grant-registry-unavailable.ts';
export { OAuthGrantModulesSchema } from './auth/oauth-grant-registry-contract.ts';
export type { OAuthGrantPrincipal, OAuthGrantRecord } from './auth/oauth-grant-registry-contract.ts';
export {
  OAuthConnectionRevocationNotesInputSchema,
  OAuthConnectionRevocationNotesResultSchema,
  oauthConnectionRevocationNotesRead,
} from './auth/oauth-connection-revocation-notes-read.ts';
// @ontos-codesmith-core-read-exports:start

// @ontos-core-read legal-entity-detail
export { legalEntityDetailRead } from './generated-reads/legal-entity-detail.ts';
// @ontos-codesmith-core-read-exports:end
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
export { databaseRuntime } from '#database-runtime';
export type { DatabaseRuntime } from './db/database-runtime.ts';
export type { DatabaseIdentityConnections } from './db/config.ts';
export {
  BEARER_ASSERTION_ROLE_SETTINGS,
  defineDatabaseIdentityEnrollment,
  DatabaseIdentityEnrollmentError,
  trustRoutinesForIdentities,
  SHARED_RUNTIME_IDENTITY,
  SHELL_GATEWAY_ISSUER_IDENTITY,
} from './db/database-identity-manifest.ts';
export type {
  CloudflareHyperdriveBinding,
  DatabaseAcceptedFinding,
  DatabaseIdentity,
  DatabaseIdentityId,
  DatabaseIdentityEnrollment,
  DatabaseOwnerIdentityDescriptor,
  DatabaseRoleGrants,
  DatabaseScopeAuthority,
  DatabaseSequenceGrant,
  DatabaseTableGrant,
  DatabaseTablePrivilege,
  DatabaseUrlKey,
} from './db/database-identity-manifest.ts';
export {
  DatabaseIdentityEnrollmentContext,
  makeDatabaseIdentityEnrollmentLive,
  databaseIdentityForRole,
  gatewayScopeGrantRoleForAudience,
} from './db/database-identities.ts';
export type { DatabasePoolDeadlines } from './db/pool-configuration.ts';
export { CorePersistenceLive } from './runtime-infrastructure.ts';
export { parseSpiceDbConfig } from './permissions/config.ts';
export {
  DatabaseConfig,
  DatabaseConfigError,
  DatabaseConfigLive,
  ROOT_ENV_PATH,
  loadDatabaseConnectionPair,
  loadDatabaseConfig,
  loadDatabaseIdentityConnections,
  makeDatabaseConfigLive,
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
export {
  gatewayScopedTenantLegalEntityRlsPolicies,
  gatewayScopedTenantRlsPolicies,
  sessionScopedTenantLegalEntityReadRlsPolicy,
  sessionScopedTenantReadRlsPolicy,
  tenantLegalEntityRlsPolicies,
  tenantRlsPolicies,
} from './db/scoped-transaction.ts';
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
export { PersistenceFailure } from './database/persistence-failure.ts';
export { findPostgresFailure, isPostgresUniqueViolation } from './database/postgres-failure.ts';
export type { PostgresFailureMetadata } from './database/postgres-failure.ts';
export {
  ContextAccess,
  ContextAccessLive,
  makeContextAccess,
  makeContextAccessLive,
  RequestPermissionDecisions,
  withRequestPermissionDecisions,
  assortmentPermissionTargetRequiresLegalEntity,
  toAssortmentPermissionAccessKey,
  toAssortmentPermissionAccessObjectId,
  toAssortmentPermissionAccessObjectIdForTargets,
  toBusinessPermissionAccessKey,
  toBusinessPermissionAccessObjectId,
  toContextPermissionAccessKey,
  toContextPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
} from './permissions/context-access.ts';
export { LEGAL_ENTITY_PERMISSION_KEYS, TENANT_PERMISSION_KEYS } from './permissions/context-permissions.ts';
export type {
  AssortmentPermissionAccessTarget,
  AssortmentPermissionAccessTargetWithTrustedStorefront,
  AssortmentPermissionAdmissionSet,
  AssortmentPermissionCode,
  AssortmentPermissionCommercialScope,
  AssortmentPermissionSelector,
  AssortmentPermissionSubject,
  BusinessAccessTarget,
  BusinessPermissionAccessTarget,
  ContextAccessClientFactory,
  ContextAccessDecision,
  ContextAccessResult,
  ContextAccessService,
  ContextPermissionAccessTarget,
  ResourceAccessTarget,
} from './permissions/context-access.ts';
export type { LegalEntityPermissionKey, TenantPermissionKey } from './permissions/context-permissions.ts';
export {
  OwnerAuthorizationDecisionSchema,
  OwnerAuthorizationOverlay,
  OwnerAuthorizationOverlayAllowLive,
  allowOwnerAuthorizationOverlay,
  failClosedOwnerAuthorizationDecision,
  failClosedOwnerAuthorizationOverlay,
  transactionalOwnerAuthorization,
} from './permissions/owner-authorization-overlay.ts';
export type {
  OwnerAuthorizationCheck,
  OwnerAuthorizationDecision,
  OwnerAuthorizationInput,
  OwnerAuthorizationOverlayService,
  OwnerAuthorizationRequest,
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
  activeAssignmentMember,
  AssigneeIneligible,
  AssignablePrincipals,
  AssignablePrincipalsUnavailable,
  loadAssignablePrincipalDirectory,
  loadAssignmentPreflightSnapshot,
  makeAssignablePrincipals,
  readAssignablePrincipals,
  resolveAssignee,
} from './auth/assignable-principals.ts';
export type {
  AssignablePrincipal,
  AssignablePrincipalDirectory,
  AssignmentCompanyScope,
  AssignmentDirectoryMember,
} from './auth/assignable-principals.ts';
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
  ResourceContainmentMutationUnavailable,
  ResourceContainmentRelationshipMutation,
  ResourceContainmentRelationshipMutationLive,
  createResourceContainmentRelationshipMutationClient,
  makeResourceContainmentRelationshipMutation,
  makeResourceContainmentRelationshipMutationLive,
} from './permissions/resource-containment-mutation.ts';
export type {
  ResourceContainmentRelationship,
  ResourceContainmentRelationshipMutationClient,
  ResourceContainmentRelationshipMutationInput,
  ResourceContainmentRelationshipMutationService,
  SpiceDbResourceReference,
} from './permissions/resource-containment-mutation.ts';
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
  defineActionAssortmentPermissions,
  defineActionBusinessPermission,
  defineActionResourcePermission,
  isActionRegistration,
} from './actions/definition.ts';
export type {
  ActionAssortmentPermissionDeclaration,
  ActionAssortmentPermissionTarget,
  ActionAssortmentPermissionTargetResolver,
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
  ActionServiceFactory,
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
export {
  ActionExecutionResolutionSchema,
  ActionRuntime,
  makeActionRuntimeLive,
  resolveActionCommit,
  runAction,
} from './actions/runtime.ts';
export type {
  ActionCommitOpen,
  ActionExecutionResolution,
  ActionRuntimeService,
  ResolveActionCommitInput,
  RunActionInput,
} from './actions/runtime.ts';
export { TrustedCompanyPrincipalContextSchema } from './actions/principal-context.ts';
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
  readVerifiedGatewayCompositionRevision,
  readVerifiedGatewayScopeAssertion,
  trustResolvedSystemPrincipalContext,
  trustVerifiedGatewayPrincipalContext,
} from './auth/system-principal-context-provenance.ts';
export type { GatewayScopeAssertion } from './auth/system-principal-context-provenance.ts';
export {
  GatewayScopeGrantRegistrar,
  GatewayScopeGrantRegistrarLive,
  GatewayScopeGrantUnavailableError,
} from './auth/gateway-scope-grant.ts';
export type { GatewayScopeGrantInput } from './auth/gateway-scope-grant.ts';
export {
  OperationalScopeRepositoryLive,
  OperationalScopeResolver,
  OperationalScopeResolverFromRepositoryLive,
  makeOperationalScopeRepository,
  makeOperationalScopeResolver,
} from './operations/context.ts';
export { LEGAL_ENTITY_SCOPES } from './operations/legal-entity-scope.ts';
export type { LegalEntityScope } from './operations/legal-entity-scope.ts';
export { OperationalScopeRepositoryContext } from './operations/repository-context.ts';
export type {
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
  ReadFinish,
  ReadFinishPipeline,
  ReadLoad,
  ReadLoadPipeline,
  ReadOwnerStages,
  ReadPrepare,
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
export type {
  ReadEvidenceMetadata,
  ReadFinishContext,
  ReadHandlerResult,
  ReadLoadContext,
  ReadOwnerTransaction,
  ReadPrepareContext,
} from './reads/context.ts';
export { IoInsideDatabaseTransaction } from './db/transaction-io-guard.ts';
export type { TransactionIo } from './db/transaction-io-guard.ts';
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
  CoreSearchIngestion,
  CoreSearchIngestionLive,
  CoreSearchIngestionObservationSchema,
  makeCoreSearchIngestion,
} from './search/ingestion.ts';
export type { CoreSearchIngestionObservation, CoreSearchIngestionService } from './search/ingestion.ts';
export {
  CoreSearchIngestionRegistry,
  coreSearchIngestionRegistryLayer,
  defineCoreSearchIngestionRegistrations,
} from './search/ingestion-registry.ts';
export type { CoreSearchIngestionRegistration } from './search/ingestion-registry.ts';
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
  ONTOS_SHELL_CONTRIBUTION_ABI,
  ONTOS_SHELL_RUNTIME_CONTRACT_PATH,
  ApplicationCompositionArtifactReferenceSchema,
  ApplicationCompositionBackendSchema,
  ApplicationCompositionBrowserFederationSchema,
  ApplicationCompositionCloudflareWorkerBackendSchema,
  ApplicationCompositionModuleSchema,
  ApplicationCompositionSchema,
  ApplicationCompositionServerOnlyFederationSchema,
  ApplicationCompositionSingletonSchema,
  ApplicationCompositionValidationError,
  OntosShellRuntimeContractSchema,
  ApplicationCompositionVersionedIdentitySchema,
  canonicalizeApplicationComposition,
  validateApplicationCompositionCandidate,
} from './modules/application-composition.ts';
export type {
  ApplicationComposition,
  ApplicationCompositionBackend,
  ApplicationCompositionBrowserFederation,
  ApplicationCompositionCandidateEvidence,
  ApplicationCompositionModule,
  ApplicationCompositionVersionedIdentity,
  ObservedApplicationCompositionContract,
  ObservedModuleFederationManifest,
  OntosShellRuntimeContract,
} from './modules/application-composition.ts';
export {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
  ActiveApplicationCompositionSnapshotSchema,
  makeActiveApplicationCompositionLayer,
  validateActiveApplicationCompositionSnapshot,
} from './modules/active-application-composition.ts';
export {
  applicationCompositionContentRevision,
  buildApplicationCompositionCatalog,
} from './modules/application-composition-catalog.ts';
export { ActiveApplicationCompositionUnavailableError } from './modules/active-application-composition-errors.ts';
export {
  ApplicationCompositionAuthorityError,
  closeApplicationCompositionDurableAdmission,
  drainApplicationCompositionAuthority,
  isApplicationCompositionWorkDrained,
  isApplicationCompositionDurableWorkDrained,
  lockApplicationCompositionAuthority,
  lockApplicationCompositionPublication,
  markApplicationCompositionMigrationComplete,
  publishApplicationCompositionAuthority,
  resumeApplicationCompositionDurableAdmission,
  sealApplicationCompositionAuthority,
} from './modules/application-composition-authority.ts';
export {
  ACTIVE_APPLICATION_COMPOSITION_EDGE_BINDING,
  ACTIVE_APPLICATION_COMPOSITION_EDGE_KEY,
} from './modules/active-application-composition-edge.ts';
export type {
  ActiveApplicationCompositionServiceContract,
  ActiveApplicationCompositionSnapshot,
} from './modules/active-application-composition.ts';
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
  ONTOS_MODULE_MCP_TOOL_CATALOG_PATH,
  OntosMcpContributionSchema,
  OntosMcpHidden,
  OntosMcpRevisionSchema,
  OntosMcpTextSchema,
  OntosMcpToolCatalogJsonSchema,
  OntosMcpToolCatalogReferenceSchema,
  OntosMcpToolCatalogSchema,
  OntosMcpToolSchema,
  defineOntosMcpContribution,
} from './modules/mcp-contribution.ts';
export type {
  OntosMcpContribution,
  OntosMcpContributionInput,
  OntosMcpRevision,
  OntosMcpText,
  OntosMcpTool,
  OntosMcpToolTextInput,
  OntosMcpWriteInput,
} from './modules/mcp-contribution.ts';
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
  isReservedShellRouteRoot,
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

export { readPrincipalBinding } from './auth/external-identity/read.ts';
export {
  ExternalIdentityAdmission,
  resolveExternalSubject,
  resolveExternalSubjectFromTransaction,
} from './auth/external-identity/resolve.ts';
export type { ResolveExternalSubjectInput, ResolveExternalSubjectResult } from './auth/external-identity/resolve.ts';
export type { ExternalIdentityAdmissionContext } from './auth/external-identity/repository.ts';
export { externalIdentitySubjectForBinding } from './auth/external-identity/repository.ts';

// <generated-core-action-exports>
export { activatePrincipalBindingAction } from './modules/actions/activate-principal-binding.action.ts';
export { bindManagedApiKeyAction } from './modules/actions/bind-managed-api-key.action.ts';
export { bindSelfApiKeyAction } from './modules/actions/bind-self-api-key.action.ts';
export { changePrincipalBindingStatusAction } from './modules/actions/change-principal-binding-status.action.ts';
export { changePrincipalStatusAction } from './modules/actions/change-principal-status.action.ts';
export { changeTenantModuleStateAction } from './modules/actions/change-tenant-module-state.action.ts';
export { configureDemoCompaniesAction } from './modules/actions/configure-demo-companies.action.ts';
export {
  manageDemoAccountAction,
  ManageDemoAccountAuditEvidenceSchema,
  ManageDemoAccountPayloadSchema,
} from './modules/actions/manage-demo-account.action.ts';
export type {
  ManageDemoAccountPayload,
  ManageDemoAccountResult,
} from './modules/actions/manage-demo-account.action.ts';
export { demoAccountObjectIdParts, openDemoAccountGrants } from './install/demo-account-administration.ts';
export type { DemoAccountGrants } from './install/demo-account-administration.ts';
export type { DemoAccountRelationship } from './install/demo-account-administration.ts';
export { openPrincipalOperators, operatorChanges } from './permissions/principal-operators.ts';
export type { PrincipalOperators } from './permissions/principal-operators.ts';
export {
  agentGrantRelationships,
  agentModuleAccessOf,
  isReadPermission,
  relationshipModuleAccess,
} from './install/agent-entity-grants.ts';
export type { AgentGrantAccess, AgentGrantModule, AgentGrantWritePolicy } from './install/agent-entity-grants.ts';
export { createNonHumanPrincipalAction } from './modules/actions/create-non-human-principal.action.ts';
export { recordSupportImpersonationAction } from './modules/actions/record-support-impersonation.action.ts';
export { replaceAgentOperatorsAction } from './modules/actions/replace-agent-operators.action.ts';
export { reservePrincipalBindingAction } from './modules/actions/reserve-principal-binding.action.ts';
export { setCompanyMembershipAction } from './modules/actions/set-company-membership.action.ts';
export { setManagedApiKeyBindingStatusAction } from './modules/actions/set-managed-api-key-binding-status.action.ts';
export { setScopedRoleMembershipAction } from './modules/actions/set-scoped-role-membership.action.ts';
export { setSelfApiKeyBindingStatusAction } from './modules/actions/set-self-api-key-binding-status.action.ts';
// </generated-core-action-exports>

export {
  AgentProfileProjectionSchema,
  DEFAULT_AGENT_PROFILE,
  foldAgentProfiles,
} from './auth/agent-profile-projection.ts';
export type { AgentProfile, AgentProfileAuditRow } from './auth/agent-profile-projection.ts';
export { AgentProfilesInputSchema, AgentProfilesResultSchema, agentProfilesRead } from './auth/agent-profiles-read.ts';
export { agentActivityRead } from './auth/agent-activity-read.ts';
export { agentActivityActorsRead } from './auth/agent-activity-actors-read.ts';
export {
  AgentOperatorCommandSchema,
  CompanyAgentDirectoryInputSchema,
  CompanyAgentDirectoryResultSchema,
  companyAgentDirectoryRead,
} from './auth/company-agent-directory-read.ts';
export {
  ReplaceAgentOperatorsAuditEvidenceSchema,
  ReplaceAgentOperatorsPayloadSchema,
  ReplaceAgentOperatorsResultSchema,
} from './modules/actions/agent-operator-command.ts';
export type {
  AgentOperatorCommand,
  ReplaceAgentOperatorsPayload,
  ReplaceAgentOperatorsResult,
} from './modules/actions/agent-operator-command.ts';

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
  OutboxWorkerDescriptorError,
} from './outbox/errors.ts';
export type { OutboxWorkerHealth, OutboxWorkerHealthServer, OutboxWorkerReadiness } from './outbox/health.ts';
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
export type {
  DefineOutboxWorkerEntryInput,
  OutboxWorkerEntry,
  OutboxWorkerLoopInput,
  RunOutboxWorkerHostInput,
} from './outbox/process.ts';
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

export {
  configureAgentAction,
  ConfigureAgentPayloadSchema,
  ConfigureAgentResultSchema,
  ConfigureAgentAuditEvidenceSchema,
  AgentProfileSchema,
} from './modules/actions/configure-agent.action.ts';
export type { ConfigureAgentPayload } from './modules/actions/configure-agent.action.ts';
export {
  manageAgentStatusAction,
  ManageAgentStatusPayloadSchema,
  ManageAgentStatusResultSchema,
  ManageAgentStatusAuditEvidenceSchema,
} from './modules/actions/manage-agent-status.action.ts';
export type { ManageAgentStatusPayload } from './modules/actions/manage-agent-status.action.ts';
