import { proposalLifecycleAdministrator } from '@app/core-runtime';
import { administersOAuthConnections } from '../../../../packages/core-runtime/src/auth/oauth-connection-administration-read.ts';
import { mayFindPeople } from '@app/core-runtime/people/search';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { agentAdministrationDecision } from '../../api/auth/administration-access.ts';
import { peopleAdministrationCapability } from '../../api/auth/demo-accounts.ts';
import { TENANT_MODULE_TARGET_ACCESS_DECLARATION } from '../../api/modules/shell-governed-reads.ts';
import {
  DECISION_AT,
  accessAdminTemplateLayer,
  withAccessAdminCase,
} from '../support/access-admin-real-gate-fixture.ts';
import type { AccessAdminCase, Persona } from '../support/access-admin-real-gate-fixture.ts';

/*
 * The questions that used to ask legacy `ContextAccess` relations, answered by the real v2 gate on a
 * v2-only tenant (bootstrapped by `bootstrapTenantAccess`, no legacy tuple anywhere, real SpiceDB, a
 * private case database). Each row: a person who holds the capability is allowed, a person who does
 * not is refused (exactly as a legacy tenant without the right was), and another tenant's or another
 * company's person gets nothing.
 */

/**
 * The selected-company principal of one persona, as the Shell's company session carries it. The other
 * tenant's owner is presented with THIS tenant and company, so the question is "may another tenant's
 * person act here" (it never may).
 */
const companyPrincipal = Effect.fn('LegacyRows.companyPrincipal')(function* companyPrincipal(
  accessCase: AccessAdminCase,
  persona: Persona,
  company?: string,
) {
  const legalEntityId = company ?? accessCase.companies[0] ?? '';
  const scope = yield* accessCase.scopeFor(persona, legalEntityId);
  return { ...scope, legalEntityId, tenantId: accessCase.tenantId };
});

const canManagePeople = Effect.fn('LegacyRows.canManagePeople')(function* canManagePeople(
  accessCase: AccessAdminCase,
  persona: Persona,
) {
  const principal = yield* companyPrincipal(accessCase, persona);
  const { canManage } = yield* peopleAdministrationCapability({ principal }).pipe(
    Effect.provideService(AccessDecisionGate, accessCase.gate),
  );
  return canManage;
});

const agentAdministration = Effect.fn('LegacyRows.agentAdministration')(function* agentAdministration(
  accessCase: AccessAdminCase,
  persona: Persona,
  company: string | undefined,
) {
  const principal = yield* companyPrincipal(accessCase, persona, company);
  const decision = yield* agentAdministrationDecision(principal).pipe(
    Effect.provideService(AccessDecisionGate, accessCase.gate),
  );
  return decision.outcome;
});

const tenantReleaseHint = Effect.fn('LegacyRows.tenantReleaseHint')(function* tenantReleaseHint(
  accessCase: AccessAdminCase,
  persona: Persona,
) {
  const scope = { ...(yield* accessCase.scopeFor(persona)), tenantId: accessCase.tenantId };
  const decision = yield* accessCase.gate.decide({
    carrier: { accessDeclaration: TENANT_MODULE_TARGET_ACCESS_DECLARATION },
    legalEntityScope: 'optional',
    now: DECISION_AT,
    scope,
  });
  return decision.outcome;
});

const withdrawsAgentProposals = Effect.fn('LegacyRows.withdrawsAgentProposals')(function* withdrawsAgentProposals(
  accessCase: AccessAdminCase,
  persona: Persona,
  company: string | undefined,
) {
  const scope = yield* companyPrincipal(accessCase, persona, company);
  return yield* proposalLifecycleAdministrator(scope).pipe(Effect.provideService(AccessDecisionGate, accessCase.gate));
});

const administersConnections = Effect.fn('LegacyRows.administersConnections')(function* administersConnections(
  accessCase: AccessAdminCase,
  persona: Persona,
  company: string | undefined,
) {
  const scope = yield* companyPrincipal(accessCase, persona, company);
  return yield* administersOAuthConnections(scope).pipe(Effect.provideService(AccessDecisionGate, accessCase.gate));
});

