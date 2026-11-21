import { Schema } from 'effect';

import { PackageDefinitionSelectionRevisionSchema } from '@app/catalog-selection-contracts/catalog-selection';
import {
  PackageDefinitionEvidenceRefsSchema,
  PackageDefinitionMutationResultSchema,
  PackageDefinitionReasonSchema,
} from './package-definition-contract.ts';

export const PromotePackageDefinitionPayloadSchema = Schema.Struct({
  evidenceRefs: PackageDefinitionEvidenceRefsSchema,
  expectedCurrent: PackageDefinitionSelectionRevisionSchema,
  expectedOptionRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  reason: PackageDefinitionReasonSchema,
  successor: PackageDefinitionSelectionRevisionSchema,
});
export type PromotePackageDefinitionPayload = typeof PromotePackageDefinitionPayloadSchema.Type;

export const PromotePackageDefinitionResultSchema = Schema.Struct({
  ...PackageDefinitionMutationResultSchema.fields,
  optionRevision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type PromotePackageDefinitionResult = typeof PromotePackageDefinitionResultSchema.Type;
