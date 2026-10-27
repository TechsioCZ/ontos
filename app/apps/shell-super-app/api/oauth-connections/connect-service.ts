/**
 * Shell connect flow of MCP connections (screens /cs/pripojit and /cs/pripojit/souhlas, design §3.1, §3.3–§3.4,
 * §4.1, §7.1): options for the chooser, the draft grant, its summary, approval (supersedes the previous grant of the
 * same user, company, acting principal and client, reusing its profile id) and denial. Pure helpers are exported for
 * unit tests; the HTTP mapping lives in connect-http.ts.
 */
import {
  OAuthAuthenticationAudit,
  OAuthConnectionCompanies,
  openDemoAccountGrants,
  openPrincipalOperators,
} from '@app/core-runtime';
import type {
  ConnectAgentOption,
  ConnectApproveRequest,
  ConnectApproveResponse,
  ConnectCompanyOption,
  ConnectDenyRequest,
  ConnectDenyResponse,
  ConnectDraftRequest,
  ConnectDraftResponse,
  ConnectDraftSummary,
  ConnectDraftSummaryRequest,
  ConnectOptions,
  ConnectOptionsRequest,
  ConnectionActingKind,
  ConnectionClient,
  ConnectionModulesRequest,
} from '@app/shared-contracts/oauth-connections';
import { ConnectionModulesRequestSchema, OAUTH_DRAFT_TTL_SECONDS } from '@app/shared-contracts/oauth-connections';
import { Clock, Crypto, Duration, Effect, Schema } from 'effect';

import { finishRevocation, loadActingAuthority } from './connection-service.ts';
import { effectiveAuthority, isModulesRequestWithin, isPolicyWithin, minWritePolicy } from './effective-authority.ts';
import { ConnectionForbidden, ConnectionInvalid, ConnectionUnavailable } from './errors.ts';
import {
  approveDraftGrant,
  findGrant,
  findPreviousProfileId,
  findSessionGrant,
  insertDraftGrant,
  listAgentPrincipals,
  loadPrincipals,
  setGrantStatus,
} from './grant-store.ts';
import type { VerifiedOAuthQuery } from './oauth-flow.ts';
import { OAuthFlow, clientKindOf, redirectHostOf } from './oauth-flow.ts';
import { loadOAuthServerConfig } from './server-config.ts';
import type { GrantRow } from './types.ts';

/** The signed-in shell session behind a connect request (resolved by connect-http.ts). */
export interface ConnectSession {
  readonly activeLegalEntityId: string | null;
  readonly authBindingId: string | undefined;
  readonly companies: readonly { readonly legalEntityId: string; readonly legalName: string }[];
  readonly displayName: string;
  readonly principalId: string;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly userId: string;
}

/** Pure: the client's redirect URI with `error=access_denied`, the original `state` and `iss` (RFC 9207). */
export const buildDenyRedirect = (verified: VerifiedOAuthQuery, issuer: string): string => {
  const url = new URL(verified.redirectUri);
  url.searchParams.set('error', 'access_denied');
  if (verified.state !== null) {
    url.searchParams.set('state', verified.state);
  }
  url.searchParams.set('iss', issuer);
  return url.href;
};

/** Pure: pre-selection from `?company=` / `?agent=`, the active shell company or the only offered company. */
export const choosePreselect = (input: {
  readonly activeLegalEntityId: string | null;
  readonly companies: readonly ConnectCompanyOption[];
  readonly requestedAgent: string | null;
  readonly requestedCompany: string | null;
}): ConnectOptions['preselect'] => {
  const offered = (legalEntityId: string | null) =>
    legalEntityId === null ? undefined : input.companies.find((company) => company.legalEntityId === legalEntityId);
  const company =
    offered(input.requestedCompany) ??
    offered(input.activeLegalEntityId) ??
    (input.companies.length === 1 ? input.companies[0] : undefined);
  const agentPrincipalId =
    company !== undefined &&
    input.requestedAgent !== null &&
    company.agents.some((agent) => agent.principalId === input.requestedAgent)
      ? input.requestedAgent
      : null;
  return { agentPrincipalId, legalEntityId: company?.legalEntityId ?? null };
};

const ModulesJson = Schema.fromJsonString(ConnectionModulesRequestSchema);

const toUnavailable = (cause: unknown): ConnectionUnavailable =>
  Schema.is(Schema.instanceOf(ConnectionUnavailable))(cause) ? cause : new ConnectionUnavailable({ cause });

const modulesJson = (modules: ConnectionModulesRequest) =>
  Schema.encodeEffect(ModulesJson)(modules).pipe(Effect.mapError(toUnavailable));

