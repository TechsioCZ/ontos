/**
 * Live state of MCP connection grants: every connector exchange and every "Připojené aplikace" read re-checks the
 * grant against OntOS (user, acting principal, binding, company membership, operator relation). A failed check
 * revokes the grant (where the design says so). Nothing is cached, so a change of the person, the agent, its grants or
 * the connection applies to the very next request. Pure checks live in
 * `evaluateLiveChecks`; the database, SpiceDB and catalog reads live in the effects below.
 */
import {
  ContextAccess,
  OAuthAuthenticationAudit,
  OAuthConnectionCompanies,
  openDemoAccountGrants,
  openPrincipalOperators,
} from '@app/core-runtime';
import {
  ConnectionClientIdSchema,
  ConnectionGrantIdSchema,
  ConnectionLegalEntityIdSchema,
  ConnectionModuleIdSchema,
  ConnectionModulesRequestSchema,
  ConnectionPrincipalIdSchema,
  ConnectionProfileIdSchema,
  ConnectionTenantIdSchema,
} from '@app/shared-contracts/oauth-connections';
import type {
  ConnectionActingKind,
  ConnectionDescription,
  ConnectionGrantStatus,
  ConnectionModule,
  ConnectionModulesRequest,
  ConnectionRevokeReason,
  ConnectionSummary,
  ConnectionWritePolicy,
} from '@app/shared-contracts/oauth-connections';
import { DateTime, Effect, Option, Schema } from 'effect';

import { callerModuleAccess } from '../agent-platform/caller.ts';
import { composedModulesOf } from '../agent-platform/composed-modules.ts';
import { mcpModulesOf } from '../mcp/catalog.ts';
import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import { ConnectionForbidden, ConnectionInvalid, ConnectionUnauthorized, ConnectionUnavailable } from './errors.ts';
import type { ConnectionUnauthorizedCode } from './errors.ts';
import { OAuthFlow } from './oauth-flow.ts';
import { effectiveAuthority, isModulesRequestWithin, isPolicyWithin, offeredModules } from './effective-authority.ts';
import type { LiveRights } from './effective-authority.ts';
import {
  findGrant,
  loadBindingStatus,
  loadPrincipals,
  loadUserAccount,
  setGrantBindingStatus,
  setGrantStatus,
  updateGrantAccess,
} from './grant-store.ts';
import type { GrantRow } from './types.ts';

/** Facts gathered by `loadLiveConnection` for one grant; every check of `evaluateLiveChecks` reads these. */
export interface LiveFacts {
  readonly actingKind: ConnectionActingKind;
  readonly actingPrincipalStatus: string | undefined;
  /** Always true for `human`. */
  readonly agentInCompany: boolean;
  readonly bindingStatus: string | undefined;
  readonly grantStatus: ConnectionGrantStatus;
  /** The USER principal has `legal_entity#access`. */
  readonly hasCompanyAccess: boolean;
  /** Always true for `human`. */
  readonly operatorHolds: boolean;
  readonly userBanned: boolean;
  readonly userEmailVerified: boolean;
  readonly userExists: boolean;
  readonly userPrincipalStatus: string | undefined;
}

export type LiveVerdict =
  | { readonly ok: true }
  | { readonly code: ConnectionUnauthorizedCode; readonly ok: false; readonly revoke: ConnectionRevokeReason | null };

/** Pure: the first failing check wins, in the order fixed by the design (§4.2). */
export const evaluateLiveChecks = (facts: LiveFacts): LiveVerdict => {
  const agent = facts.actingKind === 'agent';
  if (facts.grantStatus !== 'active') {
    return { code: 'grant_inactive', ok: false, revoke: null };
  }
  if (!facts.userExists || facts.userBanned || facts.userPrincipalStatus !== 'active') {
    return { code: 'user_disabled', ok: false, revoke: 'user_disabled' };
  }
  if (!facts.userEmailVerified) {
    return { code: 'user_disabled', ok: false, revoke: null };
  }
  if (agent && facts.actingPrincipalStatus !== 'active') {
    return { code: 'agent_disabled', ok: false, revoke: 'agent_disabled' };
  }
  if (facts.bindingStatus !== 'active') {
    return { code: 'binding_inactive', ok: false, revoke: null };
  }
  if (!facts.hasCompanyAccess) {
    return { code: 'membership_missing', ok: false, revoke: agent ? 'operator_removed' : null };
  }
  if (agent && !facts.agentInCompany) {
    return { code: 'agent_disabled', ok: false, revoke: 'agent_disabled' };
  }
  if (agent && !facts.operatorHolds) {
    return { code: 'operator_removed', ok: false, revoke: 'operator_removed' };
  }
  return { ok: true };
};