const findsPeople = Effect.fn('LegacyRows.findsPeople')(function* findsPeople(
  accessCase: AccessAdminCase,
  persona: Persona,
) {
  const scope = yield* companyPrincipal(accessCase, persona);
  return yield* mayFindPeople(scope).pipe(Effect.provideService(AccessDecisionGate, accessCase.gate));
});

/**
 * An agent of the first company on a live, credential-bound connection its owner consented to: a member of the tenant
 * and the company in v2 intent, with an active connection row and consent snapshot, and the trusted scope the MCP
 * transport builds for it. It holds no legacy tuple of any kind.
 */
const connectedAgent = Effect.fn('LegacyRows.connectedAgent')(function* connectedAgent(accessCase: AccessAdminCase) {
  const [minted] = yield* accessCase.admin
    .unsafe<{ readonly agent: string; readonly connection: string; readonly grant: string }>(
      'select gen_random_uuid()::text as agent, gen_random_uuid()::text as connection, gen_random_uuid()::text as grant',
    )
    .pipe(Effect.orDie);
  const agentId = minted?.agent ?? '';
  const connectionId = minted?.connection ?? '';
  const grantId = minted?.grant ?? '';
  const companyA = accessCase.companies[0] ?? '';
  const operator = accessCase.ids.get('owner')?.principalId ?? '';
  const [tenantScope, companyScope] = yield* Effect.all([accessCase.scopeIdOf(), accessCase.scopeIdOf(companyA)]);
  for (const statement of [
    `insert into core.principals (tenant_id, principal_id, kind, display_name, status)
       values ('${accessCase.tenantId}', '${agentId}', 'agent', 'Agent', 'active')`,
    `insert into core.principal_company_memberships (tenant_id, legal_entity_id, principal_id, affiliation, status)
       values ('${accessCase.tenantId}', '${companyA}', '${agentId}', null, 'active')`,
    `insert into core.access_memberships (membership_id, tenant_id, scope_id, agent_id, kind, status, valid_from, recorded_by)
       values (gen_random_uuid(), '${accessCase.tenantId}', '${tenantScope}', '${agentId}', 'member', 'active',
               now() - interval '1 day', '${operator}'),
              (gen_random_uuid(), '${accessCase.tenantId}', '${companyScope}', '${agentId}', 'member', 'active',
               now() - interval '1 day', '${operator}')`,
    `insert into core.access_agent_connections (connection_id, tenant_id, agent_id, principal_id, scope_id, status,
       revision, ceiling_json, valid_from, valid_until)
       values ('${connectionId}', '${accessCase.tenantId}', '${agentId}', '${operator}', '${companyScope}', 'active', 1,
               '{"cells":[]}', now() - interval '1 day', now() + interval '10 years')`,
    `insert into core.access_consent_snapshots (tenant_id, connection_id, revision, ceiling_json, granted_at, granted_by)
       values ('${accessCase.tenantId}', '${connectionId}', 1, '{"cells":[]}', now() - interval '1 day', '${operator}')`,
  ]) {
    yield* accessCase.admin.unsafe(statement).pipe(Effect.orDie);
  }
  const trusted = yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
    authBindingId: grantId,
    authContextRef: `oauth-grant:${grantId}`,
    authMethod: 'oauth_connection',
    connection: {
      agentConnection: { connectionId, revision: 1 },
      clientId: 'https://client.example/oauth/metadata.json',
      clientName: 'Client',
      grantId,
      modules: 'all',
      writePolicy: 'direct',
    },
    delegatedByPrincipalId: operator,
    legalEntityId: companyA,
    principalId: agentId,
    tenantId: accessCase.tenantId,
  }).pipe(Effect.orDie);
  return { ...trusted, correlationId: 'legacy-rows:agent', legalEntityId: companyA, tenantId: accessCase.tenantId };
});

