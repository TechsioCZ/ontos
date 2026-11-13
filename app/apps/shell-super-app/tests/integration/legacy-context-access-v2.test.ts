import { proposalLifecycleAdministrator } from '@app/core-runtime';
import { administersOAuthConnections } from '../../../../packages/core-runtime/src/auth/oauth-connection-administration-read.ts';
import { mayFindPeople } from '@app/core-runtime/people/search';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { agentAdministrationDecision } from '../../api/auth/administration-access.ts';
import { peopleAdministrationCapability } from '../../api/auth/demo-accounts.ts';
import {
  DECISION_AT,
  accessAdminTemplateLayer,
  withAccessAdminCase,
} from '../support/access-admin-real-gate-fixture.ts';
import type { AccessAdminCase, Persona } from '../support/access-admin-real-gate-fixture.ts';
import { tenantModuleTargetTestCarrier } from '../support/tenant-module-target-carrier.ts';

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
    carrier: tenantModuleTargetTestCarrier,
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