/** Pure: `superseded` only when a newer grant replaced this one; every other reason is `revoked`. */
export const revokedStatusFor = (reason: ConnectionRevokeReason): 'revoked' | 'superseded' =>
  reason === 'superseded' ? 'superseded' : 'revoked';

const toUnavailable = (cause: unknown): ConnectionUnavailable =>
  Schema.is(Schema.instanceOf(ConnectionUnavailable))(cause) ? cause : new ConnectionUnavailable({ cause });

const ModulesJson = Schema.fromJsonString(ConnectionModulesRequestSchema);
const modulesJson = Schema.encodeEffect(ModulesJson);

type PrincipalNames = ReadonlyMap<
  string,
  { readonly displayName: string; readonly kind: string; readonly status: string }
>;

/** Current graph authority; connection consent can narrow these rights but profiles cannot grant them. */
export const loadActingAuthority = Effect.fn('OAuthConnectionService.loadActingAuthority')(
  function* loadActingAuthority(input: {
    readonly actingKind: ConnectionActingKind;
    readonly actingPrincipalId: string;
    readonly legalEntityId: string;
    readonly tenantId: string;
  }) {
    const sets = yield* callerModuleAccess({
      principal: {
        legalEntityId: input.legalEntityId,
        principalId: input.actingPrincipalId,
        tenantId: input.tenantId,
      },
    });
    const catalog = yield* (yield* ShellInstalledModuleCatalog).load;
    const { labelOf } = composedModulesOf(mcpModulesOf(catalog.composition));
    const live: LiveRights = { read: sets.access, write: sets.propose };
    let policyCap: ConnectionWritePolicy = 'read_only';
    if (input.actingKind === 'human' || sets.write.size > 0) {
      policyCap = 'direct';
    } else if (sets.propose.size > 0) {
      policyCap = 'approval';
    }
    return { labelOf, live, offered: offeredModules(live, policyCap, labelOf), policyCap };
  },
  Effect.mapError(toUnavailable),
);

export interface LiveConnection {
  readonly description: ConnectionDescription;
  readonly grant: GrantRow;
}

/**
 * Side effects after a grant left `active` (its row and binding are already updated): drops its OAuth tokens and
 * consent, forgets the cached live check and writes `oauth.connection.revoked`.
 */
export const finishRevocation = Effect.fn('OAuthConnectionService.finishRevocation')(function* finishRevocation(input: {
  readonly actorPrincipalId: string | null;
  readonly grant: GrantRow;
  readonly note: string | null;
  readonly reason: ConnectionRevokeReason;
}) {
  yield* (yield* OAuthFlow).deleteGrantTokens(input.grant.grantId);
  yield* (yield* OAuthAuthenticationAudit)
    .record({
      authBindingId: null,
      authMethod: input.actorPrincipalId === null ? 'system' : 'session',
      eventType: 'oauth.connection.revoked',
      evidence: { note: input.note, reason: input.reason, revokedByPrincipalId: input.actorPrincipalId },
      grant: input.grant,
      outcome: 'succeeded',
      outcomeCode: input.reason,
      principalId: input.actorPrincipalId,
    })
    .pipe(Effect.mapError(toUnavailable));
});

/**
 * Revokes (or denies a draft of) a grant: status, binding, Better Auth tokens and audit row.
 * Grants that are already revoked, superseded or denied are returned unchanged.
 */
