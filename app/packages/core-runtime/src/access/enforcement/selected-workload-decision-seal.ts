import { Predicate } from 'effect';

import type { OperationalScope } from '../../operations/context.ts';
import type { AccessDecision } from '../decision/contract.ts';
import type { GateCarrier } from './contract.ts';

export interface SelectedWorkloadDecision {
  readonly carrier: GateCarrier;
  readonly scope: OperationalScope;
  readonly workloadKeys: ReadonlySet<string>;
}
const decisionProperty = '__ontosCoreSelectedWorkloadDecision';

class SelectedWorkloadDecisionSeal {
  readonly #decision: AccessDecision;
  readonly #selected: SelectedWorkloadDecision;

  constructor(decision: AccessDecision, selected: SelectedWorkloadDecision) {
    this.#decision = decision;
    this.#selected = selected;
    Object.freeze(this);
  }

  static read(decision: AccessDecision): SelectedWorkloadDecision | undefined {
    const seal: unknown = Object.getOwnPropertyDescriptor(decision, decisionProperty)?.value;
    return Predicate.isObject(seal) && #selected in seal && seal.#decision === decision ? seal.#selected : undefined;
  }
}

/** Core-private: called only at the actual gate's successful workload branch. */
export const sealSelectedWorkloadDecision = (
  decision: AccessDecision,
  input: Pick<SelectedWorkloadDecision, 'carrier' | 'scope'>,
  workloadKeys: readonly string[],
): AccessDecision => {
  if (decision.outcome === 'ALLOWED') {
    Object.defineProperty(decision, decisionProperty, {
      value: new SelectedWorkloadDecisionSeal(
        decision,
        Object.freeze({ ...input, workloadKeys: new Set(workloadKeys) }),
      ),
    });
  }
  return Object.freeze(decision);
};

export const readSelectedWorkloadDecision = (decision: AccessDecision): SelectedWorkloadDecision | undefined =>
  SelectedWorkloadDecisionSeal.read(decision);
