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
import type { OperationalScope } from '@app/core-runtime';
import {
  ConnectionClientIdSchema,
  ConnectionGrantIdSchema,
  ConnectionLegalEntityIdSchema,
  ConnectionModulesRequestSchema,
  ConnectionPrincipalIdSchema,
  ConnectionProfileIdSchema,
  OAUTH_DRAFT_TTL_SECONDS,
} from '@app/shared-contracts/oauth-connections';
import { Clock, Crypto, Duration, Effect, Exit, Option, Ref, Schema } from 'effect';

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
  /** The actual session requester; read-only subject queries retain this object unchanged. */
  readonly scope: OperationalScope;
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
  const agent = company?.agents.find((candidate) => candidate.principalId === input.requestedAgent);
  return {
    agentPrincipalId: Option.fromUndefinedOr(agent?.principalId),
    legalEntityId: Option.fromUndefinedOr(company?.legalEntityId),
  };
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
  const foundClient = yield* flow.findClient(verified.clientId);
  if (Option.isNone(foundClient)) {
    return yield* new ConnectionInvalid({ code: 'oauth_query_invalid' });
  }
  const clientInfo = foundClient.value;
  const client: ConnectionClient = {
    clientId: ConnectionClientIdSchema.make(clientInfo.clientId),
    host: redirectHostOf(verified.redirectUri),
    kind: clientKindOf(verified.redirectUri),
    logoUri: Option.fromNullOr(clientInfo.logoUri),
    name: clientInfo.name,
  };
  return { client, verified };
});

/** The SpiceDB reads of the options build: one bulk operate check, then one companies read per operable agent. */
export interface AgentDirectory {
  readonly canOperateMany: (
    agentPrincipalIds: readonly string[],
    operatorPrincipalId: string,
  ) => Effect.Effect<ReadonlyMap<string, boolean>, ConnectionUnavailable>;
  readonly companiesOf: (
    agentPrincipalIds: readonly string[],
  ) => Effect.Effect<ReadonlyMap<string, readonly string[]>, ConnectionUnavailable>;
}

/** Each call opens one SpiceDB client and closes it again; the build calls each at most once. */
const liveAgentDirectory: AgentDirectory = {
  canOperateMany: (agentPrincipalIds, operatorPrincipalId) =>
    agentPrincipalIds.length === 0
      ? Effect.succeed(new Map<string, boolean>())
      : openPrincipalOperators.pipe(
          Effect.flatMap((operators) => operators.canOperateMany(agentPrincipalIds, operatorPrincipalId)),
          Effect.scoped,
          Effect.mapError(toUnavailable),
        ),
  companiesOf: (agentPrincipalIds) =>
    agentPrincipalIds.length === 0
      ? Effect.succeed(new Map<string, readonly string[]>())
      : openDemoAccountGrants.pipe(
          Effect.flatMap((grants) =>
            Effect.forEach(
              agentPrincipalIds,
              (agentPrincipalId) =>
                grants
                  .companiesOf(agentPrincipalId)
                  .pipe(Effect.map((companies) => [agentPrincipalId, companies] as const)),
              { concurrency: 4 },
            ),
          ),
          Effect.map((entries) => new Map(entries)),
          Effect.scoped,
          Effect.mapError(toUnavailable),
        ),
};

const OptionsPhaseSchema = Schema.Literals([
  'agentCompanies',
  'canOperate',
  'companyAuthority',
  'listAgents',
  'verifyClient',
]);
type OptionsPhase = typeof OptionsPhaseSchema.Type;

/** One options build's progress. Kept in a Ref so a build that stalls or is cut off still names its active phase. */
interface OptionsTrace {
  readonly active: OptionsPhase | null;
  readonly agents: number;
  readonly budgetExceeded: boolean;
  readonly companies: number;
  readonly durations: Partial<Record<OptionsPhase, number>>;
  readonly operableAgents: number;
}

