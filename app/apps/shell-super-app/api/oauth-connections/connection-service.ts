/**
 * Live state of MCP connection grants: every connector exchange and every "Připojené aplikace" read re-checks the
 * grant against OntOS (user, acting principal, binding, company membership, operator relation). A failed check
 * revokes the grant (where the design says so); a passing check is cached for at most 30 s. Pure checks live in
 * `evaluateLiveChecks`; the database, SpiceDB and catalog reads live in the effects below.
 */
import { ContextAccess, openDemoAccountGrants, openPrincipalOperators } from '@app/core-runtime';
import {
  type ConnectionActingKind,
  type ConnectionDescription,
  type ConnectionGrantStatus,
  type ConnectionModule,
  type ConnectionModulesRequest,
  type ConnectionRevokeReason,
  type ConnectionSummary,
  type ConnectionWritePolicy,
  ConnectionModulesRequestSchema,
  OAUTH_LIVE_CHECK_TTL_SECONDS,
} from '@app/shared-contracts/oauth-connections';
import { Clock, DateTime, Effect, Option, Schema } from 'effect';

import { moduleAccessSets } from '../agent-platform/approval-logic.ts';
import { loadAgentProfiles } from '../auth/agent-store.ts';
import { DEFAULT_AGENT_PROFILE, moduleLabel } from '../auth/agent-store-model.ts';
import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import {
  ConnectionForbidden,
  ConnectionInvalid,
  ConnectionUnauthorized,
  type ConnectionUnauthorizedCode,
  ConnectionUnavailable,
} from './errors.ts';
import { OAuthFlow } from './oauth-flow.ts';
import {
  type LiveRights,
  agentLiveRights,
  effectiveAuthority,
  isModulesRequestWithin,
  isPolicyWithin,
  offeredModules,
} from './effective-authority.ts';
import {
  findGrant,
  listGrants,
  loadBindingStatus,
  loadLegalNames,
  loadPrincipals,
  loadUserAccount,
  recordConnectionAudit,
  setGrantBindingStatus,
  setGrantStatus,
  updateGrantAccess,
} from './grant-store.ts';
import type { GrantListFilter, GrantRow } from './types.ts';

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
  cause instanceof ConnectionUnavailable ? cause : new ConnectionUnavailable({ cause });

const iso = (value: Date): string => DateTime.formatIso(DateTime.fromDateUnsafe(value));

const ModulesJson = Schema.fromJsonString(ConnectionModulesRequestSchema);
const modulesJson = (modules: ConnectionModulesRequest): string => Schema.encodeSync(ModulesJson)(modules);

type PrincipalNames = ReadonlyMap<
  string,
  { readonly displayName: string; readonly kind: string; readonly status: string }
>;

/** What the acting principal may do right now (SpiceDB rights, narrowed for agents by their profile). */
export const loadActingAuthority = Effect.fn('OAuthConnectionService.loadActingAuthority')(function* (input: {
  readonly actingKind: ConnectionActingKind;
  readonly actingPrincipalId: string;
  readonly legalEntityId: string;
  readonly tenantId: string;
}) {
  const relationships = yield* Effect.scoped(
    Effect.flatMap(openDemoAccountGrants, (grants) => grants.relationshipsOf(input.actingPrincipalId)),
  );
  const sets = moduleAccessSets(relationships, input.legalEntityId);
  // SpiceDB can still hold rights on modules that are no longer installed; a connection only offers live modules.
  const installed = new Set<string>((yield* (yield* ShellInstalledModuleCatalog).load).moduleIds);
  const spice: LiveRights = {
    read: new Set([...sets.access].filter((moduleId) => installed.has(moduleId))),
    write: new Set([...sets.write].filter((moduleId) => installed.has(moduleId))),
  };
  if (input.actingKind === 'human') {
    return { live: spice, offered: offeredModules(spice, 'direct'), policyCap: 'direct' as ConnectionWritePolicy };
  }
  const profiles = yield* loadAgentProfiles(input.tenantId, [input.actingPrincipalId]);
  const profile = profiles.get(input.actingPrincipalId) ?? DEFAULT_AGENT_PROFILE;
  const live = agentLiveRights(spice, profile.modules);
  return { live, offered: offeredModules(live, profile.writePolicy), policyCap: profile.writePolicy };
}, Effect.mapError(toUnavailable));

export interface LiveConnection {
  readonly description: ConnectionDescription;
  readonly grant: GrantRow;
}

const liveCache = new Map<string, { readonly expiresAt: number; readonly value: LiveConnection }>();

/** Drops the cached live check of a grant (after any change to it). */
export const forgetLiveConnection = (grantId: string): void => {
  liveCache.delete(grantId);
};