const companiesOfAgent = (agentPrincipalId: string) =>
  openDemoAccountGrants.pipe(
    Effect.flatMap((grants) => grants.companiesOf(agentPrincipalId)),
    Effect.scoped,
    Effect.mapError(toUnavailable),
  );

const canOperateAgent = (agentPrincipalId: string, operatorPrincipalId: string) =>
  openPrincipalOperators.pipe(
    Effect.flatMap((operators) => operators.canOperate(agentPrincipalId, operatorPrincipalId)),
    Effect.scoped,
    Effect.mapError(toUnavailable),
  );

/** The agent is active, belongs to the company and the session person may operate it (`principal#operate`). */
const mayActAsAgent = Effect.fn('OAuthConnectService.mayActAsAgent')(function* mayActAsAgent(
  session: ConnectSession,
  agentPrincipalId: string,
  legalEntityId: string,
) {
  const active = (yield* listAgentPrincipals(session.tenantId)).some((agent) => agent.principalId === agentPrincipalId);
  return (
    active &&
    (yield* companiesOfAgent(agentPrincipalId)).includes(legalEntityId) &&
    (yield* canOperateAgent(agentPrincipalId, session.principalId))
  );
});

/** Verified OAuth query and the client it names (unknown client = invalid query). */
const verifiedClient = Effect.fn('OAuthConnectService.verifiedClient')(function* verifiedClient(oauthQuery: string) {
  const flow = yield* OAuthFlow;
  const verified = yield* flow.verifyQuery(oauthQuery);
  const clientInfo = yield* flow.findClient(verified.clientId);
  if (clientInfo === undefined) {
    return yield* new ConnectionInvalid({ code: 'oauth_query_invalid' });
  }
  const client: ConnectionClient = {
    clientId: clientInfo.clientId,
    host: redirectHostOf(verified.redirectUri),
    kind: clientKindOf(verified.redirectUri),
    logoUri: clientInfo.logoUri,
    name: clientInfo.name,
  };
  return { client, verified };
});

/** Active agents the session person may operate, with the companies each agent belongs to. */
const operableAgents = Effect.fn('OAuthConnectService.operableAgents')(function* operableAgents(
  session: ConnectSession,
) {
  const agents = yield* listAgentPrincipals(session.tenantId);
  const checked = yield* Effect.forEach(
    agents,
    Effect.fn('OAuthConnectService.checkAgent')(function* checkAgent(agent) {
      const operable = yield* canOperateAgent(agent.principalId, session.principalId);
      const companies = operable ? yield* companiesOfAgent(agent.principalId) : [];
      return { ...agent, companies, operable };
    }),
    { concurrency: 4 },
  );
  return checked.filter((agent) => agent.operable);
});

export const connectOptions = Effect.fn('OAuthConnectService.connectOptions')(function* connectOptions(
  session: ConnectSession,
  request: ConnectOptionsRequest,
) {
  const { client, verified } = yield* verifiedClient(request.oauthQuery);
  const user = { displayName: session.displayName, principalId: session.principalId };
  if (session.companies.length === 0) {
    return {
      client,
      companies: [],
      preselect: { agentPrincipalId: null, legalEntityId: null },
      state: 'access_blocked',
      user,
    } satisfies ConnectOptions;
  }
  const agents = yield* operableAgents(session);
  const agentOption = Effect.fn('OAuthConnectService.agentOption')(function* agentOption(
    legalEntityId: string,
    agent: { readonly displayName: string; readonly principalId: string },
  ) {
    const authority = yield* loadActingAuthority({
      actingKind: 'agent',
      actingPrincipalId: agent.principalId,
      legalEntityId,
      tenantId: session.tenantId,
    });
    return {
      displayName: agent.displayName,
      modules: authority.offered,
      principalId: agent.principalId,
      writePolicy: authority.policyCap,
    } satisfies ConnectAgentOption;
  });
  const companyOption = Effect.fn('OAuthConnectService.companyOption')(function* companyOption(
    company: ConnectSession['companies'][number],
  ) {
    const own = yield* loadActingAuthority({
      actingKind: 'human',
      actingPrincipalId: session.principalId,
      legalEntityId: company.legalEntityId,
      tenantId: session.tenantId,
    });
    const agentOptions = yield* Effect.forEach(
      agents.filter((agent) => agent.companies.includes(company.legalEntityId)),
      (agent) => agentOption(company.legalEntityId, agent),
      { concurrency: 4 },
    );
    return {
      agents: agentOptions,
      legalEntityId: company.legalEntityId,
      legalName: company.legalName,
      modules: own.offered,
    } satisfies ConnectCompanyOption;
  });
  const companies = yield* Effect.forEach(session.companies, companyOption, { concurrency: 4 });
  return {
    client,
    companies,
    preselect: choosePreselect({
      activeLegalEntityId: session.activeLegalEntityId,
      companies,
      requestedAgent: verified.agent,
      requestedCompany: verified.company,
    }),
    state: 'ready',
    user,
  } satisfies ConnectOptions;
});

