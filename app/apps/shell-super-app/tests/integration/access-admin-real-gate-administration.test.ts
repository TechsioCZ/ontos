import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { accessAdminTemplateLayer, withAccessAdminCase } from '../support/access-admin-real-gate-fixture.ts';
import { SPINE_DECLARATION, adminCapabilityKeys } from './access-admin-real-gate.fixture.ts';

it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '120 seconds' })(
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
  },
);
