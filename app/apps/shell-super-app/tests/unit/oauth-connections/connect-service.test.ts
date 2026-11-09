import { v1 } from '@authzed/authzed-node';
import {
  ConnectionLegalEntityIdSchema,
  ConnectionModuleIdSchema,
  ConnectionPrincipalIdSchema,
} from '@app/shared-contracts/oauth-connections';
import { Duration, Effect, Fiber, Layer, Logger, Option } from 'effect';
import { TestClock } from 'effect/testing';
import type { ConnectCompanyOption, ConnectionWritePolicy } from '@app/shared-contracts/oauth-connections';
import { expect, it, test } from 'effect-rstest';

import { OAuthGrantRegistry } from '../../../../../packages/core-runtime/src/auth/oauth-grant-registry-service.ts';
import { operateAnswers } from '../../../../../packages/core-runtime/src/permissions/principal-operators.ts';
import { toProblem } from '../../../api/oauth-connections/connect-http.ts';
import {
  OPTIONS_BUDGET_CAUSE,
  buildDenyRedirect,
  choosePreselect,
  connectOptionsWith,
} from '../../../api/oauth-connections/connect-service.ts';
import type {
  AgentDirectory,
  ConnectOptionsPorts,
  ConnectSession,
} from '../../../api/oauth-connections/connect-service.ts';
import { connectionScopeOf } from '../../../api/oauth-connections/connection-service.ts';
import { ConnectionUnavailable } from '../../../api/oauth-connections/errors.ts';
import { OAuthFlow } from '../../../api/oauth-connections/oauth-flow.ts';
import type { OAuthFlowService, VerifiedOAuthQuery } from '../../../api/oauth-connections/oauth-flow.ts';
import { toGrantRow } from '../../../api/oauth-connections/grant-store.ts';
import { grantRegistryFixture, retainedGrant } from './grant-registry-fixture.ts';

const ISSUER = 'http://localhost:3020/shell-super-app-api/oauth';

const verified = (state: string | null): VerifiedOAuthQuery => ({
  agent: null,
  clientId: 'https://claude.ai/oauth/mcp-client.json',
  company: null,
  redirectUri: 'http://localhost:5555/callback',
  resource: 'http://localhost:3020/mcp',
  scope: 'ontos',
  state,
});

const company = (legalEntityId: string, agentIds: readonly string[] = []): ConnectCompanyOption => ({
  agents: agentIds.map((principalId) => ({
    displayName: principalId,
    modules: [],
    principalId: ConnectionPrincipalIdSchema.make(principalId),
    writePolicy: 'approval',
  })),
  legalEntityId: ConnectionLegalEntityIdSchema.make(legalEntityId),
  legalName: `Firma ${legalEntityId}`,
  modules: [],
});

test('buildDenyRedirect adds access_denied, the original state and the issuer', () => {
  const href = buildDenyRedirect(verified('xyz'), ISSUER);
  expect(href.startsWith('http://localhost:5555/callback?')).toBe(true);
  expect(href).toContain('error=access_denied');
  expect(href).toContain('state=xyz');
  expect(href).toContain('iss=http%3A%2F%2Flocalhost%3A3020%2Fshell-super-app-api%2Foauth');
});

test('buildDenyRedirect leaves out state when the request had none', () => {
  const url = new URL(buildDenyRedirect(verified(null), ISSUER));
  expect(url.searchParams.has('state')).toBe(false);
  expect(url.searchParams.get('error')).toBe('access_denied');
  expect(url.searchParams.get('iss')).toBe(ISSUER);
});

test('choosePreselect prefers the requested company when it is offered', () => {
  expect(
    choosePreselect({
      activeLegalEntityId: 'le-a',
      companies: [company('le-a'), company('le-b')],
      requestedAgent: null,
      requestedCompany: 'le-b',
    }),
  ).toStrictEqual({ agentPrincipalId: Option.none(), legalEntityId: Option.some('le-b') });
});