export const createDraft = Effect.fn('OAuthConnectService.createDraft')(function* createDraft(
  session: ConnectSession,
  request: ConnectDraftRequest,
) {
  const { client } = yield* verifiedClient(request.oauthQuery);
  if (!session.companies.some((company) => company.legalEntityId === request.legalEntityId)) {
    return yield* new ConnectionForbidden({ code: 'access_blocked', reason: 'K této firmě nemáte přístup.' });
  }
  let actingKind: ConnectionActingKind = 'human';
  let actingPrincipalId = session.principalId;
  if (request.actingPrincipalId !== null) {
    const agentId = request.actingPrincipalId;
    if (!(yield* mayActAsAgent(session, agentId, request.legalEntityId))) {
      return yield* new ConnectionForbidden({
        code: 'acting_principal_forbidden',
        reason: 'Za tohoto agenta nesmíte jednat.',
      });
    }
    actingKind = 'agent';
    actingPrincipalId = agentId;
  }
  const authority = yield* loadActingAuthority({
    actingKind,
    actingPrincipalId,
    legalEntityId: request.legalEntityId,
    tenantId: session.tenantId,
  });
  if (!isPolicyWithin(request.writePolicy, authority.policyCap)) {
    return yield* new ConnectionForbidden({
      code: 'write_policy_forbidden',
      reason:
        authority.policyCap === 'read_only'
          ? 'Agent smí jen číst (nastavení agenta).'
          : 'Agent smí jen navrhovat změny (nastavení agenta).',
    });
  }
  if (!isModulesRequestWithin(request.modules, authority.offered)) {
    return yield* new ConnectionInvalid({ code: 'modules_invalid' });
  }
  const profileId =
    (yield* findPreviousProfileId({
      actingPrincipalId,
      clientId: client.clientId,
      legalEntityId: request.legalEntityId,
      userId: session.userId,
    })) ?? (yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4()).pipe(Effect.mapError(toUnavailable)));
  // Picked modules without any write box can change nothing, so the draft (and consent) says read-only.
  const writePolicy =
    request.modules !== 'all' && !request.modules.some((grant) => grant.access === 'write')
      ? 'read_only'
      : request.writePolicy;
  const row = yield* insertDraftGrant({
    actingKind,
    actingPrincipalId,
    clientHost: client.host,
    clientId: client.clientId,
    clientKind: client.kind,
    clientLogoUri: client.logoUri,
    clientName: client.name,
    legalEntityId: request.legalEntityId,
    modules: request.modules,
    profileId,
    sessionId: session.sessionId,
    tenantId: session.tenantId,
    userId: session.userId,
    userPrincipalId: session.principalId,
    writePolicy,
  });
  return { grantId: row.grantId } satisfies ConnectDraftResponse;
});

