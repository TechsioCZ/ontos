import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { Effect, Layer, Schema } from 'effect';

import { catalogSourceAdmissionPorts } from './catalog-source-admission-ports.ts';
import { CatalogSourceActionPersistenceFactory } from './catalog-source-action-capability.ts';
import type {
  CatalogLocalOverrideActionFactoryInput,
  CatalogSourceActionOperationContext,
  CatalogSourceActionPersistenceFactoryService,
} from './catalog-source-action-capability.ts';
import { catalogSourceAuthorityPorts } from './catalog-source-authority-map.ts';
import { catalogSourceResolutionStoreForScope } from './catalog-source-resolution-store.ts';
import { CatalogExternalCorrelationResolver } from './external-correlation-resolver.ts';
import { CatalogImportAcceptanceServiceFactory } from './catalog-import-acceptance-service.ts';
import { CatalogLocalOverrideServiceFactory } from './catalog-local-override-service.ts';

const catalogSourceValuesEqual = Schema.toEquivalence(Schema.Json);

export const catalogSourceActionPersistenceFactoryLive = Layer.effect(
  CatalogSourceActionPersistenceFactory,
  Effect.all(
    {
      externalCorrelation: CatalogExternalCorrelationResolver,
      importAcceptanceFactory: CatalogImportAcceptanceServiceFactory,
      localOverrideFactory: CatalogLocalOverrideServiceFactory,
    },
    { concurrency: 3 },
  ).pipe(
    Effect.map(
      ({ externalCorrelation, importAcceptanceFactory, localOverrideFactory }) =>
        ({
          makeImport: <Transaction>(
            transaction: Transaction,
            scope: CatalogLocalOverrideActionFactoryInput['scope'],
          ) => {
            // eslint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Core invokes owner factories only with its branded, scope-installed transaction; expires: 2027-03-31.
            const scopedTransaction = transaction as ScopedTransactionExecutor;
            return {
              importAcceptanceAt: (context: CatalogSourceActionOperationContext) =>
                importAcceptanceFactory.make<Schema.Json>({
                  admission: catalogSourceAdmissionPorts({
                    allowedOverrideOperation: null,
                    principalId: scope.principalId,
                  }),
                  authority: catalogSourceAuthorityPorts(),
                  events: context.events,
                  resolveTarget: externalCorrelation.resolve,
                  store: catalogSourceResolutionStoreForScope(scopedTransaction, scope, {
                    acceptedAt: context.at,
                    actionInvocationId: context.actionInvocationId,
                    principalId: context.principalId,
                  }),
                  valuesEqual: catalogSourceValuesEqual,
                }),
            };
          },
          makeLocalOverride: <Transaction>(
            transaction: Transaction,
            { allowedOverrideOperation, scope }: CatalogLocalOverrideActionFactoryInput,
          ) => {
            // eslint-disable-next-line typescript/no-unsafe-type-assertion -- SAFETY: Core invokes owner factories only with its branded, scope-installed transaction; expires: 2027-03-31.
            const scopedTransaction = transaction as ScopedTransactionExecutor;
            return {
              localOverrideAt: (context: CatalogSourceActionOperationContext) =>
                localOverrideFactory.make<Schema.Json>({
                  admission: catalogSourceAdmissionPorts({ allowedOverrideOperation, principalId: scope.principalId }),
                  events: context.events,
                  store: catalogSourceResolutionStoreForScope(scopedTransaction, scope, {
                    acceptedAt: context.at,
                    actionInvocationId: context.actionInvocationId,
                    principalId: context.principalId,
                  }),
                  valuesEqual: catalogSourceValuesEqual,
                }),
            };
          },
        }) satisfies CatalogSourceActionPersistenceFactoryService,
    ),
  ),
);
