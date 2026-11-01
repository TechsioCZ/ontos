/** Focused server-only entrypoint used to bundle the combined Outbox Worker host and its MicroVertical entries. */
export { defineAction, defineActionBusinessPermission, defineActionResourcePermission } from '../actions/definition.ts';
export { ActionPermissionCheckError } from '../actions/errors.ts';
export { commitActionThenReject } from '../actions/context.ts';
export { defineMicroverticalPolicy, denyPolicy } from '../actions/policy.ts';
export {
  isTrustedSystemPrincipalContext,
  isVerifiedGatewayPrincipalContext,
  readVerifiedGatewayCompositionRevision,
  readVerifiedGatewayScopeAssertion,
} from '../auth/system-principal-context-provenance.ts';
export { defineRead, defineReadConditionalPermission, defineReadResourcePermission } from '../reads/definition.ts';
export { OperationContextUnavailable } from '../operations/operation-context-unavailable.ts';
export { defineVerticalRuntimeRegistration } from '../modules/runtime-registration.ts';
export { ONTOS_MODULE_DEPENDENCY_CONTRACT_CAPABILITY } from '../modules/module-dependency-contracts.ts';
export {
  ShellNavigationContributionSchema,
  ShellPageContributionSchema,
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
export { defineTenantModuleEntrypoint } from '../modules/module-entrypoint.ts';
export { defineScopedRoutine } from '../db/scoped-routine.ts';
export { findPostgresFailure } from '../database/postgres-failure.ts';
export { DatabaseTransactionFailure, decodeDatabaseDriverFailure } from '../database/driver-failure.ts';
export {
  BusinessPermissionCodeSchema,
  defineBusinessPermission,
  defineBusinessPermissionCatalog,
} from '../permissions/business-permission.ts';
export { AuthorizationMutationReconciliationUnavailable } from '../permissions/authorization-reconciler.ts';
export {
  AuthorizationMutationSagaError,
  reconcileCommittedAuthorizationMutation,
} from '../permissions/authorization-mutation-saga.ts';
export { AuthorizationMutationStateSchema } from '../permissions/authorization-mutation.ts';
export {
  BusinessPermissionRelationshipMutation,
  BusinessPermissionRelationshipMutationLive,
} from '../permissions/business-permission-mutation.ts';
export {
  ContextAccess,
  ContextAccessLive,
  toBusinessPermissionAccessKey,
  toBusinessPermissionAccessObjectId,
} from '../permissions/context-access.ts';
export { PrincipalEligibility, PrincipalRefSchema } from '../permissions/principal-ref.ts';
export {
  ReadHandlerNotFound,
  ReadHandlerUnavailable,
  ReadPermissionDenied,
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
export { PARTY_REGISTRY_REQUEST_IDENTITY, PARTY_REGISTRY_WORKER_IDENTITY } from '../db/database-identity-manifest.ts';
export { CorePersistenceLive } from '../runtime-infrastructure.ts';
export { CoreSearchIngestion, CoreSearchIngestionLive } from '../search/ingestion.ts';
export { CoreSearchProjectionStoreLive } from '../search/persistence.ts';
export {
  CoreSearchProjectionDocumentSchema,
  CoreSearchProjectionMutationSchema,
  CoreSearchProjectionStore,
  CoreSearchResourceRefSchema,
} from '../search/projection.ts';
export { CoreSearchWorkerSnapshot, CoreSearchWorkerSnapshotLive } from '../search/worker-snapshot.ts';
export {
  defineOutboxWorker,
  extractOutboxWorkerSubscriptions,
  isVerifiedOutboxWorkerHandlerContext,
} from './definition.ts';
export { defineOutboxWorkerCompletion, OutboxWorkerCompletionPublicationError } from './completion-publication.ts';
export {
  ResourceContainmentMutationUnavailable,
  ResourceContainmentRelationshipMutation,
  ResourceContainmentRelationshipMutationLive,
  createResourceContainmentRelationshipMutationClient,
  makeResourceContainmentRelationshipMutation,
  makeResourceContainmentRelationshipMutationLive,
} from '../permissions/resource-containment-mutation.ts';
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
export type {
  ResourceContainmentRelationship,
  ResourceContainmentRelationshipMutationClient,
  ResourceContainmentRelationshipMutationInput,
  ResourceContainmentRelationshipMutationService,
  SpiceDbResourceReference,
} from '../permissions/resource-containment-mutation.ts';
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
