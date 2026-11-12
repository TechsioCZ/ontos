// Owner and consumer calls over the generated governed records client. Callers pass the encoded request, which is
// decoded here before the generated client sends it.
import { DateTime, Effect, Schema } from 'effect';
import { RecordsRequestSchema } from '../../shared/apis/records.ts';
import type {
  ProductRecord,
  RecordsRequestEncoded,
  RecordsResponse,
  RecordsViewEncoded,
} from '../../shared/apis/records.ts';
import {
  executeRecords as executeDecodedRecords,
  executeRecordsWithAuthorization as executeDecodedRecordsWithAuthorization,
} from './records-client.ts';

/** The generated client's invocation after its payload. */
type Invocation<Arguments extends readonly unknown[]> = Arguments extends readonly [unknown, ...infer Rest]
  ? Rest
  : never;

export const executeRecordsWithAuthorization = (
  payload: RecordsRequestEncoded,
  ...invocation: Invocation<Parameters<typeof executeDecodedRecordsWithAuthorization>>
) =>
  Schema.decodeEffect(RecordsRequestSchema)(payload).pipe(
    Effect.flatMap((decoded) => executeDecodedRecordsWithAuthorization(decoded, ...invocation)),
  );

export const executeRecords = (
  payload: RecordsRequestEncoded,
  ...invocation: Invocation<Parameters<typeof executeDecodedRecords>>
) =>
  Schema.decodeEffect(RecordsRequestSchema)(payload).pipe(
    Effect.flatMap((decoded) => executeDecodedRecords(decoded, ...invocation)),
  );

const viewPayload = (view: RecordsViewEncoded | undefined): RecordsRequestEncoded =>
  view === undefined ? {} : { view };

/**
 * The VAT rate a staff product is sold at now, from the response's `taxRates` (Tax's rules of the company): 0 for a
 * non-payer, `undefined` when its classification has no rate (the product cannot be sold).
 */
export const productVatRateAt = (
  response: Pick<RecordsResponse, 'taxRates' | 'taxRegime'>,
  product: Pick<ProductRecord, 'taxClassificationCode'>,
  at: DateTime.Utc,
): number | undefined => {
  if (response.taxRegime === 'NON_PAYER') {
    return 0;
  }
  const rate = (response.taxRates ?? []).find(
    (entry) =>
      entry.code === product.taxClassificationCode &&
      !DateTime.isLessThan(at, entry.effectiveFrom) &&
      (entry.effectiveTo === undefined || DateTime.isLessThan(at, entry.effectiveTo)),
  )?.ratePercent;
  return rate !== undefined && Number.isInteger(rate) ? rate : undefined;
};

/** Staff products with the VAT rate each is sold at now (`undefined`: not sellable). */
export const listProductsWithVat = (requestCorrelation: string, view?: RecordsViewEncoded) =>
  Effect.all([executeRecords(viewPayload(view), requestCorrelation), DateTime.now], { concurrency: 1 }).pipe(
    Effect.map(([response, now]) =>
      response.products.map((product) => ({ product, vatRate: productVatRateAt(response, product, now) })),
    ),
  );

/** Typed collection reads. Each runs the single records read and returns one collection of it. */
export const listProducts = (requestCorrelation: string, view?: RecordsViewEncoded) =>
  executeRecords(viewPayload(view), requestCorrelation).pipe(Effect.map((response) => response.products));

export const listOrders = (requestCorrelation: string, view?: RecordsViewEncoded) =>
  executeRecords(viewPayload(view), requestCorrelation).pipe(Effect.map((response) => response.orders));

export const listMovements = (requestCorrelation: string, view?: RecordsViewEncoded) =>
  executeRecords(viewPayload(view), requestCorrelation).pipe(Effect.map((response) => response.movements));
