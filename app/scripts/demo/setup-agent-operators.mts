import type { TrustedPrincipalContext } from '@app/core-runtime';
import { ContextAccess } from '@app/core-runtime';
import { NodeServices } from '@effect/platform-node';
import { Console, Effect } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';

import { companyDirectoryLive } from '../../apps/shell-super-app/api/oauth-connections-admin/company-directory-live.ts';
import { grantAdminPortLive } from '../../apps/shell-super-app/api/oauth-connections-admin/grant-port-live.ts';
import { replaceAgentOperators } from '../../apps/shell-super-app/api/oauth-connections-admin/handlers.ts';
import { mcpResourceUrl } from '../../apps/shell-super-app/api/oauth-connections-admin/config.ts';
import { AgentProfileOperatorLive, authenticateAgentProfileOperator } from './agent-profile-operator.mts';
import { AgentProfileSetupError } from './agent-profile-setup.mts';
import { demoId } from './fixture-ids.mts';

interface OperatorSetupInput {
  readonly agentPrincipalId: string;
  readonly legalEntityId: string;
  readonly operatorPrincipalIds: readonly string[];
}
// Explicit setup requirements, not runtime authority or ownership inferred from key names.
const salesCompany = '71000000-0000-4000-8000-000000000020';
const crmCompany = '71000000-0000-4000-8000-000000000022';
const salesAdmin = demoId('core.principal', 'obchod');
const crmAdmin = demoId('core.principal', 'hanak-spravce');
export const demoAgentOperatorSetup: readonly OperatorSetupInput[] = [
  {
    agentPrincipalId: '35b748a0-d93a-520e-bd52-91433c8d15b8',
    legalEntityId: salesCompany,
    operatorPrincipalIds: [salesAdmin],
  },
  {
    agentPrincipalId: 'e931e0fd-adba-56fd-9e17-e5f3adb3efa0',
    legalEntityId: salesCompany,
    operatorPrincipalIds: [salesAdmin],
  },
  {
    agentPrincipalId: '3619acbd-a1bf-50f9-a8d5-d56df7096e0f',
    legalEntityId: salesCompany,
    operatorPrincipalIds: [salesAdmin],
  },
  {
    agentPrincipalId: '40052c4b-ea18-5c8c-ae8d-5d80548cec33',
    legalEntityId: crmCompany,
    operatorPrincipalIds: [crmAdmin],
  },
  {
    agentPrincipalId: 'c771c6f7-8d32-5ba7-af67-de4bd05eabc7',
    legalEntityId: crmCompany,
    operatorPrincipalIds: [crmAdmin],
  },
  {
    agentPrincipalId: '6300a06d-e532-5f52-8f66-5f1d4752a75e',
    legalEntityId: crmCompany,
    operatorPrincipalIds: [crmAdmin],
  },
];

/** Uses the same audited product handler as connections administration. Never writes graph or audit directly. */
export const runAgentOperatorSetup = Effect.fn('AgentOperatorSetup.run')(function* runOperatorSetup(
  actor: TrustedPrincipalContext,
  inputs: readonly OperatorSetupInput[],
  mode: 'dry-run' | 'apply' | 'verify',
) {
  const access = yield* ContextAccess;
  const mcpUrl = yield* mcpResourceUrl;
  const plans = yield* Effect.forEach(
    inputs,
    (input) =>
      Effect.gen(function* preflightOperators() {
        const decisions = yield* access.legalEntities({
          legalEntityIds: [input.legalEntityId],
          permission: 'manage_people',
          principalId: actor.principalId,
          tenantId: actor.tenantId,
        });
        if (!decisions.some((decision) => decision.decision === 'allowed')) {
          return yield* new AgentProfileSetupError({
            reason: 'The operator cannot manage this exact company’s agent operators',
          });
        }
        const members = yield* companyDirectoryLive.members(actor.tenantId, input.legalEntityId);
        const agents = yield* companyDirectoryLive.agents(actor.tenantId, input.legalEntityId, members);
        const people = yield* companyDirectoryLive.people(actor.tenantId, members);
        const activePeople = new Set(people.map((person) => person.principalId));
        if (
          !agents.some(
            (agent) => agent.principalId === input.agentPrincipalId && agent.status === 'active' && agent.hasProfile,
          ) ||
          input.operatorPrincipalIds.some((id) => !activePeople.has(id))
        ) {
          return yield* new AgentProfileSetupError({
            reason: 'Explicit agent/operator setup input is not an active company member',
          });
        }
        const before = yield* companyDirectoryLive.operatorsOf(input.agentPrincipalId);
        // Setup adds only explicitly requested operators; a later administrator's unrelated operators are preserved.
        const wanted = [...new Set([...before, ...input.operatorPrincipalIds])];
        return { ...input, changed: wanted.length !== before.length, operatorPrincipalIds: wanted };
      }),
    { concurrency: 1 },
  );
  if (mode === 'verify' && plans.some((plan) => plan.changed)) {
    return yield* new AgentProfileSetupError({ reason: 'Explicit agent operators have not been configured' });
  }
  let applied = 0;
  if (mode === 'apply') {
    for (const plan of plans) {
      if (plan.changed) {
        yield* replaceAgentOperators(
          {
            isCompanyAdmin: true,
            legalEntityId: plan.legalEntityId,
            legalName: plan.legalEntityId,
            principalId: actor.principalId,
            tenantId: actor.tenantId,
          },
          { directory: companyDirectoryLive, grants: grantAdminPortLive, mcpUrl },
          { agentPrincipalId: plan.agentPrincipalId, operatorPrincipalIds: plan.operatorPrincipalIds },
        );
        applied += 1;
      }
    }
  }
  return { applied, mode, pending: plans.filter((plan) => plan.changed).length };
});
const command = Command.make(
  'setup-agent-operators',
  {
    mode: Flag.Literals('mode', ['dry-run', 'apply', 'verify']).pipe(Flag.withDefault('dry-run')),
  },
  ({ mode }) =>
    Effect.gen(function* setupOperators() {
      const operator = yield* Effect.acquireRelease(authenticateAgentProfileOperator, (session) =>
        session.close.pipe(Effect.ignore),
      );
      yield* Console.log(yield* runAgentOperatorSetup(operator.principal, demoAgentOperatorSetup, mode));
    }).pipe(
      Effect.scoped,
      // oxlint-disable-next-line effect-native/no-effect-provide-in-library -- Executable CLI composition root; --help must not acquire native operator services.
      Effect.provide(AgentProfileOperatorLive),
    ),
);
if (import.meta.main) {
  await Effect.runPromise(Command.run(command, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)));
}