export const revokeConnection = Effect.fn('OAuthConnectionService.revokeConnection')(function* revokeConnection(input: {
  readonly actorPrincipalId: string | null;
  readonly grantId: string;
  readonly note: string | null;
  readonly reason: ConnectionRevokeReason;
}) {
  const grant = yield* findGrant(input.grantId);
  if (grant === undefined) {
    return yield* new ConnectionInvalid({ code: 'grant_not_found' });
  }
  if (grant.status === 'revoked' || grant.status === 'superseded' || grant.status === 'denied') {
    return grant;
  }
  if (grant.status === 'draft') {
    const denied = yield* setGrantStatus({
      grantId: input.grantId,
      revokedByPrincipalId: input.actorPrincipalId,
      revokeReason: null,
      status: 'denied',
    });
    return denied ?? grant;
  }
  const updated = yield* setGrantStatus({
    grantId: input.grantId,
    revokedByPrincipalId: input.actorPrincipalId,
    revokeReason: input.reason,
    status: revokedStatusFor(input.reason),
  });
  if (updated === undefined) {
    return yield* new ConnectionInvalid({ code: 'grant_not_found' });
  }
  if (grant.authBindingId !== null) {
    yield* setGrantBindingStatus({ authBindingId: grant.authBindingId, status: 'disabled', tenantId: grant.tenantId });
  }
  yield* finishRevocation({ actorPrincipalId: input.actorPrincipalId, grant, note: input.note, reason: input.reason });
  return updated;
});

/**
 * Live check and description of an active grant, on every call. A failed check revokes the grant when the verdict
 * says so and then fails with `ConnectionUnauthorized`.
 */
export const loadLiveConnection = Effect.fn('OAuthConnectionService.loadLiveConnection')(function* loadLiveConnection(
  grantId: string,
) {
  const grant = yield* findGrant(grantId);
  if (grant === undefined) {
    return yield* new ConnectionUnauthorized({ code: 'grant_inactive' });
  }
  const agent = grant.actingKind === 'agent';
  const [user, names] = yield* Effect.all(
    [loadUserAccount(grant.userId), loadPrincipals(grant.tenantId, [grant.userPrincipalId, grant.actingPrincipalId])],
    { concurrency: 2 },
  );
  const bindingStatus =
    grant.authBindingId === null
      ? undefined
      : yield* loadBindingStatus({ authBindingId: grant.authBindingId, tenantId: grant.tenantId });
  const access = yield* (yield* ContextAccess).legalEntities({
    legalEntityIds: [grant.legalEntityId],
    permission: 'access',
    principalId: grant.userPrincipalId,
    tenantId: grant.tenantId,
  });
  if (access.some((entry) => entry.decision === 'unavailable')) {
    return yield* new ConnectionUnavailable({ cause: 'context_access_unavailable' });
  }
  let agentInCompany = true;
  let operatorHolds = true;
  if (agent) {
    const companies = yield* openDemoAccountGrants.pipe(
      Effect.flatMap((grants) => grants.companiesOf(grant.actingPrincipalId)),
      Effect.scoped,
      Effect.mapError(toUnavailable),
    );
    agentInCompany = companies.includes(grant.legalEntityId);
    operatorHolds = yield* openPrincipalOperators.pipe(
      Effect.flatMap((operators) => operators.canOperate(grant.actingPrincipalId, grant.userPrincipalId)),
      Effect.scoped,
      Effect.mapError(toUnavailable),
    );
  }
  const verdict = evaluateLiveChecks({
    actingKind: grant.actingKind,
    actingPrincipalStatus: names.get(grant.actingPrincipalId)?.status,
    agentInCompany,
    bindingStatus,
    grantStatus: grant.status,
    hasCompanyAccess: access.some((entry) => entry.decision === 'allowed'),
    operatorHolds,
    userBanned: user?.banned ?? false,
    userEmailVerified: user?.emailVerified ?? false,
    userExists: user !== undefined,
    userPrincipalStatus: names.get(grant.userPrincipalId)?.status,
  });
  if (!verdict.ok) {
    if (verdict.revoke !== null) {
      yield* revokeConnection({ actorPrincipalId: null, grantId, note: null, reason: verdict.revoke }).pipe(
        Effect.catchTag('ConnectionInvalid', (error) => Effect.fail(new ConnectionUnavailable({ cause: error }))),
      );
    }
    return yield* new ConnectionUnauthorized({ code: verdict.code });
  }
  const authority = yield* loadActingAuthority({
    actingKind: grant.actingKind,
    actingPrincipalId: grant.actingPrincipalId,
    legalEntityId: grant.legalEntityId,
    tenantId: grant.tenantId,
  });
  const effective = effectiveAuthority({
    labelOf: authority.labelOf,
    live: authority.live,
    policyCap: authority.policyCap,
    requested: grant.modules,
    requestedPolicy: grant.writePolicy,
  });
  const legalName = (yield* (yield* OAuthConnectionCompanies)
    .names(grant.tenantId, [grant.legalEntityId])
    .pipe(Effect.mapError(toUnavailable))).get(grant.legalEntityId);
  const catalog = yield* (yield* ShellInstalledModuleCatalog).load.pipe(Effect.mapError(toUnavailable));
  const description: ConnectionDescription = {
    acting: {
      displayName: names.get(grant.actingPrincipalId)?.displayName ?? '',
      kind: grant.actingKind,
      principalId: ConnectionPrincipalIdSchema.make(grant.actingPrincipalId),
    },
    client: {
      clientId: ConnectionClientIdSchema.make(grant.clientId),
      host: grant.clientHost,
      kind: grant.clientKind,
      logoUri: Option.fromNullOr(grant.clientLogoUri),
      name: grant.clientName,
    },
    compositionRevision: catalog.composition.revision,
    delegatedBy: agent
      ? Option.some({
          displayName: names.get(grant.userPrincipalId)?.displayName ?? '',
          principalId: ConnectionPrincipalIdSchema.make(grant.userPrincipalId),
        })
      : Option.none(),
    grantId: ConnectionGrantIdSchema.make(grant.grantId),
    legalEntityId: ConnectionLegalEntityIdSchema.make(grant.legalEntityId),
    legalName: legalName ?? grant.legalEntityId,
    modules: effective.modules,
    profileId: ConnectionProfileIdSchema.make(grant.profileId),
    status: 'active',
    tenantId: ConnectionTenantIdSchema.make(grant.tenantId),
    writePolicy: effective.writePolicy,
  };
  const live: LiveConnection = { description, grant };
  return live;
});

