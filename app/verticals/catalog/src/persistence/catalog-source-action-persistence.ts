import type { ScopedTransactionExecutor } from '@app/core-runtime';
import { Effect, Layer, Schema } from 'effect';

import type { CatalogFactScope } from '../domain/catalog-source-resolution.ts';
import { catalogSourceAdmissionPorts } from './catalog-source-admission-ports.ts';
import { CatalogSourceActionPersistenceFactory } from './catalog-source-action-capability.ts';
import type {
  CatalogLocalOverrideActionFactoryInput,
  CatalogLocalOverrideOperationContext,
  CatalogSourceActionOperationContext,
  CatalogSourceActionPersistenceFactoryService,
} from './catalog-source-action-capability.ts';
import { catalogSourceAuthorityPorts } from './catalog-source-authority-map.ts';
import { catalogSourceResolutionStoreForScope } from './catalog-source-resolution-store.ts';
import { catalogProductExistsForScope } from './catalog-source-resolution-read-store.ts';
import { CatalogSourceResolutionUnavailable } from './catalog-source-resolution-ports.ts';
import { CatalogExternalCorrelationResolver } from './external-correlation-resolver.ts';
import { CatalogImportAcceptanceServiceFactory } from './catalog-import-acceptance-service.ts';
import { CatalogLocalOverrideServiceFactory } from './catalog-local-override-service.ts';

const productExistenceEvidenceUnavailable = (cause: unknown) =>
  Object.assign(
    new CatalogSourceResolutionUnavailable({
      code: 'catalog_source_resolution_unavailable',
      reason: 'Catalog Product existence evidence is temporarily unavailable',
    }),
    { cause },
  );

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
              localOverrideAt: (context: CatalogLocalOverrideOperationContext) =>
                localOverrideFactory.make<Schema.Json>({
                  admission: catalogSourceAdmissionPorts({ allowedOverrideOperation, principalId: scope.principalId }),
                  events: context.events,
                  productExists: Effect.fn('CatalogSourceActionPersistence.productExists')(function* productExists(
                    target: CatalogFactScope,
                  ) {
                    const exists = yield* catalogProductExistsForScope(scopedTransaction, scope, true)(target);
                    yield* context
                      .recordDataAccess({
                        accessKind: 'read',
                        queryHash: `catalog-source-product-existence:${target.targetId}`,
                        resultCount: exists ? 1 : 0,
                        servingModuleKey: 'commerce.catalog',
                        targetModuleKey: 'commerce.catalog',
                        targetResourceId: target.targetId,
                        targetResourceType: 'commerce.catalog.product',
                      })
                      .pipe(Effect.mapError(productExistenceEvidenceUnavailable));
                    return exists;
                  }),
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
