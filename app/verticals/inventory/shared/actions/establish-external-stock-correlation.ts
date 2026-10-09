import { Schema } from 'effect';

import {
  EstablishExternalStockCorrelationInputSchema,
  ExternalStockCorrelationSchema,
} from '../domain/external-stock-correlation.ts';
import { ExternalStockCorrelationPersistenceUnavailable } from '../domain/external-stock-correlation-persistence-unavailable.ts';
import { ExternalStockCorrelationRejected } from '../domain/external-stock-correlation-rejected.ts';
import { ExternalStockCorrelationRefSchema } from '../resources/external-stock-correlation.ts';

export const EstablishExternalStockCorrelationPayloadSchema = Schema.Struct({
  correlationRef: ExternalStockCorrelationRefSchema,
  ...EstablishExternalStockCorrelationInputSchema.fields,
});
export type EstablishExternalStockCorrelationPayload = typeof EstablishExternalStockCorrelationPayloadSchema.Type;

export const EstablishExternalStockCorrelationResultSchema = Schema.Struct({
  correlation: ExternalStockCorrelationSchema,
});

export const EstablishExternalStockCorrelationErrorSchema = Schema.Union([
  ExternalStockCorrelationRejected,
  ExternalStockCorrelationPersistenceUnavailable,
]);
