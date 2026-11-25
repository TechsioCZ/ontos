import { Schema } from 'effect';

import { ConfigurationUnitRefSchema } from '../resources/configuration-unit.ts';
import { ConfigurationUnitEvidenceRefsSchema, ConfigurationUnitTextSchema } from './configuration-unit-contract.ts';
import { CatalogRevisionInstantSchema } from '@app/catalog-selection-contracts/catalog-resource-reference';

export const CreateConfigurationUnitPayloadSchema = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80), Schema.isTrimmed()),
  dimension: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160), Schema.isTrimmed()),
  effectiveFrom: CatalogRevisionInstantSchema,
  effectiveTo: Schema.optionalKey(CatalogRevisionInstantSchema),
  evidenceRefs: ConfigurationUnitEvidenceRefsSchema,
  meaning: ConfigurationUnitTextSchema,
  reason: ConfigurationUnitTextSchema,
  unitRef: ConfigurationUnitRefSchema,
});
export type CreateConfigurationUnitPayload = typeof CreateConfigurationUnitPayloadSchema.Type;
export { ConfigurationUnitMutationResultSchema as CreateConfigurationUnitResultSchema } from './configuration-unit-contract.ts';
