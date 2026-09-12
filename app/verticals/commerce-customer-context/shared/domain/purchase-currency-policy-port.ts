import { Context, Effect } from 'effect';
import { unavailablePurchaseCurrencyDependency } from './purchase-currency-dependency.ts';
import type { PurchaseCurrencyDependencyUnavailable } from './purchase-currency-dependency.ts';
import type {
  CurrencyPolicyDecision,
  PurchaseCurrencyCurrentFacts,
  PurchaseCurrencySubject,
} from './purchase-currency-resolution.ts';

export interface PurchaseCurrencyPolicyPortService {
  readonly resolveCurrent: (input: {
    readonly context: Pick<PurchaseCurrencyCurrentFacts, 'contextRevision' | 'purchasingContext'>;
    readonly observedAt: string;
    readonly subject: PurchaseCurrencySubject;
  }) => Effect.Effect<CurrencyPolicyDecision, PurchaseCurrencyDependencyUnavailable>;
}

export class PurchaseCurrencyPolicyPort extends Context.Service<
  PurchaseCurrencyPolicyPort,
  PurchaseCurrencyPolicyPortService
>()('@app/commerce-customer-context/shared/domain/purchase-currency-policy-port/PurchaseCurrencyPolicyPort') {}

export const unavailablePurchaseCurrencyPolicyPort = (): PurchaseCurrencyPolicyPortService => ({
  resolveCurrent: () =>
    Effect.fail(
      unavailablePurchaseCurrencyDependency(
        'currency_policy_unavailable',
        'The Current Customer Commerce Policy provider is not configured',
      ),
    ),
});
