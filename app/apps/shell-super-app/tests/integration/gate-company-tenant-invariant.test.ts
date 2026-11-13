import { decodeAccessWorkload } from '@app/core-runtime';
import type { LegalEntityScope, OperationalScope } from '@app/core-runtime';
import { Effect, Result, Tracer } from 'effect';
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

const withQueryCompany = (scope: OperationalScope) =>
  scope.legalEntityId === undefined
    ? { tenantId: scope.tenantId }
    : { legalEntityId: scope.legalEntityId, tenantId: scope.tenantId };

/**
 * The same question asked as an inspection: the requester asks about itself, so the subject is the persona of the
 * case. A company named in the tenant context is checked by the subject's own scope read, never by a read of its own.
 */
const inspectionOf = Effect.fn('GateInvariant.inspection')(function* inspectionOf(
  accessCase: AccessAdminCase,
  testCase: Case,
  legalEntityScope: LegalEntityScope,
) {
  const declaration = accessCase.declarations.get(DECLARATION);
  if (declaration === undefined) {
    return yield* Effect.die(new Error(`${DECLARATION} is not published`));
  }
  const requesterScope = yield* scopeOf(accessCase, testCase);
  const { decision } = yield* accessCase.inspection
    .inspect({
      carrier: { accessDeclaration: declaration },
      legalEntityScope,
      queryScope: withQueryCompany(requesterScope),
      requesterScope,
      subject: { principalId: requesterScope.principalId, tenantId: requesterScope.tenantId },
    })
    .pipe(Effect.orDie);
  return {
    case: testCase.label,
    codes: decision.reasons.map(({ code }) => code),
    mode: legalEntityScope,
    outcome: decision.outcome,
  };
});

/** Counts the spans one program opens, by name: the loader's scope reads, its statements and its transactions. */
const countingTracer = (counts: Map<string, number>) =>
  Tracer.make({
    span: (options) => {
      counts.set(options.name, (counts.get(options.name) ?? 0) + 1);
      return new Tracer.NativeSpan(options);
    },
  });

const publishedDeclaration = (accessCase: AccessAdminCase) => {
  const declaration = accessCase.declarations.get(DECLARATION);
  return declaration === undefined
    ? Effect.die(new Error(`${DECLARATION} is not published`))
    : Effect.succeed(declaration);
};

/** One description of the owner in the selected company: the people-directory question in every scope mode. */
const describeOwnerIn = Effect.fn('GateInvariant.describe')(function* describeOwnerIn(
  accessCase: AccessAdminCase,
  company: string | undefined,
) {
  const declaration = yield* publishedDeclaration(accessCase);
  const requesterScope = { ...(yield* accessCase.scopeFor('owner', company)), tenantId: accessCase.tenantId };
  const answers = yield* accessCase.inspection
    .capabilities({
      actionKeys: [],
      queryScope: withQueryCompany(requesterScope),
      questions: MODES.map((legalEntityScope) => ({
        carrier: { accessDeclaration: declaration },
        legalEntityScope,
        listing: false,
      })),
      requesterScope,
      subject: { principalId: requesterScope.principalId, tenantId: requesterScope.tenantId },
    })
    .pipe(Effect.orDie);
  return answers.answers.map(({ decision }) => ({
    codes: decision.reasons.map(({ code }) => code),
    outcome: decision.outcome,
  }));
});

/** Every mode and case that names a company or no company in a way the mode can be asked. */
const QUESTIONS = MODES.flatMap((mode) =>
  CASES.filter((testCase) => mode !== 'required' || testCase.company !== 'none').map((testCase) => ({
    mode,
    testCase,
  })),
);

/** The storefront workload carrier of a Customer Context read, as a governed read decodes it. */
const STOREFRONT_CARRIER = {
  accessWorkload: Result.getOrThrow(
    decodeAccessWorkload(
      {
        reason: 'The registered storefront client reads on its customer behalf',
        workloads: ['commerce.storefront-client'],
      },
      { access: 'read', authorization: { kind: 'protected' }, moduleKey: 'commerce.customer-context', role: 'api' },
    ),
  ),
};

