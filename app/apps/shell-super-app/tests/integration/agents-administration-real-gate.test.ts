import { AgentEntityOverviewSchema } from '@app/shared-contracts/agent-access';
import { Effect, Option, Schema } from 'effect';
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
const MANAGE_PATH = '/auth/identity/agent-entities';
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

    suite.effect(
      "the owner reads the company's agent, its operators, its audit and the tenant's v2 roles; a member is refused",
      () =>
        withAccessAdminCase((accessCase) =>
          Effect.scoped(
            Effect.gen(function* ownerReadsCompanyAgents() {
              // Stage-shaped: an agent of the company (its Core company membership, as `configure-agent` writes it),
              // the tenant's v2 roles, and no legacy SpiceDB tuple anywhere (the fixture's SpiceDB carries exactly the
              // schema stage serves). Trunk read the company's members and each agent's operators from legacy
              // `legal_entity#member` / `principal#operator` relations: empty on a v2 tenant, unknown to its schema.
              const [ours = ''] = accessCase.companies;
              const agentId = accessCase.ids.get('agent')?.principalId ?? '';
              const memberId = accessCase.ids.get('member')?.principalId ?? '';
              yield* accessCase.admin
                .unsafe(
                  `insert into core.principal_company_memberships (tenant_id, legal_entity_id, principal_id, affiliation, status)
                   values ($1, $2, $3, null, 'active')`,
                  [accessCase.tenantId, ours, agentId],
                )
                .pipe(Effect.orDie);
              const shell = yield* shellHttpFor(accessCase, yield* installedReleaseComposition);
              // A member's attempt to disable the agent is refused, and the refusal is written to the agent audit.
              const attempt = yield* shell.post({
                idempotencyKey: 'agents-real-gate-member-disable',
                legalEntityId: ours,
                path: MANAGE_PATH,
                payload: {
                  expectedStatus: 'active',
                  newStatus: 'disabled',
                  operation: 'change-status',
                  principalId: agentId,
                  reason: 'Zkouška',
                },
                persona: 'member',
                sameOrigin: true,
              });
              expect(attempt.status).toBe(403);
              const list = yield* shell.post({ legalEntityId: ours, path: LIST_PATH, payload: {}, persona: 'owner' });
              expect({ status: list.status, text: list.status === 200 ? '' : list.text }).toEqual({
                status: 200,
                text: '',
              });
              const overview = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(AgentEntityOverviewSchema))(
                list.text,
              ).pipe(Effect.orDie);
              const agent = overview.agents.find(({ principalId }) => principalId === agentId);
              // The company's agent, with the operators its committed operator command names (none yet).
              expect({ operators: agent?.operators, status: agent?.status }).toEqual({
                operators: [],
                status: 'active',
              });
              expect(overview.members.map(({ principalId }) => principalId)).toContain(memberId);
              // The member's refused attempt is in the agent administration audit.
              expect(overview.audit.length).toBeGreaterThan(0);
              // The roles offered are the company's own v2 roles (a tenant-wide role lives in the tenant context, never
              // in a company assignment), and only those an agent may hold.
              const roles = yield* accessCase.admin
                .unsafe<{ readonly role_id: string }>(
                  `select role_id from core.access_roles where tenant_id = $1 and legal_entity_id = $2`,
                  [accessCase.tenantId, ours],
                )
                .pipe(Effect.orDie);
              const companyRoleIds = new Set(roles.map(({ role_id }) => role_id));
              expect(overview.roles.every(({ roleId }) => companyRoleIds.has(roleId))).toBe(true);
              // Every role the agent holds is named on the page; nothing technical is shown instead.
              expect((agent?.roles ?? []).every(({ name }) => name !== '')).toBe(true);
              // The owner gives the agent an assignable company role through the People Action family, and takes it away.
              const heldRoleIds = new Set((agent?.roles ?? []).map(({ roleId }) => roleId));
              const offeredRole = overview.roles.find(({ roleId }) => !heldRoleIds.has(roleId));
              const offered = yield* Effect.fromOption(Option.fromUndefinedOr(offeredRole)).pipe(Effect.orDie);
              const assigned = yield* shell.post({
                idempotencyKey: 'agents-real-gate-assign-role',
                legalEntityId: ours,
                path: MANAGE_PATH,
                payload: {
                  expectedRevision: overview.rolesRevision,
                  expectedRoleRevisionId: offered.roleRevisionId,
                  operation: 'assign-role',
                  principalId: agentId,
                  roleId: offered.roleId,
                },
                persona: 'owner',
                sameOrigin: true,
              });
              expect(assigned.status, assigned.text).toBe(200);
              const after = yield* shell
                .post({ legalEntityId: ours, path: LIST_PATH, payload: {}, persona: 'owner' })
                .pipe(
                  Effect.flatMap(({ text }) =>
                    Schema.decodeUnknownEffect(Schema.fromJsonString(AgentEntityOverviewSchema))(text),
                  ),
                  Effect.orDie,
                );
              const holding = after.agents
                .find(({ principalId }) => principalId === agentId)
                ?.roles.find(({ roleId }) => roleId === offered.roleId);
              expect(holding?.name).toBe(offered.name);
              // A member may not assign roles: the People rule refuses them here too.
              const memberAssign = yield* shell.post({
                idempotencyKey: 'agents-real-gate-member-assign',
                legalEntityId: ours,
                path: MANAGE_PATH,
                payload: {
                  expectedRevision: after.rolesRevision,
                  expectedRoleRevisionId: offered.roleRevisionId,
                  operation: 'assign-role',
                  principalId: agentId,
                  roleId: offered.roleId,
                },
                persona: 'member',
                sameOrigin: true,
              });
              expect(memberAssign.status).toBe(403);
              const removed = yield* shell.post({
                idempotencyKey: 'agents-real-gate-remove-role',
                legalEntityId: ours,
                path: MANAGE_PATH,
                payload: {
                  assignmentId: holding?.assignmentId ?? '',
                  expectedRevision: after.rolesRevision,
                  operation: 'remove-role',
                  principalId: agentId,
                },
                persona: 'owner',
                sameOrigin: true,
              });
              expect(removed.status, removed.text).toBe(200);
              const refused = yield* shell.post({
                legalEntityId: ours,
                path: LIST_PATH,
                payload: {},
                persona: 'member',
              });
              expect(refused.status).toBe(403);
              // Creating and configuring agents is still not in this release: a clean refusal, never a 503.
              for (const request of [
                { operation: 'create', operatorPrincipalIds: [memberId] },
                { operation: 'configure', principalId: agentId },
              ]) {
                const change = yield* shell.post({
                  idempotencyKey: `agents-real-gate-${request.operation}`,
                  legalEntityId: ours,
                  path: MANAGE_PATH,
                  payload: {
                    ...request,
                    description: null,
                    displayName: `Agent ${request.operation}`,
                    ownerPrincipalId: memberId,
                    writePolicy: 'approval',
                  },
                  persona: 'owner',
                  sameOrigin: true,
                });
                expect({ operation: request.operation, status: change.status }).toEqual({
                  operation: request.operation,
                  status: 422,
                });
                expect(change.text).toContain('Vytváření a úpravy agentů nejsou v této verzi k dispozici.');
              }
            }),
          ),
        ),
      CASE_TIMEOUT,
    );
  },
);
