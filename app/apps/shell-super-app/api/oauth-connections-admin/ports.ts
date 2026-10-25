/**
 * Management contracts for Připojené aplikace. Grant persistence stays behind GrantAdminPort;
 * the governed company directory is supplied by its request-bound Context service.
 * Live Layers capture their internal dependencies; management methods require no additional services.
 */
import type { TrustedPrincipalContext } from '@app/core-runtime';
import type {
  AgentModuleGrant,
  AgentStatus,
  AgentWritePolicy,
  ConnectionStatus,
  ConnectionSummary,
  PrincipalRef,
} from '@app/shared-contracts/agent-access';
import { Context, Schema } from 'effect';
import type { Effect, Option } from 'effect';

import type { CompanyDirectoryPort } from './company-directory.ts';
import type { ConnectionsForbidden } from './connections-forbidden.ts';
import type { ConnectionsGone } from './connections-gone.ts';
import type { ConnectionsInvalid } from './connections-invalid.ts';
import type { ConnectionsNotFound } from './connections-not-found.ts';
import type { ConnectionsUnavailable } from './connections-unavailable.ts';

/** The signed-in person calling a management endpoint, in the company selected in the shell. */
export interface ConnectionsCaller {
  /** True when the person administers people of the selected company (same rule as Lidé a role). */
  readonly isCompanyAdmin: boolean;
  readonly legalEntityId: string;
  readonly legalName: string;
  /** Original resolver-issued carrier, including authentication and binding metadata. */
  readonly principal: TrustedPrincipalContext & { readonly legalEntityId: string };
  readonly principalId: string;
  readonly tenantId: string;
}

export type ConnectionsAdminError =
  | ConnectionsForbidden
  | ConnectionsGone
  | ConnectionsInvalid
  | ConnectionsNotFound
  | ConnectionsUnavailable;

export interface GrantListFilter {
  readonly actingPrincipalId?: string;
  readonly legalEntityId?: string;
  readonly statuses: readonly ConnectionStatus[];
  readonly tenantId: string;
  readonly userPrincipalId?: string;
}

/** Audit reason codes of oauth.connection.revoked this lane can cause. */
export const RevokeReasonCodeSchema = Schema.Literals(['admin', 'operator_removed', 'user']);
export type RevokeReasonCode = typeof RevokeReasonCodeSchema.Type;

/** Grant store + update/revoke service of lane connection-grants, as the management handlers see it. */
export interface GrantAdminPort<R> {
  /** One connection by grant id; None when unknown or a draft. */
  readonly get: (grantId: string) => Effect.Effect<Option.Option<ConnectionSummary>, ConnectionsUnavailable, R>;
  /** Connections matching the filter (never drafts), newest first, with effective modules/policy and live limits. */
  readonly list: (filter: GrantListFilter) => Effect.Effect<readonly ConnectionSummary[], ConnectionsUnavailable, R>;
  /** Marks the grant revoked, disables its binding, deletes refresh tokens + consent, writes oauth.connection.revoked. */
  readonly revoke: (input: {
    readonly actorPrincipalId: string;
    readonly grantId: string;
    readonly reasonCode: RevokeReasonCode;
    readonly reasonText: string | null;
  }) => Effect.Effect<void, ConnectionsUnavailable, R>;
  /** Replaces modules and write policy of an ACTIVE grant and writes oauth.connection.updated. */
  readonly update: (input: {
    readonly actorPrincipalId: string;
    readonly grantId: string;
    readonly modules: 'all' | readonly AgentModuleGrant[];
    readonly writePolicy: AgentWritePolicy;
  }) => Effect.Effect<void, ConnectionsUnavailable, R>;
}

export class GrantAdmin extends Context.Service<GrantAdmin, GrantAdminPort<never>>()(
  '@app/shell-super-app/api/oauth-connections-admin/ports/GrantAdmin',
) {}

/** An agent entity (Core principal kind agent) of one company with its current profile. */
export interface CompanyAgent {
  /** Administrator text; null when empty. */
  readonly description: string | null;
  readonly displayName: string;
  readonly hasProfile: boolean;
  readonly modules: readonly AgentModuleGrant[];
  /** Responsible person of the company; null when none. */
  readonly ownerPrincipalId: string | null;
  readonly principalId: string;
  readonly status: AgentStatus;
  readonly writePolicy: AgentWritePolicy;
}

export interface CompanyDirectoryAgent extends CompanyAgent {
  readonly operatorCommand: {
    readonly desiredOperatorPrincipalIds: readonly string[];
    readonly revision: number;
  } | null;
  readonly operatorPrincipalIds: readonly string[];
}

/** One governed view used for target validation, eligible humans and prior operators. */
export interface CompanyDirectorySnapshot {
  readonly agents: readonly CompanyDirectoryAgent[];
  readonly members: readonly string[];
  readonly people: readonly PrincipalRef[];
}

/** Everything a management handler needs. */
export interface ConnectionsAdminDeps<R> {
  readonly directory: CompanyDirectoryPort<R>;
  readonly grants: GrantAdminPort<R>;
  /** ONTOS_MCP_RESOURCE_URL, e.g. http://localhost:3090/mcp. */
  readonly mcpUrl: string;
}
