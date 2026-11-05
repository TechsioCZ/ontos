import type { Array as Arr } from 'effect';

import type { AccessDecision } from '../decision/contract.ts';
import type { DecisionReason } from '../model.ts';

/** A seam denial: the request is refused before (or instead of) an engine answer, with no evidence. */
export const seamDenial = (first: DecisionReason, ...rest: readonly DecisionReason[]): AccessDecision => {
  const reasons: Arr.NonEmptyReadonlyArray<DecisionReason> = [first, ...rest];
  return { evidence: [], outcome: 'DENIED', reasons, selectors: [] };
};

/** One refusal code as a denial, which is how every seam refusal leaves the gate. */
export const seamRefusal = (code: string): AccessDecision => seamDenial({ code });

/**
 * A seam admittance: a trusted workload running an entrypoint its carrier declares for workloads
 * (O29, O59, O67-Q4). It is the owner's classification, not a v2 grant, so it carries no evidence
 * and never reaches the engine or the decision log.
 */
export const seamAdmission = (code: string): AccessDecision => ({
  evidence: [],
  outcome: 'ALLOWED',
  reasons: [{ code }],
  selectors: [],
});

/**
 * No safe answer exists: the identity row or the intent of the scope could not be read. It is a
 * retryable 503 and never a denial (O48b); it grants nothing.
 */
export const seamUnavailable = (code: string): AccessDecision => {
  const reasons: Arr.NonEmptyReadonlyArray<DecisionReason> = [{ code }];
  return { evidence: [], outcome: 'UNAVAILABLE', reasons, selectors: [] };
};
