/**
 * A new tenant's access (O67-Q6): its scopes and fences, its owner's memberships, the release catalog of
 * its installed modules, the "Plný přístup" role assigned to the owner in every scope, and one reconcile
 * through the single Core writer. Every step is idempotent, so a stage bootstrap, a local development seed
 * and an integration test can all call it as often as they like.
 */
export {
  AccessBootstrapError,
  AccessBootstrapErrorCodeSchema,
  bootstrapRefusal,
  bootstrapSourceRefusal,
} from './errors.ts';
export type { AccessBootstrapErrorCode } from './errors.ts';
export {
  TenantAccessBootstrap,
  TenantAccessBootstrapLive,
  bootstrapTenantAccessProgram,
} from './bootstrap-tenant-access.ts';
export type {
  BootstrapRequirements,
  BootstrapTenantAccessRequest,
  BootstrapTenantAccessResult,
  TenantAccessBootstrapService,
} from './bootstrap-tenant-access.ts';
export {
  FULL_ACCESS_ROLE_NAME,
  FULL_ACCESS_ROLE_TEMPLATE_KEY,
  compileFullAccessRole,
  fullAccessRoleIntent,
} from './full-access-role.ts';
export {
  BootstrapScopeSchema,
  bootstrapScopesOf,
  legalEntityScopeId,
  ownerAssignmentIncarnationId,
  tenantContextScopeId,
  writeBootstrapScopes,
  writeOwnerAssignments,
} from './persistence.ts';
export type { BootstrapScope, WriteBootstrapScopesInput, WriteOwnerAssignmentsInput } from './persistence.ts';
