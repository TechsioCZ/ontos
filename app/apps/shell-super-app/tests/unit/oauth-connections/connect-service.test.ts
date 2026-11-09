import {
  ConnectionLegalEntityIdSchema,
  ConnectionModuleIdSchema,
  ConnectionPrincipalIdSchema,
} from '@app/shared-contracts/oauth-connections';
import { Crypto, Duration, Effect, Fiber, Layer, Logger, Option, Result } from 'effect';
import { TestClock } from 'effect/testing';
import type {
  ConnectCompanyOption,
  ConnectDraftRequest,
  ConnectionWritePolicy,
} from '@app/shared-contracts/oauth-connections';
import { expect, it, test } from 'effect-rstest';

import { OAuthGrantRegistry } from '../../../../../packages/core-runtime/src/auth/oauth-grant-registry-service.ts';
import { makeInstalledModuleCatalogLayer } from '../../../api/modules/installed-module-catalog.ts';
import { toProblem } from '../../../api/oauth-connections/connect-http.ts';
import {
  OPTIONS_BUDGET_CAUSE,
  buildDenyRedirect,
  choosePreselect,
  connectOptionsWith,
  createDraft,
} from '../../../api/oauth-connections/connect-service.ts';
import type { ConnectOptionsPorts, ConnectSession } from '../../../api/oauth-connections/connect-service.ts';
import { connectionScopeOf } from '../../../api/oauth-connections/connection-service.ts';
import { ConnectionForbidden, ConnectionUnavailable } from '../../../api/oauth-connections/errors.ts';
import { OAuthFlow } from '../../../api/oauth-connections/oauth-flow.ts';
import type { OAuthFlowService, VerifiedOAuthQuery } from '../../../api/oauth-connections/oauth-flow.ts';
import { toGrantRow } from '../../../api/oauth-connections/grant-store.ts';
import { makeCompositionSnapshot } from '../../fixtures/application-composition.ts';
import { subjectInspectionFixture } from '../oauth-connections-admin/subject-inspection.fixture.ts';
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

/** The person is signed in to le-a (tenant-1) and also belongs to le-b; both have agents the person may operate. */
const agents = [
  { displayName: 'Agent Eins', principalId: 'agent-1' },
  { displayName: 'Agent Dva', principalId: 'agent-2' },
];
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
  scope: { ...connectionScopeOf(toGrantRow(retainedGrant)), legalEntityId: 'le-a', tenantId: 'tenant-1' },
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
/** The registry as the connect flow reads it; every agent listing is recorded into `agentReads`. */
const servicesWith = (agentReads: string[]) =>
  Layer.merge(
    Layer.succeed(OAuthFlow, flow),
    Layer.succeed(
      OAuthGrantRegistry,
      grantRegistryFixture({
        listAgentPrincipals: (tenantId) =>
          Effect.sync(() => {
            agentReads.push(tenantId);
            return agents;
          }),
      }),
    ),
  );

const policy: ConnectionWritePolicy = 'direct';
interface AuthorityRead {
  readonly actingKind: string;
  readonly legalEntityId: string;
}

/**
 * Human authority of the requester's company (le-a offers CRM). Like `loadActingAuthority`, it refuses a company other
 * than the requester's own and any agent; every read it is asked is recorded in `reads`.
 */
const authorityDouble =
  (reads: AuthorityRead[]): ConnectOptionsPorts<never>['authorityOf'] =>
  (asker, input) => {
    reads.push({ actingKind: input.actingKind, legalEntityId: input.legalEntityId });
    if (asker.tenantId !== input.tenantId || asker.legalEntityId !== input.legalEntityId) {
      return Effect.fail(new ConnectionUnavailable({ cause: 'Connection scope differs from requester scope' }));
    }
    if (input.actingKind === 'agent') {
      return Effect.fail(
        new ConnectionUnavailable({
          cause: 'OAuth agent has no credential-bound access connection and consent revision',
        }),
      );
    }
    return Effect.succeed({
      labelOf: () => 'CRM',
      live: { read: new Set<string>(), write: new Set<string>() },
      offered: [crm],
      policyCap: policy,
    });
  };

/** Everything `createDraft` names in its requirements. The inspection records each authority read it is asked. */
const draftLayers = (agentReads: string[]) =>
  Effect.gen(function* draftDependencies() {
    const snapshot = yield* makeCompositionSnapshot([]);
    const inspection = subjectInspectionFixture({ snapshot, subjects: [] });
    const crypto = Crypto.make({
      digest: (_algorithm, data) => Effect.succeed(data),
      randomBytes: (size) => new Uint8Array(size).fill(7),
    });
    return {
      inspection,
      layer: Layer.mergeAll(
        servicesWith(agentReads),
        inspection.layer,
        makeInstalledModuleCatalogLayer(Effect.succeed(snapshot)),
        Layer.succeed(Crypto.Crypto, crypto),
      ),
    };
  });

