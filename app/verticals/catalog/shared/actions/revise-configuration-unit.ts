import { Schema } from 'effect';

import { ConfigurationUnitRefSchema } from '../resources/configuration-unit.ts';
import { ConfigurationUnitEvidenceRefsSchema, ConfigurationUnitTextSchema } from './configuration-unit-contract.ts';
import { CatalogRevisionInstantSchema } from '@app/catalog-selection-contracts/catalog-resource-reference';

export const ReviseConfigurationUnitPayloadSchema = Schema.Struct({
  dimension: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160), Schema.isTrimmed()),
  effectiveFrom: CatalogRevisionInstantSchema,
  effectiveTo: Schema.optionalKey(CatalogRevisionInstantSchema),
  evidenceRefs: ConfigurationUnitEvidenceRefsSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  meaning: ConfigurationUnitTextSchema,
  reason: ConfigurationUnitTextSchema,
  unitRef: ConfigurationUnitRefSchema,
});
export type ReviseConfigurationUnitPayload = typeof ReviseConfigurationUnitPayloadSchema.Type;
export { ConfigurationUnitMutationResultSchema as ReviseConfigurationUnitResultSchema } from './configuration-unit-contract.ts';
