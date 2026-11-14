/**
 * Live state of MCP connection grants: every connector exchange and every "Připojené aplikace" read re-checks the
 * grant against OntOS (user, acting principal, binding, company membership, operator relation). A failed check
 * revokes the grant (where the design says so). Nothing is cached, so a change of the person, the agent, its grants or
 * the connection applies to the very next request. Pure checks live in
 * `evaluateLiveChecks`; the database, SpiceDB and catalog reads live in the effects below.
 */
import {
  decideModuleStateAccess,
  OAuthAuthenticationAudit,
  OAuthConnectionCompanies,
  TenantModuleStateService,
} from '@app/core-runtime';
import type { OAuthAgentConnection, OperationalScope, TenantModuleState } from '@app/core-runtime';
import { SubjectAccessInspection, SubjectInspectionUnavailable } from '@app/core-runtime/access/enforcement';
import { AgentIdSchema, LegalEntityIdSchema, PrincipalIdSchema } from '@app/core-runtime/access/ids';
import { AgentConnectionStore, agentConnectionIdOfGrant } from '@app/core-runtime/access/intent/agent-connections';
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
import type { Ref } from 'effect';

import { subjectModuleAccess } from '../agent-platform/caller.ts';
import type { SubjectAccessTrace } from '../agent-platform/caller.ts';
import { composedModulesOf } from '../agent-platform/composed-modules.ts';
import { mcpModulesOf } from '../mcp/catalog.ts';
import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import { ConnectionForbidden, ConnectionInvalid, ConnectionUnauthorized, ConnectionUnavailable } from './errors.ts';
import type { ConnectionUnauthorizedCode } from './errors.ts';
import { OAuthFlow } from './oauth-flow.ts';
import {
  effectiveAuthority,
  isModulesRequestWithin,
  isPolicyWithin,
  minWritePolicy,
  offeredModules,
} from './effective-authority.ts';
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
import { connectionScopeOf } from './connection-scope.ts';
import type { GrantRow } from './types.ts';

