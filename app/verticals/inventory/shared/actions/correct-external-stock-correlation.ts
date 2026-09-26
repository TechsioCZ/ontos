import { Schema } from 'effect';

import {
  CorrectExternalStockCorrelationInputSchema,
  ExternalStockCorrelationSchema,
} from '../domain/external-stock-correlation.ts';
import { ExternalStockCorrelationPersistenceUnavailable } from '../domain/external-stock-correlation-persistence-unavailable.ts';
import { ExternalStockCorrelationRejected } from '../domain/external-stock-correlation-rejected.ts';
import { ExternalStockCorrelationRefSchema } from '../resources/external-stock-correlation.ts';

export const CorrectExternalStockCorrelationPayloadSchema = Schema.Struct({
  ...CorrectExternalStockCorrelationInputSchema.fields,
  replacementCorrelationRef: ExternalStockCorrelationRefSchema,
});
export type CorrectExternalStockCorrelationPayload = typeof CorrectExternalStockCorrelationPayloadSchema.Type;

export const CorrectExternalStockCorrelationResultSchema = Schema.Struct({
  correlation: ExternalStockCorrelationSchema,
});

export const CorrectExternalStockCorrelationErrorSchema = Schema.Union([
  ExternalStockCorrelationRejected,
  ExternalStockCorrelationPersistenceUnavailable,
]);
