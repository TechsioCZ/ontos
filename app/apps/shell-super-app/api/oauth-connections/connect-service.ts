/**
 * Shell connect flow of MCP connections (screens /cs/pripojit and /cs/pripojit/souhlas, design §3.1, §3.3–§3.4,
 * §4.1, §7.1): options for the chooser, the draft grant, its summary, approval (supersedes the previous grant of the
 * same user, company, acting principal and client, reusing its profile id) and denial. Pure helpers are exported for
 * unit tests; the HTTP mapping lives in connect-http.ts.
 */
import { OAuthAuthenticationAudit, OAuthConnectionCompanies } from '@app/core-runtime';
import type {
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

import { emptySubjectAccessTrace } from '../agent-platform/caller.ts';
import type { SubjectAccessTrace } from '../agent-platform/caller.ts';
import { finishRevocation, loadActingAuthority } from './connection-service.ts';
import { effectiveAuthority, isModulesRequestWithin, isPolicyWithin, minWritePolicy } from './effective-authority.ts';
import { ConnectionForbidden, ConnectionInvalid, ConnectionUnavailable } from './errors.ts';
import {
  approveDraftGrant,
  findGrant,
  findPreviousProfileId,
  findSessionGrant,
  insertDraftGrant,
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

/** Refusal of a draft that would act as an agent: no OAuth agent has a credential-bound connection. */
const AGENT_REFUSAL = 'Za tohoto agenta nesmíte jednat.';
/** Refusal of a write policy the person's current authority does not reach. */
const WRITE_POLICY_REFUSAL = 'Požadovaný způsob zápisu není pro toto připojení povolen.';

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

const OptionsPhaseSchema = Schema.Literals(['companyAuthority', 'verifyClient']);
type OptionsPhase = typeof OptionsPhaseSchema.Type;

/** One options build's progress. Kept in a Ref so a build that stalls or is cut off still names its active phase. */
interface OptionsTrace {
  readonly active: OptionsPhase | null;
  readonly budgetExceeded: boolean;
  readonly companies: number;
  readonly durations: Partial<Record<OptionsPhase, number>>;
}

/** Both traces of one options build: its own phases, and the steps inside the company-authority read. */
interface OptionsTraces {
  readonly authority: Ref.Ref<SubjectAccessTrace>;
  readonly options: Ref.Ref<OptionsTrace>;
}

interface OptionsTiming {
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
  return { phase };
};

/** Longest a consent options build may run; below the 30 s request budget, so a stall ends as a retryable 503. */
const CONNECT_OPTIONS_BUDGET = Duration.seconds(20);
/** A build slower than this logs one line with every phase's duration. */
const SLOW_OPTIONS_MILLIS = 3000;
/** Cause of the budget failure; `toProblem` maps it to the same retryable 503 as any unavailable build. */
export const OPTIONS_BUDGET_CAUSE = 'connect options exceeded budget';

/** The acting-authority read of one company: `loadActingAuthority` in production, a double in tests. */
type ActingAuthority = Effect.Success<ReturnType<typeof loadActingAuthority>>;
type ActingAuthorityInput = Parameters<typeof loadActingAuthority>[1];

/** What an options build reads beyond the OAuth query and the session. Production wires the live one. */
export interface ConnectOptionsPorts<Requirements> {
  readonly authorityOf: (
    asker: OperationalScope,
    input: ActingAuthorityInput,
    trace: Ref.Ref<SubjectAccessTrace>,
  ) => Effect.Effect<ActingAuthority, ConnectionUnavailable, Requirements>;
}

interface OptionsBuild<Requirements> {
  readonly authorityTrace: Ref.Ref<SubjectAccessTrace>;
  readonly ports: ConnectOptionsPorts<Requirements>;
  readonly request: ConnectOptionsRequest;
  readonly session: ConnectSession;
  readonly timing: OptionsTiming;
}

const buildOptions = Effect.fn('OAuthConnectService.buildOptions')(function* buildOptions<Requirements>({
  authorityTrace,
  ports,
  request,
  session,
  timing,
}: OptionsBuild<Requirements>) {
  const { client, verified } = yield* timing.phase('verifyClient', verifiedClient(request.oauthQuery));
  const user = { displayName: session.displayName, principalId: ConnectionPrincipalIdSchema.make(session.principalId) };
  // Only the company the session is scoped to has authority that can be loaded, so no other company is offered.
  const scoped = session.companies.find((company) => company.legalEntityId === session.scope.legalEntityId);
  if (scoped === undefined) {
    return {
      client,
      companies: [],
      preselect: { agentPrincipalId: Option.none(), legalEntityId: Option.none() },
      state: 'access_blocked',
      user,
    } satisfies ConnectOptions;
  }
  const own = yield* timing.phase(
    'companyAuthority',
    ports.authorityOf(
      session.scope,
      {
        actingKind: 'human',
        actingPrincipalId: session.principalId,
        legalEntityId: scoped.legalEntityId,
        tenantId: session.scope.tenantId,
      },
      authorityTrace,
    ),
  );
  const companies = [
    {
      agents: [],
      legalEntityId: ConnectionLegalEntityIdSchema.make(scoped.legalEntityId),
      legalName: scoped.legalName,
      modules: own.offered,
    },
  ] satisfies ConnectCompanyOption[];
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
  readonly traces: OptionsTraces;
}) {
  const totalMs = (yield* Clock.currentTimeMillis) - input.startedAt;
  if (totalMs <= SLOW_OPTIONS_MILLIS) {
    return;
  }
  const state = yield* Ref.get(input.traces.options);
  const authority = yield* Ref.get(input.traces.authority);
  yield* Effect.logWarning('OAuth connect options slow').pipe(
    Effect.annotateLogs({
      activePhase: state.active ?? 'none',
      authorityActions: authority.actions,
      authorityActivePhase: authority.active ?? 'none',
      authorityCapabilitiesMs: authority.durations.capabilities ?? null,
      authorityCarriers: authority.carriers,
      authorityCatalogMs: authority.durations.catalog ?? null,
      authorityInspectionCalls: authority.inspectionCalls,
      authorityScopeMs: authority.durations.scope ?? null,
      companies: state.companies,
      companyAuthorityMs: state.durations.companyAuthority ?? null,
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
    const traces: OptionsTraces = {
      authority: yield* Ref.make(emptySubjectAccessTrace),
      options: yield* Ref.make<OptionsTrace>({
        active: null,
        budgetExceeded: false,
        companies: session.companies.length,
        durations: {},
      }),
    };
    const startedAt = yield* Clock.currentTimeMillis;
    return yield* buildOptions({
      authorityTrace: traces.authority,
      ports,
      request,
      session,
      timing: makeTiming(traces.options),
    }).pipe(
      Effect.timeoutOrElse({
        duration: CONNECT_OPTIONS_BUDGET,
        orElse: () =>
          Ref.update(traces.options, (current) => ({ ...current, budgetExceeded: true })).pipe(
            Effect.andThen(Effect.fail(new ConnectionUnavailable({ cause: OPTIONS_BUDGET_CAUSE }))),
          ),
      }),
      Effect.onExit((exit) => logSlowOptions({ exit, startedAt, traces })),
    );
  });

export const connectOptions = connectOptionsWith({ authorityOf: loadActingAuthority });

export const createDraft = Effect.fn('OAuthConnectService.createDraft')(function* createDraft(
  session: ConnectSession,
  request: ConnectDraftRequest,
) {
  const { client } = yield* verifiedClient(request.oauthQuery);
  if (
    request.legalEntityId !== session.scope.legalEntityId ||
    !session.companies.some((company) => company.legalEntityId === request.legalEntityId)
  ) {
    return yield* new ConnectionForbidden({ code: 'access_blocked', reason: 'K této firmě nemáte přístup.' });
  }
  // No OAuth agent has a credential-bound connection, so an agent cannot be connected. Refused before any read.
  if (Option.isSome(request.actingPrincipalId)) {
    return yield* new ConnectionForbidden({ code: 'acting_principal_forbidden', reason: AGENT_REFUSAL });
  }
  const authority = yield* loadActingAuthority(session.scope, {
    actingKind: 'human',
    actingPrincipalId: session.principalId,
    legalEntityId: request.legalEntityId,
    tenantId: session.scope.tenantId,
  });
  if (!isPolicyWithin(request.writePolicy, authority.policyCap)) {
    return yield* new ConnectionForbidden({ code: 'write_policy_forbidden', reason: WRITE_POLICY_REFUSAL });
  }
  if (!isModulesRequestWithin(request.modules, authority.offered)) {
    return yield* new ConnectionInvalid({ code: 'modules_invalid' });
  }
  const profileId =
    (yield* findPreviousProfileId({
      actingPrincipalId: session.principalId,
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
    actingKind: 'human',
    actingPrincipalId: session.principalId,
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

/** A grant belongs to the scope the session is in now: its tenant and its company. Summary, approval and denial share it. */
const inSessionScope = (grant: GrantRow, session: ConnectSession): boolean =>
  grant.tenantId === session.scope.tenantId && grant.legalEntityId === session.scope.legalEntityId;

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
  if (!inSessionScope(grant, session)) {
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
  // Refused before any read or write, also for an agent draft made before createDraft refused agents.
  if (grant.actingKind === 'agent') {
    return yield* new ConnectionForbidden({ code: 'acting_principal_forbidden', reason: AGENT_REFUSAL });
  }
  if (grant.actingPrincipalId !== session.principalId) {
    return yield* new ConnectionInvalid({ code: 'draft_not_found' });
  }
  if (!inSessionScope(grant, session)) {
    return yield* new ConnectionUnavailable({ cause: 'Retained connection scope differs from original requester' });
  }
  // The consent showed the draft under the person's authority; approval re-reads that authority, so a right withdrawn
  // since the draft (or a write policy the company no longer allows) refuses the grant and writes nothing.
  const authority = yield* loadActingAuthority(session.scope, {
    actingKind: 'human',
    actingPrincipalId: grant.actingPrincipalId,
    legalEntityId: grant.legalEntityId,
    tenantId: grant.tenantId,
  });
  if (!isPolicyWithin(grant.writePolicy, authority.policyCap)) {
    return yield* new ConnectionForbidden({ code: 'write_policy_forbidden', reason: WRITE_POLICY_REFUSAL });
  }
  if (!isModulesRequestWithin(grant.modules, authority.offered)) {
    return yield* new ConnectionInvalid({ code: 'modules_invalid' });
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
  yield* (yield* OAuthAuthenticationAudit)
    .record({
      authBindingId: session.authBindingId ?? null,
      authMethod: 'session',
      eventType: 'oauth.connection.created',
      evidence: {
        actingPrincipalId: grant.actingPrincipalId,
        clientKind: grant.clientKind,
        delegatedByPrincipalId: null,
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
    // A denial writes only a draft of this session and of the company the session is in now.
    if (
      grant !== undefined &&
      grant.status === 'draft' &&
      grant.sessionId === session.sessionId &&
      grant.userId === session.userId &&
      inSessionScope(grant, session)
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
