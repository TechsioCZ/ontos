/** Focused server-only entrypoint used to bundle the combined Outbox Worker host and its MicroVertical entries. */
export { SHARED_RUNTIME_IDENTITY } from '../db/database-identity-manifest.ts';
export { databaseRuntime } from '#database-runtime';
export { defineAction, defineActionOwnerPermissions, defineActionResourcePermission } from '../actions/definition.ts';
export { ActionPermissionCheckError, ActionResultValidationError } from '../actions/errors.ts';
export { commitActionThenReject, TrustedPrincipalContextSchema } from '../actions/context.ts';
export { ActionRuntime } from '../actions/runtime.ts';
export { defineMicroverticalPolicy, denyPolicy } from '../actions/policy.ts';
export { decodeAccessDeclarationOrThrow } from '../authorization/access-declaration.ts';
export {
  assertCurrentExternalIdentityBinding,
  CurrentExternalIdentityBindingSchema,
} from '../auth/external-identity/repository.ts';
export {
  isTrustedSystemPrincipalContext,
  isVerifiedGatewayPrincipalContext,
  readVerifiedGatewayActor,
  readVerifiedGatewayCompositionRevision,
  readVerifiedGatewayScopeAssertion,
} from '../auth/system-principal-context-provenance.ts';
export {
  defineRead,
  defineReadConditionalPermission,
  defineReadOwnerPermission,
  defineReadResourcePermission,
} from '../reads/definition.ts';
export { OperationContextUnavailable } from '../operations/operation-context-unavailable.ts';
export { defineVerticalRuntimeRegistration } from '../modules/runtime-registration.ts';
export { ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY } from '../modules/module-dependency-contracts.ts';
export {
  ShellNavigationContributionSchema,
  ShellPageContributionSchema,
  ShellPublicComponentContributionSchema,
  ShellReportContributionSchema,
  ShellSearchContributionSchema,
} from '../modules/shell-contribution.ts';
export { requireModuleOperation } from '../modules/module-operation-requirement.ts';
export {
  ActiveApplicationCompositionConfigLive,
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '../modules/active-application-composition.ts';
export { ApplicationCompositionSchema } from '../modules/application-composition.ts';
export { defineOntosModuleManifest, OntosModuleIdSchema } from '../modules/manifest.ts';
export { defineOntosMcpContribution } from '../modules/mcp-contribution.ts';
export { defineTenantModuleEntrypoint } from '../modules/module-entrypoint.ts';
export { defineScopedRoutine } from '../db/scoped-routine.ts';
export { findPostgresFailure, isPostgresUniqueViolation } from '../database/postgres-failure.ts';
export { DatabaseTransactionFailure, decodeDatabaseDriverFailure } from '../database/driver-failure.ts';
export {
  BusinessPermissionCodeSchema,
  defineBusinessPermission,
  defineBusinessPermissionCatalog,
} from '../permissions/business-permission.ts';
export {
  ContextAccess,
  ContextAccessLive,
  createOwnerPermissionAccessTarget,
  isOwnerPermissionAccessTargetMetadataValid,
  isOwnerPermissionAccessTargetValid,
} from '../permissions/context-access.ts';
export { PrincipalEligibility, PrincipalRefSchema } from '../permissions/principal-ref.ts';
export { humanPrincipalCandidatesForTransaction } from '../permissions/human-principal-candidates.ts';
export {
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
  ReadPermissionUnavailable,
  ReadPolicyDenied,
} from '../reads/errors.ts';
export {
  gatewayScopedTenantLegalEntityRlsPolicies,
  gatewayScopedTenantRlsPolicies,
  sessionScopedTenantLegalEntityReadRlsPolicy,
  sessionScopedTenantReadRlsPolicy,
  tenantLegalEntityRlsPolicies,
  tenantRlsPolicies,
} from '../db/scoped-transaction.ts';
export { DatabaseConfigLive, makeDatabaseConfigLive } from '../db/config.ts';
export { DatabaseIdentityEnrollmentContext, makeDatabaseIdentityEnrollmentLive } from '../db/database-identities.ts';
export { CorePersistenceLive } from '../runtime-infrastructure.ts';
export { CoreSearchIngestion, CoreSearchIngestionLive } from '../search/ingestion.ts';
export {
  coreSearchIngestionRegistryLayer,
  defineCoreSearchIngestionRegistrations,
} from '../search/ingestion-registry.ts';
export { CoreSearchProjectionStoreLive } from '../search/persistence.ts';
export {
  CoreSearchProjectionDocumentSchema,
  CoreSearchProjectionHitSchema,
  CoreSearchProjectionInvalid,
  CoreSearchProjectionMutationSchema,
  CoreSearchProjectionReplacementSchema,
  CoreSearchProjectionStore,
  CoreSearchQueryRuntime,
  CoreSearchResourceRefSchema,
} from '../search/projection.ts';
export { CoreSearchWorkerSnapshot, CoreSearchWorkerSnapshotLive } from '../search/worker-snapshot.ts';
export {
  defineOutboxWorker,
  extractOutboxWorkerSubscriptions,
  isVerifiedOutboxWorkerHandlerContext,
  outboxTerminalFailureFields,
} from './definition.ts';
export { defineOutboxWorkerCompletion, OutboxWorkerCompletionPublicationError } from './completion-publication.ts';
export { defineOutboxWorkerEntry, OutboxWorkerInfrastructureLive, startOutboxWorkerHost } from './process.ts';
export { OutboxRepositoryLive } from './repository.ts';
export {
  makeOutboxWorkerLegalEntityScopeFanout,
  OutboxWorkerLegalEntityScopeError,
  OutboxWorkerLegalEntityScopeFanout,
  OutboxWorkerLegalEntityScopeFanoutLive,
} from './legal-entity-scope-fanout.ts';
export {
  makeOutboxWorkerTenantScope,
  OutboxWorkerTenantScope,
  OutboxWorkerTenantScopeError,
  OutboxWorkerTenantScopeLive,
} from './tenant-scope.ts';
export type { AnyOutboxWorkerRegistration, OutboxWorkerHandlerContext } from './definition.ts';
export type { OutboxWorkerEntry } from './process.ts';
export type {
  OutboxWorkerCompletionDefinition,
  OutboxWorkerCompletionInput,
  OutboxWorkerCompletionPublicationResult,
  OutboxWorkerCompletionPublisher,
} from './completion-publication.ts';
export type {
  OutboxWorkerLegalEntityScope,
  OutboxWorkerLegalEntityScopeBackend,
  OutboxWorkerLegalEntityScopeFanoutService,
  OutboxWorkerLegalEntityScopeRecord,
} from './legal-entity-scope-fanout.ts';
export type {
  OutboxWorkerTenantScopeBackend,
  OutboxWorkerTenantScopeService,
  OutboxWorkerTenantScopeView,
} from './tenant-scope.ts';
export type { CoreSearchIngestionService } from '../search/ingestion.ts';
export type {
  CoreSearchProjectionDocument,
  CoreSearchProjectionMutation,
  CoreSearchProjectionStoreService,
} from '../search/projection.ts';
export type {
  CoreSearchSnapshotReadExecutor,
  CoreSearchWorkerSnapshotService,
  CoreSearchWorkerSnapshotView,
} from '../search/worker-snapshot.ts';

export type { OwnerPermissionAccessTarget, OwnerPermissionContract } from '../permissions/context-access.ts';
