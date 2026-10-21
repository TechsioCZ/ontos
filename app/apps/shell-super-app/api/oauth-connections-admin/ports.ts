/**
 * "Připojené aplikace" management (lane mcp-connections-ui, ONTOS-MCP-AUTH-DESIGN.md §7.2): what the management
 * handlers need from the rest of the shell. Handlers never write grant tables themselves; the grant store and the
 * update/revoke service of lane connection-grants (api/oauth-connections/**) sit behind `GrantAdminPort`.
 * `R` is the Effect requirement of a live implementation; unit tests use plain fakes with `R = never`.
 */
import type {
  AgentModuleGrant,
  AgentStatus,
  AgentWritePolicy,
  ConnectionStatus,
  ConnectionSummary,
  PrincipalRef,
} from '@app/shared-contracts/agent-access';
import { Data } from 'effect';
import type { Effect } from 'effect';

/** The signed-in person calling a management endpoint, in the company selected in the shell. */
export interface ConnectionsCaller {
  /** True when the person administers people of the selected company (same rule as Lidé a role). */
  readonly isCompanyAdmin: boolean;
  readonly legalEntityId: string;
  readonly legalName: string;
  readonly principalId: string;
  readonly tenantId: string;
}

/** Czech `reason` becomes the problem detail (HTTP 403). */
export class ConnectionsForbidden extends Data.TaggedError('ConnectionsForbidden')<{ readonly reason: string }> {}
/** Czech `reason` becomes the problem detail (HTTP 422). */
export class ConnectionsInvalid extends Data.TaggedError('ConnectionsInvalid')<{ readonly reason: string }> {}
/** Czech `reason` becomes the problem detail (HTTP 404). */
export class ConnectionsNotFound extends Data.TaggedError('ConnectionsNotFound')<{ readonly reason: string }> {}
/** Storage or SpiceDB failure (HTTP 503). */
export class ConnectionsUnavailable extends Data.TaggedError('ConnectionsUnavailable')<{ readonly cause: unknown }> {}

export type ConnectionsAdminError =
  | ConnectionsForbidden
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

/** Audit reason codes of `oauth.connection.revoked` this lane can cause. */
export type RevokeReasonCode = 'admin' | 'operator_removed' | 'user';

/** Grant store + update/revoke service of lane connection-grants, as the management handlers see it. */
export interface GrantAdminPort<R> {
  /** Connections matching the filter (never drafts), newest first, with effective modules/policy and live limits. */
  readonly list: (filter: GrantListFilter) => Effect.Effect<readonly ConnectionSummary[], ConnectionsUnavailable, R>;
  /** One connection by grant id; undefined when unknown or a draft. */
  readonly get: (grantId: string) => Effect.Effect<ConnectionSummary | undefined, ConnectionsUnavailable, R>;
  /** Replaces modules and write policy of an ACTIVE grant and writes `oauth.connection.updated`. */
  readonly update: (input: {
    readonly actorPrincipalId: string;
    readonly grantId: string;
    readonly modules: 'all' | readonly AgentModuleGrant[];
    readonly writePolicy: AgentWritePolicy;
  }) => Effect.Effect<void, ConnectionsUnavailable, R>;
  /** Marks the grant revoked, disables its binding, deletes refresh tokens + consent, writes `oauth.connection.revoked`. */
  readonly revoke: (input: {
    readonly actorPrincipalId: string;
    readonly grantId: string;
    readonly reasonCode: RevokeReasonCode;
    readonly reasonText: string | null;
  }) => Effect.Effect<void, ConnectionsUnavailable, R>;
}

/** An agent entity (Core principal kind `agent`) of one company with its current profile. */
export interface CompanyAgent {
  readonly displayName: string;
  readonly modules: readonly AgentModuleGrant[];
  readonly principalId: string;
  readonly seeded: boolean;
  readonly status: AgentStatus;
  readonly writePolicy: AgentWritePolicy;
}

/** People, agents and SpiceDB operator relations of one company. */
export interface CompanyDirectoryPort<R> {
  /** Active human members of the company, sorted by display name (cs). */
  readonly people: (
    tenantId: string,
    legalEntityId: string,
  ) => Effect.Effect<readonly PrincipalRef[], ConnectionsUnavailable, R>;
  /** Agent entities that are members of the company (any status), sorted by display name (cs). */
  readonly agents: (
    tenantId: string,
    legalEntityId: string,
  ) => Effect.Effect<readonly CompanyAgent[], ConnectionsUnavailable, R>;
  /** Principal ids with `principal:{agent}#operator`. */
  readonly operatorsOf: (agentPrincipalId: string) => Effect.Effect<readonly string[], ConnectionsUnavailable, R>;
  /** Makes `operatorPrincipalIds` the complete operator set of the agent and audits the change. */
  readonly replaceOperators: (input: {
    readonly actorPrincipalId: string;
    readonly agentPrincipalId: string;
    readonly legalEntityId: string;
    readonly operatorPrincipalIds: readonly string[];
    readonly tenantId: string;
  }) => Effect.Effect<void, ConnectionsUnavailable, R>;
}

/** Everything a management handler needs. */
export interface ConnectionsAdminDeps<R> {
  readonly directory: CompanyDirectoryPort<R>;
  readonly grants: GrantAdminPort<R>;
  /** `ONTOS_MCP_RESOURCE_URL`, e.g. `http://localhost:3090/mcp`. */
  readonly mcpUrl: string;
}