/**
 * Live check and description of an active grant, cached for at most `OAUTH_LIVE_CHECK_TTL_SECONDS`. A failed check
 * is never cached; it revokes the grant when the verdict says so and then fails with `ConnectionUnauthorized`.
 */
export const loadLiveConnection = Effect.fn('OAuthConnectionService.loadLiveConnection')(function* (grantId: string) {
  const now = yield* Clock.currentTimeMillis;
  const cached = liveCache.get(grantId);
  if (cached !== undefined && now < cached.expiresAt) {
    return cached.value;
  }
  const grant = yield* findGrant(grantId);
  if (grant === undefined) {
    return yield* new ConnectionUnauthorized({ code: 'grant_inactive' });
  }
  const agent = grant.actingKind === 'agent';
  const user = yield* loadUserAccount(grant.userId);
  const names: PrincipalNames = yield* loadPrincipals(grant.tenantId, [grant.userPrincipalId, grant.actingPrincipalId]);
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
    const companies = yield* Effect.scoped(
      Effect.flatMap(openDemoAccountGrants, (grants) => grants.companiesOf(grant.actingPrincipalId)),
    ).pipe(Effect.mapError(toUnavailable));
    agentInCompany = companies.includes(grant.legalEntityId);
    operatorHolds = yield* Effect.scoped(
      Effect.flatMap(openPrincipalOperators, (operators) =>
        operators.canOperate(grant.actingPrincipalId, grant.userPrincipalId),
      ),
    ).pipe(Effect.mapError(toUnavailable));
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
    live: authority.live,
    policyCap: authority.policyCap,
    requested: grant.modules,
    requestedPolicy: grant.writePolicy,
  });
  const legalName = (yield* loadLegalNames(grant.tenantId, [grant.legalEntityId])).get(grant.legalEntityId);
  const catalog = yield* (yield* ShellInstalledModuleCatalog).load.pipe(Effect.mapError(toUnavailable));
  const description: ConnectionDescription = {
    acting: {
      displayName: names.get(grant.actingPrincipalId)?.displayName ?? '',
      kind: grant.actingKind,
      principalId: grant.actingPrincipalId,
    },
    client: {
      clientId: grant.clientId,
      host: grant.clientHost,
      kind: grant.clientKind,
      logoUri: grant.clientLogoUri,
      name: grant.clientName,
    },
    compositionRevision: catalog.composition.revision,
    delegatedBy: agent
      ? { displayName: names.get(grant.userPrincipalId)?.displayName ?? '', principalId: grant.userPrincipalId }
      : null,
    grantId: grant.grantId,
    legalEntityId: grant.legalEntityId,
    legalName: legalName ?? grant.legalEntityId,
    modules: effective.modules,
    profileId: grant.profileId,
    status: 'active',
    tenantId: grant.tenantId,
    writePolicy: effective.writePolicy,
  };
  const live: LiveConnection = { description, grant };
  liveCache.set(grantId, { expiresAt: now + OAUTH_LIVE_CHECK_TTL_SECONDS * 1000, value: live });
  return live;
});

/**
 * Revokes (or denies a draft of) a grant: status, binding, Better Auth tokens, live-check cache and audit row.
 * Grants that are already revoked, superseded or denied are returned unchanged.
 */