/** Facts gathered by `loadLiveConnection` for one grant; every check of `evaluateLiveChecks` reads these. */
export interface LiveFacts {
  readonly actingKind: ConnectionActingKind;
  readonly actingPrincipalStatus: string | undefined;
  /** Always true for `human`. */
  readonly agentInCompany: boolean;
  readonly bindingStatus: string | undefined;
  /** The grant's credential-bound access connection is active and names this agent, operator and company. */
  readonly connectionLive: boolean;
  readonly grantStatus: ConnectionGrantStatus;
  /** The original OAuth owner may select this exact company through the canonical inspection. */
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
  if (agent && !facts.connectionLive) {
    // An agent acts only through its credential-bound connection; without a live one the grant carries nothing.
    return { code: 'grant_inactive', ok: false, revoke: null };
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

/**
 * The credential-bound connection an agent's authority is read through, and the administrator's write policy for the
 * agent. Present exactly for an agent: the gate decides an agent only on its connection, as the agent and on both sides.
 */
export interface ActingAgentConnection {
  readonly connection: OAuthAgentConnection;
  readonly operatorPrincipalId: string;
  readonly writePolicy: ConnectionWritePolicy;
}

/**
 * Read-only connection ceilings, evaluated under the original requester. A person's authority is their own; an agent's
 * is asked of the gate as the agent on its credential-bound connection (with the operator on the other side), so what
 * it offers is exactly what the gate would admit. An agent without a connection has no authority to read.
 */
export const loadActingAuthority = Effect.fn('OAuthConnectionService.loadActingAuthority')(
  function* loadActingAuthority(
    asker: OperationalScope,
    input: {
      readonly actingKind: ConnectionActingKind;
      readonly actingPrincipalId: string;
      readonly agent?: ActingAgentConnection;
      readonly legalEntityId: string;
      readonly tenantId: string;
    },
    /** Receives the inner steps' progress, so a slow or cut-off caller can say which step it was in. */
    trace?: Ref.Ref<SubjectAccessTrace>,
  ) {
    if (asker.tenantId !== input.tenantId || asker.legalEntityId !== input.legalEntityId) {
      return yield* new SubjectInspectionUnavailable({ reason: 'Connection scope differs from requester scope' });
    }
    const { agent } = input;
    if (input.actingKind === 'agent' && agent === undefined) {
      return yield* new SubjectInspectionUnavailable({
        reason: 'An OAuth agent is read only through its credential-bound access connection',
      });
    }
    const subject =
      input.actingKind === 'agent' && agent !== undefined
        ? {
            agentContext: {
              connectionId: agent.connection.connectionId,
              consentRevision: agent.connection.revision,
              principalId: agent.operatorPrincipalId,
            },
            principalId: input.actingPrincipalId,
            tenantId: input.tenantId,
          }
        : { principalId: input.actingPrincipalId, tenantId: input.tenantId };
    // A module is usable only while the tenant's own state admits the access, exactly as its entrypoints are gated,
    // so a connection reaches no other module. The states are read first, and only modules whose state admits a read
    // (every state that admits a write admits a read) are asked about: the answers for any other module were always
    // dropped here, and asking them cost a question, its reads and its evidence for every module the tenant never
    // installed. The gate itself answers over the whole composition (a tenant owner is admitted on every
    // administration declaration, also of a module this tenant never installed).
    const moduleStates = yield* TenantModuleStateService;
    const sets = yield* subjectModuleAccess(
      {
        queryScope: { legalEntityId: input.legalEntityId, tenantId: input.tenantId },
        requesterScope: asker,
        subject,
      },
      trace,
      (moduleIds) =>
        moduleStates.getTenantModuleStates(input.tenantId, moduleIds).pipe(
          Effect.map((states) => {
            const readable = new Set(
              states.flatMap(({ moduleKey, state }) =>
                decideModuleStateAccess(state, 'read') === 'allow' ? [moduleKey] : [],
              ),
            );
            return new Set(moduleIds.filter((moduleId) => readable.has(moduleId)));
          }),
        ),
    );
    const { labelOf } = composedModulesOf(mcpModulesOf(sets.installed.composition));
    // The states are read once more after the decisions, as they were before the first read narrowed the questions: a
    // module deactivated while the description ran (its rights not yet withdrawn from the projection) is dropped. One
    // indexed statement, outside any transaction.
    const answered = [...new Set([...sets.access, ...sets.run, ...sets.propose])];
    const states = yield* moduleStates.getTenantModuleStates(input.tenantId, answered);
    const stateOf = new Map<string, TenantModuleState>(states.map(({ moduleKey, state }) => [moduleKey, state]));
    const admitted = (modules: ReadonlySet<string>, access: 'read' | 'write'): ReadonlySet<string> =>
      new Set(
        [...modules].filter((moduleId) => decideModuleStateAccess(stateOf.get(moduleId) ?? null, access) === 'allow'),
      );
    const run = admitted(sets.run, 'write');
    const propose = admitted(sets.propose, 'write');
    const live: LiveRights = { read: admitted(sets.access, 'read'), write: new Set([...run, ...propose]) };
    // A module the person may only propose to cannot take a direct write, so while one exists the ceiling is approval.
    // The MCP execution path enforces the same thing per call; this keeps the offer and the consent truthful.
    const proposeOnly = [...propose].some((moduleId) => !run.has(moduleId));
    const rightsCap: ConnectionWritePolicy = proposeOnly ? 'approval' : 'direct';
    // An agent never writes beyond the write policy its administrator set for it.
    const policyCap = agent === undefined ? rightsCap : minWritePolicy(rightsCap, agent.writePolicy);
    return { labelOf, live, offered: offeredModules(live, policyCap, labelOf), policyCap };
  },
  Effect.mapError(toUnavailable),
);

export interface LiveConnection {
  /** Exactly for an agent: the credential-bound connection the request's trusted context carries to the gate. */
  readonly agentConnection?: OAuthAgentConnection;
  readonly description: ConnectionDescription;
  readonly grant: GrantRow;
}

/** An active grant whose live checks passed now: who it acts for and the scope its authority is asked in. */
export interface LiveGrant {
  /** Exactly for an agent: the credential-bound connection the live check found active, and the agent's write policy. */
  readonly agent?: ActingAgentConnection;
  readonly grant: GrantRow;
  readonly names: PrincipalNames;
  readonly requesterScope: OperationalScope;
}

const sameConnectionScope = (scope: OperationalScope, grant: GrantRow): boolean =>
  scope.tenantId === grant.tenantId && scope.legalEntityId === grant.legalEntityId;

/**
 * Ends an agent grant's credential-bound access connection for good, so the gate refuses the agent from the next
 * decision on whatever still holds the grant's credential. A person's grant has no connection; nothing happens.
 */
export const endAgentConnectionOf = Effect.fn('OAuthConnectionService.endAgentConnectionOf')(function* endConnection(
  grant: GrantRow,
) {
  if (grant.actingKind !== 'agent') {
    return;
  }
  yield* (yield* AgentConnectionStore)
    .revoke(connectionScopeOf(grant), agentConnectionIdOfGrant(grant.grantId))
    .pipe(Effect.mapError(toUnavailable));
});

/**
 * Side effects after a grant left `active` (its row and binding are already updated): drops its OAuth tokens and
 * consent, ends an agent's access connection and writes `oauth.connection.revoked`.
 */
export const finishRevocation = Effect.fn('OAuthConnectionService.finishRevocation')(function* finishRevocation(input: {
  readonly actorPrincipalId: string | null;
  readonly grant: GrantRow;
  readonly note: string | null;
  readonly reason: ConnectionRevokeReason;
}) {
  // The connection ends first: a revocation already ended it, a supersede ends it here, retried before anything else.
  yield* endAgentConnectionOf(input.grant).pipe(Effect.retry({ times: 2 }));
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
  // An agent's connection ends before the grant changes status: should the status change fail, the agent is
  // already refused, never left acting on a grant someone revoked.
  yield* endAgentConnectionOf(grant);
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
 * The PostgreSQL facts an agent grant re-checks on every request: the agent is an active agent of the company, the
 * grant's person is still one of its operators, the administrator's write policy for it, and the credential-bound
 * connection of this grant is active and names exactly this agent, operator and company.
 */
const liveAgentFactsOf = Effect.fn('OAuthConnectionService.liveAgentFactsOf')(function* liveAgentFactsOf(
  grant: GrantRow,
) {
  const connectionId = agentConnectionIdOfGrant(grant.grantId);
  const facts = yield* (yield* AgentConnectionStore)
    .liveFacts(connectionScopeOf(grant), {
      agentId: AgentIdSchema.make(grant.actingPrincipalId),
      connectionId,
      legalEntityId: LegalEntityIdSchema.make(grant.legalEntityId),
      operatorPrincipalId: PrincipalIdSchema.make(grant.userPrincipalId),
    })
    .pipe(Effect.mapError(toUnavailable));
  const row = Option.getOrUndefined(facts.connection);
  const live =
    row !== undefined &&
    row.status === 'active' &&
    row.agentId === grant.actingPrincipalId &&
    row.principalId === grant.userPrincipalId;
  const now = yield* DateTime.nowAsDate;
  const connection: OAuthAgentConnection | undefined =
    live && now < row.validUntil ? { connectionId: row.connectionId, revision: row.revision } : undefined;
  return {
    agentInCompany: facts.agentInCompany,
    connection,
    operatorHolds: facts.operatorHolds,
    writePolicy: facts.writePolicy,
  };
});

/**
 * The grant that passed its live check. An agent is read in its connection's own scope, now carrying the exact
 * connection the credential is bound to; a person in the scope the check was asked in.
 */
const liveGrantOf = (input: {
  readonly agentFacts: Effect.Success<ReturnType<typeof liveAgentFactsOf>> | undefined;
  readonly asker: OperationalScope | undefined;
  readonly grant: GrantRow;
  readonly names: PrincipalNames;
  readonly requesterScope: OperationalScope;
}): LiveGrant => {
  const { agentFacts, asker, grant, names, requesterScope } = input;
  if (agentFacts?.connection === undefined) {
    return { grant, names, requesterScope };
  }
  return {
    agent: {
      connection: agentFacts.connection,
      operatorPrincipalId: grant.userPrincipalId,
      writePolicy: agentFacts.writePolicy,
    },
    grant,
    names,
    requesterScope: asker ?? connectionScopeOf(grant, agentFacts.connection),
  };
};

/** The agent-only live facts; a person's grant has none to fail, so each is true for it. */
const agentLiveFactsOf = (
  facts: Effect.Success<ReturnType<typeof liveAgentFactsOf>> | undefined,
): Pick<LiveFacts, 'agentInCompany' | 'connectionLive' | 'operatorHolds'> =>
  facts === undefined
    ? { agentInCompany: true, connectionLive: true, operatorHolds: true }
    : {
        agentInCompany: facts.agentInCompany,
        connectionLive: facts.connection !== undefined,
        operatorHolds: facts.operatorHolds,
      };

/**
 * Live check of an active grant, on every call: the grant, its user, acting principal, binding, company selection
 * and (for an agent) its company and operator. A failed check revokes the grant when the verdict says so and then
 * fails with `ConnectionUnauthorized`. It does not describe the grant's authority (`describeLiveGrant`).
 *
 * `asker` is the trusted scope of the person whose surface reads the grant; absent, the request is the
 * connection's own (an MCP call), and the acting principal is evaluated in the connection's own scope.
 */
export const checkLiveGrant = Effect.fn('OAuthConnectionService.checkLiveGrant')(function* checkLiveGrant(
  grantId: string,
  asker?: OperationalScope,
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
  const requesterScope = asker ?? connectionScopeOf(grant);
  if (!sameConnectionScope(requesterScope, grant)) {
    return yield* new ConnectionUnavailable({ cause: 'Connection scope differs from the original requester' });
  }
  const access = yield* (yield* SubjectAccessInspection)
    .scope({
      queryScope: { legalEntityId: grant.legalEntityId, tenantId: grant.tenantId },
      requesterScope,
      subject: { principalId: grant.userPrincipalId, tenantId: grant.tenantId },
    })
    .pipe(Effect.mapError(toUnavailable));
  const agentFacts = agent ? yield* liveAgentFactsOf(grant) : undefined;
  const verdict = evaluateLiveChecks({
    ...agentLiveFactsOf(agentFacts),
    actingKind: grant.actingKind,
    actingPrincipalStatus: names.get(grant.actingPrincipalId)?.status,
    bindingStatus,
    grantStatus: grant.status,
    hasCompanyAccess: access.decision === 'allowed',
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
  return liveGrantOf({ agentFacts, asker, grant, names, requesterScope });
});

/**
 * The current description of a grant that passed `checkLiveGrant`: its acting authority over the installed modules,
 * narrowed by the grant's own ceiling and write policy. Nothing is cached; every call asks the gate again.
 */
export const describeLiveGrant = Effect.fn('OAuthConnectionService.describeLiveGrant')(function* describeLiveGrant(
  liveGrant: LiveGrant,
) {
  const { grant, names, requesterScope } = liveGrant;
  const agent = grant.actingKind === 'agent';
  const acting = {
    actingKind: grant.actingKind,
    actingPrincipalId: grant.actingPrincipalId,
    legalEntityId: grant.legalEntityId,
    tenantId: grant.tenantId,
  };
  const authority = yield* loadActingAuthority(
    requesterScope,
    liveGrant.agent === undefined ? acting : { ...acting, agent: liveGrant.agent },
  );
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
  const live: LiveConnection =
    liveGrant.agent === undefined
      ? { description, grant }
      : { agentConnection: liveGrant.agent.connection, description, grant };
  return live;
});

/** Live check and description of an active grant, on every call (`checkLiveGrant`, then `describeLiveGrant`). */
export const loadLiveConnection = Effect.fn('OAuthConnectionService.loadLiveConnection')(function* loadLiveConnection(
  grantId: string,
  asker?: OperationalScope,
) {
  return yield* describeLiveGrant(yield* checkLiveGrant(grantId, asker));
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

/**
 * One grant's summary as read now. `live` only when its live check passed in this read: only then are its modules and
 * write policy its current rights. A summary that is not live carries the stored grant, which is not a usable right.
 */
export interface ConnectionSummaryRead {
  readonly live: boolean;
  readonly summary: ConnectionSummary;
}

/** Summarizes retained grant rows without querying the same management selection twice. */
export const connectionSummariesOf = Effect.fn('OAuthConnectionService.connectionSummariesOf')(
  function* connectionSummariesOf(tenantId: string, rows: readonly GrantRow[], asker?: OperationalScope) {
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
          ? loadLiveConnection(row.grantId, asker).pipe(
              Effect.option,
              Effect.map((live) => ({
                live: Option.isSome(live),
                summary: summaryOf(row, names, legalNames, Option.getOrUndefined(live), labelOf),
              })),
            )
          : Effect.succeed({ live: false, summary: summaryOf(row, names, legalNames, undefined, labelOf) }),
      // loadLiveConnection eventually opens two authority reads; keep room for the PostgreSQL connection.
      { concurrency: 2 },
    );
  },
);

/** Changes the module ceiling and write policy of an active grant; both must stay within the actor's authority. */
export const updateConnection = Effect.fn('OAuthConnectionService.updateConnection')(function* updateConnection(
  asker: OperationalScope,
  input: {
    readonly actorPrincipalId: string;
    readonly grantId: string;
    readonly modules: ConnectionModulesRequest;
    readonly writePolicy: ConnectionWritePolicy;
  },
) {
  const grant = yield* findGrant(input.grantId);
  if (grant === undefined || grant.status !== 'active') {
    return yield* new ConnectionInvalid({ code: 'grant_not_found' });
  }
  if (!sameConnectionScope(asker, grant)) {
    return yield* new ConnectionUnavailable({ cause: 'Connection scope differs from the original requester' });
  }
  const authority = yield* loadActingAuthority(asker, {
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
  const [read] = yield* connectionSummariesOf(grant.tenantId, [updated], asker);
  if (read === undefined) {
    return yield* new ConnectionInvalid({ code: 'grant_not_found' });
  }
  return read.summary;
});
