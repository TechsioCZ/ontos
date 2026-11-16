import { Context, Effect, Layer, Schema } from 'effect';

import type { AccessDecision } from '../access/decision/contract.ts';
import { accessDecisionUnavailable } from '../access/decision/errors.ts';
import type { AccessDecisionUnavailable } from '../access/decision/errors.ts';
import type { GateInput } from '../access/enforcement/contract.ts';
import { seamAdmission, seamRefusal } from '../access/enforcement/decisions.ts';
import { recheckPreparedAccessIn } from '../actions/owner-transaction-access.ts';
import type { ScopedTransactionExecutor } from '../db/scoped-transaction.ts';
import { bindLiveActionAccessGate } from '../operations/access-gate.ts';
import type { PreparedAccessDecision } from '../operations/access-gate.ts';

/**
 * The two halves of the agent lifecycle question (`core.identity.agent-status.manage`) a withdrawal of an agent's
 * proposals asks: decided before the Action transaction, with the engine's answer captured, and re-decided inside
 * that transaction from its own snapshot under the authority fence. A right revoked in between is refused there, and
 * nothing is withdrawn (F3).
 */
export interface AgentLifecycleAuthorityService {
  readonly prepare: (question: GateInput) => Effect.Effect<PreparedAccessDecision, AccessDecisionUnavailable>;
  readonly recheck: (
    prepared: PreparedAccessDecision,
    now: Date,
    transaction: ScopedTransactionExecutor,
  ) => Effect.Effect<AccessDecision, AccessDecisionUnavailable>;
}

export class AgentLifecycleAuthority extends Context.Service<AgentLifecycleAuthority, AgentLifecycleAuthorityService>()(
  '@app/core-runtime/auth/agent-lifecycle-authority/AgentLifecycleAuthority',
) {}

/** The runtime's own: the bound Action gate prepares, and the Action transaction re-checks. */
export const AgentLifecycleAuthorityLive = Layer.effect(
  AgentLifecycleAuthority,
  Effect.gen(function* agentLifecycleAuthorityLive() {
    const gate = yield* bindLiveActionAccessGate;
    const { prepare } = gate;
    return {
      prepare: (question: GateInput) =>
        prepare === undefined
          ? Effect.fail(accessDecisionUnavailable('The agent lifecycle question cannot be prepared'))
          : prepare(question),
      recheck: recheckPreparedAccessIn,
    } satisfies AgentLifecycleAuthorityService;
  }),
);

const LifecycleAnswerSchema = Schema.Literals(['allowed', 'denied']);
type LifecycleAnswer = typeof LifecycleAnswerSchema.Type;

/** The answers a test double gives: when the invocation is prepared, and when it is re-checked in its transaction. */
export interface TestAgentLifecycleAnswers {
  readonly prepare: (question: GateInput) => LifecycleAnswer;
  readonly recheck: () => LifecycleAnswer;
}

const decisionOf = (answer: LifecycleAnswer): AccessDecision =>
  answer === 'allowed' ? seamAdmission('allow.granted') : seamRefusal('deny.insufficient_grant');

/**
 * A test double: a test whose re-check answer differs from the prepare answer (a right revoked in between) sees
 * exactly what the live re-check enforces. It never reads the transaction it is handed.
 */
export const makeTestAgentLifecycleAuthority = (answers: TestAgentLifecycleAnswers): AgentLifecycleAuthorityService => {
  const recheck = () => Effect.sync(() => decisionOf(answers.recheck()));
  return {
    prepare: (question) => Effect.sync(() => ({ decision: decisionOf(answers.prepare(question)), recheck })),
    recheck,
  };
};
