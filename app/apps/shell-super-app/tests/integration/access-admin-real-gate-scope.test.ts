import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  TASKS_CAPABILITY_KEY,
  accessAdminTemplateLayer,
  withAccessAdminCase,
} from '../support/access-admin-real-gate-fixture.ts';
import type { Persona } from '../support/access-admin-real-gate-fixture.ts';
import {
  MEMBERSHIP_WRITE_KEYS,
  SHELL_READ_DECLARATION,
  SPINE_DECLARATION,
  shippedDeclaration,
} from './access-admin-real-gate.fixture.ts';
import type { Where } from './access-admin-real-gate.fixture.ts';

it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '120 seconds' })(
  'the real access gate',
  (suite) => {
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

    suite.effect('a company role decides in its own company only, and an expired tenant row holds nothing', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* seededPeopleIntent() {
          const [companyA, companyB] = accessCase.companies;
          const ask = (persona: Persona, legalEntityId: string | undefined) =>
            accessCase.decide({ declarationKey: TASKS_CAPABILITY_KEY, legalEntityId, persona, scope: 'legal-entity' });
          expect((yield* ask('manager', companyA)).outcome).toBe('ALLOWED');
          expect((yield* ask('manager', companyB)).outcome).toBe('DENIED');
          // The lapsed person still holds an active company-B row and B assignment; only the tenant row
          // ended. Admission must never turn that back on (skeptic S1), so it must be DENIED here first.
          expect((yield* ask('lapsed', companyB)).outcome).toBe('DENIED');
        }),
      ),
    );

    suite.effect('admitting and ending a membership is decided by administration of that scope', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* membershipWriteDecisions() {
          const [companyA, companyB] = accessCase.companies;
          const tenant: Where = { scope: 'tenant' };
          const inA: Where = { legalEntityId: companyA, scope: 'legal-entity' };
          const inB: Where = { legalEntityId: companyB, scope: 'legal-entity' };
          const expected: readonly (readonly [Persona, Where, 'ALLOWED' | 'DENIED'])[] = [
            ['owner', tenant, 'ALLOWED'],
            ['owner', inA, 'ALLOWED'],
            ['companyAdmin', inA, 'ALLOWED'],
            ['companyAdmin', inB, 'DENIED'],
            ['companyAdmin', tenant, 'DENIED'],
            ['member', inA, 'DENIED'],
            ['agent', inA, 'DENIED'],
            // The manager's delegation names both keys (fixture SQL; no command can grant them), so the
            // gate admits the manager in company A. Core's own permanent-basis rule is what refuses
            // that delegate: access-admin-people-writes.test.ts proves the 403 people_authority_missing.
            ['manager', inA, 'ALLOWED'],
            ['manager', inB, 'DENIED'],
          ];
          for (const declarationKey of MEMBERSHIP_WRITE_KEYS) {
            const declaration = shippedDeclaration(declarationKey);
            for (const [persona, where, outcome] of expected) {
              const answer = yield* accessCase.decide({ declaration, declarationKey, persona, ...where });
              expect({ declarationKey, outcome: answer.outcome, persona, where }).toEqual({
                declarationKey,
                outcome,
                persona,
                where,
              });
            }
          }
        }),
      ),
    );
  },
);
