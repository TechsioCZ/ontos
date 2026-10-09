import { Schema } from 'effect';

import { ConfigurationUnitRefSchema } from '../resources/configuration-unit.ts';
import {
  ConfigurationUnitEvidenceRefsSchema,
  ConfigurationUnitInstantSchema,
  ConfigurationUnitTextSchema,
} from './configuration-unit-contract.ts';

export const CreateConfigurationUnitPayloadSchema = Schema.Struct({
  code: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80), Schema.isTrimmed()),
  dimension: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160), Schema.isTrimmed()),
  effectiveFrom: ConfigurationUnitInstantSchema,
  effectiveTo: Schema.optionalKey(ConfigurationUnitInstantSchema),
  evidenceRefs: ConfigurationUnitEvidenceRefsSchema,
  meaning: ConfigurationUnitTextSchema,
  reason: ConfigurationUnitTextSchema,
  unitRef: ConfigurationUnitRefSchema,
});
export type CreateConfigurationUnitPayload = typeof CreateConfigurationUnitPayloadSchema.Type;
export { ConfigurationUnitMutationResultSchema as CreateConfigurationUnitResultSchema } from './configuration-unit-contract.ts';
