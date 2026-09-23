import { Schema } from 'effect';

import { ConfigurationUnitRefSchema } from '../resources/configuration-unit.ts';
import {
  ConfigurationUnitEvidenceRefsSchema,
  ConfigurationUnitInstantSchema,
  ConfigurationUnitTextSchema,
} from './configuration-unit-contract.ts';

export const RetireConfigurationUnitPayloadSchema = Schema.Struct({
  effectiveFrom: ConfigurationUnitInstantSchema,
  effectiveTo: Schema.optionalKey(ConfigurationUnitInstantSchema),
  evidenceRefs: ConfigurationUnitEvidenceRefsSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  reason: ConfigurationUnitTextSchema,
  unitRef: ConfigurationUnitRefSchema,
});
export type RetireConfigurationUnitPayload = typeof RetireConfigurationUnitPayloadSchema.Type;
export { ConfigurationUnitMutationResultSchema as RetireConfigurationUnitResultSchema } from './configuration-unit-contract.ts';
