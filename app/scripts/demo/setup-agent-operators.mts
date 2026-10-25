import { createHash, randomUUID } from 'node:crypto';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import {
  ActionRuntime,
  companyAgentDirectoryRead,
  ContextAccess,
  ReadRuntime,
  replaceAgentOperatorsAction,
} from '@app/core-runtime';
import { ActionPermission } from '@app/core-runtime/actions/runtime-wiring';
import { ActiveApplicationCompositionService } from '@app/core-runtime/modules/active-application-composition';
import { ActionAuthorizationLifecycle } from '@app/core-runtime/outbox/core-system-worker';
import { NodeServices } from '@effect/platform-node';
import { Console, Effect, Schema } from 'effect';
import { Command, Flag } from 'effect/unstable/cli';

import { AuthenticationService } from '../../apps/shell-super-app/api/auth/service.ts';
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

interface OperatorSession {
  readonly principal: TrustedPrincipalContext;
  readonly requestHeaders: Headers;
}
const allMembers = (members: ReadonlySet<string>, ids: readonly string[]) => ids.every((id) => members.has(id));
const sameSet = (left: readonly string[], right: readonly string[]) => {
  const ids = new Set(right);
  return left.length === ids.size && left.every((id) => ids.has(id));
};

// Selection mutates one Better Auth session; callers must keep the entire operation sequential.
const selectOperatorCompany = Effect.fn('AgentOperatorSetup.selectCompany')(function* selectOperatorCompany(
  operator: OperatorSession,
  legalEntityId: string,
) {
  const authentication = yield* AuthenticationService;
  yield* authentication.switchLegalEntity(legalEntityId, operator.requestHeaders);
  const selected = yield* authentication.resolveShellContext(operator.requestHeaders);
  if (
    selected.state !== 'authenticated' ||
    selected.principal.legalEntityId !== legalEntityId ||
    selected.principal.principalId !== operator.principal.principalId ||
    selected.principal.tenantId !== operator.principal.tenantId ||
    selected.principal.authBindingId !== operator.principal.authBindingId
  ) {
    return yield* new AgentProfileSetupError({ reason: 'The authenticated operator could not select this company' });
  }
  // Preserve the native selected-company provenance; never rebuild this carrier from IDs.
  return selected.principal;
});

