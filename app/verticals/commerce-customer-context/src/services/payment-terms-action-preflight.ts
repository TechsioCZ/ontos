import { OperationContextUnavailable } from '@app/core-runtime';
import type { ActionServicePreparationContext, OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import type { CurrentPaymentTermsResponse } from '@app/payment-term-catalog-contracts/current-payment-terms';
import { Effect } from 'effect';
import type { Result } from 'effect';
import type { CustomerPaymentTermsState } from '../../shared/domain/payment-term-contracts.ts';
import { PaymentTermsDependencyUnavailable } from '../../shared/domain/payment-term-errors.ts';
import { stableRevision } from '../integrations/order-finalization-pricing-context.ts';
import { paymentTermCatalogPortFromEnvironment } from '../integrations/payment-term-catalog.ts';
import type {
  PaymentTermCatalogPort,
  PaymentTermDefinitionRequest,
  PaymentTermsPersistenceContext,
} from '../persistence/payment-term-persistence.ts';

type PaymentTermDefinition = CurrentPaymentTermsResponse['current'][number];

export const bindPreparedPaymentTermCatalog = (
  requests: readonly PaymentTermDefinitionRequest[],
  result: Result.Result<readonly PaymentTermDefinition[], PaymentTermsDependencyUnavailable>,
): PaymentTermCatalogPort => {
  const requestRevision = stableRevision(requests);
  return {
    resolveDefinitions: (candidate) =>
      stableRevision(candidate) === requestRevision
        ? Effect.fromResult(result)
        : Effect.fail(
            new PaymentTermsDependencyUnavailable({
              code: 'payment_terms_dependency_unavailable',
              dependency: 'PAYMENT_TERM_CATALOG',
              reason: 'The prepared Payment Term Catalog selector does not match',
            }),
          ),
  };
};

export const paymentTermsSnapshotUnchanged = (snapshotRevision: string, current: CustomerPaymentTermsState): boolean =>
  stableRevision(current) === snapshotRevision;

/** The returned factory reloads the same owner state and never falls back to live Catalog I/O. */
export const preparePaymentTermsChangeCatalog = Effect.fn('PaymentTermsActionPreflight.prepareCatalog')(
  function* prepareCatalog<Failure>(
    context: ActionServicePreparationContext,
    load: (
      transaction: ScopedTransactionExecutor,
      scope: PaymentTermsPersistenceContext['scope'],
    ) => Effect.Effect<CustomerPaymentTermsState, Failure>,
    requestsFor: (state: CustomerPaymentTermsState) => readonly PaymentTermDefinitionRequest[],
  ) {
    const { scope } = context;
    const { legalEntityId } = scope;
    if (legalEntityId === undefined) {
      return yield* new OperationContextUnavailable({
        code: 'operation_context_unavailable',
        reason: 'Payment Terms changes require a trusted Legal Entity',
      });
    }
    const ownerScope = { ...scope, legalEntityId };
    const snapshot = yield* context.transaction((transaction) => load(transaction, ownerScope));
    const snapshotRevision = stableRevision(snapshot);
    const requests = requestsFor(snapshot);
    const result =
      requests.length === 0
        ? yield* Effect.result(Effect.succeed([]))
        : yield* paymentTermCatalogPortFromEnvironment({
            compositionRevision: context.compositionRevision,
            legalEntityId,
            requestCorrelation: scope.correlationId,
          }).pipe(
            Effect.flatMap((catalog) => catalog.resolveDefinitions(requests)),
            Effect.result,
          );
    const preparedCatalog = bindPreparedPaymentTermCatalog(requests, result);
    return (transaction: ScopedTransactionExecutor, currentScope: OperationalScope, revision: string) => {
      if (
        currentScope.tenantId !== scope.tenantId ||
        currentScope.legalEntityId !== legalEntityId ||
        currentScope.principalId !== scope.principalId ||
        currentScope.authBindingId !== scope.authBindingId ||
        currentScope.correlationId !== scope.correlationId ||
        revision !== context.compositionRevision
      ) {
        return Effect.fail(
          new OperationContextUnavailable({
            code: 'operation_context_unavailable',
            reason: 'The prepared Payment Terms scope does not match',
          }),
        );
      }
      return load(transaction, { ...currentScope, legalEntityId }).pipe(
        Effect.mapError((cause) =>
          Object.defineProperty(
            new OperationContextUnavailable({
              code: 'operation_context_unavailable',
              reason: 'Payment Terms owner state could not be revalidated',
            }),
            'cause',
            { value: cause },
          ),
        ),
        Effect.flatMap((current) =>
          paymentTermsSnapshotUnchanged(snapshotRevision, current)
            ? Effect.succeed(preparedCatalog)
            : Effect.fail(
                new OperationContextUnavailable({
                  code: 'operation_context_unavailable',
                  reason: 'Payment Terms owner state changed during Catalog resolution',
                }),
              ),
        ),
      );
    };
  },
);
