import { administersOAuthConnections, decodeAccessDeclarationOrThrow, peopleDirectoryRead } from '@app/core-runtime';
import type { AccessDeclaration, OperationalScope, TrustedPrincipalContext } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { preserveSystemPrincipalContextTrust } from '@app/core-runtime/auth/system-principal-context-provenance';
import { DateTime, Effect } from 'effect';

import { routeMeta as agentsRouteMeta } from '../../src/routes/[lang]/access/agents/route.meta.ts';
import { TENANT_MODULE_TARGET_ACCESS_DECLARATION } from '../modules/shell-governed-reads.ts';
import { SupportImpersonationCorrelationId } from './support-impersonation-correlation-id.ts';

/*
 * The Shell's two company administration questions, answered by the one v2 gate (O62, O81, O88):
 *
 * - "Lidé a role" (`/sprava/lide-a-role`) loads the selected company's people directory through
 *   `core.identity.people-directory.list`. Its navigation entry, the connected-apps entry and the
 *   activity identity links are shown exactly to the people that same read admits, asked in the same
 *   scope mode the read declares.
 * - The company's agents are administered through the declared Agents administration surface
 *   (`shell-super-app.access-admin.agents`): an owner, the company's own access administrator, a live
 *   delegation for it, or a role cell granted in that company.
 *
 * Neither is ever asked in another tenant's company: a named company must be the asked tenant's own.
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
  // Asked exactly as the page's read asks it (its declared scope mode), so the link never promises a page
  // the read refuses; the selected company is still checked to be the tenant's own.
  return yield* gate.decide({
    carrier: peopleDirectoryCarrier,
    legalEntityScope: peopleDirectoryCarrier.legalEntityScope,
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

/**
 * Whether the caller administers the selected company's connected applications
 * (`core.identity.oauth-connection.administer`): the connected-apps handlers' one admin question. An unreadable
 * authority answers no, as the handlers always did: the caller then sees only their own connections.
 */
export const connectedAppsAdministration = Effect.fn('AdministrationAccess.connectedApps')(
  function* connectedAppsAdministration(scope: OperationalScope) {
    return yield* administersOAuthConnections(scope).pipe(Effect.orElseSucceed(() => false));
  },
);

/**
 * Whether the caller gets the tenant release hint. It serves only tenant-context page dispatch, so it goes to exactly
 * the people that dispatch admits: `core.shell.tenant-module-target.resolve`, asked in the tenant context (O28).
 */
export const tenantReleaseHintAdmitted = Effect.fn('AdministrationAccess.tenantReleaseHint')(
  function* tenantReleaseHintAdmitted(scope: OperationalScope) {
    const gate = yield* AccessDecisionGate;
    const decision = yield* gate.decide({
      carrier: { accessDeclaration: TENANT_MODULE_TARGET_ACCESS_DECLARATION },
      legalEntityScope: 'optional',
      now: yield* DateTime.nowAsDate,
      scope,
    });
    return decision.outcome === 'ALLOWED';
  },
);
