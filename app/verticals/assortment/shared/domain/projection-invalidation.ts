import { Schema } from 'effect';

/**
 * Outbox payloads describe a committed configuration change that may require a
 * discovery projection refresh. They never carry an Assortment outcome,
 * currentness proof, completeness proof, or a claim that an event was seen.
 */
export const AssortmentProjectionInvalidationKindSchema = Schema.Literal(
  'ASSORTMENT_DISCOVERY_PROJECTION_INVALIDATION',
);
