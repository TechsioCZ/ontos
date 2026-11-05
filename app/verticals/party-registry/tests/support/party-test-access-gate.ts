import {
  AccessDecisionGate,
  AccessDecisionLog,
  AccessIntent,
  AccessPrincipalKindSource,
  LegalEntityCandidates,
} from '@app/core-runtime/access/enforcement';
import type { AccessDecisionService, GateInput } from '@app/core-runtime/access/enforcement';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { inertAccessEnforcementPorts } from '@app/core-runtime/testing/access-gate';
import { Effect, Layer } from 'effect';

import { DecisionCheck } from '../../../../packages/core-runtime/src/access/decision/engine.ts';
import type { AccessDecision } from '../../../../packages/core-runtime/src/access/decision/contract.ts';

const REASON_OF = {
  ALLOWED: 'allow.granted',
  DENIED: 'deny.insufficient_grant',
  NEEDS_APPROVAL: 'approval.required',
  UNAVAILABLE: 'unavailable.intent',
} as const satisfies Readonly<Record<AccessDecision['outcome'], string>>;

const decisionOf = (outcome: AccessDecision['outcome']): AccessDecision => ({
  evidence: [],
  outcome,
  reasons: [{ code: REASON_OF[outcome] }],
  selectors: [],
});

/**
 * The Party suite's own authority: the fixture's isolated database carries no v2 access intent and
 * reaches no engine, so a live gate could only answer UNAVAILABLE. This double answers ALLOWED for
 * every capability except the ones the suite has revoked, which it refuses exactly as the live gate
 * refuses a withdrawn assignment. The suite flips it over the fixture's own HTTP surface, so a
 * revocation is a real, observable state change rather than a fixed answer.
 */
export interface PartyTestAccessGate {
  readonly layer: Layer.Layer<
    | AccessDecisionGate
    | AccessDecisionLog
    | AccessIntent
    | AccessPrincipalKindSource
    | DecisionCheck
    | LegalEntityCandidates
  >;
  /** Refuse every capability whose declaration key starts with this prefix. */
  readonly revoke: (capabilityPrefix: string) => void;
  /** Stop refusing that capability family; the fixture's suite proves both halves. */
  readonly restore: (capabilityPrefix: string) => void;
}

export const partyTestAccessGate = (): PartyTestAccessGate => {
  const revokedPrefixes = new Set<string>();
  const answerOf = (input: Pick<GateInput, 'carrier'>) => {
    const key = input.carrier.accessDeclaration?.key;
    const revoked = key !== undefined && [...revokedPrefixes].some((prefix) => key.startsWith(prefix));
    return decisionOf(revoked ? 'DENIED' : 'ALLOWED');
  };
  const service: AccessDecisionService = {
    decide: (input) => Effect.succeed(answerOf(input)),
    decideMany: (input) => Effect.succeed(input.map((one) => answerOf(one))),
    list: (input) => {
      const decision = answerOf(input);
      const visible = decision.outcome === 'ALLOWED' || decision.outcome === 'NEEDS_APPROVAL';
      return Effect.succeed(visible ? { decision, predicate: { groups: [] } } : { decision });
    },
    // The trusted scope resolver asks the same seam which companies this actor may select (O28). The
    // fixture creates its companies at runtime, so the answer echoes the company the request named.
    selectableLegalEntities: ({ scope }) =>
      Effect.succeed(scope.legalEntityId === undefined ? [] : [LegalEntityIdSchema.make(scope.legalEntityId)]),
  };
  const ports = inertAccessEnforcementPorts();
  return Object.freeze({
    layer: Layer.mergeAll(
      Layer.succeed(AccessDecisionGate, service),
      Layer.succeed(AccessIntent, ports.intent),
      Layer.succeed(AccessDecisionLog, ports.decisionLog),
      Layer.succeed(AccessPrincipalKindSource, ports.principalKinds),
      Layer.succeed(DecisionCheck, ports.check),
      Layer.succeed(LegalEntityCandidates, ports.candidates),
    ),
    restore: (capabilityPrefix: string) => {
      revokedPrefixes.delete(capabilityPrefix);
    },
    revoke: (capabilityPrefix: string) => {
      revokedPrefixes.add(capabilityPrefix);
    },
  });
};
