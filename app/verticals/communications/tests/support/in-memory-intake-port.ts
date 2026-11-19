import { CommunicationResourceRefSchema } from '@app/communications-contracts/communication-request';
import { Effect, Option, Schema } from 'effect';

import type { CommunicationDecisionView, MessageIntentSummary } from '../../shared/communication-intake.ts';
import { CommunicationOutcome } from '../../src/domain/catalog/decision.ts';
import type { DecisionPlan, IntentPlan } from '../../src/domain/intake/plan.ts';
import type {
  CommunicationIntakePortContract,
  StoredCommunicationDecision,
} from '../../src/services/communication-intake-port.service.ts';

/**
 * The same intake port contract as the PostgreSQL form, in memory. It lets the Core Action runtime be driven end to end
 * without a database; it proves the lifecycle and the identity rules, NOT row security or the database guards (those are
 * proven on PostgreSQL in the integration suite).
 */

const decodeRef = Schema.decodeUnknownSync(CommunicationResourceRefSchema);

const summaryOf = (intent: IntentPlan): MessageIntentSummary => {
  const base = {
    intentId: intent.intentId,
    recipientRef: decodeRef(intent.identity.recipient),
    slotKey: intent.identity.slotKey,
    status: intent.status,
  };
  return Option.match(intent.reason, {
    onNone: () => base,
    onSome: (reason) => ({ ...base, reason }),
  });
};

const viewOf = (plan: DecisionPlan): CommunicationDecisionView => {
  const { outcome } = plan.decision;
  if (CommunicationOutcome.$is('NoMessage')(outcome)) {
    return outcome.ruleKey === undefined
      ? { kind: 'NO_MESSAGE', reason: outcome.reason }
      : { kind: 'NO_MESSAGE', reason: outcome.reason, ruleKey: outcome.ruleKey };
  }
  return {
    intents: plan.intents.map(summaryOf).toSorted((left, right) => left.intentId.localeCompare(right.intentId)),
    kind: 'MESSAGE_INTENTS',
    unresolvedSlots: outcome.unresolvedSlots.map(({ reason, slotKey }) => ({ reason, slotKey })),
  };
};

export const inMemoryIntakePort = () => {
  const stored = new Map<string, StoredCommunicationDecision>();
  const conflicts: { readonly fingerprint: string; readonly requestId: string }[] = [];
  const decisions: DecisionPlan[] = [];
  const port: CommunicationIntakePortContract = {
    findDecision: (identityKey) => Effect.succeed(Option.fromNullishOr(stored.get(identityKey))),
    insertDecision: ({ fingerprint, identityKey, plan }) =>
      Effect.sync(() => {
        const record: StoredCommunicationDecision = {
          decision: viewOf(plan),
          decisionId: plan.decisionId,
          fingerprint,
          requestId: plan.requestId,
          requiredness: plan.decision.type.pipe(
            Option.map(({ requiredness }) => requiredness),
            Option.getOrUndefined,
          ),
        };
        stored.set(identityKey, record);
        decisions.push(plan);
        return record;
      }),
    lockIdentity: () => Effect.void,
    recordConflict: ({ fingerprint, requestId }) =>
      Effect.sync(() => {
        if (!conflicts.some((conflict) => conflict.fingerprint === fingerprint && conflict.requestId === requestId)) {
          conflicts.push({ fingerprint, requestId });
        }
      }),
  };
  return { conflicts, decisions, port, stored };
};
