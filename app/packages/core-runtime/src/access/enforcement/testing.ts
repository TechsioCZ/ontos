import { Effect } from 'effect';
import type { Array as Arr } from 'effect';

import type { AccessDecision, GrantedAuthorityEvidence, ResolvedRecordSelector } from '../decision/contract.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';
import type { ListAccessResolution } from '../decision/engine.ts';
import type { ListAccessPredicate } from '../decision/list-access.ts';
import type { LegalEntityId } from '../ids.ts';
import type { DecisionOutcome, DecisionReason } from '../model.ts';
import type { AccessDecisionService, GateInput, ListGateInput, SelectableLegalEntitiesInput } from './contract.ts';

/**
 * One scripted answer. A suite names exactly what the gate should answer for a capability, so the
 * runner tests can prove what they do with ALLOWED, NEEDS_APPROVAL, DENIED and UNAVAILABLE without
 * a SpiceDB or a database behind them.
 */
export interface TestGateAnswer {
  readonly admissionDeadline?: Date;
  readonly evidence?: readonly GrantedAuthorityEvidence[];
  readonly outcome: DecisionOutcome;
  /** The owner predicate a list answer carries; absent means the whole scope is visible. */
  readonly predicate?: ListAccessPredicate;
  /** Reason codes, in order. A default per outcome applies when the list is empty. */
  readonly reasons?: readonly string[];
  readonly selectors?: readonly ResolvedRecordSelector[];
}

/** Everything the double answers, plus what a suite may ask of its arguments afterwards. */
export interface TestAccessDecisionSpec {
  /** Answers by declaration key; anything unnamed falls back to `defaultAnswer`. */
  readonly answers?: Readonly<Record<string, TestGateAnswer>>;
  readonly defaultAnswer?: TestGateAnswer;
  /** The companies `selectableLegalEntities` answers with (after the select check, in the fake). */
  readonly legalEntityIds?: readonly LegalEntityId[];
  /** Answers every call with an unavailable authority, like a dead engine or unreadable intent. */
  readonly unavailable?: boolean;
}

/** The double's own record of the questions it was asked, so a test can assert the gate's inputs. */
export interface TestAccessDecision extends AccessDecisionService {
  readonly askedDecisions: readonly GateInput[];
  readonly askedLists: readonly ListGateInput[];
  readonly askedSelectableLegalEntities: readonly SelectableLegalEntitiesInput[];
}

const DEFAULT_OUTCOME_REASON = {
  ALLOWED: 'allow.granted',
  DENIED: 'deny.insufficient_grant',
  NEEDS_APPROVAL: 'approval.required',
  UNAVAILABLE: 'unavailable.engine',
} as const satisfies Readonly<Record<DecisionOutcome, string>>;

const reasonsOf = (answer: TestGateAnswer): Arr.NonEmptyReadonlyArray<DecisionReason> => {
  const codes = answer.reasons ?? [];
  const [first, ...rest] = codes;
  return [{ code: first ?? DEFAULT_OUTCOME_REASON[answer.outcome] }, ...rest.map((code) => ({ code }))];
};

const decisionOf = (answer: TestGateAnswer): AccessDecision =>
  answer.admissionDeadline === undefined
    ? {
        evidence: answer.evidence ?? [],
        outcome: answer.outcome,
        reasons: reasonsOf(answer),
        selectors: answer.selectors ?? [],
      }
    : {
        admissionDeadline: answer.admissionDeadline,
        evidence: answer.evidence ?? [],
        outcome: answer.outcome,
        reasons: reasonsOf(answer),
        selectors: answer.selectors ?? [],
      };

const UNAVAILABLE_ANSWER: TestGateAnswer = { outcome: 'UNAVAILABLE' };

/**
 * The gate a suite provides instead of `AccessDecisionLive`: it decides nothing and proves nothing,
 * it only answers what the suite asked for — including the case where even the answer is
 * unavailable, so the runner's 503 path is testable (CUTOVER-PLAN L04 negative controls).
 */
export const makeTestAccessDecision = (spec: TestAccessDecisionSpec = {}): TestAccessDecision => {
  const askedDecisions: GateInput[] = [];
  const askedLists: ListGateInput[] = [];
  const askedSelectableLegalEntities: SelectableLegalEntitiesInput[] = [];
  const answerFor = (input: { readonly carrier: GateInput['carrier'] }): TestGateAnswer => {
    if (spec.unavailable === true) {
      return UNAVAILABLE_ANSWER;
    }
    const key = input.carrier.accessDeclaration?.key;
    const named = key === undefined ? undefined : spec.answers?.[key];
    return named ?? spec.defaultAnswer ?? { outcome: 'DENIED' };
  };
  const double: TestAccessDecision = {
    askedDecisions,
    askedLists,
    askedSelectableLegalEntities,
    decide: (input) => {
      askedDecisions.push(input);
      return Effect.succeed(decisionOf(answerFor(input)));
    },
    decideMany: (input) => {
      askedDecisions.push(...input);
      return Effect.succeed(input.map((one) => decisionOf(answerFor(one))));
    },
    list: (input): Effect.Effect<ListAccessResolution> => {
      askedLists.push(input);
      const answer = answerFor(input);
      const decision = decisionOf(answer);
      const visible = decision.outcome === 'ALLOWED' || decision.outcome === 'NEEDS_APPROVAL';
      return Effect.succeed(visible ? { decision, predicate: answer.predicate ?? { groups: [] } } : { decision });
    },
    selectableLegalEntities: (input) => {
      askedSelectableLegalEntities.push(input);
      // The double fails the same way the live gate does, so a caller's 503 path is real.
      return spec.unavailable === true
        ? Effect.fail(accessDecisionUnavailable('The authorization engine did not answer'))
        : Effect.succeed(spec.legalEntityIds ?? []);
    },
    // The double reads no ports, so over any other ports it is itself; its record of questions stays in one place.
    // A prepared Action authority requires a gate that can rebind (O75).
    rebind: () => double,
  };
  return double;
};