const codesOf = (decision: { readonly reasons: readonly { readonly code: string }[] }) =>
  decision.reasons.map(({ code }) => code);

const ownerQuestionOf = Effect.fn('GateInvariant.ownerQuestion')(function* ownerQuestionOf(
  accessCase: AccessAdminCase,
  declaration: NonNullable<ReturnType<AccessAdminCase['declarations']['get']>>,
  company: string | undefined,
  legalEntityScope: LegalEntityScope,
) {
  const scope = yield* accessCase.scopeFor('owner', company);
  return {
    carrier: { accessDeclaration: declaration },
    legalEntityScope,
    now: DECISION_AT,
    scope: { ...scope, tenantId: accessCase.tenantId },
  };
});

/** The owner's rows of one batch: each names its own company (ours, the other tenant's, or none) and mode. */
const batchQuestionsOf = Effect.fn('GateInvariant.batchQuestions')(function* batchQuestionsOf(
  accessCase: AccessAdminCase,
) {
  const declaration = accessCase.declarations.get(DECLARATION);
  if (declaration === undefined) {
    return yield* Effect.die(new Error(`${DECLARATION} is not published`));
  }
  const [ours] = accessCase.companies;
  const [foreign] = accessCase.foreignCompanies;
  const rows: readonly { readonly company: string | null | undefined; readonly mode: LegalEntityScope }[] = [
    { company: ours, mode: 'optional' },
    { company: foreign, mode: 'optional' },
    { company: ours, mode: 'required' },
    { company: foreign, mode: 'forbidden' },
    { company: foreign, mode: 'required' },
    { company: null, mode: 'optional' },
  ];
  return yield* Effect.forEach(
    rows,
    ({ company, mode }) => ownerQuestionOf(accessCase, declaration, company ?? undefined, mode),
    { concurrency: 1 },
  );
});