test('choosePreselect falls back to the active company for an unknown requested company', () => {
  expect(
    choosePreselect({
      activeLegalEntityId: 'le-a',
      companies: [company('le-a'), company('le-b')],
      requestedAgent: null,
      requestedCompany: 'le-unknown',
    }),
  ).toStrictEqual({ agentPrincipalId: Option.none(), legalEntityId: Option.some('le-a') });
});

test('choosePreselect selects the only company and nothing when several are offered without a hint', () => {
  expect(
    choosePreselect({
      activeLegalEntityId: null,
      companies: [company('le-a')],
      requestedAgent: null,
      requestedCompany: null,
    }),
  ).toStrictEqual({ agentPrincipalId: Option.none(), legalEntityId: Option.some('le-a') });
  expect(
    choosePreselect({
      activeLegalEntityId: null,
      companies: [company('le-a'), company('le-b')],
      requestedAgent: null,
      requestedCompany: null,
    }),
  ).toStrictEqual({ agentPrincipalId: Option.none(), legalEntityId: Option.none() });
});

test('choosePreselect keeps the requested agent only when the chosen company offers it', () => {
  const companies = [company('le-a', ['agent-1']), company('le-b', ['agent-2'])];
  expect(
    choosePreselect({ activeLegalEntityId: null, companies, requestedAgent: 'agent-1', requestedCompany: 'le-a' }),
  ).toStrictEqual({ agentPrincipalId: Option.some('agent-1'), legalEntityId: Option.some('le-a') });
  expect(
    choosePreselect({ activeLegalEntityId: null, companies, requestedAgent: 'agent-2', requestedCompany: 'le-a' }),
  ).toStrictEqual({ agentPrincipalId: Option.none(), legalEntityId: Option.some('le-a') });
});

const answer = (agentPrincipalId: string, permissionship: v1.CheckPermissionResponse_Permissionship) =>
  v1.CheckBulkPermissionsPair.create({
    request: v1.CheckBulkPermissionsRequestItem.create({
      permission: 'operate',
      resource: v1.ObjectReference.create({ objectId: agentPrincipalId, objectType: 'principal' }),
    }),
    response: { item: v1.CheckBulkPermissionsResponseItem.create({ permissionship }), oneofKind: 'item' },
  });

const erroredAnswer = (agentPrincipalId: string) =>
  v1.CheckBulkPermissionsPair.create({
    request: v1.CheckBulkPermissionsRequestItem.create({
      permission: 'operate',
      resource: v1.ObjectReference.create({ objectId: agentPrincipalId, objectType: 'principal' }),
    }),
    response: { error: { code: 13, details: [], message: 'internal' }, oneofKind: 'error' },
  });

const HAS = v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION;

test('operateAnswers reads only an explicit HAS as allowed, in request order', () => {
  const answers = operateAnswers(
    ['agent-1', 'agent-2', 'agent-3', 'agent-4'],
    [
      answer('agent-1', HAS),
      answer('agent-2', v1.CheckPermissionResponse_Permissionship.NO_PERMISSION),
      answer('agent-3', v1.CheckPermissionResponse_Permissionship.CONDITIONAL_PERMISSION),
      answer('agent-4', v1.CheckPermissionResponse_Permissionship.UNSPECIFIED),
    ],
  );
  const decided = Option.getOrUndefined(answers);
  expect(decided?.get('agent-1')).toBe(true);
  expect(decided?.get('agent-2')).toBe(false);
  expect(decided?.get('agent-3')).toBe(false);
  expect(decided?.get('agent-4')).toBe(false);
  expect(decided?.size).toBe(4);
});

test('operateAnswers gives no answer for a per-item error, a missing pair or a pair for another agent', () => {
  expect(
    Option.isNone(operateAnswers(['agent-1', 'agent-2'], [answer('agent-1', HAS), erroredAnswer('agent-2')])),
  ).toBe(true);
  expect(Option.isNone(operateAnswers(['agent-1', 'agent-2'], [answer('agent-1', HAS)]))).toBe(true);
  expect(Option.isNone(operateAnswers(['agent-1'], [answer('agent-9', HAS)]))).toBe(true);
});

