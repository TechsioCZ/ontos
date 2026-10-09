import { Schema } from 'effect';

import { ConfigurationUnitRefSchema } from '../resources/configuration-unit.ts';

export { CatalogRevisionInstantSchema as ConfigurationUnitInstantSchema } from '../domain/catalog-revision-reference.ts';

export const ConfigurationUnitTextSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1000),
  Schema.isTrimmed(),
);
export const ConfigurationUnitEvidenceRefsSchema = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed()),
).check(Schema.isMinLength(1));
export const ConfigurationUnitAuditEvidenceSchema = Schema.Struct({
  evidenceRefs: ConfigurationUnitEvidenceRefsSchema,
  reason: ConfigurationUnitTextSchema,
});
export const ConfigurationUnitMutationResultSchema = Schema.Struct({
  revision: Schema.Int.check(Schema.isGreaterThan(0)),
  unit: ConfigurationUnitRefSchema,
});

export class ConfigurationUnitActionError extends Schema.TaggedError<ConfigurationUnitActionError>()(
  'ConfigurationUnitActionError',
  {
    code: Schema.Literals(['configuration_unit_invalid', 'configuration_unit_stale', 'configuration_unit_unavailable']),
    reason: Schema.String,
  },
) {}