const workloadQuestionOf = Effect.fn('GateInvariant.workloadQuestion')(function* workloadQuestionOf(
  accessCase: AccessAdminCase,
  company: string,
) {
  const scope = yield* accessCase.scopeFor('workload', company);
  return {
    carrier: STOREFRONT_CARRIER,
    legalEntityScope: 'required' as const,
    now: DECISION_AT,
    scope: { ...scope, tenantId: accessCase.tenantId },
  };
});

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

    suite.effect('an inspection refuses a company of another tenant in every scope mode, as the gate does', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* inspections() {
          const answers = yield* Effect.forEach(
            QUESTIONS,
            ({ mode, testCase }) => inspectionOf(accessCase, testCase, mode),
            { concurrency: 1 },
          );
          expect(answers.map(({ case: label, mode, outcome }) => ({ label, mode, outcome }))).toEqual(
            QUESTIONS.map(({ mode, testCase }) => ({ label: testCase.label, mode, outcome: testCase.expected })),
          );
          const foreignPairings = answers.filter((_, index) => {
            const question = QUESTIONS[index];
            return question !== undefined && pairsForeignCompany(question.testCase);
          });
          expect(foreignPairings.map(({ case: label, codes, mode }) => ({ codes, label, mode }))).toEqual(
            foreignPairings.map(({ case: label, mode }) => ({ codes: ['deny.scope_mismatch'], label, mode })),
          );
          expect(foreignPairings.length).toBe(6);
        }),
      ),
    );

    suite.effect(
      'the description path (a batch of inspections) refuses a foreign company row by row, as the gate does',
      () =>
        withAccessAdminCase((accessCase) =>
          Effect.gen(function* describedBatches() {
            const [ours] = accessCase.companies;
            const [foreign] = accessCase.foreignCompanies;
            // One description per selected company: ours is admitted in every mode, the other tenant's in none.
            const oursAnswers = yield* describeOwnerIn(accessCase, ours);
            const foreignAnswers = yield* describeOwnerIn(accessCase, foreign);
            expect(oursAnswers.map(({ outcome }) => outcome)).toEqual(['ALLOWED', 'ALLOWED', 'ALLOWED']);
            expect(foreignAnswers).toEqual(MODES.map(() => ({ codes: ['deny.scope_mismatch'], outcome: 'DENIED' })));
          }),
        ),
    );

    suite.effect('a page of tenant-context LISTs with a company selected reads its scope once', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* measuredListPage() {
          const declaration = yield* publishedDeclaration(accessCase);
          const [ours] = accessCase.companies;
          const page = yield* Effect.forEach(
            ['optional', 'forbidden', 'optional'] as const,
            (mode) => ownerQuestionOf(accessCase, declaration, ours, mode),
            { concurrency: 1 },
          );
          const counts = new Map<string, number>();
          const listed = yield* accessCase.gate.listMany(page).pipe(Effect.withTracer(countingTracer(counts)));
          expect(listed.map(({ decision }) => decision.outcome)).toEqual(['ALLOWED', 'ALLOWED', 'ALLOWED']);
          const measured = {
            scopeReads: counts.get('TenantIntentLoader.readScope') ?? 0,
            statements: counts.get('postgres') ?? 0,
            transactions: counts.get('sql.transaction') ?? 0,
          };
          yield* Effect.logInfo('listMany page cost').pipe(Effect.annotateLogs(measured));
          // The gate's checked read answers the engine's company-less read of the same holder: one read, as on trunk.
          expect(measured.scopeReads).toBe(1);
        }),
      ),
    );

    suite.effect(
      'a batch decides each row in its own company: a foreign row is refused, never admitted or spilled over, and writes no evidence row',
      () =>
        withAccessAdminCase((accessCase) =>
          Effect.gen(function* batches() {
            const questions = yield* batchQuestionsOf(accessCase);
            const expected = ['ALLOWED', 'DENIED', 'ALLOWED', 'DENIED', 'DENIED', 'ALLOWED'];
            const batched = yield* accessCase.gate.decideMany(questions);
            expect(batched.map(({ outcome }) => outcome)).toEqual(expected);
            // Each batched answer is the answer the row gets alone.
            const alone = yield* Effect.forEach(questions, (question) => accessCase.gate.decide(question), {
              concurrency: 1,
            });
            expect(alone.map(({ outcome }) => outcome)).toEqual(expected);
            expect(
              [1, 3, 4].map((index) => batched[index]).map((answer) => (answer === undefined ? [] : codesOf(answer))),
            ).toEqual([['deny.scope_mismatch'], ['deny.scope_mismatch'], ['deny.scope_mismatch']]);
            const listed = yield* accessCase.gate.listMany(questions);
            expect(listed.map(({ decision }) => decision.outcome)).toEqual(expected);
            expect(listed.filter(({ predicate }) => predicate !== undefined).length).toBe(3);
          }),
        ),
    );

    suite.effect('a bound storefront workload acts only in its registered company of this tenant', () =>
      withAccessAdminCase((accessCase) =>
        Effect.gen(function* workloads() {
          const [companyA = '', companyB = ''] = accessCase.companies;
          const [foreign = ''] = accessCase.foreignCompanies;
          yield* accessCase.bindWorkload({
            legalEntityIds: [companyA],
            persona: 'workload',
            workloadKey: 'commerce.storefront-client',
          });
          const questions = yield* Effect.forEach(
            [companyA, foreign, companyB, companyA],
            (company) => workloadQuestionOf(accessCase, company),
            { concurrency: 1 },
          );
          const alone = yield* Effect.forEach(questions, (question) => accessCase.gate.decide(question), {
            concurrency: 1,
          });
          const batched = yield* accessCase.gate.decideMany(questions);
          for (const answers of [alone, batched]) {
            expect(answers.map((answer) => codesOf(answer))).toEqual([
              ['allow.workload'],
              ['deny.scope_mismatch'],
              ['deny.workload_unbound'],
              ['allow.workload'],
            ]);
          }
        }),
      ),
    );
  },
);
