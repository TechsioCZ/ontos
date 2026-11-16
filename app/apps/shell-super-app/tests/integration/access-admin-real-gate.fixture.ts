import { accessPeopleDeclarations } from '../../api/access-admin/people.ts';
import type { AccessAdminCase, DeclarationQuestion } from '../support/access-admin-real-gate-fixture.ts';

/*
 * P14 — cross-lane security integration (#1343), the real-gate spine.
 *
 * Every claim below is answered by the real Core gate (`AccessDecisionLive` over
 * `AccessEnforcementPortsLive` and the tenant intent loader) against real PostgreSQL intent and real
 * SpiceDB authority, bootstrapped by the real `bootstrapTenantAccess`. There is no scripted gate in
 * this file: a test can only assert what the engine actually decided.
 *
 * The scenario table this spine covers is the one the administration surface will be judged by:
 *
 *   persona            expectation
 *   owner              every published administration capability, in the tenant context, no company
 *   companyAdmin       its explicit company-local role; nothing in the neighbouring company
 *   delegate           inside its delegated company and cells only (D10b)
 *   member             no administration capability at all
 *   suspended          nothing, even though the assignment row is still active
 *   expiredAssignment  nothing, because the assignment ended
 *   agent              nothing: agents are refused this surface (O67-Q5)
 *   workload           nothing: never a human administrator
 *   foreignOwner       its own tenant's authority only, never this tenant's
 *   manager            company A only, through a delegation naming the Lidé admit and end keys
 *   lapsed             nothing in company B while the tenant row has expired
 *
 * Lidé's HTTP half (every people write through the production Shell API) is
 * `access-admin-people-writes.test.ts`. Proposals are created by calling the owner Action with
 * `transport.intent = 'propose'` (O80) and then approved and executed in the inbox — that flow is
 * the next addition to the approval scenarios below.
 */

export const adminCapabilityKeys = (accessCase: AccessAdminCase) =>
  [...accessCase.declarations.values()]
    .filter((declaration) => declaration.kind === 'admin')
    .map((declaration) => declaration.key);

/** A published administration capability the suite uses as its spine. */
export const SPINE_DECLARATION = 'core.modules.tenant-module.change-state';

/** A capability the release catalog publishes for every tenant. */
export const SHELL_READ_DECLARATION = 'core.shell.composition.read';

/** The Lidé membership writes: shipped by the Shell entrypoints, published in no release. */
export const MEMBERSHIP_WRITE_KEYS = [
  'shell-super-app.access-people.admit-member',
  'shell-super-app.access-people.end-membership',
] as const;

/** The declaration a Lidé entrypoint ships for one key, exactly as the BFF hands it to the gate. */
export const shippedDeclaration = (key: string) => {
  const declaration = Object.values(accessPeopleDeclarations).find((candidate) => candidate.key === key);
  if (declaration === undefined) {
    throw new Error(`api/access-admin/people.ts ships no declaration for ${key}`);
  }
  return declaration;
};

export type Where = Pick<DeclarationQuestion, 'legalEntityId' | 'scope'>;
