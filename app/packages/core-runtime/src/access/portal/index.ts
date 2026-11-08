export {
  ACCESS_PORTAL_FAILURE_CODES,
  AccessPortalError,
  accessPortalAssignmentId,
  accessPortalRoleId,
  accessPortalWritesForTransaction,
  compilePortalRole,
  portalRoleRelease,
} from './portal-access.ts';
export type {
  AccessPortalFailureCode,
  AccessPortalGrantInput,
  AccessPortalReceipt,
  AccessPortalTransaction,
  AccessPortalWrites,
} from './portal-access.ts';
export { AccessPortalProjection, reconcileAccessPortalAfterAttempt } from './portal-projection.ts';
export type { AccessPortalProjectionService } from './portal-projection.ts';
export { AccessPortalRoleSchema, decodeAccessPortalRole, defineAccessPortalRole } from './portal-role.ts';
export type { AccessPortalRole, AccessPortalRoleInput } from './portal-role.ts';
export { portalPrincipalInLegalEntity } from './portal-principal.ts';
