import { Effect, Predicate } from 'effect';

import type { ScopedTransactionExecutor } from '../../db/scoped-transaction.ts';
import type { OperationalScope } from '../../operations/context.ts';
import { accessDecisionUnavailable } from '../decision/errors.ts';
import type { AccessDecision } from '../decision/contract.ts';

import { readSelectedWorkloadDecision } from './selected-workload-decision-seal.ts';
import type { SelectedWorkloadDecision } from './selected-workload-decision-seal.ts';

export { sealSelectedWorkloadDecision } from './selected-workload-decision-seal.ts';

const scopeProperty = '__ontosCoreScopedWorkloadAdmission';
type ScopedWorkloadAdmissionWitness = Pick<ScopedTransactionExecutor, 'invoke'>;

class ScopedWorkloadAdmissionSeal {
  #active = true;
  readonly #actionInvocationId: string | undefined;
  readonly #scope: OperationalScope;
  readonly #transaction: ScopedTransactionExecutor;
  readonly #workloadKeys: ReadonlySet<string>;

  constructor(
    transaction: ScopedTransactionExecutor,
    scope: OperationalScope,
    workloadKeys: ReadonlySet<string>,
    actionInvocationId?: string,
  ) {
    this.#actionInvocationId = actionInvocationId;
    this.#transaction = transaction;
    this.#scope = scope;
    this.#workloadKeys = workloadKeys;
    Object.freeze(this);
  }

  close(): void {
    this.#active = false;
  }

  static live(transaction: ScopedWorkloadAdmissionWitness): boolean {
    const seal: unknown = Object.getOwnPropertyDescriptor(transaction, scopeProperty)?.value;
    return (
      Predicate.isObject(seal) &&
      #active in seal &&
      seal.#active &&
      seal.#transaction === transaction &&
      seal.#transaction.scope.tenantId === seal.#scope.tenantId &&
      seal.#transaction.scope.legalEntityId === seal.#scope.legalEntityId
    );
  }

  static actionInvocationId(transaction: ScopedTransactionExecutor, scope?: OperationalScope): string | undefined {
    const seal: unknown = Object.getOwnPropertyDescriptor(transaction, scopeProperty)?.value;
    return Predicate.isObject(seal) &&
      #active in seal &&
      seal.#active &&
      seal.#transaction === transaction &&
      (scope === undefined || seal.#scope === scope) &&
      seal.#transaction.scope.tenantId === seal.#scope.tenantId &&
      seal.#transaction.scope.legalEntityId === seal.#scope.legalEntityId
      ? seal.#actionInvocationId
      : undefined;
  }

  static read(transaction: ScopedWorkloadAdmissionWitness, scope: OperationalScope): ReadonlySet<string> | undefined {
    const seal: unknown = Object.getOwnPropertyDescriptor(transaction, scopeProperty)?.value;
    return Predicate.isObject(seal) &&
      #active in seal &&
      seal.#active &&
      seal.#transaction === transaction &&
      seal.#scope === scope &&
      seal.#transaction.scope.tenantId === scope.tenantId &&
      seal.#transaction.scope.legalEntityId === scope.legalEntityId
      ? seal.#workloadKeys
      : undefined;
  }
}

/** Core-private: binds the actual main operation decision before resolving owner services. */
export const bindScopedWorkloadAdmission = (
  transaction: ScopedTransactionExecutor,
  input: Pick<SelectedWorkloadDecision, 'carrier' | 'scope'> & { readonly actionInvocationId?: string },
  decision?: AccessDecision,
): Readonly<{ readonly close: () => void; readonly transaction: ScopedTransactionExecutor }> => {
  const selected = decision === undefined ? undefined : readSelectedWorkloadDecision(decision);
  const workloadKeys =
    selected?.scope === input.scope && selected.carrier === input.carrier ? selected.workloadKeys : new Set<string>();
  const carrier = { ...transaction };
  const admission = new ScopedWorkloadAdmissionSeal(carrier, input.scope, workloadKeys, input.actionInvocationId);
  Object.defineProperty(carrier, scopeProperty, { value: admission });
  return Object.freeze({ close: () => admission.close(), transaction: Object.freeze(carrier) });
};

/** Factual branch selection only: a credential kind or a registered key alone grants no proof. */
export const readScopedAdmittedWorkload = (
  transaction: ScopedWorkloadAdmissionWitness,
  scope: OperationalScope,
  workloadKey: string,
) =>
  Effect.suspend(() => {
    const workloadKeys = ScopedWorkloadAdmissionSeal.read(transaction, scope);
    if (workloadKeys === undefined) {
      return Effect.fail(
        accessDecisionUnavailable('The selected workload branch is unavailable outside its exact owner scope'),
      );
    }
    return Effect.succeed(workloadKeys.has(workloadKey));
  });

/** Core-private: authentic current Action identity, unavailable to Reads and after transaction completion. */
export const readScopedActionInvocationId = (
  transaction: ScopedTransactionExecutor,
  scope?: OperationalScope,
): string | undefined => ScopedWorkloadAdmissionSeal.actionInvocationId(transaction, scope);

/** Core-private: authentic live Read or Action factory transaction with its unchanged native scope. */
export const isLiveScopedOperationTransaction = (transaction: ScopedWorkloadAdmissionWitness): boolean =>
  ScopedWorkloadAdmissionSeal.live(transaction);
