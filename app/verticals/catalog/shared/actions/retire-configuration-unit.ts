import { Schema } from 'effect';

import { ConfigurationUnitRefSchema } from '../resources/configuration-unit.ts';
import { ConfigurationUnitEvidenceRefsSchema, ConfigurationUnitTextSchema } from './configuration-unit-contract.ts';
import { CatalogRevisionInstantSchema } from '@app/catalog-selection-contracts/catalog-resource-reference';

export const RetireConfigurationUnitPayloadSchema = Schema.Struct({
  effectiveFrom: CatalogRevisionInstantSchema,
  effectiveTo: Schema.optionalKey(CatalogRevisionInstantSchema),
  evidenceRefs: ConfigurationUnitEvidenceRefsSchema,
  expectedRevision: Schema.Int.check(Schema.isGreaterThan(0)),
  reason: ConfigurationUnitTextSchema,
  unitRef: ConfigurationUnitRefSchema,
});
export type RetireConfigurationUnitPayload = typeof RetireConfigurationUnitPayloadSchema.Type;
export { ConfigurationUnitMutationResultSchema as RetireConfigurationUnitResultSchema } from './configuration-unit-contract.ts';
