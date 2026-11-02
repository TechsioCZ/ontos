// Owner and consumer calls over the generated governed records client. Callers pass the encoded request, which is
// decoded here before the generated client sends it.
import { Effect, Schema } from 'effect';
import { RecordsRequestSchema } from '../../shared/apis/records.ts';
import type { RecordsRequestEncoded, RecordsViewEncoded } from '../../shared/apis/records.ts';
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

/** Typed collection reads. Each runs the single records read and returns one collection of it. */
export const listProducts = (requestCorrelation: string, view?: RecordsViewEncoded) =>
  executeRecords(viewPayload(view), requestCorrelation).pipe(Effect.map((response) => response.products));

export const listOrders = (requestCorrelation: string, view?: RecordsViewEncoded) =>
  executeRecords(viewPayload(view), requestCorrelation).pipe(Effect.map((response) => response.orders));

export const listMovements = (requestCorrelation: string, view?: RecordsViewEncoded) =>
  executeRecords(viewPayload(view), requestCorrelation).pipe(Effect.map((response) => response.movements));
