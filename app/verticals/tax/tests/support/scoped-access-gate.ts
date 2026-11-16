import {
  AccessDecisionGate,
  AccessDecisionLog,
  AccessIntent,
  AccessPrincipalKindSource,
  LegalEntityCandidates,
  seamRefusal,
} from '@app/core-runtime/access/enforcement';
import type { AccessDecisionService, GateInput, ListGateInput } from '@app/core-runtime/access/enforcement';
import { Effect, Layer } from 'effect';

import type { AccessDecision } from '../../../../packages/core-runtime/src/access/decision/contract.ts';
import { DecisionCheck } from '../../../../packages/core-runtime/src/access/decision/engine.ts';
import type { ListAccessResolution } from '../../../../packages/core-runtime/src/access/decision/engine.ts';
import { LegalEntityIdSchema } from '../../../../packages/core-runtime/src/access/ids.ts';
import { bindAccessGate } from '../../../../packages/core-runtime/src/operations/access-gate.ts';
import type { BoundAccessGate } from '../../../../packages/core-runtime/src/operations/access-gate.ts';
import { inertAccessEnforcementPorts } from '../../../../packages/core-runtime/src/testing/access-gate.ts';

const allowedDecision = (): AccessDecision => ({
  evidence: [],
  outcome: 'ALLOWED',
  reasons: [{ code: 'allow.granted' }],
  selectors: [],
});

/**
 * The one gate as a suite scripts it: the assignment this principal holds inside one Selling Legal
 * Entity's access scope and nowhere else (O7, O67-Q2). A capability in scope B is refused with the
 * engine's own denial reason, so the runner's denial path is the real one.
 */
export interface SellerScopedAccessGate {
  readonly askedDecisions: readonly GateInput[];
  readonly askedLists: readonly ListGateInput[];
  readonly bound: BoundAccessGate;
  /** `AccessDecisionGate` plus the five enforcement ports the live runtime binds at wiring time. */
  readonly layer: Layer.Layer<
    | AccessDecisionGate
    | AccessDecisionLog
    | AccessIntent
    | AccessPrincipalKindSource
    | DecisionCheck
    | LegalEntityCandidates
  >;
  /** Admit it again, as re-granting the assignment would. */
  readonly restore: (legalEntityId: string) => void;
  /** Stop admitting a Selling Legal Entity's capability, as revoking its assignment would (O7). */
  readonly revoke: (legalEntityId: string) => void;
}

export const makeSellerScopedAccessGate = (grantedLegalEntityIds: readonly string[]): SellerScopedAccessGate => {
  const askedDecisions: GateInput[] = [];
  const askedLists: ListGateInput[] = [];
  const granted = new Set(grantedLegalEntityIds);
  const answerIn = (input: GateInput | ListGateInput): AccessDecision =>
    input.scope.legalEntityId !== undefined && granted.has(input.scope.legalEntityId)
      ? allowedDecision()
      : seamRefusal('deny.insufficient_grant');
  const listOf = (input: ListGateInput): ListAccessResolution => {
    askedLists.push(input);
    const decision = answerIn(input);
    return decision.outcome === 'ALLOWED' ? { decision, predicate: { groups: [] } } : { decision };
  };
  const gate: AccessDecisionService = {
    decide: (input) => {
      askedDecisions.push(input);
      return Effect.succeed(answerIn(input));
    },
    decideMany: (input) => {
      askedDecisions.push(...input);
      return Effect.succeed(input.map(answerIn));
    },
    list: (input) => Effect.succeed(listOf(input)),
    listMany: (input) => Effect.succeed(input.map(listOf)),
    selectableLegalEntities: () =>
      Effect.succeed(grantedLegalEntityIds.map((legalEntityId) => LegalEntityIdSchema.make(legalEntityId))),
  };
  const ports = inertAccessEnforcementPorts();
  return Object.freeze({
    askedDecisions,
    askedLists,
    bound: bindAccessGate(gate, ports),
    layer: Layer.mergeAll(
      Layer.succeed(AccessDecisionGate, gate),
      Layer.succeed(AccessIntent, ports.intent),
      Layer.succeed(AccessDecisionLog, ports.decisionLog),
      Layer.succeed(AccessPrincipalKindSource, ports.principalKinds),
      Layer.succeed(DecisionCheck, ports.check),
      Layer.succeed(LegalEntityCandidates, ports.candidates),
    ),
    restore: (legalEntityId: string) => {
      granted.add(legalEntityId);
    },
    revoke: (legalEntityId: string) => {
      granted.delete(legalEntityId);
    },
  });
};