/** Governed Core Reads/Actions only. The existing serialized lifecycle owns graph projection. */
export const runAgentOperatorSetup = Effect.fn('AgentOperatorSetup.run')(function* runOperatorSetup(
  operator: OperatorSession,
  inputs: readonly OperatorSetupInput[],
  mode: 'dry-run' | 'apply' | 'verify',
) {
  const access = yield* ContextAccess;
  const permission = yield* ActionPermission;
  const reads = yield* ReadRuntime;
  const actions = yield* ActionRuntime;
  const lifecycle = yield* ActionAuthorizationLifecycle;
  const composition = yield* ActiveApplicationCompositionService;
  const snapshots = yield* Effect.forEach(
    inputs,
    (input) =>
      Effect.gen(function* preflightOperators() {
        const principal = yield* selectOperatorCompany(operator, input.legalEntityId);
        const decisions = yield* access.legalEntities({
          legalEntityIds: [input.legalEntityId],
          permission: 'manage_people',
          principalId: principal.principalId,
          tenantId: principal.tenantId,
        });
        if (!decisions.some((decision) => decision.decision === 'allowed')) {
          return yield* new AgentProfileSetupError({
            reason: 'The operator cannot manage this exact company’s agent operators',
          });
        }
        const actionDecision = yield* permission.checkActionPermission({
          actionKey: replaceAgentOperatorsAction.descriptor.actionKey,
          correlationId: randomUUID(),
          legalEntityId: input.legalEntityId,
          principalId: principal.principalId,
          tenantId: principal.tenantId,
        });
        if (actionDecision !== 'allowed') {
          return yield* new AgentProfileSetupError({
            reason: 'The operator cannot execute the native operator Action in every requested company',
          });
        }
        const directory = yield* reads.runRead({
          input: {},
          principal,
          registration: companyAgentDirectoryRead,
          transport: { correlationId: randomUUID() },
        });
        const agent = directory.agents.find((candidate) => candidate.principalId === input.agentPrincipalId);
        const activePeople = new Set(directory.people.map((person) => person.principalId));
        if (
          agent?.status !== 'active' ||
          !agent.hasProfile ||
          input.operatorPrincipalIds.some((id) => !activePeople.has(id))
        ) {
          return yield* new AgentProfileSetupError({
            reason: 'Explicit agent/operator setup input is not an active company member',
          });
        }
        return { ...input, activePeople, agent };
      }),
    { concurrency: 1 },
  );
  // Commands/revisions belong to the tenant's agent, not to each requested company.
  const agentIds = [...new Set(inputs.map((input) => input.agentPrincipalId))];
  const plans = yield* Effect.forEach(
    agentIds,
    (agentPrincipalId) =>
      Effect.gen(function* planAgentOperators() {
        const candidates = snapshots.filter((snapshot) => snapshot.agentPrincipalId === agentPrincipalId);
        const initial = candidates.at(0);
        if (initial === undefined) {
          return yield* new AgentProfileSetupError({ reason: 'Missing operator preflight snapshot' });
        }
        const { agent } = initial;
        const revision = agent.operatorCommand?.revision ?? 0;
        if (
          candidates.some(
            (candidate) =>
              (candidate.agent.operatorCommand?.revision ?? 0) !== revision ||
              !sameSet(candidate.agent.operatorPrincipalIds, agent.operatorPrincipalIds),
          )
        ) {
          return yield* new AgentProfileSetupError({ reason: 'Agent operators changed during preflight; retry' });
        }
        // Preserve graph operators and any pending additions as well as every explicitly requested addition.
        const wanted = [
          ...new Set([
            ...agent.operatorPrincipalIds,
            ...(agent.operatorCommand?.desiredOperatorPrincipalIds ?? []),
            ...candidates.flatMap((candidate) => candidate.operatorPrincipalIds),
          ]),
        ];
        const commandMatches =
          agent.operatorCommand !== null && sameSet(agent.operatorCommand.desiredOperatorPrincipalIds, wanted);
        const changed =
          !sameSet(agent.operatorPrincipalIds, wanted) || (agent.operatorCommand !== null && !commandMatches);
        // The native projection validates membership in the command's company. Fail BEFORE any Action
        // if none of the requested companies can preserve the complete principal-global operator set.
        const company = candidates.find((candidate) => allMembers(candidate.activePeople, wanted));
        if (changed && company === undefined) {
          return yield* new AgentProfileSetupError({
            reason: 'No requested company can preserve all existing and requested agent operators',
          });
        }
        const { legalEntityId } = company ?? initial;
        const payload = {
          agentPrincipalId,
          context: 'operators-edited' as const,
          expectedRevision: revision,
          operatorPrincipalIds: wanted,
          revokedConnections: 0,
        };
        // Validate EVERY complete payload, including the native operator limit, before executing any Action.
        const encoded = yield* Schema.encodeEffect(
          Schema.fromJsonString(replaceAgentOperatorsAction.descriptor.payloadSchema),
        )(payload).pipe(
          Effect.mapError(() => new AgentProfileSetupError({ reason: 'Invalid operator setup command' })),
        );
        const idempotencyKey = createHash('sha256')
          .update(operator.principal.tenantId)
          .update('\0')
          .update(legalEntityId)
          .update('\0')
          .update(encoded)
          .digest('hex');
        return { changed, commandMatches, idempotencyKey, legalEntityId, payload, revision, wanted };
      }),
    { concurrency: 1 },
  );
  if (mode === 'verify' && plans.some((plan) => plan.changed)) {
    return yield* new AgentProfileSetupError({ reason: 'Explicit agent operators have not been configured' });
  }
  let applied = 0;
  if (mode === 'apply') {
    for (const plan of plans) {
      if (!plan.changed) {
        continue;
      }
      const principal = yield* selectOperatorCompany(operator, plan.legalEntityId);
      if (!plan.commandMatches) {
        yield* actions
          .runAction({
            payload: plan.payload,
            principal,
            registration: replaceAgentOperatorsAction,
            transport: { correlationId: randomUUID(), idempotencyKey: plan.idempotencyKey },
          })
          .pipe(Effect.catchTag('ActionAlreadyCommitted', () => Effect.void));
      }
      // Resume matching committed commands without a second Action/audit. The lifecycle reloads the
      // principal-global latest command under its existing lock, after the Action SQL transaction ends.
      const installed = yield* composition.load;
      yield* lifecycle.reconcilePrincipal(
        principal.tenantId,
        plan.payload.agentPrincipalId,
        installed.composition.revision,
      );
      const confirmed = yield* reads.runRead({
        input: {},
        principal,
        registration: companyAgentDirectoryRead,
        transport: { correlationId: randomUUID() },
      });
      const agent = confirmed.agents.find((candidate) => candidate.principalId === plan.payload.agentPrincipalId);
      if (
        agent?.status !== 'active' ||
        agent.operatorCommand?.revision !== plan.revision + (plan.commandMatches ? 0 : 1) ||
        !sameSet(agent.operatorCommand.desiredOperatorPrincipalIds, plan.wanted) ||
        !sameSet(agent.operatorPrincipalIds, plan.wanted)
      ) {
        return yield* new AgentProfileSetupError({ reason: 'Agent operator projection has not converged; retry' });
      }
      applied += 1;
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
      yield* Console.log(yield* runAgentOperatorSetup(operator, demoAgentOperatorSetup, mode));
    }).pipe(
      Effect.scoped,
      // oxlint-disable-next-line effect-native/no-effect-provide-in-library -- Executable CLI composition root; --help must not acquire native operator services.
      Effect.provide(AgentProfileOperatorLive),
    ),
);
if (import.meta.main) {
  await Effect.runPromise(Command.run(command, { version: '1.0.0' }).pipe(Effect.provide(NodeServices.layer)));
}
