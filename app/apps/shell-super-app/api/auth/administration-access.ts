import { decodeAccessDeclarationOrThrow, peopleDirectoryRead } from '@app/core-runtime';
import type { AccessDeclaration, TrustedPrincipalContext } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { preserveSystemPrincipalContextTrust } from '@app/core-runtime/auth/system-principal-context-provenance';
import { DateTime, Effect } from 'effect';

import { routeMeta as agentsRouteMeta } from '../../src/routes/[lang]/access/agents/route.meta.ts';
import { SupportImpersonationCorrelationId } from './support-impersonation-correlation-id.ts';

/*
 * The Shell's two company administration questions, answered by the one v2 gate (O62, O81, O88):
 *
 * - "Lidé a role" (`/sprava/lide-a-role`) loads the selected company's people directory through
 *   `core.identity.people-directory.list`. Its navigation entry, the connected-apps entry and the
 *   activity identity links are shown exactly to the people that same read admits, asked the same way.
 * - The company's agents are administered through the declared Agents administration surface
 *   (`shell-super-app.access-admin.agents`): an owner, the company's own access administrator, a live
 *   delegation for it, or a role cell granted in that company.
 *
 * Both are asked in the caller's own selected company, never in another company or the tenant context.
 * No legacy SpiceDB relation (`read_people`, `manage_people`, `manage_identity`) is asked: authorization
 * v2 writes none, so asking them refused every v2 tenant.
 */

/** The declared Agents administration surface; its declaration is the question every agent write asks first. */
export const AGENT_ADMINISTRATION_DECLARATION: AccessDeclaration = decodeAccessDeclarationOrThrow(
  agentsRouteMeta.accessDeclaration,
  agentsRouteMeta.entrypoint,
);

/** The people directory read the "Lidé a role" page loads its people from. */
const peopleDirectoryCarrier = peopleDirectoryRead.descriptor;

type CompanyPrincipal = TrustedPrincipalContext & { readonly legalEntityId: string };

/** The caller's own company scope, keeping a trusted system principal's provenance. */
const companyScopeOf = Effect.fn('AdministrationAccess.companyScope')(function* companyScope(
  principal: CompanyPrincipal,
) {
  return preserveSystemPrincipalContextTrust(principal, {
    ...principal,
    correlationId: yield* SupportImpersonationCorrelationId,
  });
});

/** The gate's answer to the People directory read in the caller's selected company. */
export const peopleAdministrationDecision = Effect.fn('AdministrationAccess.people')(function* peopleDecision(
  principal: CompanyPrincipal,
) {
  const gate = yield* AccessDecisionGate;
  // The page loads the selected company's list, so the question is asked in that company's exact scope.
  return yield* gate.decide({
    carrier: peopleDirectoryCarrier,
    legalEntityScope: 'required',
    now: yield* DateTime.nowAsDate,
    scope: yield* companyScopeOf(principal),
  });
});

/** The gate's answer to the Agents administration surface in the caller's selected company. */
export const agentAdministrationDecision = Effect.fn('AdministrationAccess.agents')(function* agentsDecision(
  principal: CompanyPrincipal,
) {
  const gate = yield* AccessDecisionGate;
  return yield* gate.decide({
    carrier: { accessDeclaration: AGENT_ADMINISTRATION_DECLARATION },
    legalEntityScope: 'required',
    now: yield* DateTime.nowAsDate,
    scope: yield* companyScopeOf(principal),
  });
});
