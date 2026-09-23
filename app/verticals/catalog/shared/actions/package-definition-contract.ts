import { Schema } from 'effect';

import { CatalogResourceRefSchema, CatalogRevisionInstantSchema } from '../domain/catalog-revision-reference.ts';
import {
  PackageDefinitionSelectionRevisionSchema,
  SetCompositionSelectionRevisionSchema,
} from '../domain/catalog-selection-evidence.ts';
import { VariantExactFormSchema } from '../domain/variant-exact-form.ts';
import { PackageDefinitionRefSchema } from '../resources/package-definition.ts';

const positiveDecimal = Schema.String.check(
  Schema.isPattern(/^(?:0|[1-9]\d*)(?:\.\d+)?$/u),
  Schema.makeFilter((value) => (/[1-9]/u.test(value) ? undefined : 'Expected positive quantity')),
);
const positiveWhole = Schema.String.check(Schema.isPattern(/^[1-9]\d*$/u));
export const PackageDefinitionReasonSchema = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(1000),
  Schema.isTrimmed(),
);
export const PackageDefinitionEvidenceRefsSchema = Schema.Array(
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed()),
).check(Schema.isMinLength(1));
export const PackageDefinitionChangeKindSchema = Schema.Literals(['physical_change', 'correction']);
export const PackageDefinitionAuditEvidenceSchema = Schema.Struct({
  changeKind: Schema.optionalKey(PackageDefinitionChangeKindSchema),
  evidenceRefs: PackageDefinitionEvidenceRefsSchema,
  priorErrorExplanation: Schema.optionalKey(PackageDefinitionReasonSchema),
  reason: PackageDefinitionReasonSchema,
});

/** A requested immutable content revision, never a mutable latest-size field. */
export const PackageDefinitionContentInputSchema = Schema.Struct({
  amount: positiveDecimal,
  configurationKey: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed()).pipe(Schema.brand('CatalogPackageConfigurationKey')),
  ),
  effectiveAt: CatalogRevisionInstantSchema,
  form: VariantExactFormSchema,
  lower: Schema.optionalKey(
    Schema.Struct({ count: positiveWhole, revision: PackageDefinitionSelectionRevisionSchema }),
  ),
  setComposition: Schema.optionalKey(SetCompositionSelectionRevisionSchema),
  unitRef: CatalogResourceRefSchema,
});

export const PackageDefinitionMutationResultSchema = Schema.Struct({
  contentRevision: PackageDefinitionSelectionRevisionSchema,
  definitionRef: PackageDefinitionRefSchema,
});

export class PackageDefinitionActionError extends Schema.TaggedError<PackageDefinitionActionError>()(
  'PackageDefinitionActionError',
  {
    code: Schema.Literals(['package_definition_invalid', 'package_definition_stale', 'package_definition_unavailable']),
    reason: Schema.String,
  },
) {}
export const PackageDefinitionActionErrorSchema = PackageDefinitionActionError;
