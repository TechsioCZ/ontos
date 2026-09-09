import { Context, Effect, Schema } from 'effect';
import { CurrencyCodeSetSchema } from './currency.ts';

const CatalogRevisionSchema = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300));

export const RecognizedCurrencyCatalogSnapshotSchema = Schema.Struct({
  recognizedCurrencies: CurrencyCodeSetSchema.check(Schema.isMinLength(1)),
  revision: CatalogRevisionSchema,
});
export type RecognizedCurrencyCatalogSnapshot = typeof RecognizedCurrencyCatalogSnapshotSchema.Type;

export const RecognizedCurrencyCatalogUnavailable = Schema.TaggedStruct(
  'RecognizedCurrencyCatalogUnavailable',
  {
    code: Schema.Literal('recognized_currency_catalog_unavailable'),
    reason: Schema.String,
    retryable: Schema.Literal(true),
  },
);
export type RecognizedCurrencyCatalogUnavailableError =
  typeof RecognizedCurrencyCatalogUnavailable.Type;

export interface RecognizedCurrencyCatalogPortService {
  readonly resolveCurrent: (scope: {
    readonly legalEntityId: string;
    readonly tenantId: string;
  }) => Effect.Effect<RecognizedCurrencyCatalogSnapshot, RecognizedCurrencyCatalogUnavailableError>;
}

export class RecognizedCurrencyCatalogPort extends Context.Service<
  RecognizedCurrencyCatalogPort,
  RecognizedCurrencyCatalogPortService
>()(
  '@app/commerce-customer-context/shared/domain/currency-catalog-port/RecognizedCurrencyCatalogPort',
) {}

export const unavailableRecognizedCurrencyCatalogPort =
  (): RecognizedCurrencyCatalogPortService => ({
    resolveCurrent: () =>
      Effect.fail(
        RecognizedCurrencyCatalogUnavailable.make({
          code: 'recognized_currency_catalog_unavailable',
          reason: 'The Current recognized-currency catalog is not configured',
          retryable: true,
        }),
      ),
  });
