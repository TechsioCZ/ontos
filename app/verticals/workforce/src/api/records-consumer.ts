// Owner and consumer calls over the generated governed records client. Callers pass the encoded request, which is
// decoded here before the generated client sends it.
import type { EffectBffClientOptions } from '@app/shared-contracts/client-runtime';
import { Effect, Random, Schema } from 'effect';
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

/** Exact-target reads opt out explicitly; the generated client forwards these canonical transport options. */
export const executeFreshRecords = (payload: RecordsRequestEncoded, requestCorrelation: string) => {
  const options: Pick<EffectBffClientOptions, 'baseUrl' | 'compositionRevision' | 'requestCache'> = {
    requestCache: 'no-store',
  };
  return executeRecords(payload, requestCorrelation, options);
};

/** Every Employee the caller may read. Other verticals import this for assignee pickers. */
export const listEmployees = Effect.fn('Workforce.listEmployees')(function* listEmployees() {
  const nonce = yield* Random.nextInt;
  const response = yield* executeRecords({}, `workforce:list:${nonce}`);
  return response.items;
});
