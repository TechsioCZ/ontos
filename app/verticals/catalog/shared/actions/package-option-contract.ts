import { Schema } from 'effect';

import { PackageDefinitionSelectionRevisionSchema } from '../domain/catalog-selection-evidence.ts';
import { PackageDefinitionRefSchema } from '../resources/package-definition.ts';

export const PackageOptionTransitionPayloadSchema = Schema.Struct({
  expectedContent: PackageDefinitionSelectionRevisionSchema,
  expectedOptionRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const PackageOptionTransitionResultSchema = Schema.Struct({
  contentRevision: PackageDefinitionSelectionRevisionSchema,
  definitionRef: PackageDefinitionRefSchema,
  optionRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  state: Schema.Literals(['ACTIVE', 'RETIRED']),
});

export class PackageOptionActionError extends Schema.TaggedError<PackageOptionActionError>()(
  'PackageOptionActionError',
  {
    code: Schema.Literals([
      'package_option_invalid',
      'package_option_not_found',
      'package_option_stale',
      'package_option_unavailable',
    ]),
    reason: Schema.String,
  },
) {}

export const PackageOptionActionErrorSchema = PackageOptionActionError;
