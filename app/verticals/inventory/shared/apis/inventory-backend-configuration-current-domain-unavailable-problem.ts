import { HttpApiSchema } from '@modern-js/bff-effect/effect-client';
import { Schema } from 'effect';

const problemDetailsRepresentation = HttpApiSchema.asJson({
  contentType: 'application/problem+json',
});

export class InventoryBackendConfigurationCurrentDomainUnavailableProblem extends Schema.TaggedError<InventoryBackendConfigurationCurrentDomainUnavailableProblem>()(
  'InventoryBackendConfigurationCurrentDomainUnavailableProblem',
  {
    detail: Schema.String,
    reasonCode: Schema.Literal('inventory_backend_configuration_persistence_unavailable'),
    retryable: Schema.Literal(true),
    status: Schema.Literal(503),
    title: Schema.String,
    type: Schema.String,
  },
) {}

export const InventoryBackendConfigurationCurrentDomainUnavailableProblemSchema =
  InventoryBackendConfigurationCurrentDomainUnavailableProblem.pipe(
    problemDetailsRepresentation,
    HttpApiSchema.status(503),
  );