interface OptionsTiming {
  readonly count: (update: Partial<Pick<OptionsTrace, 'agents' | 'operableAgents'>>) => Effect.Effect<void>;
  readonly phase: <Value, Failure, Requirements>(
    phase: OptionsPhase,
    effect: Effect.Effect<Value, Failure, Requirements>,
  ) => Effect.Effect<Value, Failure, Requirements>;
}

const makeTiming = (trace: Ref.Ref<OptionsTrace>): OptionsTiming => {
  const phase = Effect.fn('OAuthConnectService.phase')(function* timedPhase<Value, Failure, Requirements>(
    name: OptionsPhase,
    effect: Effect.Effect<Value, Failure, Requirements>,
  ) {
    yield* Ref.update(trace, (current) => ({ ...current, active: name }));
    const startedAt = yield* Clock.currentTimeMillis;
    const value = yield* effect;
    const finishedAt = yield* Clock.currentTimeMillis;
    yield* Ref.update(trace, (current) => ({
      ...current,
      active: null,
      durations: { ...current.durations, [name]: finishedAt - startedAt },
    }));
    return value;
  });
  return {
    count: (update) => Ref.update(trace, (current) => ({ ...current, ...update })),
    phase,
  };
};

/** Active agents the session person may operate, with the companies each agent belongs to. */
const operableAgents = Effect.fn('OAuthConnectService.operableAgents')(function* operableAgents(
  session: ConnectSession,
  directory: AgentDirectory,
  timing: OptionsTiming,
) {
  const agents = yield* timing.phase('listAgents', listAgentPrincipals(session.tenantId));
  yield* timing.count({ agents: agents.length });
  const operable = yield* timing.phase(
    'canOperate',
    directory.canOperateMany(
      agents.map((agent) => agent.principalId),
      session.principalId,
    ),
  );
  const candidates = agents.filter((agent) => operable.get(agent.principalId) === true);
  yield* timing.count({ operableAgents: candidates.length });
  const companies = yield* timing.phase(
    'agentCompanies',
    directory.companiesOf(candidates.map((agent) => agent.principalId)),
  );
  return candidates.map((agent) => ({ ...agent, companies: companies.get(agent.principalId) ?? [] }));
});

/** Longest a consent options build may run; below the 30 s request budget, so a stall ends as a retryable 503. */
const CONNECT_OPTIONS_BUDGET = Duration.seconds(20);
/** A build slower than this logs one line with every phase's duration. */
const SLOW_OPTIONS_MILLIS = 3000;
/** Cause of the budget failure; `toProblem` maps it to the same retryable 503 as any unavailable build. */
export const OPTIONS_BUDGET_CAUSE = 'connect options exceeded budget';

/** The acting-authority read of one company or agent: `loadActingAuthority` in production, a double in tests. */
type ActingAuthority = Effect.Success<ReturnType<typeof loadActingAuthority>>;
type ActingAuthorityInput = Parameters<typeof loadActingAuthority>[1];

/** What an options build reads beyond the OAuth query and the session. Production wires the live ones. */
export interface ConnectOptionsPorts<Requirements> {
  readonly agents: AgentDirectory;
  readonly authorityOf: (
    asker: OperationalScope,
    input: ActingAuthorityInput,
  ) => Effect.Effect<ActingAuthority, ConnectionUnavailable, Requirements>;
}

interface OptionsBuild<Requirements> {
  readonly ports: ConnectOptionsPorts<Requirements>;
  readonly request: ConnectOptionsRequest;
  readonly session: ConnectSession;
  readonly timing: OptionsTiming;
}

