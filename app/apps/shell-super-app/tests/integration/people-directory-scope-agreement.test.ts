import { peopleDirectoryRead } from '@app/core-runtime';
import { AccessDecisionGate } from '@app/core-runtime/access/enforcement';
import { mayFindPeople } from '@app/core-runtime/people/search';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { peopleAdministrationCapability } from '../../api/auth/demo-accounts.ts';
import {
  DECISION_AT,
  accessAdminTemplateLayer,
  withAccessAdminCase,
} from '../support/access-admin-real-gate-fixture.ts';
import type { AccessAdminCase, Persona } from '../support/access-admin-real-gate-fixture.ts';

/*
 * The "Lidé a role" page, its navigation entry and People search are one question
 * (`core.identity.people-directory.list`) asked in ONE scope mode: the mode the People list read declares.
 * Each is asked here through its own code, over the real gate on a v2-only tenant with company A selected,
 * for a tenant-wide holder, a company-only holder, a person without the right, the owner and the company's
 * access administrator. For every one of them the link, search and the page give the same answer.
 */

const DIRECTORY_LIST = 'core.identity.people-directory.list';

interface Answers {
  readonly link: boolean;
  readonly page: boolean;
  readonly search: boolean;
}

const companyScope = Effect.fn('PeopleAgreement.companyScope')(function* companyScope(
  accessCase: AccessAdminCase,
  persona: Persona,
) {
  const legalEntityId = accessCase.companies[0] ?? '';
  const scope = yield* accessCase.scopeFor(persona, legalEntityId);
  return { ...scope, legalEntityId, tenantId: accessCase.tenantId };
});

const answersOf = Effect.fn('PeopleAgreement.answers')(function* answersOf(
  accessCase: AccessAdminCase,
  persona: Persona,
) {
  const scope = yield* companyScope(accessCase, persona);
  const page = yield* accessCase.gate.decide({
    carrier: peopleDirectoryRead.descriptor,
    legalEntityScope: peopleDirectoryRead.descriptor.legalEntityScope,
    now: DECISION_AT,
    scope,
  });
  const { canManage } = yield* peopleAdministrationCapability({ principal: scope }).pipe(
    Effect.provideService(AccessDecisionGate, accessCase.gate),
  );
  const search = yield* mayFindPeople(scope).pipe(Effect.provideService(AccessDecisionGate, accessCase.gate));
  return { link: canManage, page: page.outcome === 'ALLOWED', search } satisfies Answers;
});

const all = (value: boolean): Answers => ({ link: value, page: value, search: value });

it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '180 seconds' })(
  'the People page, its navigation entry and People search answer alike',
  (suite) => {
    suite.effect('the read declares the tenant-context mode the link and search now share', () =>
      Effect.sync(() => {
        expect(peopleDirectoryRead.descriptor.legalEntityScope).toBe('optional');
      }),
    );

    suite.effect('tenant-wide holder, company-only holder and non-holder each get one answer', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* holders() {
          const [companyA] = accessCase.companies;
          // Before any grant, the plain member holds nothing: no link, no hit, no page.
          expect(yield* answersOf(accessCase, 'member')).toEqual(all(false));

          // A role holding the list right in the tenant context: every surface admits it.
          yield* accessCase.grantRole({ capabilityKeys: [DIRECTORY_LIST], persona: 'member' });
          expect(yield* answersOf(accessCase, 'member')).toEqual(all(true));

          // The same right only in company A: the page's read is decided in the tenant context and refuses
          // it, so the link and search refuse it too — never a link to a page that then says no.
          yield* accessCase.grantRole({
            capabilityKeys: [DIRECTORY_LIST],
            legalEntityId: companyA,
            persona: 'manager',
          });
          expect(yield* answersOf(accessCase, 'manager')).toEqual(all(false));

          expect(yield* answersOf(accessCase, 'owner')).toEqual(all(true));
        }),
      ),
    );

    suite.effect('a company access administrator gets neither link nor search hits the page would refuse', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* companyAdministrator() {
          // Access administration is not the list right: the company's administrator holds the admin keys,
          // and `people-directory.list` is a read. The page refuses them and so do the link and search. (The
          // mode change narrowed only company-only role holders of the list right, the manager case above.)
          expect(yield* answersOf(accessCase, 'companyAdmin')).toEqual(all(false));
        }),
      ),
    );
  },
);