/** Two companies, three agents: agent-2 is not operable; agent-1 belongs to both companies, agent-3 to le-a only. */
const agents = [
  { displayName: 'Agent Eins', principalId: 'agent-1' },
  { displayName: 'Agent Dva', principalId: 'agent-2' },
  { displayName: 'Agent Tri', principalId: 'agent-3' },
];
const memberships = new Map<string, readonly string[]>([
  ['agent-1', ['le-a', 'le-b']],
  ['agent-2', ['le-a']],
  ['agent-3', ['le-a']],
]);
const crm = { label: 'CRM', moduleId: ConnectionModuleIdSchema.make('crm'), read: true, write: false };
const session: ConnectSession = {
  activeLegalEntityId: 'le-a',
  authBindingId: 'binding-1',
  companies: [
    { legalEntityId: 'le-a', legalName: 'Firma A' },
    { legalEntityId: 'le-b', legalName: 'Firma B' },
  ],
  displayName: 'Ada',
  principalId: 'person-1',
  scope: connectionScopeOf(toGrantRow(retainedGrant)),
  sessionId: 'session-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
};
const request = { oauthQuery: 'signed-query' };
const signedQuery: VerifiedOAuthQuery = {
  agent: null,
  clientId: 'https://claude.ai/oauth/mcp-client.json',
  company: null,
  redirectUri: 'http://localhost:5555/callback',
  resource: 'http://localhost:3020/mcp',
  scope: 'ontos',
  state: 'xyz',
};
const flow: OAuthFlowService = {
  deleteGrantTokens: () => Effect.void,
  findClient: () => Effect.succeed(Option.some({ clientId: signedQuery.clientId, logoUri: null, name: 'Claude' })),
  verifyQuery: () => Effect.succeed(signedQuery),
};
const services = Layer.merge(
  Layer.succeed(OAuthFlow, flow),
  Layer.succeed(OAuthGrantRegistry, grantRegistryFixture({ listAgentPrincipals: () => Effect.succeed(agents) })),
);

/** Human authority per company (le-a offers CRM); agent authority only when `agentsAvailable`, as the real loader. */
const policy: ConnectionWritePolicy = 'direct';
const authorityOf =
  (agentsAvailable: boolean): ConnectOptionsPorts<never>['authorityOf'] =>
  (_asker, input) =>
    input.actingKind === 'agent' && !agentsAvailable
      ? Effect.fail(new ConnectionUnavailable({ cause: 'agent authority unavailable' }))
      : Effect.succeed({
          labelOf: () => 'CRM',
          live: { read: new Set<string>(), write: new Set<string>() },
          offered: input.legalEntityId === 'le-a' ? [crm] : [],
          policyCap: policy,
        });

/** A directory that records every SpiceDB-backed read it is asked for. */
const recordingDirectory = (operable: ReadonlySet<string>) => {
  const operate: (readonly string[])[] = [];
  const companies: (readonly string[])[] = [];
  const directory: AgentDirectory = {
    canOperateMany: (agentPrincipalIds) =>
      Effect.sync(() => {
        operate.push([...agentPrincipalIds]);
        return new Map(agentPrincipalIds.map((id): [string, boolean] => [id, operable.has(id)]));
      }),
    companiesOf: (agentPrincipalIds) =>
      Effect.sync(() => {
        companies.push([...agentPrincipalIds]);
        return new Map(agentPrincipalIds.map((id): [string, readonly string[]] => [id, memberships.get(id) ?? []]));
      }),
  };
  return { directory, reads: { companies, operate } };
};