const buildOptions = Effect.fn('OAuthConnectService.buildOptions')(function* buildOptions<Requirements>({
  ports,
  request,
  session,
  timing,
}: OptionsBuild<Requirements>) {
  const { client, verified } = yield* timing.phase('verifyClient', verifiedClient(request.oauthQuery));
  const user = { displayName: session.displayName, principalId: ConnectionPrincipalIdSchema.make(session.principalId) };
  if (session.companies.length === 0) {
    return {
      client,
      companies: [],
      preselect: { agentPrincipalId: Option.none(), legalEntityId: Option.none() },
      state: 'access_blocked',
      user,
    } satisfies ConnectOptions;
  }
  const agents = yield* operableAgents(session, ports.agents, timing);
  const agentOption = Effect.fn('OAuthConnectService.agentOption')(function* agentOption(
    legalEntityId: string,
    agent: { readonly displayName: string; readonly principalId: string },
  ) {
    const authority = yield* ports.authorityOf(session.scope, {
      actingKind: 'agent',
      actingPrincipalId: agent.principalId,
      legalEntityId,
      tenantId: session.scope.tenantId,
    });
    return {
      displayName: agent.displayName,
      modules: authority.offered,
      principalId: ConnectionPrincipalIdSchema.make(agent.principalId),
      writePolicy: authority.policyCap,
    } satisfies ConnectAgentOption;
  });
  const companyOption = Effect.fn('OAuthConnectService.companyOption')(function* companyOption(
    company: ConnectSession['companies'][number],
  ) {
    const own = yield* ports.authorityOf(session.scope, {
      actingKind: 'human',
      actingPrincipalId: session.principalId,
      legalEntityId: company.legalEntityId,
      tenantId: session.scope.tenantId,
    });
    const agentOptions = yield* Effect.forEach(
      agents.filter((agent) => agent.companies.includes(company.legalEntityId)),
      (agent) => agentOption(company.legalEntityId, agent),
      { concurrency: 4 },
    );
    return {
      agents: agentOptions,
      legalEntityId: ConnectionLegalEntityIdSchema.make(company.legalEntityId),
      legalName: company.legalName,
      modules: own.offered,
    } satisfies ConnectCompanyOption;
  });
  const companies = yield* timing.phase(
    'companyAuthority',
    Effect.forEach(session.companies, companyOption, { concurrency: 4 }),
  );
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

const outcomeOf = (exit: Exit.Exit<unknown, unknown>, state: OptionsTrace): string => {
  if (Exit.isSuccess(exit)) {
    return 'ok';
  }
  return state.budgetExceeded ? 'budget_exceeded' : 'failed';
};

/** One warning with the phase durations and counts when the build was slow. Fixed names only: no identities or tokens. */
const logSlowOptions = Effect.fn('OAuthConnectService.logSlowOptions')(function* logSlowOptions(input: {
  readonly exit: Exit.Exit<unknown, unknown>;
  readonly startedAt: number;
  readonly trace: Ref.Ref<OptionsTrace>;
}) {
  const totalMs = (yield* Clock.currentTimeMillis) - input.startedAt;
  if (totalMs <= SLOW_OPTIONS_MILLIS) {
    return;
  }
  const state = yield* Ref.get(input.trace);
  yield* Effect.logWarning('OAuth connect options slow').pipe(
    Effect.annotateLogs({
      activePhase: state.active ?? 'none',
      agentCompaniesMs: state.durations.agentCompanies ?? null,
      agents: state.agents,
      canOperateMs: state.durations.canOperate ?? null,
      companies: state.companies,
      companyAuthorityMs: state.durations.companyAuthority ?? null,
      listAgentsMs: state.durations.listAgents ?? null,
      operableAgents: state.operableAgents,
      outcome: outcomeOf(input.exit, state),
      totalMs,
      verifyClientMs: state.durations.verifyClient ?? null,
    }),
  );
});

/** The consent chooser's options with the given ports, bounded by the budget and timed per phase. */
export const connectOptionsWith = <Requirements>(ports: ConnectOptionsPorts<Requirements>) =>
  Effect.fn('OAuthConnectService.connectOptions')(function* connectOptions(
    session: ConnectSession,
    request: ConnectOptionsRequest,
  ) {
    const trace = yield* Ref.make<OptionsTrace>({
      active: null,
      agents: 0,
      budgetExceeded: false,
      companies: session.companies.length,
      durations: {},
      operableAgents: 0,
    });
    const startedAt = yield* Clock.currentTimeMillis;
    return yield* buildOptions({ ports, request, session, timing: makeTiming(trace) }).pipe(
      Effect.timeoutOrElse({
        duration: CONNECT_OPTIONS_BUDGET,
        orElse: () =>
          Ref.update(trace, (current) => ({ ...current, budgetExceeded: true })).pipe(
            Effect.andThen(Effect.fail(new ConnectionUnavailable({ cause: OPTIONS_BUDGET_CAUSE }))),
          ),
      }),
      Effect.onExit((exit) => logSlowOptions({ exit, startedAt, trace })),
    );
  });

export const connectOptions = connectOptionsWith({ agents: liveAgentDirectory, authorityOf: loadActingAuthority });

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
  if (Option.isSome(request.actingPrincipalId)) {
    const agentId = request.actingPrincipalId.value;
    if (!(yield* mayActAsAgent(session, agentId, request.legalEntityId))) {
      return yield* new ConnectionForbidden({
        code: 'acting_principal_forbidden',
        reason: 'Za tohoto agenta nesmíte jednat.',
      });
    }
    actingKind = 'agent';
    actingPrincipalId = agentId;
  }
  const authority = yield* loadActingAuthority(session.scope, {
    actingKind,
    actingPrincipalId,
    legalEntityId: request.legalEntityId,
    tenantId: session.scope.tenantId,
  });
  if (!isPolicyWithin(request.writePolicy, authority.policyCap)) {
    return yield* new ConnectionForbidden({
      code: 'write_policy_forbidden',
      reason: 'Požadovaný způsob zápisu není pro toto připojení povolen.',
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
    clientLogoUri: Option.getOrNull(client.logoUri),
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
  return { grantId: ConnectionGrantIdSchema.make(row.grantId) } satisfies ConnectDraftResponse;
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
  if (grant.tenantId !== session.scope.tenantId || grant.legalEntityId !== session.scope.legalEntityId) {
    return yield* new ConnectionUnavailable({ cause: 'Retained connection scope differs from original requester' });
  }
  const agent = grant.actingKind === 'agent';
  const actingName = agent
    ? ((yield* loadPrincipals(grant.tenantId, [grant.actingPrincipalId])).get(grant.actingPrincipalId)?.displayName ??
      '')
    : session.displayName;
  const legalName = (yield* (yield* OAuthConnectionCompanies)
    .names(grant.tenantId, [grant.legalEntityId])
    .pipe(Effect.mapError(toUnavailable))).get(grant.legalEntityId);
  const authority = yield* loadActingAuthority(session.scope, {
    actingKind: grant.actingKind,
    actingPrincipalId: grant.actingPrincipalId,
    legalEntityId: grant.legalEntityId,
    tenantId: grant.tenantId,
  });
  return {
    acting: {
      displayName: actingName,
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
    delegatedBy: agent
      ? Option.some({
          displayName: session.displayName,
          principalId: ConnectionPrincipalIdSchema.make(session.principalId),
        })
      : Option.none(),
    grantId: ConnectionGrantIdSchema.make(grant.grantId),
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
  return {
    grantId: ConnectionGrantIdSchema.make(active.grantId),
    profileId: ConnectionProfileIdSchema.make(active.profileId),
    status: 'active',
  } satisfies ConnectApproveResponse;
});

export const deny = Effect.fn('OAuthConnectService.deny')(function* deny(
  session: ConnectSession,
  request: ConnectDenyRequest,
) {
  const verified = yield* (yield* OAuthFlow).verifyQuery(request.oauthQuery);
  if (Option.isSome(request.grantId)) {
    const grant = yield* findGrant(request.grantId.value);
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