const summaryOf = (
  row: GrantRow,
  names: PrincipalNames,
  legalNames: ReadonlyMap<string, string>,
  live: LiveConnection | undefined,
  labelOf: (moduleId: string) => string,
): ConnectionSummary => {
  const agent = row.actingKind === 'agent';
  const fallbackModules: readonly ConnectionModule[] =
    row.modules === 'all'
      ? []
      : row.modules.map((grant) => ({
          label: labelOf(grant.moduleId),
          moduleId: ConnectionModuleIdSchema.make(grant.moduleId),
          read: true,
          write: grant.access === 'write',
        }));
  return {
    acting: {
      displayName: names.get(row.actingPrincipalId)?.displayName ?? '',
      kind: row.actingKind,
      principalId: ConnectionPrincipalIdSchema.make(row.actingPrincipalId),
    },
    client: {
      clientId: ConnectionClientIdSchema.make(row.clientId),
      host: row.clientHost,
      kind: row.clientKind,
      logoUri: Option.fromNullOr(row.clientLogoUri),
      name: row.clientName,
    },
    createdAt: DateTime.fromDateUnsafe(row.createdAt),
    delegatedBy: agent
      ? Option.some({
          displayName: names.get(row.userPrincipalId)?.displayName ?? '',
          principalId: ConnectionPrincipalIdSchema.make(row.userPrincipalId),
        })
      : Option.none(),
    grantId: ConnectionGrantIdSchema.make(row.grantId),
    lastUsedAt: Option.map(Option.fromNullOr(row.lastUsedAt), DateTime.fromDateUnsafe),
    legalEntityId: ConnectionLegalEntityIdSchema.make(row.legalEntityId),
    legalName: legalNames.get(row.legalEntityId) ?? row.legalEntityId,
    modules: live?.description.modules ?? fallbackModules,
    profileId: ConnectionProfileIdSchema.make(row.profileId),
    requestedModules: row.modules,
    status: row.status,
    tenantId: ConnectionTenantIdSchema.make(row.tenantId),
    userDisplayName: names.get(row.userPrincipalId)?.displayName ?? '',
    writePolicy: live?.description.writePolicy ?? row.writePolicy,
  };
};