export const revokeConnection = Effect.fn('OAuthConnectionService.revokeConnection')(function* (input: {
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
      revokeReason: null,
      revokedByPrincipalId: input.actorPrincipalId,
      status: 'denied',
    });
    return denied ?? grant;
  }
  const updated = yield* setGrantStatus({
    grantId: input.grantId,
    revokeReason: input.reason,
    revokedByPrincipalId: input.actorPrincipalId,
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
 * Side effects after a grant left `active` (its row and binding are already updated): drops its OAuth tokens and
 * consent, forgets the cached live check and writes `oauth.connection.revoked`.
 */
export const finishRevocation = Effect.fn('OAuthConnectionService.finishRevocation')(function* (input: {
  readonly actorPrincipalId: string | null;
  readonly grant: GrantRow;
  readonly note: string | null;
  readonly reason: ConnectionRevokeReason;
}) {
  yield* (yield* OAuthFlow).deleteGrantTokens(input.grant.grantId);
  forgetLiveConnection(input.grant.grantId);
  yield* recordConnectionAudit({
    authBindingId: null,
    authMethod: input.actorPrincipalId === null ? 'system' : 'session',
    eventType: 'oauth.connection.revoked',
    evidence: { note: input.note, reason: input.reason, revokedByPrincipalId: input.actorPrincipalId },
    grant: input.grant,
    outcome: 'succeeded',
    outcomeCode: input.reason,
    principalId: input.actorPrincipalId,
  });
});

/** Changes the module ceiling and write policy of an active grant; both must stay within the actor's authority. */
export const updateConnection = Effect.fn('OAuthConnectionService.updateConnection')(function* (input: {
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
  const updated = yield* updateGrantAccess({
    grantId: input.grantId,
    modules: input.modules,
    writePolicy: input.writePolicy,
  });
  if (updated === undefined) {
    return yield* new ConnectionInvalid({ code: 'grant_not_found' });
  }
  forgetLiveConnection(input.grantId);
  yield* recordConnectionAudit({
    authBindingId: null,
    authMethod: 'session',
    eventType: 'oauth.connection.updated',
    evidence: {
      modulesAfter: modulesJson(input.modules),
      modulesBefore: modulesJson(grant.modules),
      writePolicyAfter: input.writePolicy,
      writePolicyBefore: grant.writePolicy,
    },
    grant,
    outcome: 'succeeded',
    outcomeCode: 'updated',
    principalId: input.actorPrincipalId,
  });
  const summary = yield* getConnectionSummary(input.grantId);
  if (summary === undefined) {
    return yield* new ConnectionInvalid({ code: 'grant_not_found' });
  }
  return summary;
});

/** Summary rows for grants: live modules for active grants (fallback: the requested ceiling). */
const summariesOf = Effect.fn('OAuthConnectionService.summariesOf')(function* (
  tenantId: string,
  rows: readonly GrantRow[],
) {
  const names: PrincipalNames = yield* loadPrincipals(tenantId, [
    ...new Set(rows.flatMap((row) => [row.userPrincipalId, row.actingPrincipalId])),
  ]);
  const legalNames = yield* loadLegalNames(tenantId, [...new Set(rows.map((row) => row.legalEntityId))]);
  return yield* Effect.forEach(
    rows,
    (row) =>
      row.status === 'active'
        ? loadLiveConnection(row.grantId).pipe(
            Effect.option,
            Effect.map((live) => summaryOf(row, names, legalNames, Option.getOrUndefined(live))),
          )
        : Effect.succeed(summaryOf(row, names, legalNames, undefined)),
    { concurrency: 4 },
  );
});

const summaryOf = (
  row: GrantRow,
  names: PrincipalNames,
  legalNames: ReadonlyMap<string, string>,
  live: LiveConnection | undefined,
): ConnectionSummary => {
  const agent = row.actingKind === 'agent';
  const fallbackModules: readonly ConnectionModule[] =
    row.modules === 'all'
      ? []
      : row.modules.map((grant) => ({
          label: moduleLabel(grant.moduleId),
          moduleId: grant.moduleId,
          read: true,
          write: grant.access === 'write',
        }));
  return {
    acting: {
      displayName: names.get(row.actingPrincipalId)?.displayName ?? '',
      kind: row.actingKind,
      principalId: row.actingPrincipalId,
    },
    client: {
      clientId: row.clientId,
      host: row.clientHost,
      kind: row.clientKind,
      logoUri: row.clientLogoUri,
      name: row.clientName,
    },
    createdAt: iso(row.createdAt),
    delegatedBy: agent
      ? { displayName: names.get(row.userPrincipalId)?.displayName ?? '', principalId: row.userPrincipalId }
      : null,
    grantId: row.grantId,
    lastUsedAt: row.lastUsedAt === null ? null : iso(row.lastUsedAt),
    legalEntityId: row.legalEntityId,
    legalName: legalNames.get(row.legalEntityId) ?? row.legalEntityId,
    modules: live?.description.modules ?? fallbackModules,
    profileId: row.profileId,
    requestedModules: row.modules,
    status: row.status,
    tenantId: row.tenantId,
    userDisplayName: names.get(row.userPrincipalId)?.displayName ?? '',
    writePolicy: live?.description.writePolicy ?? row.writePolicy,
  };
};

/** Management list ("Připojené aplikace"); every status except draft unless the filter names statuses. */
export const listConnectionSummaries = Effect.fn('OAuthConnectionService.listConnectionSummaries')(function* (
  filter: GrantListFilter,
) {
  const rows = yield* listGrants(filter);
  return yield* summariesOf(filter.tenantId, rows);
});

/** One summary by grant id; undefined for unknown grants and drafts. */
export const getConnectionSummary = Effect.fn('OAuthConnectionService.getConnectionSummary')(function* (
  grantId: string,
) {
  const grant = yield* findGrant(grantId);
  if (grant === undefined || grant.status === 'draft') {
    return undefined;
  }
  const [summary] = yield* summariesOf(grant.tenantId, [grant]);
  return summary;
});
