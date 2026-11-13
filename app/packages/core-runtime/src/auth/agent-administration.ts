import { DateTime, Effect } from 'effect';

import { AccessDecisionGate } from '../access/enforcement/contract.ts';
import type { GateInput } from '../access/enforcement/contract.ts';
import { manageAgentStatusAction } from '../modules/actions/manage-agent-status.action.ts';
import type { OperationalScope } from '../operations/context.ts';
import { ReadHandlerUnavailable, ReadPermissionDenied } from '../reads/errors.ts';

/**
 * Administering a company's agents is one right: `core.identity.agent-status.manage`, the capability of disabling or
 * archiving an agent, asked by the one gate in the request's own company (O81). The same right decides the withdrawal
 * of an agent's pending proposals and the reads behind the Agents administration page (the company's agent directory,
 * its agent administration audit and its role templates). It is not a new right, never a module's execution right and
 * never a caller-supplied capability.
 */
export const agentAdministrationQuestionOf = (scope: OperationalScope, now: Date): GateInput => ({
  carrier: { accessDeclaration: manageAgentStatusAction.descriptor.accessDeclaration },
  legalEntityScope: 'required',
  now,
  scope,
});

/** The gate's answer to the agent administration question in the selected company; none selected is DENIED. */
export const agentAdministrationOutcome = Effect.fn('AgentAdministration.outcome')(function* agentAdministrationOutcome(
  scope: OperationalScope,
) {
  if (scope.legalEntityId === undefined) {
    return 'DENIED' as const;
  }
  const gate = yield* AccessDecisionGate;
  const decision = yield* gate.decide(agentAdministrationQuestionOf(scope, DateTime.toDateUtc(yield* DateTime.now)));
  return decision.outcome;
});

/**
 * A Core read's `prepare` admits exactly the company's agent administrators: anyone else is the read's refusal, and an
 * unreadable authority is unavailable (never an empty answer, never an allow).
 */
export const requireAgentAdministration = Effect.fn('AgentAdministration.requireForRead')(
  function* requireAgentAdministration(scope: OperationalScope) {
    const outcome = yield* agentAdministrationOutcome(scope);
    if (outcome === 'ALLOWED') {
      return yield* Effect.void;
    }
    if (outcome === 'UNAVAILABLE') {
      return yield* new ReadHandlerUnavailable({
        code: 'read_handler_unavailable',
        reason: 'Agent administration authority is unavailable',
      });
    }
    return yield* new ReadPermissionDenied({
      code: 'read_permission_denied',
      reason: 'Only the company agent administrators read this',
    });
  },
);