/** Summarizes retained grant rows without querying the same management selection twice. */
export const connectionSummariesOf = Effect.fn('OAuthConnectionService.connectionSummariesOf')(
  function* connectionSummariesOf(tenantId: string, rows: readonly GrantRow[]) {
    const companies = yield* OAuthConnectionCompanies;
    const [names, legalNames] = yield* Effect.all(
      [
        loadPrincipals(tenantId, [...new Set(rows.flatMap((row) => [row.userPrincipalId, row.actingPrincipalId]))]),
        companies
          .names(tenantId, [...new Set(rows.map((row) => row.legalEntityId))])
          .pipe(Effect.mapError(toUnavailable)),
      ],
      { concurrency: 2 },
    );
    const catalog = yield* (yield* ShellInstalledModuleCatalog).load.pipe(Effect.mapError(toUnavailable));
    const { labelOf } = composedModulesOf(mcpModulesOf(catalog.composition));
    return yield* Effect.forEach(
      rows,
      (row) =>
        row.status === 'active'
          ? loadLiveConnection(row.grantId).pipe(
              Effect.option,
              Effect.map((live) => summaryOf(row, names, legalNames, Option.getOrUndefined(live), labelOf)),
            )
          : Effect.succeed(summaryOf(row, names, legalNames, undefined, labelOf)),
      // loadLiveConnection eventually opens two authority reads; keep room for the PostgreSQL connection.
      { concurrency: 2 },
    );
  },
);

/** Changes the module ceiling and write policy of an active grant; both must stay within the actor's authority. */
export const updateConnection = Effect.fn('OAuthConnectionService.updateConnection')(function* updateConnection(input: {
  readonly actorPrincipalId: string;
  readonly grantId: string;
  readonly modules: ConnectionModulesRequest;
  readonly writePolicy: ConnectionWritePolicy;
}) {
  const grant = yield* findGrant(input.grantId);
  if (grant === undefined || grant.status !== 'active') {
    return yield* new ConnectionInvalid({ code: 'grant_not_found' });
  }
  const authority = yield* loadActingAuthority({
    actingKind: grant.actingKind,
    actingPrincipalId: grant.actingPrincipalId,
    legalEntityId: grant.legalEntityId,
    tenantId: grant.tenantId,
  });
  if (!isModulesRequestWithin(input.modules, authority.offered)) {
    return yield* new ConnectionForbidden({
      code: 'modules_forbidden',
      reason: 'Připojení může mít jen moduly, které jednající smí používat.',
    });
  }
  if (!isPolicyWithin(input.writePolicy, authority.policyCap)) {
    return yield* new ConnectionForbidden({
      code: 'write_policy_forbidden',
      reason: 'Tento způsob zápisu nastavení agenta nedovoluje.',
    });
  }
  const [modulesAfter, modulesBefore] = yield* Effect.all([modulesJson(input.modules), modulesJson(grant.modules)], {
    concurrency: 2,
  }).pipe(Effect.mapError(toUnavailable));
  const updated = yield* updateGrantAccess({
    grantId: input.grantId,
    modules: input.modules,
    writePolicy: input.writePolicy,
  });
  if (updated === undefined) {
    return yield* new ConnectionInvalid({ code: 'grant_not_found' });
  }
  yield* (yield* OAuthAuthenticationAudit)
    .record({
      authBindingId: null,
      authMethod: 'session',
      eventType: 'oauth.connection.updated',
      evidence: {
        modulesAfter,
        modulesBefore,
        writePolicyAfter: input.writePolicy,
        writePolicyBefore: grant.writePolicy,
      },
      grant,
      outcome: 'succeeded',
      outcomeCode: 'updated',
      principalId: input.actorPrincipalId,
    })
    .pipe(Effect.mapError(toUnavailable));
  const [summary] = yield* connectionSummariesOf(grant.tenantId, [updated]);
  if (summary === undefined) {
    return yield* new ConnectionInvalid({ code: 'grant_not_found' });
  }
  return summary;
});
