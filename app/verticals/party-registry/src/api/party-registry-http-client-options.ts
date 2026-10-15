import type { EffectBffClientOptions, EffectBffRequestContext } from '@app/shared-contracts/client-runtime';
import { Redacted } from 'effect';

import type { OperationContext } from '../../shared/api.ts';

// Owner transport options live apart from the native client call: api:check proves
// `makeEffectHttpApiClient` arguments only in modules that do not mutate objects.

export const requestCorrelationHeaderName = 'x-correlation-id' as const;

export interface PartyRegistryHttpRequestContextValue {
  readonly baseUrl: string | URL;
  readonly compositionRevision?: string;
  readonly credential?: Redacted.Redacted<string>;
  /** Action transport header; the endpoint contracts declare no header codec. */
  readonly idempotencyKey?: string;
  readonly operationContext?: OperationContext;
  readonly requestCorrelationHeader?: 'x-correlation-id';
  readonly requestCorrelation?: string;
  readonly requestLocale?: string;
  readonly requestTrace?: string;
  readonly requestTraceparent?: string;
}

export const partyRegistryClientOptions = (context: PartyRegistryHttpRequestContextValue): EffectBffClientOptions => {
  const requestCorrelationHeader = context.requestCorrelationHeader ?? requestCorrelationHeaderName;
  const transportHeaders =
    context.credential === undefined || context.requestCorrelation === undefined
      ? undefined
      : {
          authorization: Redacted.value(context.credential),
          [requestCorrelationHeader]: context.requestCorrelation,
          'x-trace-id': context.requestTrace,
          'idempotency-key': context.idempotencyKey,
          'x-ontos-composition-revision': context.compositionRevision,
        };
  const requestContext: EffectBffRequestContext = {};
  if (context.requestLocale !== undefined) {
    Object.assign(requestContext, { locale: context.requestLocale });
  }
  if (context.operationContext !== undefined) {
    Object.assign(requestContext, {
      operationContext: context.operationContext,
    });
  }
  if (context.requestTraceparent !== undefined) {
    Object.assign(requestContext, { traceparent: context.requestTraceparent });
  }
  const options: EffectBffClientOptions = { baseUrl: context.baseUrl };
  if (Object.keys(requestContext).length > 0) {
    Object.assign(options, { requestContext });
  }
  if (transportHeaders !== undefined) {
    Object.assign(options, { transportHeaders });
  }
  return options;
};
