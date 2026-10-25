/**
 * Shapes shared by the grant store, the connection services and the management handlers (lane mcp-connections-ui
 * imports these; it never writes the grant table directly). Table: `core.oauth_connection_grants` (migration in
 * packages/core-runtime/drizzle, same database as the Better Auth tables).
 */
import type { Option } from 'effect';

import type {
  ConnectionActingKind,
  ConnectionClientKind,
  ConnectionGrantStatus,
  ConnectionModulesRequest,
  ConnectionRevokeReason,
  ConnectionWritePolicy,
} from '@app/shared-contracts/oauth-connections';

export interface GrantRow {
  readonly actingKind: ConnectionActingKind;
  readonly actingPrincipalId: string;
  /** `core.principal_auth_bindings` row (subject type `oauth_grant`); null while draft/denied. */
  readonly authBindingId: string | null;
  readonly clientHost: string;
  readonly clientId: string;
  readonly clientKind: ConnectionClientKind;
  readonly clientLogoUri: string | null;
  readonly clientName: string;
  readonly consentedAt: Date | null;
  /** Better Auth consent id (fallback lookup only). */
  readonly consentId: string | null;
  readonly createdAt: Date;
  readonly grantId: string;
  readonly lastUsedAt: Date | null;
  readonly legalEntityId: string;
  /** Requested ceiling. */
  readonly modules: ConnectionModulesRequest;
  readonly profileId: string;
  readonly revokedAt: Date | null;
  readonly revokedByPrincipalId: string | null;
  readonly revokeReason: ConnectionRevokeReason | null;
  /** Better Auth session that created the draft. */
  readonly sessionId: string | null;
  readonly status: ConnectionGrantStatus;
  readonly tenantId: string;
  /** Better Auth user id (JWT `sub`). */
  readonly userId: string;
  readonly userPrincipalId: string;
  readonly writePolicy: ConnectionWritePolicy;
}

/** Retained native token/grant facts, without the token or token hash crossing into audit evidence. */
export interface OAuthRefreshGuardRow {
  readonly clientId: string;
  readonly grant: Option.Option<GrantRow>;
  readonly id: string;
  readonly referenceId: string | null;
  readonly revoked: Date | null;
  readonly rotatedAt: Date | null;
  readonly rotationReplayExpiresAt: Date | null;
}

/** Who performs a management change (for the audit row); null for system-initiated revocation. */
export interface ConnectionActor {
  readonly authBindingId: string | undefined;
  readonly authMethod: string;
  readonly principalId: string;
}

export interface GrantListFilter {
  readonly actingPrincipalId?: string;
  readonly clientId?: string;
  readonly legalEntityId?: string;
  /** Empty or absent = every status except `draft`. */
  readonly statuses?: readonly ConnectionGrantStatus[];
  readonly tenantId: string;
  readonly userId?: string;
  readonly userPrincipalId?: string;
}

/** Insert shape of a draft grant (status `draft`, no binding yet). */
export type NewDraftGrant = Omit<
  GrantRow,
  | 'authBindingId'
  | 'consentId'
  | 'consentedAt'
  | 'createdAt'
  | 'grantId'
  | 'lastUsedAt'
  | 'revokeReason'
  | 'revokedAt'
  | 'revokedByPrincipalId'
  | 'status'
>;
