import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  DECISION_AT,
  accessAdminTemplateLayer,
  shellHttpFor,
  withAccessAdminCase,
} from '../support/access-admin-real-gate-fixture.ts';
import type { AccessAdminCase, Persona } from '../support/access-admin-real-gate-fixture.ts';
import { installedReleaseComposition } from '../support/installed-release-composition.ts';

/*
 * The Agents administration page, end to end on a v2-only tenant (real SpiceDB, no legacy tuples): its list endpoint
 * runs the page's gate question and then Core's company agent directory, agent administration audit and role template
 * reads. Those reads asked legacy `read_people` / `manage_identity` / `manage_people` targets, which the v2 schema does
 * not define, so every caller got 503. Now each person gets exactly the page gate's decision: 200 when it admits them,
 * a refusal otherwise, and never 503.
 */

const AGENTS_DECLARATION = 'shell-super-app.access-admin.agents';
const LIST_PATH = '/auth/identity/agent-entities/list';
const CASE_TIMEOUT = 300_000;

interface Ask {
  readonly company: 'other' | 'ours';
  readonly persona: Persona;
}

/** Every kind of caller: administrators, their delegate, plain members, an agent, and another tenant's owner. */
const ASKS: readonly Ask[] = [
  { company: 'ours', persona: 'owner' },
  { company: 'other', persona: 'owner' },
  { company: 'ours', persona: 'companyAdmin' },
  { company: 'other', persona: 'companyAdmin' },
  { company: 'ours', persona: 'delegate' },
  { company: 'ours', persona: 'member' },
  { company: 'ours', persona: 'directoryMember' },
  { company: 'ours', persona: 'agent' },
  { company: 'ours', persona: 'foreignOwner' },
];

const companyOf = (accessCase: AccessAdminCase, ask: Ask) => {
  const [ours = '', other = ''] = accessCase.companies;
  return ask.company === 'ours' ? ours : other;
};

/** The page's own gate question for this caller in this company, asked of the real gate. */
const pageDecision = Effect.fn('AgentsAdministration.pageDecision')(function* pageDecision(
  accessCase: AccessAdminCase,
  ask: Ask,
) {
  const declaration = accessCase.declarations.get(AGENTS_DECLARATION);
  if (declaration === undefined) {
    return yield* Effect.die(new Error(`${AGENTS_DECLARATION} is not published`));
  }
  const decision = yield* accessCase.gate.decide({
    carrier: { accessDeclaration: declaration },
    legalEntityScope: 'required',
    now: DECISION_AT,
    scope: yield* accessCase.scopeFor(ask.persona, companyOf(accessCase, ask)),
  });
  return decision.outcome;
});

type ShellHttp = Effect.Success<ReturnType<typeof shellHttpFor>>;

/** One caller's list answer beside the page gate's decision for the same caller and company. */
const listAnswerOf = Effect.fn('AgentsAdministration.listAnswer')(function* listAnswerOf(
  accessCase: AccessAdminCase,
  shell: ShellHttp,
  ask: Ask,
) {
  const outcome = yield* pageDecision(accessCase, ask);
  const response = yield* shell.post({
    legalEntityId: companyOf(accessCase, ask),
    path: LIST_PATH,
    payload: {},
    persona: ask.persona,
  });
  return { ...ask, outcome, status: response.status, text: response.text };
});

/** 200, a refusal (401/403), or anything else exactly as answered. */
const classOf = (status: number): number | 'refused' => {
  if (status === 200) {
    return 200;
  }
  return [401, 403].includes(status) ? 'refused' : status;
};

it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '180 seconds' })(
  'the Agents administration page on a v2-only tenant',
  (suite) => {
    suite.effect(
      'its list answers every caller exactly as the page gate decides: 200 or a refusal, never 503',
      () =>
        withAccessAdminCase((accessCase) =>
          Effect.scoped(
            Effect.gen(function* agentsList() {
              const shell = yield* shellHttpFor(accessCase, yield* installedReleaseComposition);
              const answers = yield* Effect.forEach(ASKS, (ask) => listAnswerOf(accessCase, shell, ask), {
                concurrency: 1,
              });
              for (const answer of answers) {
                const expected = answer.outcome === 'ALLOWED' ? 200 : 'refused';
                const actual = classOf(answer.status);
                expect({ ...answer, actual, text: actual === expected ? '' : answer.text }).toEqual({
                  ...answer,
                  actual: expected,
                  text: '',
                });
              }
              // The page admits its administrators: the owner in either company, the company's own administrator.
              expect(
                answers.filter(({ status }) => status === 200).map(({ company, persona }) => `${persona}@${company}`),
              ).toEqual(expect.arrayContaining(['owner@ours', 'owner@other', 'companyAdmin@ours']));
              // Nobody without the right reads it: members, an agent, another company's or tenant's administrator.
              expect(
                answers
                  .filter(({ persona }) => ['member', 'directoryMember', 'agent', 'foreignOwner'].includes(persona))
                  .map(({ status }) => status === 200),
              ).toEqual([false, false, false, false]);
              expect(
                answers.find(({ company, persona }) => persona === 'companyAdmin' && company === 'other')?.status,
              ).not.toBe(200);
            }),
          ),
        ),
      CASE_TIMEOUT,
    );
  },
);