it.effect('answers the options from one bulk operate check and reads companies only for operable agents', () => {
  const { directory, reads } = recordingDirectory(new Set(['agent-1', 'agent-3']));
  return connectOptionsWith({ agents: directory, authorityOf: authorityOf(true) })(session, request).pipe(
    Effect.provide(services),
    Effect.flatMap((options) =>
      Effect.sync(() => {
        expect(reads.operate).toStrictEqual([['agent-1', 'agent-2', 'agent-3']]);
        expect(reads.companies).toStrictEqual([['agent-1', 'agent-3']]);
        expect(options.state).toBe('ready');
        expect(options.companies).toStrictEqual([
          {
            agents: [
              { displayName: 'Agent Eins', modules: [crm], principalId: 'agent-1', writePolicy: 'direct' },
              { displayName: 'Agent Tri', modules: [crm], principalId: 'agent-3', writePolicy: 'direct' },
            ],
            legalEntityId: 'le-a',
            legalName: 'Firma A',
            modules: [crm],
          },
          {
            agents: [{ displayName: 'Agent Eins', modules: [], principalId: 'agent-1', writePolicy: 'direct' }],
            legalEntityId: 'le-b',
            legalName: 'Firma B',
            modules: [],
          },
        ]);
        expect(options.preselect).toStrictEqual({
          agentPrincipalId: Option.none(),
          legalEntityId: Option.some('le-a'),
        });
        expect(options.user).toStrictEqual({
          displayName: 'Ada',
          principalId: ConnectionPrincipalIdSchema.make('person-1'),
        });
      }),
    ),
  );
});

it.effect('fails the whole options build when the bulk operate check errors, instead of excluding that agent', () => {
  const erroring: AgentDirectory = {
    canOperateMany: () => Effect.fail(new ConnectionUnavailable({ cause: 'spicedb unavailable' })),
    companiesOf: () => Effect.fail(new ConnectionUnavailable({ cause: 'companies must not be read' })),
  };
  return connectOptionsWith({ agents: erroring, authorityOf: authorityOf(true) })(session, request).pipe(
    Effect.provide(services),
    Effect.flip,
    Effect.map((error) => expect(error).toStrictEqual(new ConnectionUnavailable({ cause: 'spicedb unavailable' }))),
  );
});

it.effect('keeps the agent acting-authority failure as before: an operable agent makes the build unavailable', () => {
  const { directory } = recordingDirectory(new Set(['agent-1']));
  return connectOptionsWith({ agents: directory, authorityOf: authorityOf(false) })(session, request).pipe(
    Effect.provide(services),
    Effect.flip,
    Effect.map((error) => expect(error._tag).toBe('ConnectionUnavailable')),
  );
});

it.effect('ends a stalled options build at the 20 second budget as the retryable 503 problem', () => {
  const stalled: AgentDirectory = {
    canOperateMany: () => Effect.never,
    companiesOf: () => Effect.never,
  };
  return Effect.gen(function* stalledBuild() {
    const fiber = yield* connectOptionsWith({ agents: stalled, authorityOf: authorityOf(true) })(session, request).pipe(
      Effect.provide(services),
      Effect.forkChild,
    );
    yield* TestClock.adjust(Duration.seconds(19));
    expect(fiber.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust(Duration.seconds(1));
    const error = yield* Fiber.join(fiber).pipe(Effect.flip);
    expect(error).toStrictEqual(new ConnectionUnavailable({ cause: OPTIONS_BUDGET_CAUSE }));
    const problem = yield* toProblem(error);
    expect(problem.status).toBe(503);
    expect(problem).toMatchObject({ retryable: true, status: 503 });
  });
});

it.effect('logs one structured line with each phase duration and the counts when the build is slow', () => {
  const entries: unknown[] = [];
  const slow: AgentDirectory = {
    canOperateMany: (agentPrincipalIds) =>
      TestClock.adjust(Duration.seconds(4)).pipe(
        Effect.as(new Map(agentPrincipalIds.map((id) => [id, false] as const))),
      ),
    companiesOf: () => Effect.succeed(new Map<string, readonly string[]>()),
  };
  return connectOptionsWith({ agents: slow, authorityOf: authorityOf(true) })(session, request).pipe(
    Effect.provide(services),
    Effect.provide(
      Logger.layer([
        Logger.make((options) => {
          entries.push(Logger.formatStructured.log(options));
        }),
      ]),
    ),
    Effect.flatMap(() =>
      Effect.sync(() => {
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
          annotations: {
            activePhase: 'none',
            agentCompaniesMs: 0,
            agents: 3,
            canOperateMs: 4000,
            companies: 2,
            companyAuthorityMs: 0,
            listAgentsMs: 0,
            operableAgents: 0,
            outcome: 'ok',
            totalMs: 4000,
            verifyClientMs: 0,
          },
        });
      }),
    ),
  );
});