it.effect(
  'offers only the scoped company with no agent choices, although the person has another company and operable agents',
  () => {
    const reads: AuthorityRead[] = [];
    const agentReads: string[] = [];
    return connectOptionsWith({ authorityOf: authorityDouble(reads) })(session, request).pipe(
      Effect.provide(servicesWith(agentReads)),
      Effect.flatMap((options) =>
        Effect.sync(() => {
          expect(options.state).toBe('ready');
          expect(options.companies).toStrictEqual([
            { agents: [], legalEntityId: 'le-a', legalName: 'Firma A', modules: [crm] },
          ]);
          expect(options.preselect).toStrictEqual({
            agentPrincipalId: Option.none(),
            legalEntityId: Option.some('le-a'),
          });
          expect(options.user).toStrictEqual({
            displayName: 'Ada',
            principalId: ConnectionPrincipalIdSchema.make('person-1'),
          });
          expect(reads).toStrictEqual([{ actingKind: 'human', legalEntityId: 'le-a' }]);
          expect(agentReads).toStrictEqual([]);
        }),
      ),
    );
  },
);

it.effect('answers access_blocked, with no form, when the session is not scoped to a company it may offer', () => {
  const reads: AuthorityRead[] = [];
  const agentReads: string[] = [];
  const unscoped: ConnectSession = { ...session, scope: { ...session.scope, legalEntityId: 'le-unknown' } };
  return connectOptionsWith({ authorityOf: authorityDouble(reads) })(unscoped, request).pipe(
    Effect.provide(servicesWith(agentReads)),
    Effect.flatMap((options) =>
      Effect.sync(() => {
        expect(options.state).toBe('access_blocked');
        expect(options.companies).toStrictEqual([]);
        expect(options.preselect).toStrictEqual({ agentPrincipalId: Option.none(), legalEntityId: Option.none() });
        expect(reads).toStrictEqual([]);
        expect(agentReads).toStrictEqual([]);
      }),
    ),
  );
});

it.effect('refuses a draft that would act as an agent before any authority or agent read', () =>
  Effect.gen(function* agentDraftRefused() {
    const agentReads: string[] = [];
    const { inspection, layer } = yield* draftLayers(agentReads);
    const agentDraft: ConnectDraftRequest = {
      actingPrincipalId: Option.some(ConnectionPrincipalIdSchema.make('agent-1')),
      legalEntityId: ConnectionLegalEntityIdSchema.make('le-a'),
      modules: 'all',
      oauthQuery: 'signed-query',
      writePolicy: 'direct',
    };
    const refused = yield* createDraft(session, agentDraft).pipe(Effect.provide(layer), Effect.result);
    expect(Result.isFailure(refused)).toBe(true);
    if (Result.isFailure(refused)) {
      expect(refused.failure).toStrictEqual(
        new ConnectionForbidden({ code: 'acting_principal_forbidden', reason: 'Za tohoto agenta nesmíte jednat.' }),
      );
    }
    expect(agentReads).toStrictEqual([]);
    expect(inspection.requesterScopes).toStrictEqual([]);
  }),
);

it.effect('refuses a draft for a company other than the scoped one before any authority read', () =>
  Effect.gen(function* otherCompanyDraftRefused() {
    const { inspection, layer } = yield* draftLayers([]);
    const otherCompany: ConnectDraftRequest = {
      actingPrincipalId: Option.none(),
      legalEntityId: ConnectionLegalEntityIdSchema.make('le-b'),
      modules: 'all',
      oauthQuery: 'signed-query',
      writePolicy: 'direct',
    };
    const refused = yield* createDraft(session, otherCompany).pipe(Effect.provide(layer), Effect.result);
    expect(Result.isFailure(refused)).toBe(true);
    if (Result.isFailure(refused)) {
      expect(refused.failure).toStrictEqual(
        new ConnectionForbidden({ code: 'access_blocked', reason: 'K této firmě nemáte přístup.' }),
      );
    }
    expect(inspection.requesterScopes).toStrictEqual([]);
  }),
);

it.effect('ends a stalled options build at the 20 second budget as the retryable 503 problem', () => {
  const stalled: ConnectOptionsPorts<never> = { authorityOf: () => Effect.never };
  return Effect.gen(function* stalledBuild() {
    const fiber = yield* connectOptionsWith(stalled)(session, request).pipe(
      Effect.provide(servicesWith([])),
      Effect.forkChild,
    );
    yield* TestClock.adjust(Duration.seconds(19));
    expect(fiber.pollUnsafe()).toBeUndefined();
    yield* TestClock.adjust(Duration.seconds(1));
    const outcome = yield* Fiber.join(fiber).pipe(Effect.result);
    expect(Result.isFailure(outcome)).toBe(true);
    if (Result.isFailure(outcome)) {
      expect(outcome.failure).toStrictEqual(new ConnectionUnavailable({ cause: OPTIONS_BUDGET_CAUSE }));
      const problem = yield* toProblem(outcome.failure);
      expect(problem.status).toBe(503);
      expect(problem).toMatchObject({ retryable: true, status: 503 });
    }
  });
});

it.effect('logs one structured line with each phase duration and the counts when the build is slow', () => {
  const entries: unknown[] = [];
  const slow: ConnectOptionsPorts<never> = {
    authorityOf: (asker, input) =>
      TestClock.adjust(Duration.seconds(4)).pipe(Effect.andThen(authorityDouble([])(asker, input))),
  };
  return connectOptionsWith(slow)(session, request).pipe(
    Effect.provide(servicesWith([])),
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
            companies: 2,
            companyAuthorityMs: 4000,
            outcome: 'ok',
            totalMs: 4000,
            verifyClientMs: 0,
          },
        });
      }),
    ),
  );
});
