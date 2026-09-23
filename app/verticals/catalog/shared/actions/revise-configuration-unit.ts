import { Schema } from 'effect';

import { ConfigurationUnitRefSchema } from '../resources/configuration-unit.ts';
import {
  ConfigurationUnitEvidenceRefsSchema,
  ConfigurationUnitInstantSchema,
  ConfigurationUnitTextSchema,
} from './configuration-unit-contract.ts';

export const ReviseConfigurationUnitPayloadSchema = Schema.Struct({
  dimension: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(160), Schema.isTrimmed()),
  effectiveFrom: ConfigurationUnitInstantSchema,
  effectiveTo: Schema.optionalKey(ConfigurationUnitInstantSchema),
  evidenceRefs: ConfigurationUnitEvidenceRefsSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  meaning: ConfigurationUnitTextSchema,
  reason: ConfigurationUnitTextSchema,
  unitRef: ConfigurationUnitRefSchema,
});
export type ReviseConfigurationUnitPayload = typeof ReviseConfigurationUnitPayloadSchema.Type;
export { ConfigurationUnitMutationResultSchema as ReviseConfigurationUnitResultSchema } from './configuration-unit-contract.ts';
