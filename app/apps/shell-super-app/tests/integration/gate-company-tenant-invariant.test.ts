import type { LegalEntityScope, OperationalScope } from '@app/core-runtime';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  DECISION_AT,
  accessAdminTemplateLayer,
  withAccessAdminCase,
} from '../support/access-admin-real-gate-fixture.ts';
import type { AccessAdminCase, Persona } from '../support/access-admin-real-gate-fixture.ts';

/*
 * The gate never decides a request whose tenant and company do not belong together (O66, O88). A scope is
 * a tenant, a principal and maybe a company; every combination below is asked of the real gate over real
 * intent and SpiceDB, in every scope mode. Only a principal of the asked tenant, asking about a company of
 * that same tenant (or none), may ever be admitted.
 *
 * Before the fix, `optional` and `forbidden` ignored the named company and decided in the tenant context:
 * tenant B's owner, asking in tenant B with a company of tenant A, was ALLOWED by its own "Plný přístup"
 * cell in tenant B.
 */

const DECLARATION = 'core.identity.people-directory.list';
const MODES: readonly LegalEntityScope[] = ['optional', 'forbidden', 'required'];

interface Case {
  readonly company: 'foreign' | 'none' | 'ours';
  readonly expected: 'ALLOWED' | 'DENIED';
  readonly label: string;
  readonly persona: Persona;
  readonly tenant: 'foreign' | 'ours';
}

const CASES: readonly Case[] = [
  {
    company: 'ours',
    expected: 'ALLOWED',
    label: 'our owner, our tenant, our company',
    persona: 'owner',
    tenant: 'ours',
  },
  {
    company: 'ours',
    expected: 'DENIED',
    label: "the other tenant's owner, its own tenant, OUR company",
    persona: 'foreignOwner',
    tenant: 'foreign',
  },
  {
    company: 'ours',
    expected: 'DENIED',
    label: "the other tenant's owner, OUR tenant, our company",
    persona: 'foreignOwner',
    tenant: 'ours',
  },
  {
    company: 'none',
    expected: 'DENIED',
    label: "the other tenant's owner, OUR tenant, no company",
    persona: 'foreignOwner',
    tenant: 'ours',
  },
  {
    company: 'foreign',
    expected: 'DENIED',
    label: "our owner, our tenant, the OTHER tenant's company",
    persona: 'owner',
    tenant: 'ours',
  },
];

/** A company of another tenant in the request: the pairing the gate must refuse by its scope, not by grants. */
const pairsForeignCompany = (testCase: Case): boolean =>
  testCase.company === 'foreign' || (testCase.tenant === 'foreign' && testCase.company === 'ours');

const scopeOf = Effect.fn('GateInvariant.scope')(function* scopeOf(accessCase: AccessAdminCase, testCase: Case) {
  const companies = new Map([
    ['foreign', accessCase.foreignCompanies[0]],
    ['ours', accessCase.companies[0]],
  ]);
  const legalEntityId = companies.get(testCase.company);
  const base = yield* accessCase.scopeFor(testCase.persona, legalEntityId);
  const tenantId = testCase.tenant === 'ours' ? accessCase.tenantId : accessCase.foreignTenantId;
  const { legalEntityId: _dropped, ...withoutCompany } = base;
  const scope: OperationalScope = legalEntityId === undefined ? withoutCompany : { ...base, legalEntityId };
  return { ...scope, tenantId };
});

const answerOf = Effect.fn('GateInvariant.answer')(function* answerOf(
  accessCase: AccessAdminCase,
  testCase: Case,
  legalEntityScope: LegalEntityScope,
) {
  const declaration = accessCase.declarations.get(DECLARATION);
  if (declaration === undefined) {
    return yield* Effect.die(new Error(`${DECLARATION} is not published`));
  }
  const decision = yield* accessCase.gate.decide({
    carrier: { accessDeclaration: declaration },
    legalEntityScope,
    now: DECISION_AT,
    scope: yield* scopeOf(accessCase, testCase),
  });
  return {
    case: testCase.label,
    codes: decision.reasons.map(({ code }) => code),
    mode: legalEntityScope,
    outcome: decision.outcome,
  };
});

/** Every mode and case that names a company or no company in a way the mode can be asked. */
const QUESTIONS = MODES.flatMap((mode) =>
  CASES.filter((testCase) => mode !== 'required' || testCase.company !== 'none').map((testCase) => ({
    mode,
    testCase,
  })),
);

it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '120 seconds' })(
  'the gate pairs a tenant only with its own principals and companies',
  (suite) => {
    suite.effect('every scope mode refuses a principal or a company of another tenant', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* everyMode() {
          const answers = yield* Effect.forEach(
            QUESTIONS,
            ({ mode, testCase }) => answerOf(accessCase, testCase, mode),
            { concurrency: 1 },
          );
          expect(answers.map(({ case: label, mode, outcome }) => ({ label, mode, outcome }))).toEqual(
            QUESTIONS.map(({ mode, testCase }) => ({ label: testCase.label, mode, outcome: testCase.expected })),
          );
          const foreignPairings = answers.filter((_, index) => {
            const question = QUESTIONS[index];
            return question !== undefined && pairsForeignCompany(question.testCase);
          });
          expect(foreignPairings.length).toBe(6);
          for (const answer of foreignPairings) {
            expect({ case: answer.case, codes: answer.codes, mode: answer.mode }).toEqual({
              case: answer.case,
              codes: ['deny.scope_mismatch'],
              mode: answer.mode,
            });
          }
        }),
      ),
    );
  },
);
