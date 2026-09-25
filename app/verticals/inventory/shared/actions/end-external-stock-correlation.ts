import { Schema } from 'effect';

import {
  EndExternalStockCorrelationInputSchema,
  ExternalStockCorrelationSchema,
} from '../domain/external-stock-correlation.ts';
import { ExternalStockCorrelationPersistenceUnavailable } from '../domain/external-stock-correlation-persistence-unavailable.ts';
import { ExternalStockCorrelationRejected } from '../domain/external-stock-correlation-rejected.ts';
import { ExternalStockCorrelationRefSchema } from '../resources/external-stock-correlation.ts';

export const EndExternalStockCorrelationPayloadSchema = Schema.Struct({
  correlationRef: ExternalStockCorrelationRefSchema,
  ...EndExternalStockCorrelationInputSchema.fields,
});
export type EndExternalStockCorrelationPayload = typeof EndExternalStockCorrelationPayloadSchema.Type;

export const EndExternalStockCorrelationResultSchema = Schema.Struct({
  correlation: ExternalStockCorrelationSchema,
});

export const EndExternalStockCorrelationErrorSchema = Schema.Union([
  ExternalStockCorrelationRejected,
  ExternalStockCorrelationPersistenceUnavailable,
]);