export const draftSummary = Effect.fn('OAuthConnectService.draftSummary')(function* draftSummary(
  session: ConnectSession,
  request: ConnectDraftSummaryRequest,
) {
  const verified = yield* (yield* OAuthFlow).verifyQuery(request.oauthQuery);
  const grant = yield* findSessionGrant({ sessionId: session.sessionId, userId: session.userId });
  if (grant?.status === 'active' && grant.clientId === verified.clientId) {
    return yield* new ConnectionInvalid({ code: 'connection_active' });
  }
  if (grant === undefined || grant.status !== 'draft' || grant.clientId !== verified.clientId) {
    return yield* new ConnectionInvalid({ code: 'draft_not_found' });
  }
  const agent = grant.actingKind === 'agent';
  const actingName = agent
    ? ((yield* loadPrincipals(grant.tenantId, [grant.actingPrincipalId])).get(grant.actingPrincipalId)?.displayName ??
      '')
    : session.displayName;
  const legalName = (yield* (yield* OAuthConnectionCompanies)
    .names(grant.tenantId, [grant.legalEntityId])
    .pipe(Effect.mapError(toUnavailable))).get(grant.legalEntityId);
  const authority = yield* loadActingAuthority({
    actingKind: grant.actingKind,
    actingPrincipalId: grant.actingPrincipalId,
    legalEntityId: grant.legalEntityId,
    tenantId: grant.tenantId,
  });
  return {
    acting: {
      displayName: actingName,
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
    delegatedBy: agent ? { displayName: session.displayName, principalId: session.principalId } : null,
    grantId: grant.grantId,
    legalName: legalName ?? grant.legalEntityId,
    modules:
      grant.modules === 'all'
        ? 'all'
        : effectiveAuthority({
            labelOf: authority.labelOf,
            live: authority.live,
            policyCap: authority.policyCap,
            requested: grant.modules,
            requestedPolicy: grant.writePolicy,
          }).modules,
    writePolicy: minWritePolicy(grant.writePolicy, authority.policyCap),
  } satisfies ConnectDraftSummary;
});

/** A draft this session created for this client that has not expired yet. */
const isOwnFreshDraft = (grant: GrantRow, session: ConnectSession, clientId: string, nowMillis: number): boolean =>
  grant.status === 'draft' &&
  grant.sessionId === session.sessionId &&
  grant.userId === session.userId &&
  grant.clientId === clientId &&
  nowMillis - grant.createdAt.getTime() <= Duration.toMillis(Duration.seconds(OAUTH_DRAFT_TTL_SECONDS));

export const approve = Effect.fn('OAuthConnectService.approve')(function* approve(
  session: ConnectSession,
  request: ConnectApproveRequest,
) {
  const verified = yield* (yield* OAuthFlow).verifyQuery(request.oauthQuery);
  const grant = yield* findGrant(request.grantId);
  const now = yield* Clock.currentTimeMillis;
  if (grant === undefined || !isOwnFreshDraft(grant, session, verified.clientId, now)) {
    return yield* new ConnectionInvalid({ code: 'draft_not_found' });
  }
  // The agent may have been deactivated, deleted or the person removed from its operators since the draft.
  if (grant.actingKind === 'agent' && !(yield* mayActAsAgent(session, grant.actingPrincipalId, grant.legalEntityId))) {
    yield* setGrantStatus({
      grantId: grant.grantId,
      revokedByPrincipalId: session.principalId,
      revokeReason: null,
      status: 'denied',
    });
    return yield* new ConnectionForbidden({
      code: 'acting_principal_forbidden',
      reason:
        'Agent byl mezitím deaktivován nebo smazán, nebo ho už nesmíte připojit. Připojení se nevytvořilo; spusťte ho znovu.',
    });
  }
  const approved = yield* approveDraftGrant({ actorPrincipalId: session.principalId, grant });
  if (approved === undefined) {
    return yield* new ConnectionInvalid({ code: 'draft_not_found' });
  }
  const { active, superseded } = approved;
  yield* Effect.forEach(
    superseded,
    (old) => finishRevocation({ actorPrincipalId: session.principalId, grant: old, note: null, reason: 'superseded' }),
    { concurrency: 1, discard: true },
  );
  const agent = grant.actingKind === 'agent';
  yield* (yield* OAuthAuthenticationAudit)
    .record({
      authBindingId: session.authBindingId ?? null,
      authMethod: 'session',
      eventType: 'oauth.connection.created',
      evidence: {
        actingPrincipalId: grant.actingPrincipalId,
        clientKind: grant.clientKind,
        delegatedByPrincipalId: agent ? session.principalId : null,
        legalEntityId: grant.legalEntityId,
        modules: yield* modulesJson(grant.modules),
        writePolicy: grant.writePolicy,
      },
      grant: active,
      outcome: 'succeeded',
      outcomeCode: 'connection_created',
      principalId: session.principalId,
    })
    .pipe(Effect.mapError(toUnavailable));
  return { grantId: active.grantId, profileId: active.profileId, status: 'active' } satisfies ConnectApproveResponse;
});

export const deny = Effect.fn('OAuthConnectService.deny')(function* deny(
  session: ConnectSession,
  request: ConnectDenyRequest,
) {
  const verified = yield* (yield* OAuthFlow).verifyQuery(request.oauthQuery);
  if (request.grantId !== null) {
    const grant = yield* findGrant(request.grantId);
    if (
      grant !== undefined &&
      grant.status === 'draft' &&
      grant.sessionId === session.sessionId &&
      grant.userId === session.userId
    ) {
      const denied = yield* setGrantStatus({
        grantId: grant.grantId,
        revokedByPrincipalId: session.principalId,
        revokeReason: null,
        status: 'denied',
      });
      yield* (yield* OAuthAuthenticationAudit)
        .record({
          authBindingId: session.authBindingId ?? null,
          authMethod: 'session',
          eventType: 'oauth.connection.denied',
          evidence: { actingPrincipalId: grant.actingPrincipalId, clientKind: grant.clientKind },
          grant: denied ?? grant,
          outcome: 'denied',
          outcomeCode: 'access_denied',
          principalId: session.principalId,
        })
        .pipe(Effect.mapError(toUnavailable));
    }
  }
  const config = yield* loadOAuthServerConfig;
  return { redirectTo: buildDenyRedirect(verified, config.issuer), status: 'denied' } satisfies ConnectDenyResponse;
});
