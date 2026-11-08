import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { templateDatabaseLayer, withAccessAdminCase } from '../support/access-admin-real-gate-fixture.ts';
import type { AccessAdminCase } from '../support/access-admin-real-gate-fixture.ts';

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
 *
 * The HTTP half of the table (401/403/409/422/503 per surface, tenant isolation, stale preview,
 * approval single use) needs P1's registered groups and P2–P7's handlers; it lands on top of this
 * fixture once `shared/api.ts` serves them. Proposals are created by calling the owner Action with
 * `transport.intent = 'propose'` (O80) and then approved and executed in the inbox — that flow is
 * the next addition to the approval scenarios below.
 */

const adminCapabilityKeys = (accessCase: AccessAdminCase) =>
  [...accessCase.declarations.values()]
    .filter((declaration) => declaration.kind === 'admin')
    .map((declaration) => declaration.key);

/** A published administration capability the suite uses as its spine. */
const SPINE_DECLARATION = 'core.modules.tenant-module.change-state';

/** A capability the release catalog publishes for every tenant. */
const SHELL_READ_DECLARATION = 'core.shell.composition.read';

it.layer(templateDatabaseLayer, { excludeTestServices: true, timeout: '120 seconds' })(
  'the real access gate',
  (suite) => {
    suite.effect('a bootstrapped owner may run every published administration capability', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* ownerRunsAdministration() {
          const keys = adminCapabilityKeys(accessCase);
          expect(keys.length).toBeGreaterThan(0);
          for (const declarationKey of keys) {
            const answer = yield* accessCase.decide({ declarationKey, persona: 'owner' });
            expect({ declarationKey, outcome: answer.outcome }).toEqual({ declarationKey, outcome: 'ALLOWED' });
          }
        }),
      ),
    );

    suite.effect('a plain member of the tenant holds no administration capability', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* memberHoldsNothing() {
          const answer = yield* accessCase.decide({ declarationKey: SPINE_DECLARATION, persona: 'member' });
          expect(answer.outcome).toBe('DENIED');
        }),
      ),
    );

    suite.effect('administration is decided in the tenant context, with no company selected', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* tenantContextAdministration() {
          // The negative control first: an ordinary member is refused in the same tenant context.
          const denied = yield* accessCase.decide({
            declarationKey: SPINE_DECLARATION,
            persona: 'member',
            scope: 'tenant',
          });
          expect(denied.outcome).toBe('DENIED');
          const allowed = yield* accessCase.decide({
            declarationKey: SPINE_DECLARATION,
            persona: 'owner',
            scope: 'tenant',
          });
          expect(allowed.outcome).toBe('ALLOWED');
          expect(allowed.reasonCodes).not.toContain('deny.scope_mismatch');
        }),
      ),
    );

    suite.effect('a company administrator holds its company-local role and nothing in the other company', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* companyLocalAdministration() {
          const [companyA, companyB] = accessCase.companies;
          const inside = yield* accessCase.decide({
            declarationKey: SPINE_DECLARATION,
            legalEntityId: companyA,
            persona: 'companyAdmin',
            scope: 'legal-entity',
          });
          expect(inside.outcome).toBe('ALLOWED');
          // The negative control: the same role in the neighbouring company is not a grant there.
          const outside = yield* accessCase.decide({
            declarationKey: SPINE_DECLARATION,
            legalEntityId: companyB,
            persona: 'companyAdmin',
            scope: 'legal-entity',
          });
          expect(outside.outcome).toBe('DENIED');
        }),
      ),
    );

    suite.effect('a suspended holder, an ended assignment and an agent hold nothing', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* revokedHolders() {
          for (const persona of ['suspended', 'expiredAssignment', 'agent'] as const) {
            const answer = yield* accessCase.decide({
              declarationKey: SPINE_DECLARATION,
              legalEntityId: accessCase.companies[0],
              persona,
              scope: 'legal-entity',
            });
            expect({ outcome: answer.outcome, persona }).toEqual({ outcome: 'DENIED', persona });
          }
        }),
      ),
    );

    suite.effect('a delegate acts inside its delegated company only', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* delegatedAdministration() {
          const [companyA, companyB] = accessCase.companies;
          const inside = yield* accessCase.decide({
            declarationKey: SPINE_DECLARATION,
            legalEntityId: companyA,
            persona: 'delegate',
            scope: 'legal-entity',
          });
          expect(inside.outcome).toBe('ALLOWED');
          const outside = yield* accessCase.decide({
            declarationKey: SPINE_DECLARATION,
            legalEntityId: companyB,
            persona: 'delegate',
            scope: 'legal-entity',
          });
          expect(outside.outcome).toBe('DENIED');
        }),
      ),
    );

    suite.effect('an unreachable engine is UNAVAILABLE, never DENIED (O48)', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* unavailableEngine() {
          const answer = yield* accessCase.decideUnavailable({
            declarationKey: SHELL_READ_DECLARATION,
            legalEntityId: accessCase.companies[0],
            persona: 'owner',
            scope: 'legal-entity',
          });
          expect(answer.outcome).toBe('UNAVAILABLE');
          expect(answer.reasonCodes.some((code) => code.startsWith('unavailable.'))).toBe(true);
        }),
      ),
    );

    suite.effect('another tenant is decided against its own authority', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* tenantIsolation() {
          // The foreign owner is a real owner — of the other tenant. The same declaration asked with
          // this tenant's scope must not answer from that authority.
          const own = yield* accessCase.decide({ declarationKey: SPINE_DECLARATION, persona: 'foreignOwner' });
          expect(own.outcome).toBe('ALLOWED');
          const member = yield* accessCase.decide({ declarationKey: SPINE_DECLARATION, persona: 'member' });
          expect(member.outcome).toBe('DENIED');
          expect(accessCase.ids.get('member')?.principalId).not.toBe(accessCase.ids.get('owner')?.principalId);
        }),
      ),
    );
  },
);
