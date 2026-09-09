import { Context, Effect } from 'effect';
import { unavailablePurchaseCurrencyDependency } from './purchase-currency-dependency.ts';
import type { PurchaseCurrencyDependencyUnavailable } from './purchase-currency-dependency.ts';
import type {
  PurchaseCurrencyCurrentFacts,
  PurchaseCurrencyResolutionRequest,
} from './purchase-currency-resolution.ts';

export interface PurchaseCurrencyTrustedScope {
  readonly legalEntityId: string;
  readonly storefrontId: string;
  readonly tenantId: string;
}

export interface PurchaseCurrencyPurchasingContextPortService {
  readonly resolveCurrent: (input: {
    readonly claimedContext: PurchaseCurrencyResolutionRequest['purchasingContext'];
    readonly claimedContextRevision: PurchaseCurrencyResolutionRequest['contextRevision'];
    readonly claimedSubject: PurchaseCurrencyResolutionRequest['subject'];
    readonly observedAt: string;
    readonly scope: PurchaseCurrencyTrustedScope;
  }) => Effect.Effect<
    Pick<PurchaseCurrencyCurrentFacts, 'contextRevision' | 'purchasingContext' | 'subject'>,
    PurchaseCurrencyDependencyUnavailable
  >;
}

export class PurchaseCurrencyPurchasingContextPort extends Context.Service<
  PurchaseCurrencyPurchasingContextPort,
  PurchaseCurrencyPurchasingContextPortService
>()(
  '@app/commerce-customer-context/shared/domain/purchase-currency-context-port/PurchaseCurrencyPurchasingContextPort',
) {}

export const unavailablePurchaseCurrencyPurchasingContextPort =
  (): PurchaseCurrencyPurchasingContextPortService => ({
    resolveCurrent: () =>
      Effect.fail(
        unavailablePurchaseCurrencyDependency(
          'purchasing_context_unavailable',
          'The Current Commerce Purchasing Context provider is not configured',
        ),
      ),
  });