it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '120 seconds' })(
  'legacy context-access questions on a v2-only tenant',
  (suite) => {
    suite.effect('row 1: the People navigation flag follows the People list read', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* peopleNavigation() {
          expect(yield* canManagePeople(accessCase, 'owner')).toBe(true);
          expect(yield* canManagePeople(accessCase, 'member')).toBe(false);
          expect(yield* canManagePeople(accessCase, 'foreignOwner')).toBe(false);
        }),
      ),
    );

    suite.effect('row 1: agent administration follows the Agents administration surface, per company', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* agentAdministrationRows() {
          const [companyA, companyB] = accessCase.companies;
          expect(yield* agentAdministration(accessCase, 'owner', companyA)).toBe('ALLOWED');
          expect(yield* agentAdministration(accessCase, 'companyAdmin', companyA)).toBe('ALLOWED');
          // Another company's administrator gets nothing here, and neither does another tenant's owner.
          expect(yield* agentAdministration(accessCase, 'companyAdmin', companyB)).toBe('DENIED');
          expect(yield* agentAdministration(accessCase, 'foreignOwner', companyA)).toBe('DENIED');
          expect(yield* agentAdministration(accessCase, 'member', companyA)).toBe('DENIED');
        }),
      ),
    );

    suite.effect('row 2: the tenant release hint follows tenant-context page dispatch', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* tenantReleaseHintRows() {
          expect(yield* tenantReleaseHint(accessCase, 'owner')).toBe('ALLOWED');
          expect(yield* tenantReleaseHint(accessCase, 'member')).toBe('DENIED');
          expect(yield* tenantReleaseHint(accessCase, 'foreignOwner')).toBe('DENIED');
        }),
      ),
    );

    suite.effect("row 4: an agent's pending proposals are withdrawn by those who may disable the agent", () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* proposalWithdrawalRows() {
          const [companyA, companyB] = accessCase.companies;
          expect(yield* withdrawsAgentProposals(accessCase, 'owner', companyA)).toBe(true);
          expect(yield* withdrawsAgentProposals(accessCase, 'companyAdmin', companyA)).toBe(true);
          expect(yield* withdrawsAgentProposals(accessCase, 'member', companyA)).toBe(false);
          expect(yield* withdrawsAgentProposals(accessCase, 'companyAdmin', companyB)).toBe(false);
          expect(yield* withdrawsAgentProposals(accessCase, 'foreignOwner', companyA)).toBe(false);
        }),
      ),
    );

    suite.effect("row 5: connected-apps administration and others' revocation notes follow the new admin right", () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* connectedAppsAdministration() {
          const [companyA, companyB] = accessCase.companies;
          expect(yield* administersConnections(accessCase, 'owner', companyA)).toBe(true);
          expect(yield* administersConnections(accessCase, 'companyAdmin', companyA)).toBe(true);
          expect(yield* administersConnections(accessCase, 'member', companyA)).toBe(false);
          expect(yield* administersConnections(accessCase, 'companyAdmin', companyB)).toBe(false);
          expect(yield* administersConnections(accessCase, 'foreignOwner', companyA)).toBe(false);
        }),
      ),
    );

    suite.effect('an agent on its live connection is cleanly refused every administration question, never 503', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* agentAdministrationRefused() {
          const agent = yield* connectedAgent(accessCase);
          const gated = <A, E>(effect: Effect.Effect<A, E, AccessDecisionGate>) =>
            effect.pipe(Effect.provideService(AccessDecisionGate, accessCase.gate));
          // The questions the Core reads behind the agents, proposals and connections pages ask in `prepare`: an agent
          // administers nothing, so each is a refusal (403), never an unavailable answer (503).
          const administration = yield* gated(agentAdministrationDecision(agent));
          expect(administration.outcome).toBe('DENIED');
          expect(administration.reasons.map(({ code }) => code)).toContain('deny.agent_forbidden');
          expect(yield* gated(proposalLifecycleAdministrator(agent))).toBe(false);
          expect(yield* gated(administersOAuthConnections(agent))).toBe(false);
          expect(yield* gated(mayFindPeople(agent))).toBe(false);
          const people = yield* gated(peopleAdministrationCapability({ principal: agent }));
          expect(people.canManage).toBe(false);
        }),
      ),
    );

    suite.effect('row 3: a person is found exactly by those who may list the company people', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* peopleSearchVisibility() {
          expect(yield* findsPeople(accessCase, 'owner')).toBe(true);
          expect(yield* findsPeople(accessCase, 'member')).toBe(false);
          expect(yield* findsPeople(accessCase, 'foreignOwner')).toBe(false);
        }),
      ),
    );
  },
);
