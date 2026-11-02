// Owner and consumer calls over the generated governed records client. Callers pass the encoded request, which is
// decoded here before the generated client sends it.
import { Effect, Schema } from 'effect';
import { RecordsRequestSchema } from '../../shared/apis/records.ts';
import type { RecordsRequestEncoded } from '../../shared/apis/records.ts';
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
